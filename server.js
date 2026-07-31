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

      CREATE TABLE IF NOT EXISTS exercise_logs (
        id SERIAL PRIMARY KEY,
        exercise_id INTEGER REFERENCES exercises(id) ON DELETE CASCADE,
        weight DECIMAL(6,2) NOT NULL,
        reps INTEGER,
        sets INTEGER,
        feeling VARCHAR(20),
        logged_at TIMESTAMP DEFAULT NOW()
      );
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
       RETURNING id, name, email`,
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
      user: { id: user.id, name: user.name, email: user.email },
      token: signToken(user),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.get("/api/me", requireAuth, async (req, res) => {
  const result = await pool.query("SELECT id, name, email FROM users WHERE id = $1", [req.user.id]);
  if (!result.rows[0]) return res.status(404).json({ error: "Nutzer nicht gefunden" });
  res.json({ user: result.rows[0] });
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

// ── Exercise logs (Gewicht + Gefühl je Einheit) ──────────────────────────────

app.get("/api/exercises/:id/last-log", requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT l.* FROM exercise_logs l
     JOIN exercises e ON e.id = l.exercise_id
     JOIN workout_days d ON d.id = e.workout_day_id
     WHERE l.exercise_id = $1 AND d.user_id = $2
     ORDER BY l.logged_at DESC LIMIT 1`,
    [req.params.id, req.user.id]
  );
  res.json(result.rows[0] || null);
});

app.get("/api/exercises/:id/logs", requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT l.* FROM exercise_logs l
     JOIN exercises e ON e.id = l.exercise_id
     JOIN workout_days d ON d.id = e.workout_day_id
     WHERE l.exercise_id = $1 AND d.user_id = $2
     ORDER BY l.logged_at DESC`,
    [req.params.id, req.user.id]
  );
  res.json(result.rows);
});

app.post("/api/exercises/:id/logs", requireAuth, async (req, res) => {
  const { weight, reps, sets, feeling } = req.body || {};
  if (weight === undefined || weight === null) {
    return res.status(400).json({ error: "weight erforderlich" });
  }
  if (feeling && !FEELINGS.includes(feeling)) {
    return res.status(400).json({ error: `feeling muss einer von ${FEELINGS.join(", ")} sein` });
  }
  const owned = await pool.query(
    `SELECT e.id FROM exercises e
     JOIN workout_days d ON d.id = e.workout_day_id
     WHERE e.id = $1 AND d.user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!owned.rows[0]) return res.status(404).json({ error: "Übung nicht gefunden" });
  const result = await pool.query(
    `INSERT INTO exercise_logs (exercise_id, weight, reps, sets, feeling)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.params.id, weight, reps || null, sets || null, feeling || null]
  );
  res.status(201).json(result.rows[0]);
});

// ── Health & boot ─────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => res.json({ ok: true }));

initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Gym Buddy läuft auf Port ${PORT}`));
  })
  .catch((err) => {
    console.error("DB-Init fehlgeschlagen:", err);
    process.exit(1);
  });
