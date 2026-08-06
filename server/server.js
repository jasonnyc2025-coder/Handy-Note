const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');
const { runMigrations } = require('./migrate');

const app = express();
const PORT = process.env.PORT || 3000;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const JWT_SECRET = process.env.JWT_SECRET;
const ALLOWED_EMAILS = process.env.ALLOWED_EMAILS
  ? new Set(process.env.ALLOWED_EMAILS.split(',').map(e => e.trim().toLowerCase()))
  : null; // null = allow anyone

if (!GOOGLE_CLIENT_ID || !JWT_SECRET) {
  console.error('ERROR: GOOGLE_CLIENT_ID and JWT_SECRET must be set');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

app.use(cors());
app.use(express.json({ limit: '100mb' }));

// ── Public endpoints ────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Expose Google Client ID to the frontend (it's a public value)
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

// Google Sign-In: verify ID token → return our JWT
app.post('/api/auth/google', async (req, res) => {
  const { id_token } = req.body;
  if (!id_token) return res.status(400).json({ error: 'Missing id_token' });
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: id_token,
      audience: GOOGLE_CLIENT_ID
    });
    const { sub, email, name, picture } = ticket.getPayload();

    // Check email whitelist
    if (ALLOWED_EMAILS && !ALLOWED_EMAILS.has(email.toLowerCase())) {
      return res.status(403).json({ error: 'This Google account is not allowed' });
    }

    // Upsert user record
    const result = await pool.query(
      `INSERT INTO users (google_sub, email, name, picture)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (google_sub) DO UPDATE
         SET email = $2, name = $3, picture = $4
       RETURNING id`,
      [sub, email, name, picture]
    );
    const userId = result.rows[0].id;

    const token = jwt.sign(
      { userId, email, name, picture },
      JWT_SECRET,
      { expiresIn: '365d' }
    );
    res.json({ token, name, email, picture });
  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(401).json({ error: 'Invalid Google token' });
  }
});

// ── JWT auth middleware for protected routes ────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token expired or invalid — please sign in again' });
  }
}

// ── Sync endpoints (protected) ──────────────────────────────────────────────

