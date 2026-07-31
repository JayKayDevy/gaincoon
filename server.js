require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-prod";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Database ──────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FEELINGS = ["too_light", "comfortable", "too_heavy"];

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        onboarding_status VARCHAR(20) NOT NULL DEFAULT 'not_started',
        onboarding_step INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS workout_days (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        weekday VARCHAR(3) NOT NULL,
        name VARCHAR(100),
        order_index INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS exercises (
        id SERIAL PRIMARY KEY,
        workout_day_id INTEGER REFERENCES workout_days(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        order_index INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS workout_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        workout_day_id INTEGER REFERENCES workout_days(id) ON DELETE CASCADE,
        started_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS set_logs (
        id SERIAL PRIMARY KEY,
        session_id INTEGER REFERENCES workout_sessions(id) ON DELETE CASCADE,
        exercise_id INTEGER REFERENCES exercises(id) ON DELETE CASCADE,
        set_number INTEGER NOT NULL,
        weight DECIMAL(6,2) NOT NULL,
        reps INTEGER,
        feeling VARCHAR(20),
        logged_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`DROP TABLE IF EXISTS exercise_logs CASCADE;`);
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_status VARCHAR(20) NOT NULL DEFAULT 'not_started';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_step INTEGER NOT NULL DEFAULT 0;
    `);
  } finally {
    client.release();
  }
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "90d" });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Nicht angemeldet" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Ungültiges Token" });
  }
}

// ── Auth routes ───────────────────────────────────────────────────────────────

app.post("/api/register", async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, E-Mail und Passwort erforderlich" });
  }
  try {
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)
       RETURNING id, name, email, onboarding_status, onboarding_step`,
      [name, email, password_hash]
    );
    const user = result.rows[0];
    res.status(201).json({ user, token: signToken(user) });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "E-Mail bereits registriert" });
    }
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "E-Mail und Passwort erforderlich" });
  }
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "E-Mail oder Passwort falsch" });
    }
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        onboarding_status: user.onboarding_status,
        onboarding_step: user.onboarding_step,
      },
      token: signToken(user),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.get("/api/me", requireAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT id, name, email, onboarding_status, onboarding_step FROM users WHERE id = $1",
    [req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Nutzer nicht gefunden" });
  res.json({ user: result.rows[0] });
});

// ── Onboarding ────────────────────────────────────────────────────────────────

app.get("/api/onboarding", requireAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT onboarding_status, onboarding_step FROM users WHERE id = $1",
    [req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Nutzer nicht gefunden" });
  res.json(result.rows[0]);
});

app.patch("/api/onboarding", requireAuth, async (req, res) => {
  const { step, completed } = req.body || {};
  if (!Number.isInteger(step) || step < 0) {
    return res.status(400).json({ error: "step muss eine nicht-negative Ganzzahl sein" });
  }
  const status = completed ? "completed" : "in_progress";
  const result = await pool.query(
    `UPDATE users SET onboarding_status = $1, onboarding_step = $2
     WHERE id = $3 RETURNING onboarding_status, onboarding_step`,
    [status, step, req.user.id]
  );
  res.json(result.rows[0]);
});

// ── Workout days & exercises ─────────────────────────────────────────────────

app.get("/api/workout-days", requireAuth, async (req, res) => {
  const days = await pool.query(
    `SELECT * FROM workout_days WHERE user_id = $1 ORDER BY order_index, id`,
    [req.user.id]
  );
  const exercises = await pool.query(
    `SELECT e.* FROM exercises e
     JOIN workout_days d ON d.id = e.workout_day_id
     WHERE d.user_id = $1 ORDER BY e.order_index, e.id`,
    [req.user.id]
  );
  const byDay = {};
  for (const ex of exercises.rows) {
    (byDay[ex.workout_day_id] ??= []).push(ex);
  }
  res.json(days.rows.map((d) => ({ ...d, exercises: byDay[d.id] || [] })));
});

