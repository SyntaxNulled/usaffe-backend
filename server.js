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
//   https://usafe-staff-portal.onrender.com  (on Render)
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
app.get('/api/avatar/:robloxId', async (req, res) => {
  const { robloxId } = req.params;
  try {
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

app.get('/api/users/:idOrRobloxId', (req, res) => {
  const { idOrRobloxId } = req.params;
  getUserByIdOrRobloxId(idOrRobloxId, (err, user) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.all(
      `SELECT * FROM medals WHERE user_roblox_id = ? ORDER BY date DESC`,
      [user.roblox_id],
      (mErr, medals) => {
        if (mErr) return res.status(500).json({ error: 'Database error' });

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
            if (tErr) return res.status(500).json({ error: 'Database error' });

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

app.post('/api/users/:idOrRobloxId/adjust', (req, res) => {
  const { idOrRobloxId } = req.params;
  const { combatDelta } = req.body;

  if (typeof combatDelta !== 'number') {
    return res.status(400).json({ error: 'combatDelta must be a number' });
  }

  getUserByIdOrRobloxId(idOrRobloxId, (err, user) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newCombat = (user.combat_points || 0) + combatDelta;
    db.run(
      `UPDATE users SET combat_points = ? WHERE id = ?`,
      [newCombat, user.id],
      (uErr) => {
        if (uErr) return res.status(500).json({ error: 'Database error' });
        res.json({ success: true, new_combat_points: newCombat });
      }
    );
  });
});

app.post('/api/users/:idOrRobloxId/promote', (req, res) => {
  const { idOrRobloxId } = req.params;
  const { newRank } = req.body;

  if (!newRank) {
    return res.status(400).json({ error: 'newRank is required' });
  }

  getUserByIdOrRobloxId(idOrRobloxId, (err, user) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.run(
      `UPDATE users SET rank = ? WHERE id = ?`,
      [newRank, user.id],
      (uErr) => {
        if (uErr) return res.status(500).json({ error: 'Database error' });
        res.json({ success: true, rank: newRank });
      }
    );
  });
});

// =============================
// TRAININGS
// =============================

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
      if (err) return res.status(500).json({ error: 'Database error' });

      res.json({
        training_id: this.lastID,
        type,
        date,
        host_id
      });
    }
  );
});

app.post('/api/trainings/:trainingId/attendees', (req, res) => {
  const { trainingId } = req.params;
  const { attendees } = req.body;

  if (!Array.isArray(attendees) || attendees.length === 0) {
    return res.status(400).json({ error: 'attendees must be a non-empty array' });
  }

  db.get(`SELECT * FROM trainings WHERE id = ?`, [trainingId], (err, tRow) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!tRow) return res.status(404).json({ error: 'Training not found' });

    const stmt = db.prepare(`
      INSERT INTO training_attendees (training_id, attendee_roblox_id)
      VALUES (?, ?)
    `);

    attendees.forEach(a => {
      stmt.run([trainingId, a]);
    });

    stmt.finalize((fErr) => {
      if (fErr) return res.status(500).json({ error: 'Database error' });
      res.json({ success: true });
    });
  });
});

// =============================
// MEDALS
// =============================

app.post('/api/medals/award', (req, res) => {
  const { medal_id, user_roblox_id, awarded_by_roblox_id, reason } = req.body;

  if (!medal_id || !user_roblox_id || !awarded_by_roblox_id || !reason) {
    return res.status(400).json({ error: 'medal_id, user_roblox_id, awarded_by_roblox_id, and reason are required' });
  }

  const medalName = `Medal #${medal_id}`;

  db.run(
    `
    INSERT INTO medals (user_roblox_id, medal_id, medal_name, reason, awarded_by_roblox_id)
    VALUES (?, ?, ?, ?, ?)
  `,
    [user_roblox_id, medal_id, medalName, reason, awarded_by_roblox_id],
    function (err) {
      if (err) return res.status(500).json({ error: 'Database error' });

      res.json({ success: true, medal_record_id: this.lastID });
    }
  );
});

// =============================
// COMMAND STATS
// =============================