// GET /api/sync  — fetch this user's notes + cats + Thai flashcards
app.get('/api/sync', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT notes, cats, thai, thai_rev, cards, cards_rev FROM user_data WHERE user_id = $1',
      [req.user.userId]
    );
    if (!result.rows.length) return res.json({ notes: [], cats: [], thai: [], thaiRev: 0, cards: [], cardsRev: 0 });
    const r = result.rows[0];
    res.json({
      notes: r.notes,
      cats: r.cats,
      thai: r.thai || [],
      thaiRev: Number(r.thai_rev) || 0,
      cards: r.cards || [],
      cardsRev: Number(r.cards_rev) || 0
    });
  } catch (err) {
    console.error('GET sync error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/sync  — partial upsert of notes / cats / Thai flashcards.
// Only the fields present in the body are written, so the Thai page can push
// just `thai` without touching notes/cats. The Thai section is guarded by a
// monotonic `thaiRev`: it is only overwritten when the incoming rev is >= the
// stored one, so a stale push can never clobber newer Thai data.
app.put('/api/sync', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { notes, cats, thai, thaiRev, cards, cardsRev } = req.body;

    // Ensure a row exists (defaults fill the columns we don't touch)
    await pool.query(
      `INSERT INTO user_data (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    if (notes !== undefined) {
      await pool.query(
        `UPDATE user_data SET notes = $2::jsonb, updated_at = NOW() WHERE user_id = $1`,
        [userId, JSON.stringify(notes)]
      );
    }
    if (cats !== undefined) {
      await pool.query(
        `UPDATE user_data SET cats = $2::jsonb, updated_at = NOW() WHERE user_id = $1`,
        [userId, JSON.stringify(cats)]
      );
    }
    if (thai !== undefined) {
      await pool.query(
        `UPDATE user_data
           SET thai = $2::jsonb, thai_rev = $3, updated_at = NOW()
         WHERE user_id = $1 AND $3 >= COALESCE(thai_rev, 0)`,
        [userId, JSON.stringify(thai), Number(thaiRev) || 0]
      );
    }
    if (cards !== undefined) {
      await pool.query(
        `UPDATE user_data
           SET cards = $2::jsonb, cards_rev = $3, updated_at = NOW()
         WHERE user_id = $1 AND $3 >= COALESCE(cards_rev, 0)`,
        [userId, JSON.stringify(cards), Number(cardsRev) || 0]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT sync error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/sync  — wipe this user's data (keeps account)
app.delete('/api/sync', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM user_data WHERE user_id = $1', [req.user.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Business-card photos (protected) ────────────────────────────────────────
//
// Card metadata + thumbnails sync via /api/sync (the `cards` JSONB). The full
// photos are heavier, so they live here and are uploaded / fetched per card,
// keyed by (user, cardId, side). This keeps the metadata sync light and lets a
// fresh device download originals lazily, only when a card is opened.

// strip an optional "data:...;base64," prefix and decode
function decodeDataUrl(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^data:([^;]+);base64,(.*)$/s);
  const b64 = m ? m[2] : s;
  const mime = m ? m[1] : 'image/jpeg';
  try { return { buf: Buffer.from(b64, 'base64'), mime }; } catch { return null; }
}

// PUT /api/cards/image/:cardId?side=front  — upload/replace a card photo
app.put('/api/cards/image/:cardId', requireAuth, async (req, res) => {
  try {
    const side = (req.query.side === 'back') ? 'back' : 'front';
    const dec = decodeDataUrl(req.body && (req.body.data || req.body.image));
    if (!dec || !dec.buf.length) return res.status(400).json({ error: 'No image data' });
    await pool.query(
      `INSERT INTO card_images (user_id, card_id, side, mime, data, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id, card_id, side)
         DO UPDATE SET mime = $4, data = $5, updated_at = NOW()`,
      [req.user.userId, req.params.cardId, side, req.body.mime || dec.mime, dec.buf]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT card image error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/cards/image/:cardId?side=front  — download a card photo
app.get('/api/cards/image/:cardId', requireAuth, async (req, res) => {
  try {
    const side = (req.query.side === 'back') ? 'back' : 'front';
    const r = await pool.query(
      'SELECT mime, data FROM card_images WHERE user_id = $1 AND card_id = $2 AND side = $3',
      [req.user.userId, req.params.cardId, side]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.set('Content-Type', r.rows[0].mime || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=31536000');
    res.send(r.rows[0].data);
  } catch (err) {
    console.error('GET card image error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/cards/image/:cardId  — remove both sides' photos for a card
app.delete('/api/cards/image/:cardId', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM card_images WHERE user_id = $1 AND card_id = $2',
      [req.user.userId, req.params.cardId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/cards/ocr  — read a business-card photo and return structured fields.
// Uses an OpenAI-compatible vision model (Alibaba Model Studio, qwen3-vl-flash) when
// OCR_API_KEY is configured; otherwise returns 501 so the client cleanly falls back
// to manual entry. Provider is chosen entirely by env: OCR_BASE_URL + OCR_MODEL.
const OCR_API_KEY = process.env.OCR_API_KEY;
const OCR_BASE_URL = (process.env.OCR_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const OCR_MODEL = process.env.OCR_MODEL || 'qwen3-vl-flash';

app.post('/api/cards/ocr', requireAuth, async (req, res) => {
  if (!OCR_API_KEY) {
    return res.status(501).json({ error: 'ocr_unavailable', message: '服务器未配置 OCR_API_KEY，自动识别不可用（可手动填写）' });
  }
  const dec = decodeDataUrl(req.body && (req.body.image || req.body.data));
  if (!dec || !dec.buf.length) return res.status(400).json({ error: 'No image data' });
  const mime = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(dec.mime) ? dec.mime : 'image/jpeg';
  const b64 = dec.buf.toString('base64');
  const prompt =
    '这是一张名片的照片。请提取名片上的信息，只返回一个 JSON 对象，不要任何解释或代码块标记。' +
    '字段：name(姓名), company(公司/机构), title(职位), phones(电话数组), emails(邮箱数组), ' +
    'address(地址), website(网站), other(其它有用信息，如微信/部门等)。' +
    '找不到的字段用空字符串或空数组。电话保留原样（含分机/区号）。';
  try {
    const r = await fetch(`${OCR_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${OCR_API_KEY}`
      },
      body: JSON.stringify({
        model: OCR_MODEL,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
          ]
        }]
      })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('OCR upstream error:', r.status, t.slice(0, 300));
      // surface the model provider's own error message so the client can show
      // exactly what went wrong (bad model id, invalid key, etc.). The key is
      // never included in these messages, so this is safe to return.
      let detail = '';
      try { detail = JSON.parse(t).error.message; } catch (e) { detail = (t || '').slice(0, 200); }
      return res.status(502).json({ error: 'ocr_failed', message: `识别模型返回 ${r.status}：${detail || '未知错误'}` });
    }
    const j = await r.json();
    const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
    // OpenAI-compatible returns a string; Qwen reasoning models sometimes put the
    // answer in reasoning_content when content is empty.
    let text = String(msg.content || msg.reasoning_content || '').trim();
    // tolerate a ```json fence if the model adds one
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();
    let fields = {};
    try { fields = JSON.parse(text); } catch { fields = { other: text }; }
    res.json({ ok: true, fields });
  } catch (err) {
    console.error('OCR error:', err.message);
    res.status(502).json({ error: 'ocr_failed', message: `调用识别服务异常：${err.message}` });
  }
});

// Tidy up voice-dictated text: add correct Chinese punctuation / sentence breaks
// and drop obvious filler, WITHOUT changing meaning. Reuses the same OpenAI-compatible
// endpoint as OCR. Best-effort: returns the original text on any failure so a note
// is never lost. Model defaults to OCR_MODEL (override with AI_TEXT_MODEL).
async function punctuateText(text) {
  if (!OCR_API_KEY || !text || !text.trim()) return text;
  const model = process.env.AI_TEXT_MODEL || OCR_MODEL;
  const sys = '你是中文文本整理助手。用户给你一段语音听写的文字，通常没有标点、可能带口语化的重复或语气词。' +
    '请只做三件事：1) 断句并补上正确的标点；2) 去掉明显的口头语气词和重复；3) 保持原意，不增删信息、不解释、不翻译。' +
    '直接输出整理后的文本本身，不要加任何前后缀、引号或代码块。';
  try {
    const r = await fetch(`${OCR_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${OCR_API_KEY}` },
      body: JSON.stringify({
        model, max_tokens: 1200,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: text }]
      })
    });
    if (!r.ok) { console.error('punctuate upstream', r.status); return text; }
    const j = await r.json();
    const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
    let out = String(msg.content || msg.reasoning_content || '').trim();
    const fence = out.match(/```(?:\w+)?\s*([\s\S]*?)```/);
    if (fence) out = fence[1].trim();
    out = out.replace(/^["“”'']+|["“”'']+$/g, '').trim();
    return out || text;
  } catch (err) {
    console.error('punctuate error:', err.message);
    return text;
  }
}