app.post("/api/workout-days", requireAuth, async (req, res) => {
  const { weekday, name, order_index } = req.body || {};
  if (!WEEKDAYS.includes(weekday)) {
    return res.status(400).json({ error: `weekday muss einer von ${WEEKDAYS.join(", ")} sein` });
  }
  const result = await pool.query(
    `INSERT INTO workout_days (user_id, weekday, name, order_index) VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.user.id, weekday, name || null, order_index || 0]
  );
  res.status(201).json(result.rows[0]);
});

app.delete("/api/workout-days/:id", requireAuth, async (req, res) => {
  await pool.query(`DELETE FROM workout_days WHERE id = $1 AND user_id = $2`, [
    req.params.id,
    req.user.id,
  ]);
  res.status(204).end();
});

app.post("/api/workout-days/:id/exercises", requireAuth, async (req, res) => {
  const { name, order_index } = req.body || {};
  if (!name) return res.status(400).json({ error: "name erforderlich" });
  const day = await pool.query(`SELECT id FROM workout_days WHERE id = $1 AND user_id = $2`, [
    req.params.id,
    req.user.id,
  ]);
  if (!day.rows[0]) return res.status(404).json({ error: "Trainingstag nicht gefunden" });
  const result = await pool.query(
    `INSERT INTO exercises (workout_day_id, name, order_index) VALUES ($1, $2, $3) RETURNING *`,
    [req.params.id, name, order_index || 0]
  );
  res.status(201).json(result.rows[0]);
});

app.delete("/api/exercises/:id", requireAuth, async (req, res) => {
  await pool.query(
    `DELETE FROM exercises e USING workout_days d
     WHERE e.workout_day_id = d.id AND e.id = $1 AND d.user_id = $2`,
    [req.params.id, req.user.id]
  );
  res.status(204).end();
});

// ── Preset (letztes Gewicht je Satzposition) ─────────────────────────────────

app.get("/api/exercises/:id/preset", requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT DISTINCT ON (sl.set_number) sl.set_number, sl.weight, sl.reps, sl.feeling
     FROM set_logs sl
     JOIN workout_sessions ws ON ws.id = sl.session_id
     JOIN exercises e ON e.id = sl.exercise_id
     JOIN workout_days d ON d.id = e.workout_day_id
     WHERE sl.exercise_id = $1 AND d.user_id = $2
     ORDER BY sl.set_number, sl.logged_at DESC`,
    [req.params.id, req.user.id]
  );
  res.json(result.rows);
});

// ── Trainings-Sessions (Ausführung eines Trainingstags) ──────────────────────

app.post("/api/workout-days/:id/sessions", requireAuth, async (req, res) => {
  const day = await pool.query(
    `SELECT * FROM workout_days WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!day.rows[0]) return res.status(404).json({ error: "Trainingstag nicht gefunden" });

  const exercises = await pool.query(
    `SELECT * FROM exercises WHERE workout_day_id = $1 ORDER BY order_index, id`,
    [req.params.id]
  );

  const session = await pool.query(
    `INSERT INTO workout_sessions (user_id, workout_day_id) VALUES ($1, $2) RETURNING *`,
    [req.user.id, req.params.id]
  );

  res.status(201).json({ session: session.rows[0], day: day.rows[0], exercises: exercises.rows });
});

app.patch("/api/sessions/:id/complete", requireAuth, async (req, res) => {
  const result = await pool.query(
    `UPDATE workout_sessions SET completed_at = NOW()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Session nicht gefunden" });
  res.json(result.rows[0]);
});

app.post("/api/sessions/:id/sets", requireAuth, async (req, res) => {
  const { exercise_id, set_number, weight, reps, feeling } = req.body || {};
  if (!exercise_id || !set_number || weight === undefined || weight === null) {
    return res.status(400).json({ error: "exercise_id, set_number und weight erforderlich" });
  }
  if (feeling && !FEELINGS.includes(feeling)) {
    return res.status(400).json({ error: `feeling muss einer von ${FEELINGS.join(", ")} sein` });
  }
  const session = await pool.query(
    `SELECT id FROM workout_sessions WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!session.rows[0]) return res.status(404).json({ error: "Session nicht gefunden" });

  const result = await pool.query(
    `INSERT INTO set_logs (session_id, exercise_id, set_number, weight, reps, feeling)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [req.params.id, exercise_id, set_number, weight, reps || null, feeling || null]
  );
  res.status(201).json(result.rows[0]);
});

app.delete("/api/sets/:id", requireAuth, async (req, res) => {
  await pool.query(
    `DELETE FROM set_logs sl USING workout_sessions ws
     WHERE sl.session_id = ws.id AND sl.id = $1 AND ws.user_id = $2`,
    [req.params.id, req.user.id]
  );
  res.status(204).end();
});

// ── Health & boot ─────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => res.json({ ok: true }));

initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Gaincoon läuft auf Port ${PORT}`));
  })
  .catch((err) => {
    console.error("DB-Init fehlgeschlagen:", err);
    process.exit(1);
  });
