const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// ===============================
// DATABASE SETUP
// ===============================
const dbPath = path.join(__dirname, 'usafe.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roblox_id TEXT UNIQUE,
      username TEXT,
      display_name TEXT,
      branch TEXT,
      rank TEXT,
      points INTEGER DEFAULT 0,
      valor INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS trainings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      date TEXT,
      host_id INTEGER,
      FOREIGN KEY(host_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS training_attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      training_id INTEGER,
      user_id INTEGER,
      FOREIGN KEY(training_id) REFERENCES trainings(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS medals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      description TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS medal_awards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      medal_id INTEGER,
      user_id INTEGER,
      awarded_by INTEGER,
      date TEXT,
      reason TEXT,
      FOREIGN KEY(medal_id) REFERENCES medals(id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(awarded_by) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS verification_codes (
      roblox_id TEXT PRIMARY KEY,
      code TEXT,
      expires_at TEXT
    )
  `);
});

// ===============================
// BASIC ROUTES
// ===============================
app.get('/', (req, res) => {
  res.json({ message: 'USAFE backend running' });
});

// ===============================
// AVATAR PROXY (Fixes Roblox CORS)
// ===============================
app.get('/api/avatar/:robloxId', async (req, res) => {
  const { robloxId } = req.params;

  const url = `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxId}&size=150x150&format=Png&isCircular=false`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    const imageUrl = data?.data?.[0]?.imageUrl;

    if (!imageUrl) {
      return res.status(404).json({ error: 'Avatar not found' });
    }

    res.json({ imageUrl });
  } catch (err) {
    console.error('Avatar proxy failed:', err);
    res.status(500).json({ error: 'Failed to fetch avatar' });
  }
});

// ===============================
// HELPER: RESOLVE INTERNAL USER ID
// Accepts either internal ID or roblox_id
// ===============================
function resolveInternalUserId(idOrRoblox, callback) {
  db.get(
    `SELECT id FROM users WHERE id = ? OR roblox_id = ?`,
    [idOrRoblox, idOrRoblox.toString()],
    (err, row) => {
      if (err) return callback(err);
      if (!row) return callback(new Error('User not found'));
      callback(null, row.id);
    }
  );
}

// ===============================
// USER PROFILE
// ===============================
app.get('/api/users/:robloxId', (req, res) => {
  const { robloxId } = req.params;

  const sql = `
    SELECT u.*,
      (SELECT json_group_array(json_object(
          'id', ma.id,
          'medal_name', m.name,
          'date', ma.date,
          'reason', ma.reason
        ))
        FROM medal_awards ma
        JOIN medals m ON ma.medal_id = m.id
        WHERE ma.user_id = u.id
      ) AS medals,
      (SELECT json_group_array(json_object(
          'training_id', t.id,
          'type', t.type,
          'date', t.date
        ))
        FROM training_attendance ta
        JOIN trainings t ON ta.training_id = t.id
        WHERE ta.user_id = u.id
      ) AS trainings
    FROM users u
    WHERE u.roblox_id = ?
  `;

  db.get(sql, [robloxId], (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!row) return res.status(404).json({ error: 'User not found' });

    res.json({
      id: row.id,
      roblox_id: row.roblox_id,
      username: row.username,
      display_name: row.display_name,
      branch: row.branch,
      rank: row.rank,
      points: row.points,
      valor: row.valor,
      medals: row.medals ? JSON.parse(row.medals) : [],
      trainings: row.trainings ? JSON.parse(row.trainings) : []
    });
  });
});

// ===============================
// STAFF PANEL ROUTES
// ===============================

// Create training (original)
app.post('/api/trainings', (req, res) => {
  const { type, date, host_id } = req.body;

  db.run(
    `INSERT INTO trainings (type, date, host_id) VALUES (?, ?, ?)`,
    [type, date, host_id],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to create training' });
      res.json({ success: true, training_id: this.lastID });
    }
  );
});

// Create training (alias for frontend compatibility)
app.post('/api/trainings/create', (req, res) => {
  const { type, date, host_id } = req.body;

  db.run(
    `INSERT INTO trainings (type, date, host_id) VALUES (?, ?, ?)`,
    [type, date, host_id],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to create training' });
      res.json({ success: true, training_id: this.lastID });
    }
  );
});

// Add attendees (expects INTERNAL IDs or Roblox IDs; will resolve)
app.post('/api/trainings/:trainingId/attendees', (req, res) => {
  const { trainingId } = req.params;
  const { attendees } = req.body;

  if (!Array.isArray(attendees) || attendees.length === 0) {
    return res.status(400).json({ error: 'Attendees array required' });
  }

  const stmt = db.prepare(
    `INSERT INTO training_attendance (training_id, user_id) VALUES (?, ?)`
  );

  let pending = attendees.length;
  let hadError = false;

  attendees.forEach(rawId => {
    if (!rawId) {
      pending--;
      if (pending === 0 && !hadError) {
        stmt.finalize();
        res.json({ success: true });
      }
      return;
    }

    resolveInternalUserId(rawId, (err, internalId) => {
      if (err) {
        console.warn('Failed to resolve user for training attendee:', rawId);
      } else {
        stmt.run(trainingId, internalId);
      }

      pending--;
      if (pending === 0 && !hadError) {
        stmt.finalize(e => {
          if (e) return res.status(500).json({ error: 'Failed to add attendees' });
          res.json({ success: true });
        });
      }
    });
  });
});

// Award medal
// Accepts:
//  - user_id / awarded_by as INTERNAL IDs
//  OR
//  - user_roblox_id / awarded_by_roblox_id as Roblox IDs
app.post('/api/medals/award', (req, res) => {
  const { medal_id, user_id, awarded_by, user_roblox_id, awarded_by_roblox_id, reason } = req.body;
  const date = new Date().toISOString();

  if (!medal_id || !reason) {
    return res.status(400).json({ error: 'medal_id and reason are required' });
  }

  const userIdSource = user_id || user_roblox_id;
  const awardedBySource = awarded_by || awarded_by_roblox_id;

  if (!userIdSource || !awardedBySource) {
    return res.status(400).json({ error: 'User and awarded_by identifiers are required' });
  }

  resolveInternalUserId(userIdSource, (err, internalUserId) => {
    if (err) return res.status(400).json({ error: 'Target user not found' });

    resolveInternalUserId(awardedBySource, (err2, internalAwardedById) => {
      if (err2) return res.status(400).json({ error: 'Awarding user not found' });

      db.run(
        `INSERT INTO medal_awards (medal_id, user_id, awarded_by, date, reason)
         VALUES (?, ?, ?, ?, ?)`,
        [medal_id, internalUserId, internalAwardedById, date, reason],
        function (err3) {
          if (err3) {
            console.error('Failed to award medal:', err3);
            return res.status(500).json({ error: 'Failed to award medal' });
          }
          res.json({ success: true });
        }
      );
    });
  });
});

// Adjust points / valor
// Path param can be INTERNAL ID or Roblox ID
app.post('/api/users/:userId/adjust', (req, res) => {
  const { userId } = req.params;
  const { pointsDelta = 0, valorDelta = 0 } = req.body;

  resolveInternalUserId(userId, (err, internalId) => {
    if (err) return res.status(400).json({ error: 'User not found' });

    db.run(
      `UPDATE users SET points = points + ?, valor = valor + ? WHERE id = ?`,
      [pointsDelta, valorDelta, internalId],
      function (err2) {
        if (err2) return res.status(500).json({ error: 'Failed to adjust values' });
        res.json({ success: true });
      }
    );
  });
});

// Promote user
// Path param can be INTERNAL ID or Roblox ID
app.post('/api/users/:userId/promote', (req, res) => {
  const { userId } = req.params;
  const { newRank } = req.body;

  if (!newRank) return res.status(400).json({ error: 'newRank is required' });

  resolveInternalUserId(userId, (err, internalId) => {
    if (err) return res.status(400).json({ error: 'User not found' });

    db.run(
      `UPDATE users SET rank = ? WHERE id = ?`,
      [newRank, internalId],
      function (err2) {
        if (err2) return res.status(500).json({ error: 'Failed to promote user' });
        res.json({ success: true });
      }
    );
  });
});

// ===============================
// COMMAND STATUS (for Staff Panel)
// ===============================
app.get('/api/admin/stats', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const status = {};

  db.get(`SELECT COUNT(*) AS count FROM users`, (err, row) => {
    status.active_personnel = row ? row.count : 0;

    db.get(
      `SELECT COUNT(*) AS count FROM trainings WHERE date LIKE ?`,
      [`${today}%`],
      (err2, row2) => {
        status.trainings_today = row2 ? row2.count : 0;

        db.get(`SELECT COUNT(*) AS count FROM medal_awards`, (err3, row3) => {
          status.medals_awarded = row3 ? row3.count : 0;

          res.json(status);
        });
      }
    );
  });
});

// ===============================
// ROBLOX BIO VERIFICATION LOGIN
// ===============================
function generateVerificationCode() {
  return 'USAFE-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 1) Lookup Roblox user
app.post('/api/roblox/lookup', async (req, res) => {
  const { username } = req.body;

  if (!username) return res.status(400).json({ error: 'Username is required' });

  try {
    const response = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usernames: [username],
        excludeBannedUsers: true
      })
    });

    const data = await response.json();

    if (!data.data || !data.data[0]) {
      return res.status(404).json({ error: 'Roblox user not found' });
    }

    const user = data.data[0];

    res.json({
      roblox_id: user.id.toString(),
      username: user.name,
      display_name: user.displayName
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to contact Roblox' });
  }
});

// 2) Start verification
app.post('/api/roblox/start-verification', (req, res) => {
  const { roblox_id } = req.body;

  if (!roblox_id) return res.status(400).json({ error: 'roblox_id is required' });

  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  db.run(
    `
    INSERT INTO verification_codes (roblox_id, code, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(roblox_id) DO UPDATE SET
      code = excluded.code,
      expires_at = excluded.expires_at
  `,
    [roblox_id, code, expiresAt],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to start verification' });

      res.json({ success: true, code });
    }
  );
});

// 3) Check verification
app.post('/api/roblox/check', async (req, res) => {
  const { roblox_id } = req.body;

  if (!roblox_id) return res.status(400).json({ error: 'roblox_id is required' });

  db.get(
    `SELECT code, expires_at FROM verification_codes WHERE roblox_id = ?`,
    [roblox_id],
    async (err, row) => {
      if (err || !row) {
        return res.status(400).json({ error: 'No verification code found' });
      }

      const { code, expires_at } = row;

      if (new Date(expires_at) < new Date()) {
        return res.status(400).json({ error: 'Verification code expired' });
      }

      try {
        const response = await fetch(`https://users.roblox.com/v1/users/${roblox_id}`);
        const userData = await response.json();
        const bio = userData.description || '';

        if (!bio.includes(code)) {
          return res.status(400).json({ error: 'Code not found in Roblox bio' });
        }

        const username = userData.name;
        const display_name = userData.displayName;

        db.run(
          `
          INSERT INTO users (roblox_id, username, display_name)
          VALUES (?, ?, ?)
          ON CONFLICT(roblox_id) DO UPDATE SET
            username = excluded.username,
            display_name = excluded.display_name
        `,
          [roblox_id, username, display_name],
          function () {
            db.run(`DELETE FROM verification_codes WHERE roblox_id = ?`, [roblox_id]);

            const token = `roblox_${roblox_id}_${Date.now()}`;

            res.json({
              success: true,
              token,
              roblox_id,
              username,
              display_name
            });
          }
        );
      } catch (e) {
        res.status(500).json({ error: 'Failed to verify with Roblox' });
      }
    }
  );
});

// ===============================
// START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`USAFE backend running on http://localhost:${PORT}`);
});