// ── Background push reminders (anonymous — no login required) ────────────────
//
// Devices register their Web Push subscription plus the reminders they want
// delivered. A scheduler sends a push when a reminder is due, so it fires even
// when the app is fully closed. No auth: the push subscription itself is the
// identity, which lets reminders work without signing in.

let VAPID_PUBLIC = null;
let pushReady = false;

async function getSetting(k) {
  const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [k]);
  return r.rows[0] && r.rows[0].value;
}
async function setSetting(k, v) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`, [k, v]);
}

async function initPush() {
  // Load a stable VAPID keypair (generate + persist on first run so existing
  // subscriptions keep working across restarts).
  let pub = await getSetting('vapid_public');
  let priv = await getSetting('vapid_private');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey; priv = keys.privateKey;
    await setSetting('vapid_public', pub);
    await setSetting('vapid_private', priv);
    console.log('[push] generated a new VAPID keypair');
  }
  // Apple's push service rejects an invalid VAPID subject (e.g. the reserved
  // .local TLD) with 403, so default to a real https URL. Override with the
  // VAPID_SUBJECT env var (a mailto: or https: contact URL) if you prefer.
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://handy-note.mynexussolution.com', pub, priv);
  VAPID_PUBLIC = pub;
  pushReady = true;
  setInterval(() => { sendDuePushes().catch(e => console.error('[push] scheduler:', e.message)); }, 30000);
  console.log('[push] ready');
}

// Mirror of the client's nextOccurrence() so repeating reminders keep firing
// even while the app stays closed.
function nextOccurrence(ts, repeat) {
  if (!repeat || repeat === 'none') return null;
  const now = Date.now();
  const d = new Date(ts);
  let guard = 0;
  do {
    if (repeat === 'daily') d.setDate(d.getDate() + 1);
    else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
    else if (repeat === 'monthly') d.setMonth(d.getMonth() + 1);
    else if (repeat === 'yearly') d.setFullYear(d.getFullYear() + 1);
    else return null;
    guard++;
  } while (d.getTime() <= now && guard < 3000);
  return d.getTime();
}

let pushBusy = false;
async function sendDuePushes() {
  if (!pushReady || pushBusy) return;
  pushBusy = true;
  try {
    const now = Date.now();
    const { rows } = await pool.query('SELECT endpoint, subscription, reminders FROM push_devices');
    for (const row of rows) {
      const rems = Array.isArray(row.reminders) ? row.reminders : [];
      let changed = false, gone = false;
      for (const r of rems) {
        if (!r || !r.at || r.fired || r.at > now) continue;
        try {
          await webpush.sendNotification(
            row.subscription,
            JSON.stringify({ title: '⏰ 提醒', body: r.text || '你有一条提醒', tag: r.id || undefined, id: r.id || undefined })
          );
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await pool.query('DELETE FROM push_devices WHERE endpoint = $1', [row.endpoint]);
            gone = true;
            break;
          }
          // transient error — leave it unfired to retry next tick
          continue;
        }
        const next = nextOccurrence(r.at, r.repeat);
        if (next) { r.at = next; r.fired = false; } else { r.fired = true; }
        changed = true;
      }
      if (changed && !gone) {
        await pool.query('UPDATE push_devices SET reminders = $2::jsonb WHERE endpoint = $1',
          [row.endpoint, JSON.stringify(rems)]);
      }
    }
  } finally {
    pushBusy = false;
  }
}

// Public key so the client can subscribe.
app.get('/api/push/vapid', (req, res) => res.json({ publicKey: VAPID_PUBLIC }));

// Register/refresh a device's subscription and reminder list. If the app sends
// its login JWT we also record which user this device belongs to, so a
// voice/Siri note can inject its reminder into this device's push queue.
app.post('/api/push/register', async (req, res) => {
  try {
    const { subscription, reminders } = req.body || {};
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Missing subscription' });
    const rems = Array.isArray(reminders) ? reminders : [];
    let userId = null;
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      try { userId = jwt.verify(auth.slice(7), JWT_SECRET).userId; } catch {}
    }
    await pool.query(
      `INSERT INTO push_devices (endpoint, subscription, reminders, user_id, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4, NOW())
       ON CONFLICT (endpoint) DO UPDATE
         SET subscription = $2::jsonb, reminders = $3::jsonb,
             user_id = COALESCE($4, push_devices.user_id), updated_at = NOW()`,
      [subscription.endpoint, JSON.stringify(subscription), JSON.stringify(rems), userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('push register error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send a push right now, to verify the whole chain end to end.
app.post('/api/push/test', async (req, res) => {
  try {
    if (!pushReady) return res.status(503).json({ error: 'push not configured on server' });
    const { subscription } = req.body || {};
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Missing subscription' });
    await webpush.sendNotification(
      subscription,
      JSON.stringify({ title: '⏰ 测试推送', body: '后台推送正常工作 ✅', tag: 'push-test' })
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message, statusCode: err.statusCode });
  }
});

// Snooze a reminder from the notification's "再过5分钟" button (works even when
// no page is open — the service worker calls this directly).
app.post('/api/push/snooze', async (req, res) => {
  try {
    const { endpoint, id, minutes } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
    const mins = Number(minutes) > 0 ? Number(minutes) : 5;
    const at = Date.now() + mins * 60 * 1000;
    const { rows } = await pool.query('SELECT reminders FROM push_devices WHERE endpoint = $1', [endpoint]);
    if (!rows.length) return res.status(404).json({ error: 'Unknown device' });
    let rems = Array.isArray(rows[0].reminders) ? rows[0].reminders : [];
    const existing = rems.find(r => r && String(r.id) === String(id));
    if (existing) { existing.at = at; existing.fired = false; }
    else rems.push({ id: String(id || 'snoozed'), text: '提醒', at, repeat: 'none', fired: false });
    await pool.query('UPDATE push_devices SET reminders = $2::jsonb, updated_at = NOW() WHERE endpoint = $1',
      [endpoint, JSON.stringify(rems)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('push snooze error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Unregister a device (e.g. reminders turned off).
app.delete('/api/push/register', async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (endpoint) await pool.query('DELETE FROM push_devices WHERE endpoint = $1', [endpoint]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Voice / Siri quick-add ──────────────────────────────────────────────────
//
// An iOS Shortcut posts dictated text to /api/quick-add authenticated by a
// per-user WRITE-ONLY token (not the login JWT). The token can only append one
// note — it cannot read or delete anything — and can be reset from the app,
// which limits the blast radius if it ever leaks.

// Fetch (creating on first use) the caller's quick-add token — login required.
app.get('/api/quickadd/token', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT quick_add_token FROM users WHERE id = $1', [req.user.userId]);
    let tok = r.rows[0] && r.rows[0].quick_add_token;
    if (!tok) {
      tok = 'qa_' + crypto.randomBytes(24).toString('hex');
      await pool.query('UPDATE users SET quick_add_token = $2 WHERE id = $1', [req.user.userId, tok]);
    }
    res.json({ token: tok });
  } catch (err) {
    console.error('quickadd token error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset the quick-add token (invalidates the old one) — login required.
app.post('/api/quickadd/token/reset', requireAuth, async (req, res) => {
  try {
    const tok = 'qa_' + crypto.randomBytes(24).toString('hex');
    await pool.query('UPDATE users SET quick_add_token = $2 WHERE id = $1', [req.user.userId, tok]);
    res.json({ token: tok });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Append a note — authenticated ONLY by the quick-add token (write-only).
app.post('/api/quick-add', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    // tolerant: accept "Bearer <tok>", a mistyped prefix, or the raw token
    let token = req.body && req.body.token;
    if (!token && auth) token = auth.includes(' ') ? auth.slice(auth.indexOf(' ') + 1).trim() : auth.trim();
    let text = req.body && req.body.text;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Missing text' });
    text = text.trim().slice(0, 2000);

    // AI tidy-up for voice notes: add punctuation / sentence breaks. On by default
    // when the AI key is set; the Shortcut can opt out with {"punctuate": false} or
    // {"raw": true}, or disable globally with QUICKADD_AI=off. Never blocks saving.
    if (OCR_API_KEY && process.env.QUICKADD_AI !== 'off'
        && req.body.punctuate !== false && req.body.raw !== true) {
      try { text = await punctuateText(text); } catch (e) {}
    }

    // optional reminder from the Shortcut
    let remindAt = 0;
    const raw = req.body && req.body.remindAt;
    if (raw !== undefined && raw !== null && raw !== '') {
      const ms = typeof raw === 'number' ? raw : Date.parse(raw);
      if (!isNaN(ms) && ms > 0) remindAt = ms < 1e12 ? ms * 1000 : ms;   // seconds → ms if needed
    }
    const repeat = ['daily', 'weekly', 'monthly', 'yearly'].includes(req.body && req.body.repeat) ? req.body.repeat : 'none';

    const u = await pool.query('SELECT id FROM users WHERE quick_add_token = $1', [token]);
    if (!u.rows.length) return res.status(403).json({ error: 'Invalid token' });
    const userId = u.rows[0].id;

    await pool.query('INSERT INTO user_data (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    const d = await pool.query('SELECT notes FROM user_data WHERE user_id = $1', [userId]);
    const notes = (d.rows[0] && Array.isArray(d.rows[0].notes)) ? d.rows[0].notes : [];
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const now = Date.now();
    const noteId = now + 'qa' + Math.random().toString(36).slice(2, 7);
    const note = { id: noteId, text: esc(text), rich: true, type: 'idea', done: false, ts: now, atts: [], viaSiri: true };
    if (remindAt) { note.remindAt = remindAt; note.repeat = repeat; note.remindFired = false; }
    notes.unshift(note);
    await pool.query('UPDATE user_data SET notes = $2::jsonb, updated_at = NOW() WHERE user_id = $1',
      [userId, JSON.stringify(notes)]);

    // Inject the reminder into this user's push queue so it fires in the
    // background even if the app is never opened.
    if (remindAt) {
      const dev = await pool.query('SELECT endpoint, reminders FROM push_devices WHERE user_id = $1', [userId]);
      for (const row of dev.rows) {
        const rems = Array.isArray(row.reminders) ? row.reminders : [];
        if (!rems.some(r => r && String(r.id) === noteId)) {
          rems.push({ id: noteId, text: text.slice(0, 120), at: remindAt, repeat, fired: false });
          await pool.query('UPDATE push_devices SET reminders = $2::jsonb WHERE endpoint = $1',
            [row.endpoint, JSON.stringify(rems)]);
        }
      }
    }
    res.json({ ok: true, reminded: !!remindAt });
  } catch (err) {
    console.error('quick-add error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Apply any pending DB migrations before accepting traffic, then start.
runMigrations(pool)
  .then(() => initPush().catch(err => console.error('[push] init failed:', err.message)))
  .then(() => {
    app.listen(PORT, () => console.log(`Handy-Note server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Startup aborted — migrations failed:', err.message);
    process.exit(1);
  });
