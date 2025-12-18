// ======================================
// USAFFE BACKEND - FULL server.js
// ======================================
//
// Requirements (install with npm):
//   npm install express cors sqlite3 axios
//
// Then run:
//   node server.js
//
// The API base URL you’ve been using from frontend:
//   https://usafe-backend.onrender.com  (on Render)
//

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 4000;

// =============================
// MIDDLEWARE
// =============================
app.use(cors({
  origin: [
    "https://usaffe-frontend.pages.dev",
    "https://2904a8a8.usaffe-frontend.pages.dev",
    "http://localhost:3000"
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

// =============================
// DATABASE INITIALIZATION
// =============================
const db = new sqlite3.Database('./usafe.db');

db.serialize(() => {
  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roblox_id TEXT UNIQUE,
      username TEXT,
      display_name TEXT,
      rank TEXT,
      combat_points INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Medals table
  db.run(`
    CREATE TABLE IF NOT EXISTS medals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_roblox_id TEXT,
      medal_id INTEGER,
      medal_name TEXT,
      reason TEXT,
      date TEXT DEFAULT (datetime('now')),
      awarded_by_roblox_id TEXT
    )
  `);

  // Trainings table
  db.run(`
    CREATE TABLE IF NOT EXISTS trainings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      date TEXT,
      host_id TEXT
    )
  `);

  // Training attendees
  db.run(`
    CREATE TABLE IF NOT EXISTS training_attendees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      training_id INTEGER,
      attendee_roblox_id TEXT
    )
  `);

  // Admin keys table (12-hour keys)
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE,
      created_at TEXT,
      expires_at TEXT,
      used INTEGER DEFAULT 0
    )
  `);
});

// =============================
// BASIC HELPERS
// =============================

function getUserByIdOrRobloxId(idOrRobloxId, cb) {
  // If it’s all digits and relatively long, treat as roblox_id; otherwise allow both
  db.get(
    `
    SELECT *
    FROM users
    WHERE roblox_id = ?
       OR id = ?
  `,
    [idOrRobloxId, idOrRobloxId],
    cb
  );
}

function ensureUserByRobloxProfile(robloxId, username, displayName, cb) {
  db.get(
    `SELECT * FROM users WHERE roblox_id = ?`,
    [robloxId],
    (err, row) => {
      if (err) return cb(err);

      if (row) return cb(null, row);

      db.run(
        `
        INSERT INTO users (roblox_id, username, display_name, rank, combat_points)
        VALUES (?, ?, ?, ?, ?)
      `,
        [robloxId, username || '', displayName || '', 'Unassigned', 0],
        function (insertErr) {
          if (insertErr) return cb(insertErr);
          db.get(
            `SELECT * FROM users WHERE id = ?`,
            [this.lastID],
            cb
          );
        }
      );
    }
  );
}

// =============================
// AVATAR PROXY
// =============================
// GET /api/avatar/:robloxId
app.get('/api/avatar/:robloxId', async (req, res) => {
  const { robloxId } = req.params;
  try {
    // Roblox avatar thumbnail API
    const resp = await axios.get(
      'https://thumbnails.roblox.com/v1/users/avatar-headshot',
      {
        params: {
          userIds: robloxId,
          size: '150x150',
          format: 'Png',
          isCircular: 'true'
        }
      }
    );

    const data = resp.data;
    const imageUrl =
      data &&
      data.data &&
      data.data[0] &&
      data.data[0].imageUrl
        ? data.data[0].imageUrl
        : null;

    if (!imageUrl) {
      return res.json({ imageUrl: null });
    }

    res.json({ imageUrl });
  } catch (err) {
    console.error('Avatar proxy error:', err.message);
    res.json({ imageUrl: null });
  }
});

// =============================
// USER ROUTES
// =============================

// GET /api/users/:idOrRobloxId
app.get('/api/users/:idOrRobloxId', (req, res) => {
  const { idOrRobloxId } = req.params;
  getUserByIdOrRobloxId(idOrRobloxId, (err, user) => {
    if (err) {
      console.error('User lookup error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Fetch medals and trainings for this user
    db.all(
      `SELECT * FROM medals WHERE user_roblox_id = ? ORDER BY date DESC`,
      [user.roblox_id],
      (mErr, medals) => {
        if (mErr) {
          console.error('Medals lookup error:', mErr);
          return res.status(500).json({ error: 'Database error' });
        }

        db.all(
          `
          SELECT t.*
          FROM trainings t
          JOIN training_attendees a ON a.training_id = t.id
          WHERE a.attendee_roblox_id = ?
          ORDER BY t.date DESC
        `,
          [user.roblox_id],
          (tErr, trainings) => {
            if (tErr) {
              console.error('Trainings lookup error:', tErr);
              return res.status(500).json({ error: 'Database error' });
            }

            res.json({
              ...user,
              medals,
              trainings
            });
          }
        );
      }
    );
  });
});

// POST /api/users/:idOrRobloxId/adjust
// Body: { combatDelta }
app.post('/api/users/:idOrRobloxId/adjust', (req, res) => {
  const { idOrRobloxId } = req.params;
  const { combatDelta } = req.body;

  if (typeof combatDelta !== 'number') {
    return res.status(400).json({ error: 'combatDelta must be a number' });
  }

  getUserByIdOrRobloxId(idOrRobloxId, (err, user) => {
    if (err) {
      console.error('User lookup error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const newCombat = (user.combat_points || 0) + combatDelta;
    db.run(
      `UPDATE users SET combat_points = ? WHERE id = ?`,
      [newCombat, user.id],
      (uErr) => {
        if (uErr) {
          console.error('Combat update error:', uErr);
          return res.status(500).json({ error: 'Database error' });
        }
        res.json({ success: true, new_combat_points: newCombat });
      }
    );
  });
});

// POST /api/users/:idOrRobloxId/promote
// Body: { newRank }
app.post('/api/users/:idOrRobloxId/promote', (req, res) => {
  const { idOrRobloxId } = req.params;
  const { newRank } = req.body;

  if (!newRank) {
    return res.status(400).json({ error: 'newRank is required' });
  }

  getUserByIdOrRobloxId(idOrRobloxId, (err, user) => {
    if (err) {
      console.error('User lookup error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    db.run(
      `UPDATE users SET rank = ? WHERE id = ?`,
      [newRank, user.id],
      (uErr) => {
        if (uErr) {
          console.error('Rank update error:', uErr);
          return res.status(500).json({ error: 'Database error' });
        }
        res.json({ success: true, rank: newRank });
      }
    );
  });
});

// =============================
// TRAININGS
// =============================

// POST /api/trainings/create
// Body: { type, date, host_id }
app.post('/api/trainings/create', (req, res) => {
  const { type, date, host_id } = req.body;

  if (!type || !date || !host_id) {
    return res.status(400).json({ error: 'type, date, and host_id are required' });
  }

  db.run(
    `
    INSERT INTO trainings (type, date, host_id)
    VALUES (?, ?, ?)
  `,
    [type, date, host_id],
    function (err) {
      if (err) {
        console.error('Training create error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({
        training_id: this.lastID,
        type,
        date,
        host_id
      });
    }
  );
});

// POST /api/trainings/:trainingId/attendees
// Body: { attendees: [ "robloxId1", "robloxId2", ... ] }
app.post('/api/trainings/:trainingId/attendees', (req, res) => {
  const { trainingId } = req.params;
  const { attendees } = req.body;

  if (!Array.isArray(attendees) || attendees.length === 0) {
    return res.status(400).json({ error: 'attendees must be a non-empty array' });
  }

  db.get(`SELECT * FROM trainings WHERE id = ?`, [trainingId], (err, tRow) => {
    if (err) {
      console.error('Training lookup error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    if (!tRow) {
      return res.status(404).json({ error: 'Training not found' });
    }

    const stmt = db.prepare(`
      INSERT INTO training_attendees (training_id, attendee_roblox_id)
      VALUES (?, ?)
    `);

    attendees.forEach(a => {
      stmt.run([trainingId, a]);
    });

    stmt.finalize((fErr) => {
      if (fErr) {
        console.error('Attendee insert error:', fErr);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ success: true });
    });
  });
});

// =============================
// MEDALS
// =============================

// POST /api/medals/award
// Body: { medal_id, user_roblox_id, awarded_by_roblox_id, reason }
app.post('/api/medals/award', (req, res) => {
  const { medal_id, user_roblox_id, awarded_by_roblox_id, reason } = req.body;

  if (!medal_id || !user_roblox_id || !awarded_by_roblox_id || !reason) {
    return res
      .status(400)
      .json({ error: 'medal_id, user_roblox_id, awarded_by_roblox_id, and reason are required' });
  }

  // For now we just store medal_id as given and a generic name based on ID
  const medalName = `Medal #${medal_id}`;

  db.run(
    `
    INSERT INTO medals (user_roblox_id, medal_id, medal_name, reason, awarded_by_roblox_id)
    VALUES (?, ?, ?, ?, ?)
  `,
    [user_roblox_id, medal_id, medalName, reason, awarded_by_roblox_id],
    function (err) {
      if (err) {
        console.error('Medal award error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ success: true, medal_record_id: this.lastID });
    }
  );
});

// =============================
// COMMAND STATS
// =============================

// GET /api/admin/stats
app.get('/api/admin/stats', (req, res) => {
  const stats = {
    active_personnel: 0,
    trainings_today: 0,
    medals_awarded: 0
  };

  // active_personnel = count of users
  db.get(`SELECT COUNT(*) as cnt FROM users`, (err, row) => {
    if (!err && row) stats.active_personnel = row.cnt || 0;

    // trainings_today
    db.get(
      `
      SELECT COUNT(*) as cnt
      FROM trainings
      WHERE DATE(date) = DATE('now')
    `,
      (tErr, tRow) => {
        if (!tErr && tRow) stats.trainings_today = tRow.cnt || 0;

        // medals_awarded (total)
        db.get(
          `SELECT COUNT(*) as cnt FROM medals`,
          (mErr, mRow) => {
            if (!mErr && mRow) stats.medals_awarded = mRow.cnt || 0;
            res.json(stats);
          }
        );
      }
    );
  });
});

// =============================
// ADMIN KEY + SESSION SYSTEM
// =============================

const { randomUUID } = require('crypto');
const ADMIN_SESSIONS = new Map(); // token -> { key, createdAt }

// POST /api/admin-keys/create
// Generates a new 12-hour key
app.post('/api/admin-keys/create', (req, res) => {
  const key = randomUUID(); // e.g. 6b29c8ee-9d53-4a52-b797-1f8ccbf78076

  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();

  db.run(
    `
    INSERT INTO admin_keys (key, created_at, expires_at)
    VALUES (?, ?, ?)
  `,
    [key, createdAt, expiresAt],
    function (err) {
      if (err) {
        console.error('Failed to create admin key:', err);
        return res.status(500).json({ error: 'Failed to create admin key' });
      }
      res.json({ key, expires_at: expiresAt });
    }
  );
});

// POST /api/admin/login
// Body: { key }  -> returns { token }
app.post('/api/admin/login', (req, res) => {
  const { key } = req.body;

  if (!key) {
    return res.status(400).json({ error: 'Key is required' });
  }

  db.get(
    `SELECT * FROM admin_keys WHERE key = ?`,
    [key],
    (err, row) => {
      if (err) {
        console.error('Admin key lookup failed:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (!row) {
        return res.status(401).json({ error: 'Invalid key' });
      }

      const now = new Date();
      if (new Date(row.expires_at) < now) {
        return res.status(401).json({ error: 'Key expired' });
      }

      // single-use behaviour; if you want multiple uses, you can remove this block
      if (row.used) {
        return res.status(401).json({ error: 'Key already used' });
      }

      db.run(`UPDATE admin_keys SET used = 1 WHERE id = ?`, [row.id]);

      const token = randomUUID();
      ADMIN_SESSIONS.set(token, {
        key,
        createdAt: now.toISOString()
      });

      res.json({ token });
    }
  );
});

// Middleware: require admin session
function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ error: 'Admin token required' });
  }

  const session = ADMIN_SESSIONS.get(token);
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired admin session' });
  }

  // Optional: enforce session max lifetime if you want:
  // const createdAt = new Date(session.createdAt);
  // if (Date.now() - createdAt.getTime() > 12 * 60 * 60 * 1000) { ... }

  next();
}

// Example admin-only route: list all users
app.get('/api/admin/users', requireAdmin, (req, res) => {
  db.all(`SELECT * FROM users`, (err, rows) => {
    if (err) {
      console.error('Admin users list error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(rows);
  });
});

// Example admin-only route: fetch all admin keys
app.get('/api/admin/keys', requireAdmin, (req, res) => {
  db.all(
    `SELECT id, key, created_at, expires_at, used FROM admin_keys ORDER BY created_at DESC`,
    (err, rows) => {
      if (err) {
        console.error('Admin keys list error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json(rows);
    }
  );
});

// =============================
// START SERVER
// =============================
app.listen(PORT, () => {
  console.log(`USAFFE backend listening on port ${PORT}`);
});
