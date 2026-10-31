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

// ── Change notifications for long-polling clients ───────────────────────────
// A device waiting on GET /api/sync/<section>?since=&wait= is woken the moment
// another device's PUT lands, instead of finding out on its next 20-second poll.
// In-process only (one server process); the long-poll also re-reads the row
// every few seconds as a safety net in case there are ever several processes.
const EventEmitter = require('events');
const changes = new EventEmitter();
changes.setMaxListeners(0);
function notifyChange(userId, section) { changes.emit('u' + userId, section); }

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
      'SELECT notes, cats, notes_rev, thai, thai_rev, cards, cards_rev FROM user_data WHERE user_id = $1',
      [req.user.userId]
    );
    if (!result.rows.length) return res.json({ notes: [], cats: [], notesRev: 0, thai: [], thaiRev: 0, cards: [], cardsRev: 0 });
    const r = result.rows[0];
    res.json({
      notes: r.notes,
      cats: r.cats,
      notesRev: Number(r.notes_rev) || 0,
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

// GET /api/sync/:section  — one rev-gated section only (notes | thai | cards).
//
// The full GET /api/sync carries the notes with their inline photos/PDFs plus
// the flashcards and business cards, which is megabytes — far too heavy to poll
// every 20 seconds on mobile data (that is where the "请求超时" sync failures
// came from). This returns just that section: { thai, thaiRev }, { cards,
// cardsRev }, or for the notes app { notes, cats, notesRev } (notes and cats
// share one rev — the app always pushes them together).
//
// Long-poll: with ?since=<rev>&wait=<seconds> the request is held until the
// section's rev goes past `since` (another device pushed) or the wait expires,
// so a change on one device reaches the others within about a second. On
// expiry it answers { thaiRev, unchanged: true } without the data.
const SECTIONS = {
  notes: { cols: ['notes', 'cats'], revCol: 'notes_rev', revKey: 'notesRev' },
  thai:  { cols: ['thai'],          revCol: 'thai_rev',  revKey: 'thaiRev'  },
  cards: { cols: ['cards'],         revCol: 'cards_rev', revKey: 'cardsRev' },
};
const LONGPOLL_MAX_S = 25;        // under the usual 60 s reverse-proxy read timeout
const LONGPOLL_RECHECK_MS = 5000; // safety-net DB re-read while waiting

app.get('/api/sync/:section', requireAuth, async (req, res) => {
  const sec = SECTIONS[req.params.section];
  if (!sec) return res.status(404).json({ error: 'Unknown section' });
  const userId = req.user.userId;
  const since = req.query.since === undefined ? null : (Number(req.query.since) || 0);
  const waitS = Math.min(Math.max(Number(req.query.wait) || 0, 0), LONGPOLL_MAX_S);

  const readRev = async () => {
    const r = await pool.query(`SELECT ${sec.revCol} AS rev FROM user_data WHERE user_id = $1`, [userId]);
    return r.rows.length ? (Number(r.rows[0].rev) || 0) : 0;
  };
  const readAll = async () => {
    const r = await pool.query(`SELECT ${sec.cols.join(', ')}, ${sec.revCol} AS rev FROM user_data WHERE user_id = $1`, [userId]);
    const out = { [sec.revKey]: r.rows.length ? (Number(r.rows[0].rev) || 0) : 0 };
    for (const c of sec.cols) out[c] = (r.rows.length && r.rows[0][c]) || [];
    return out;
  };

  try {
    let rev = await readRev();
    if (since !== null && waitS > 0 && rev <= since) {
      rev = await new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
          if (done) return;
          done = true;
          clearTimeout(timer); clearInterval(ticker);
          changes.off('u' + userId, onChange);
          req.off('close', onClose);
          resolve(v);
        };
        const onChange = (section) => { if (section === req.params.section) readRev().then(finish, () => finish(rev)); };
        const onClose = () => finish(rev);
        const timer = setTimeout(() => finish(rev), waitS * 1000);
        const ticker = setInterval(() => {
          readRev().then(v => { if (v > since) finish(v); }, () => {});
        }, LONGPOLL_RECHECK_MS);
        changes.on('u' + userId, onChange);
        req.on('close', onClose);
      });
      if (res.writableEnded || req.destroyed) return;   // client went away while we waited
    }
    if (since !== null && rev <= since) return res.json({ [sec.revKey]: rev, unchanged: true });
    res.json(await readAll());
  } catch (err) {
    console.error(`GET sync/${req.params.section} error:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
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
    const { notes, cats, notesBase, thai, thaiRev, thaiBase, cards, cardsRev, cardsBase } = req.body;

    // Ensure a row exists (defaults fill the columns we don't touch)
    await pool.query(
      `INSERT INTO user_data (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    const out = { ok: true };
    // notes + cats share one rev (notes_rev). Every accepted write bumps it and
    // wakes the other devices' long-polls. With `notesBase` (the rev the client
    // last pulled) the write is a compare-and-swap, same as thai/cards below:
    // if another device pushed in between, answer notesAccepted:false so the
    // client pulls, merges by per-note timestamps, and pushes again — instead
    // of its stale full array silently wiping the other device's new note.
    // Without notesBase (older app versions) the write is accepted as before.
    if (notes !== undefined || cats !== undefined) {
      const sets = ['notes_rev = COALESCE(notes_rev, 0) + 1', 'updated_at = NOW()'];
      const vals = [userId];
      if (notes !== undefined) { vals.push(JSON.stringify(notes)); sets.push(`notes = $${vals.length}::jsonb`); }
      if (cats !== undefined)  { vals.push(JSON.stringify(cats));  sets.push(`cats = $${vals.length}::jsonb`); }
      let where = 'user_id = $1';
      if (notesBase !== undefined) { vals.push(Number(notesBase) || 0); where += ` AND COALESCE(notes_rev, 0) = $${vals.length}`; }
      const r = await pool.query(
        `UPDATE user_data SET ${sets.join(', ')} WHERE ${where} RETURNING notes_rev`, vals
      );
      out.notesAccepted = r.rowCount > 0;
      if (out.notesAccepted) {
        out.notesRev = Number(r.rows[0].notes_rev) || 0;
        notifyChange(userId, 'notes');
      } else {
        const cur = await pool.query('SELECT notes_rev FROM user_data WHERE user_id = $1', [userId]);
        out.notesRev = Number(cur.rows[0] && cur.rows[0].notes_rev) || 0;
      }
    }
    // The rev-gated sections report whether the write was accepted. Before,
    // a stale push (another device wrote in between the client's GET and PUT)
    // was dropped by the WHERE clause yet still answered { ok: true }, so the
    // client believed it had synced while the server never got its changes.
    //
    // Two gates for `thai` (and likewise `cards` with `cardsBase`):
    //  · With `thaiBase` (the rev the client read before merging): the write is
    //    accepted only if the stored rev is still exactly that — a compare-and-
    //    swap. Two devices pushing in the same second otherwise both pass the
    //    timestamp check and the second silently wipes the first one's new
    //    card, with both devices reporting success. The loser gets
    //    thaiAccepted:false, re-reads, merges and pushes again.
    //  · Without it (older clients): the original "incoming rev >= stored" rule.
    if (thai !== undefined) {
      let r;
      if (thaiBase !== undefined) {
        const base = Number(thaiBase) || 0;
        const newRev = Math.max(Number(thaiRev) || 0, base + 1);   // the rev must always move forward
        r = await pool.query(
          `UPDATE user_data
             SET thai = $2::jsonb, thai_rev = $3, updated_at = NOW()
           WHERE user_id = $1 AND COALESCE(thai_rev, 0) = $4
           RETURNING thai_rev`,
          [userId, JSON.stringify(thai), newRev, base]
        );
      } else {
        r = await pool.query(
          `UPDATE user_data
             SET thai = $2::jsonb, thai_rev = $3, updated_at = NOW()
           WHERE user_id = $1 AND $3 >= COALESCE(thai_rev, 0)
           RETURNING thai_rev`,
          [userId, JSON.stringify(thai), Number(thaiRev) || 0]
        );
      }
      out.thaiAccepted = r.rowCount > 0;
      if (out.thaiAccepted) {
        out.thaiRev = Number(r.rows[0].thai_rev) || 0;   // the rev THIS write set, not whatever is stored a moment later
        notifyChange(userId, 'thai');
      }
    }
    if (cards !== undefined) {
      let r;
      if (cardsBase !== undefined) {
        const base = Number(cardsBase) || 0;
        const newRev = Math.max(Number(cardsRev) || 0, base + 1);
        r = await pool.query(
          `UPDATE user_data
             SET cards = $2::jsonb, cards_rev = $3, updated_at = NOW()
           WHERE user_id = $1 AND COALESCE(cards_rev, 0) = $4
           RETURNING cards_rev`,
          [userId, JSON.stringify(cards), newRev, base]
        );
      } else {
        r = await pool.query(
          `UPDATE user_data
             SET cards = $2::jsonb, cards_rev = $3, updated_at = NOW()
           WHERE user_id = $1 AND $3 >= COALESCE(cards_rev, 0)
           RETURNING cards_rev`,
          [userId, JSON.stringify(cards), Number(cardsRev) || 0]
        );
      }
      out.cardsAccepted = r.rowCount > 0;
      if (out.cardsAccepted) {
        out.cardsRev = Number(r.rows[0].cards_rev) || 0;
        notifyChange(userId, 'cards');
      }
    }
    if (thai !== undefined || cards !== undefined) {
      const r = await pool.query('SELECT thai_rev, cards_rev FROM user_data WHERE user_id = $1', [userId]);
      if (out.thaiRev === undefined) out.thaiRev = Number(r.rows[0] && r.rows[0].thai_rev) || 0;
      if (out.cardsRev === undefined) out.cardsRev = Number(r.rows[0] && r.rows[0].cards_rev) || 0;
    }
    res.json(out);
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

// Model ids get retired: qwen3-vl-flash started answering 404 "Model not exist."
// and the whole feature died with it. Try OCR_MODEL first, then known-good
// alternatives, and remember whichever one answers. Set OCR_MODEL (comma-separated
// is fine) in .env to pin a specific one.
const OCR_MODEL_CANDIDATES = [...new Set(
  OCR_MODEL.split(',').map(x => x.trim()).filter(Boolean).concat([
    'qwen3-vl-plus', 'qwen3-vl-flash',
    'qwen-vl-max-latest', 'qwen-vl-plus-latest',
    'qwen-vl-max', 'qwen-vl-plus'
  ])
)];
let _ocrModelOk = null;          // 用过一次就记住，别每次都从头试

// does this upstream error mean "that model id isn't a thing here"? (as opposed to
// a bad key or a rate limit, where trying another model is pointless)
function isUnknownModel(status, body) {
  if (status !== 404 && status !== 400) return false;
  return /model.*(not exist|not found|does not exist|unsupported|invalid)/i.test(body || '');
}

// Ask the endpoint what it actually serves, so the error can name real options
// instead of leaving the user guessing. Best-effort — not all providers expose it.
async function listUpstreamModels() {
  try {
    const r = await fetch(`${OCR_BASE_URL}/models`, { headers: { authorization: `Bearer ${OCR_API_KEY}` } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data || []).map(m => m.id).filter(id => /vl|vision|omni/i.test(id)).slice(0, 12);
  } catch (e) { return []; }
}

// POST one chat/completions body, walking the candidate list past dead model ids.
// Resolves { ok:true, json } or { ok:false, status, detail, tried }.
async function callVisionModel(makeBody) {
  const order = _ocrModelOk ? [_ocrModelOk, ...OCR_MODEL_CANDIDATES.filter(m => m !== _ocrModelOk)]
                            : OCR_MODEL_CANDIDATES;
  const tried = [];
  let last = { status: 0, detail: '' };
  for (const model of order) {
    tried.push(model);
    let r;
    try {
      r = await fetch(`${OCR_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${OCR_API_KEY}` },
        body: JSON.stringify(Object.assign({ model }, makeBody()))
      });
    } catch (err) {
      return { ok: false, status: 0, detail: err.message, tried };
    }
    if (r.ok) { _ocrModelOk = model; return { ok: true, json: await r.json(), model, tried }; }
    const t = await r.text().catch(() => '');
    let detail = '';
    try { detail = JSON.parse(t).error.message; } catch (e) { detail = (t || '').slice(0, 200); }
    console.error('vision upstream error:', model, r.status, String(t).slice(0, 200));
    last = { status: r.status, detail };
    if (!isUnknownModel(r.status, t)) break;   // 不是「没这个模型」就别再换了（钥匙错 / 限流）
    if (_ocrModelOk === model) _ocrModelOk = null;
  }
  return { ok: false, status: last.status, detail: last.detail, tried };
}

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
    const out = await callVisionModel(() => ({
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
        ]
      }]
    }));
    if (!out.ok) {
      // surface the provider's own message so the client shows exactly what went
      // wrong (retired model id, invalid key, …). The key never appears in these.
      let message = `识别模型返回 ${out.status}：${out.detail || '未知错误'}`;
      if (isUnknownModel(out.status, out.detail)) {
        const avail = await listUpstreamModels();
        message = `这些模型在你的账号下都不存在：${out.tried.join('、')}。` +
          (avail.length ? `可用的有：${avail.join('、')}。` : '') +
          '请在服务器 .env 里把 OCR_MODEL 改成一个可用的模型名，然后重启服务。';
      }
      return res.status(502).json({ error: 'ocr_failed', message });
    }
    const j = out.json;
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
// One text-only chat call: AI_TEXT_MODEL if pinned, else the same model-walking
// fallback the OCR uses. Resolves { ok:true, text, model } or { ok:false, status, detail }.
async function llmText(sys, user, maxTokens) {
  const pinned = process.env.AI_TEXT_MODEL;
  const mk = () => ({ max_tokens: maxTokens || 800,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] });
  let j, model;
  if (pinned) {
    const r = await fetch(`${OCR_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OCR_API_KEY}` },
      body: JSON.stringify(Object.assign({ model: pinned }, mk()))
    });
    if (!r.ok) return { ok: false, status: r.status, detail: (await r.text().catch(() => '')).slice(0, 200) };
    j = await r.json(); model = pinned;
  } else {
    const out = await callVisionModel(mk);
    if (!out.ok) return { ok: false, status: out.status, detail: out.detail };
    j = out.json; model = out.model;
  }
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  let out = String(msg.content || msg.reasoning_content || '').trim();
  const fence = out.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  if (fence) out = fence[1].trim();
  out = out.replace(/^["“”'']+|["“”'']+$/g, '').trim();
  return { ok: true, text: out, model };
}

