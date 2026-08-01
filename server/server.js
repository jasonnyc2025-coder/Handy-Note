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
      'SELECT notes, cats, thai, thai_rev FROM user_data WHERE user_id = $1',
      [req.user.userId]
    );
    if (!result.rows.length) return res.json({ notes: [], cats: [], thai: [], thaiRev: 0 });
    const r = result.rows[0];
    res.json({
      notes: r.notes,
      cats: r.cats,
      thai: r.thai || [],
      thaiRev: Number(r.thai_rev) || 0
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
    const { notes, cats, thai, thaiRev } = req.body;

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

// Register/refresh a device's subscription and reminder list (anonymous).
app.post('/api/push/register', async (req, res) => {
  try {
    const { subscription, reminders } = req.body || {};
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Missing subscription' });
    const rems = Array.isArray(reminders) ? reminders : [];
    await pool.query(
      `INSERT INTO push_devices (endpoint, subscription, reminders, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, NOW())
       ON CONFLICT (endpoint) DO UPDATE
         SET subscription = $2::jsonb, reminders = $3::jsonb, updated_at = NOW()`,
      [subscription.endpoint, JSON.stringify(subscription), JSON.stringify(rems)]
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
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.body && req.body.token);
    let text = req.body && req.body.text;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Missing text' });
    text = text.trim().slice(0, 2000);

    const u = await pool.query('SELECT id FROM users WHERE quick_add_token = $1', [token]);
    if (!u.rows.length) return res.status(403).json({ error: 'Invalid token' });
    const userId = u.rows[0].id;

    await pool.query('INSERT INTO user_data (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    const d = await pool.query('SELECT notes FROM user_data WHERE user_id = $1', [userId]);
    const notes = (d.rows[0] && Array.isArray(d.rows[0].notes)) ? d.rows[0].notes : [];
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const now = Date.now();
    notes.unshift({
      id: now + 'qa' + Math.random().toString(36).slice(2, 7),
      text: esc(text), rich: true, type: 'idea', done: false, ts: now, atts: [], viaSiri: true
    });
    await pool.query('UPDATE user_data SET notes = $2::jsonb, updated_at = NOW() WHERE user_id = $1',
      [userId, JSON.stringify(notes)]);
    res.json({ ok: true });
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
