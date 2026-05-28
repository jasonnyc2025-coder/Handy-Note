const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

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

// GET /api/sync  — fetch this user's notes + cats
app.get('/api/sync', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT notes, cats FROM user_data WHERE user_id = $1',
      [req.user.userId]
    );
    if (!result.rows.length) return res.json({ notes: [], cats: [] });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET sync error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/sync  — save (upsert) this user's notes + cats
app.put('/api/sync', requireAuth, async (req, res) => {
  try {
    const { notes = [], cats = [] } = req.body;
    await pool.query(
      `INSERT INTO user_data (user_id, notes, cats, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET notes = $2::jsonb, cats = $3::jsonb, updated_at = NOW()`,
      [req.user.userId, JSON.stringify(notes), JSON.stringify(cats)]
    );
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

app.listen(PORT, () => console.log(`Handy-Note server running on port ${PORT}`));
