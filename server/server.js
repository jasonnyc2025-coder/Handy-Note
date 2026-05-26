const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('ERROR: API_KEY environment variable is not set');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(cors());
app.use(express.json({ limit: '100mb' })); // large limit for inlined images

// Auth middleware for all /api routes
app.use('/api', (req, res, next) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// GET /api/sync/:room  — fetch notes + cats for a room
app.get('/api/sync/:room', async (req, res) => {
  try {
    const { room } = req.params;
    const result = await pool.query(
      'SELECT notes, cats FROM sync_rooms WHERE room = $1',
      [room]
    );
    if (result.rows.length === 0) return res.json({ notes: [], cats: [] });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/sync/:room  — save (upsert) notes + cats for a room
app.put('/api/sync/:room', async (req, res) => {
  try {
    const { room } = req.params;
    const { notes = [], cats = [] } = req.body;
    await pool.query(
      `INSERT INTO sync_rooms (room, notes, cats, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, NOW())
       ON CONFLICT (room) DO UPDATE
         SET notes = $2::jsonb, cats = $3::jsonb, updated_at = NOW()`,
      [room, JSON.stringify(notes), JSON.stringify(cats)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/sync/:room  — wipe all data for a room
app.delete('/api/sync/:room', async (req, res) => {
  try {
    await pool.query('DELETE FROM sync_rooms WHERE room = $1', [req.params.room]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => console.log(`Handy-Note server running on port ${PORT}`));