app.get('/api/admin/stats', (req, res) => {
  const stats = {
    active_personnel: 0,
    trainings_today: 0,
    medals_awarded: 0
  };

  db.get(`SELECT COUNT(*) as cnt FROM users`, (err, row) => {
    if (!err && row) stats.active_personnel = row.cnt || 0;

    db.get(
      `
      SELECT COUNT(*) as cnt
      FROM trainings
      WHERE DATE(date) = DATE('now')
    `,
      (tErr, tRow) => {
        if (!tErr && tRow) stats.trainings_today = tRow.cnt || 0;

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
const ADMIN_SESSIONS = new Map();

app.post('/api/admin-keys/create', (req, res) => {
  const key = randomUUID();

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
      if (err) return res.status(500).json({ error: 'Failed to create admin key' });

      res.json({ key, expires_at: expiresAt });
    }
  );
});

app.post('/api/admin/login', (req, res) => {
  const { key } = req.body;

  if (!key) {
    return res.status(400).json({ error: 'Key is required' });
  }

  db.get(
    `SELECT * FROM admin_keys WHERE key = ?`,
    [key],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'Database error' });

      if (!row) return res.status(401).json({ error: 'Invalid key' });

      const now = new Date();
      if (new Date(row.expires_at) < now) {
        return res.status(401).json({ error: 'Key expired' });
      }

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

  next();
}

app.get('/api/admin/users', requireAdmin, (req, res) => {
  db.all(`SELECT * FROM users`, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows);
  });
});

app.get('/api/admin/keys', requireAdmin, (req, res) => {
  db.all(
    `SELECT id, key, created_at, expires_at, used FROM admin_keys ORDER BY created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json(rows);
    }
  );
});

// =============================
// ROBLOX VERIFICATION SYSTEM
// =============================

// Create verification_codes table
db.run(`
  CREATE TABLE IF NOT EXISTS verification_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roblox_id INTEGER,
    code TEXT,
    created_at TEXT
  )
`);

// Helper: generate a new verification code
function generateVerificationCode() {
  return "USAFE-" + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Helper: check if code is expired (10 minutes)
function isExpired(timestamp) {
  const created = new Date(timestamp);
  const now = new Date();
  const diffMs = now - created;
  const diffMinutes = diffMs / 1000 / 60;
  return diffMinutes > 10;
}

// ---------------------------------------------
// POST /api/roblox/lookup
// Looks up a Roblox user by username
// ---------------------------------------------
app.post('/api/roblox/lookup', async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }

  try {
    const response = await axios.post(
      "https://users.roblox.com/v1/usernames/users",
      {
        usernames: [username],
        excludeBannedUsers: false
      }
    );

    const user = response.data?.data?.[0];

    if (!user) {
      return res.status(404).json({ error: "Roblox user not found" });
    }

    res.json({
      roblox_id: user.id,
      username: user.name,
      display_name: user.displayName
    });

  } catch (err) {
    console.error("Roblox lookup failed:", err.message);
    res.status(500).json({ error: "Roblox lookup failed" });
  }
});

// ---------------------------------------------
// POST /api/roblox/start-verification
// Generates and stores a verification code
// ---------------------------------------------
app.post('/api/roblox/start-verification', (req, res) => {
  const { roblox_id } = req.body;

  if (!roblox_id) {
    return res.status(400).json({ error: "roblox_id is required" });
  }

  const code = generateVerificationCode();
  const createdAt = new Date().toISOString();

  db.run(
    `
      INSERT INTO verification_codes (roblox_id, code, created_at)
      VALUES (?, ?, ?)
    `,
    [roblox_id, code, createdAt],
    (err) => {
      if (err) {
        console.error("Failed to store verification code:", err);
        return res.status(500).json({ error: "Failed to start verification" });
      }

      res.json({ code });
    }
  );
});

// ---------------------------------------------
// POST /api/roblox/check
// Confirms the code exists in the user's bio
// ---------------------------------------------
app.post('/api/roblox/check', async (req, res) => {
  const { roblox_id } = req.body;

  if (!roblox_id) {
    return res.status(400).json({ error: "roblox_id is required" });
  }

  db.get(
    `
      SELECT * FROM verification_codes
      WHERE roblox_id = ?
      ORDER BY id DESC
      LIMIT 1
    `,
    [roblox_id],
    async (err, row) => {
      if (err) {
        console.error("Verification lookup failed:", err);
        return res.status(500).json({ error: "Database error" });
      }

      if (!row) {
        return res.status(400).json({ error: "No verification started" });
      }

      if (isExpired(row.created_at)) {
        return res.status(400).json({ error: "Verification code expired" });
      }

      try {
        const response = await axios.get(
          `https://users.roblox.com/v1/users/${roblox_id}`
        );

        const bio = response.data?.description || "";

        if (!bio.includes(row.code)) {
          return res.status(400).json({ error: "Verification code not found in bio" });
        }

        // Create login token
        const token = crypto.randomUUID();

        res.json({
          token,
          roblox_id,
          username: response.data.name,
          display_name: response.data.displayName
        });

      } catch (err) {
        console.error("Verification check failed:", err.message);
        res.status(500).json({ error: "Verification check failed" });
      }
    }
  );
});

// =============================
// START SERVER
// =============================
app.get('/', (req, res) => {
  res.send('✅ USAFFE backend is running and accepting requests.');
});

app.listen(PORT, () => {
  console.log(`USAFFE backend listening on port ${PORT}`);
});