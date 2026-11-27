// Shared staff-bonus ledger — backend for the separate staff-bonus app
// (https://jasonnyc2025-coder.github.io/staff-bonus/).
//
// A book is one shared ledger. Its members (by Google email) can all read and
// edit it; only the owner can invite or remove members. Data is a flat set of
// records — employees ("emp:<id>") and employee-years ("yr:<empId>:<year>") —
// each carrying the book-wide rev at which it last changed, so:
//   · a device asks for "everything since rev N" and gets just the delta;
//   · a write names the rev it edited from, and is refused for that one record
//     if someone else changed it in between (no silent overwrite);
//   · GET .../sync?since=N&wait=25 long-polls, so the other person's edit shows
//     up within about a second.
// Every accepted change is written to bonus_log field by field (who / when /
// old → new).

const LONGPOLL_MAX_S = 25;
const LONGPOLL_RECHECK_MS = 5000;
const REC_ID_RE = /^(emp|yr):[A-Za-z0-9_:.-]{1,80}$/;
const MAX_BATCH = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = function mountBonus({ app, pool, jwt, JWT_SECRET, changes }) {
  const lc = (e) => String(e || '').trim().toLowerCase();

  // Any signed-in token (full or bonus-scoped) is fine here; access to a book
  // is decided by membership below.
  function bonusAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try { req.user = jwt.verify(auth.slice(7), JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Token expired or invalid — please sign in again' }); }
    req.email = lc(req.user.email);
    next();
  }

  // Loads req.book + req.role, or answers 403/404.
  async function bookAccess(req, res, next) {
    const id = Number(req.params.book);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Unknown ledger' });
    try {
      const r = await pool.query(
        `SELECT b.id, b.name, b.rev, m.role
           FROM bonus_books b JOIN bonus_members m ON m.book_id = b.id
          WHERE b.id = $1 AND m.email = $2`, [id, req.email]);
      if (!r.rows.length) return res.status(403).json({ error: '你没有这个账本的权限' });
      req.book = { id, name: r.rows[0].name, rev: Number(r.rows[0].rev) || 0 };
      req.role = r.rows[0].role;
      next();
    } catch (err) {
      console.error('bonus access error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  }

  const ownerOnly = (req, res, next) =>
    req.role === 'owner' ? next() : res.status(403).json({ error: '只有账本主人可以管理成员' });

  // field-level diff for the log
  function diff(a, b) {
    a = a || {}; b = b || {};
    const out = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (k === 'modified' || k === 'modifiedBy') continue;
      const x = a[k] === undefined ? null : a[k];
      const y = b[k] === undefined ? null : b[k];
      if (JSON.stringify(x) !== JSON.stringify(y)) out[k] = [x, y];
    }
    return out;
  }

  // GET /api/bonus/books — ledgers this account can open. A full account that
  // belongs to none gets its own ledger created on the spot.
  app.get('/api/bonus/books', bonusAuth, async (req, res) => {
    try {
      const q = () => pool.query(
        `SELECT b.id, b.name, m.role, ou.email AS owner_email, ou.name AS owner_name
           FROM bonus_members m
           JOIN bonus_books b ON b.id = m.book_id
           JOIN users ou ON ou.id = b.owner_id
          WHERE m.email = $1 ORDER BY b.id`, [req.email]);
      let r = await q();
      if (!r.rows.length && req.user.scope !== 'bonus') {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const b = await client.query(
            `INSERT INTO bonus_books (owner_id) VALUES ($1) RETURNING id`, [req.user.userId]);
          await client.query(
            `INSERT INTO bonus_members (book_id, email, role) VALUES ($1, $2, 'owner')`,
            [b.rows[0].id, req.email]);
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; }
        finally { client.release(); }
        r = await q();
      }
      res.json({
        books: r.rows.map(x => ({
          id: x.id, name: x.name, role: x.role, ownerEmail: x.owner_email, ownerName: x.owner_name
        }))
      });
    } catch (err) {
      console.error('bonus books error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/bonus/:book/sync?since=<rev>&wait=<s>
  // → { rev, records: [{ id, data, deleted, rev, modifiedAt, modifiedBy }] } (only rev > since)
  // → { rev, unchanged: true } when the long-poll times out with nothing new.
  app.get('/api/bonus/:book/sync', bonusAuth, bookAccess, async (req, res) => {
    const bookId = req.book.id;
    const since = Math.max(Number(req.query.since) || 0, 0);
    const waitS = Math.min(Math.max(Number(req.query.wait) || 0, 0), LONGPOLL_MAX_S);
    const readRev = async () => {
      const r = await pool.query('SELECT rev FROM bonus_books WHERE id = $1', [bookId]);
      return Number(r.rows[0] && r.rows[0].rev) || 0;
    };
    try {
      let rev = req.book.rev;
      if (waitS > 0 && rev <= since) {
        const key = 'bonus' + bookId;
        rev = await new Promise((resolve) => {
          let done = false;
          const finish = (v) => {
            if (done) return; done = true;
            clearTimeout(timer); clearInterval(ticker);
            changes.off(key, onChange); req.off('close', onClose);
            resolve(v);
          };
          const onChange = () => readRev().then(finish, () => finish(rev));
          const onClose = () => finish(rev);
          const timer = setTimeout(() => finish(rev), waitS * 1000);
          const ticker = setInterval(() => { readRev().then(v => { if (v > since) finish(v); }, () => {}); }, LONGPOLL_RECHECK_MS);
          changes.on(key, onChange);
          req.on('close', onClose);
        });
        if (res.writableEnded || req.destroyed) return;
      }
      if (rev <= since) return res.json({ rev, unchanged: true });
      const r = await pool.query(
        `SELECT rec_id, data, deleted, rev, modified_at, modified_by
           FROM bonus_records WHERE book_id = $1 AND rev > $2 ORDER BY rev`, [bookId, since]);
      res.json({
        rev: Math.max(rev, ...r.rows.map(x => Number(x.rev))),
        records: r.rows.map(x => ({
          id: x.rec_id, data: x.data, deleted: x.deleted, rev: Number(x.rev),
          modifiedAt: x.modified_at, modifiedBy: x.modified_by
        }))
      });
    } catch (err) {
      console.error('bonus sync error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    }
  });

  // PUT /api/bonus/:book/records  { records: [{ id, data, deleted?, baseRev }] }
  // Each record is accepted only if its stored rev still equals baseRev (0 = new).
  // → { rev, accepted: [{ id, rev }], rejected: [{ id, current }] }
  app.put('/api/bonus/:book/records', bonusAuth, bookAccess, async (req, res) => {
    const list = req.body && req.body.records;
    if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'No records' });
    if (list.length > MAX_BATCH) return res.status(400).json({ error: 'Too many records' });
    for (const r of list) {
      if (!r || typeof r.id !== 'string' || !REC_ID_RE.test(r.id)) return res.status(400).json({ error: 'Bad record id' });
      if (r.data !== undefined && (typeof r.data !== 'object' || Array.isArray(r.data) || r.data === null)) return res.status(400).json({ error: 'Bad record data' });
    }
    const bookId = req.book.id;
    const who = req.email;
    const whoName = req.user.name || who;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const b = await client.query('SELECT rev FROM bonus_books WHERE id = $1 FOR UPDATE', [bookId]);
      let rev = Number(b.rows[0].rev) || 0;
      const ids = list.map(r => r.id);
      const cur = await client.query(
        `SELECT rec_id, data, deleted, rev, modified_at, modified_by
           FROM bonus_records WHERE book_id = $1 AND rec_id = ANY($2)`, [bookId, ids]);
      const byId = new Map(cur.rows.map(x => [x.rec_id, x]));
      const accepted = [], rejected = [];
      for (const r of list) {
        const old = byId.get(r.id);
        const oldRev = old ? Number(old.rev) : 0;
        const base = Number(r.baseRev) || 0;
        if (oldRev !== base) {
          rejected.push({
            id: r.id,
            current: old ? { id: r.id, data: old.data, deleted: old.deleted, rev: oldRev, modifiedAt: old.modified_at, modifiedBy: old.modified_by } : null
          });
          continue;
        }
        const deleted = !!r.deleted;
        const data = r.data || (old ? old.data : {});
        const changesMap = deleted ? {} : diff(old && !old.deleted ? old.data : null, data);
        if (old && !!old.deleted === deleted && !Object.keys(changesMap).length) {
          accepted.push({ id: r.id, rev: oldRev });   // nothing actually changed
          continue;
        }
        rev += 1;
        await client.query(
          `INSERT INTO bonus_records (book_id, rec_id, data, deleted, rev, modified_at, modified_by)
             VALUES ($1, $2, $3::jsonb, $4, $5, NOW(), $6)
           ON CONFLICT (book_id, rec_id) DO UPDATE
             SET data = $3::jsonb, deleted = $4, rev = $5, modified_at = NOW(), modified_by = $6`,
          [bookId, r.id, JSON.stringify(data), deleted, rev, who]);
        const action = deleted ? 'delete' : (!old || old.deleted ? 'create' : 'update');
        await client.query(
          `INSERT INTO bonus_log (book_id, email, name, rec_id, action, changes)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [bookId, who, whoName, r.id, action,
           JSON.stringify(deleted ? { _snapshot: old ? old.data : null } : changesMap)]);
        accepted.push({ id: r.id, rev });
      }
      await client.query('UPDATE bonus_books SET rev = $2 WHERE id = $1', [bookId, rev]);
      await client.query('COMMIT');
      if (accepted.length) changes.emit('bonus' + bookId);
      res.json({ rev, accepted, rejected });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('bonus put error:', err.message);
      res.status(500).json({ error: 'Server error' });
    } finally {
      client.release();
    }
  });

  // GET /api/bonus/:book/log?before=<id>&limit=<n>&rec=<recId prefix>
  app.get('/api/bonus/:book/log', bonusAuth, bookAccess, async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const vals = [req.book.id];
      let where = 'book_id = $1';
      if (req.query.before) { vals.push(Number(req.query.before) || 0); where += ` AND id < $${vals.length}`; }
      if (req.query.rec) { vals.push(String(req.query.rec).replace(/[%_\\]/g, '\\$&') + '%'); where += ` AND rec_id LIKE $${vals.length}`; }
      vals.push(limit);
      const r = await pool.query(
        `SELECT id, at, email, name, rec_id, action, changes FROM bonus_log
          WHERE ${where} ORDER BY id DESC LIMIT $${vals.length}`, vals);
      res.json({ log: r.rows.map(x => ({ id: Number(x.id), at: x.at, email: x.email, name: x.name, recId: x.rec_id, action: x.action, changes: x.changes })) });
    } catch (err) {
      console.error('bonus log error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Members
  app.get('/api/bonus/:book/members', bonusAuth, bookAccess, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT m.email, m.role, m.added_at, u.name, u.picture
           FROM bonus_members m LEFT JOIN users u ON lower(u.email) = m.email
          WHERE m.book_id = $1 ORDER BY (m.role = 'owner') DESC, m.added_at`, [req.book.id]);
      res.json({ role: req.role, members: r.rows.map(x => ({ email: x.email, role: x.role, addedAt: x.added_at, name: x.name, picture: x.picture })) });
    } catch (err) {
      console.error('bonus members error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/bonus/:book/members', bonusAuth, bookAccess, ownerOnly, async (req, res) => {
    const email = lc(req.body && req.body.email);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不对' });
    try {
      await pool.query(
        `INSERT INTO bonus_members (book_id, email, role) VALUES ($1, $2, 'editor')
         ON CONFLICT (book_id, email) DO NOTHING`, [req.book.id, email]);
      await pool.query(
        `INSERT INTO bonus_log (book_id, email, name, rec_id, action, changes) VALUES ($1, $2, $3, 'member', 'invite', $4::jsonb)`,
        [req.book.id, req.email, req.user.name || req.email, JSON.stringify({ email: [null, email] })]);
      res.json({ ok: true });
    } catch (err) {
      console.error('bonus invite error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.delete('/api/bonus/:book/members/:email', bonusAuth, bookAccess, ownerOnly, async (req, res) => {
    const email = lc(req.params.email);
    try {
      const r = await pool.query(
        `DELETE FROM bonus_members WHERE book_id = $1 AND email = $2 AND role <> 'owner'`, [req.book.id, email]);
      if (r.rowCount) {
        await pool.query(
          `INSERT INTO bonus_log (book_id, email, name, rec_id, action, changes) VALUES ($1, $2, $3, 'member', 'remove', $4::jsonb)`,
          [req.book.id, req.email, req.user.name || req.email, JSON.stringify({ email: [email, null] })]);
      }
      res.json({ ok: true, removed: r.rowCount });
    } catch (err) {
      console.error('bonus remove member error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return {
    // used by /api/auth/google: may a non-ALLOWED_EMAILS account sign in (bonus-only)?
    async isMember(email) {
      try {
        const r = await pool.query('SELECT 1 FROM bonus_members WHERE email = $1 LIMIT 1', [lc(email)]);
        return r.rows.length > 0;
      } catch { return false; }
    }
  };
};