async function punctuateText(text) {
  if (!OCR_API_KEY || !text || !text.trim()) return text;
  const sys = '你是中文文本整理助手。用户给你一段语音听写的文字，通常没有标点、可能带口语化的重复或语气词。' +
    '请只做三件事：1) 断句并补上正确的标点；2) 去掉明显的口头语气词和重复；3) 保持原意，不增删信息、不解释、不翻译。' +
    '直接输出整理后的文本本身，不要加任何前后缀、引号或代码块。';
  try {
    const r = await llmText(sys, text, 1200);
    if (!r.ok) { console.error('punctuate upstream', r.status, r.detail); return text; }
    return r.text || text;
  } catch (err) {
    console.error('punctuate error:', err.message);
    return text;
  }
}

// POST /api/translate  { text, from?, to? } → { translation, model }
// Thai → Chinese for the flashcards' 「翻译」 button. iOS Safari has no built-in
// translator the page could use, so the phone asks the server, which uses the
// same text model as OCR / quick-add. Needs OCR_API_KEY; otherwise 501.
const _trCache = new Map();
app.post('/api/translate', requireAuth, async (req, res) => {
  if (!OCR_API_KEY) {
    return res.status(501).json({ error: 'translate_unavailable', message: '服务器未配置 OCR_API_KEY，AI 翻译不可用' });
  }
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'No text' });
  const from = String((req.body && req.body.from) || 'th').slice(0, 10);
  const to = String((req.body && req.body.to) || 'zh').slice(0, 10);
  const key = `${from}>${to}:${text}`;
  if (_trCache.has(key)) return res.json({ translation: _trCache.get(key), cached: true });
  const sys = '你是泰语—中文词典助手。用户给你一个泰语词、词组或短句（来自泰语学习卡片的例句），' +
    '请给出简洁准确的简体中文翻译。规则：只输出译文本身，不要解释、不要拼音、不要加引号或前后缀；' +
    '如果是多义词，用「/」分隔列出最常用的 2～3 个意思；短句就直接译成自然的中文。';
  try {
    const r = await llmText(sys, text, 300);
    if (!r.ok) return res.status(502).json({ error: 'upstream', message: `翻译模型返回 ${r.status || '网络错误'}：${r.detail || ''}` });
    const translation = (r.text || '').trim();
    if (!translation) return res.status(502).json({ error: 'empty', message: '翻译模型没有返回内容' });
    _trCache.set(key, translation);
    if (_trCache.size > 2000) _trCache.delete(_trCache.keys().next().value);
    res.json({ translation, model: r.model });
  } catch (err) {
    console.error('translate error:', err.message);
    res.status(500).json({ error: 'Server error', message: err.message });
  }
});

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
