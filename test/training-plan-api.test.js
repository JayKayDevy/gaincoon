// Integrationstests für POST /api/training-plan/generate und GET /api/training-plan.
// Läuft gegen eine echte (Wegwerf-)Postgres, siehe [[project_gaincoon]] Testing-
// Konvention. OpenAI wird vollständig über __setTestAIClient gemockt - kein
// echter, kostenpflichtiger Aufruf. Voraussetzung: DATABASE_URL zeigt auf eine
// laufende Postgres-Instanz mit "localhost" im Connection-String (SSL wird dann
// übersprungen, siehe server.js).
//
// docker run -d -e POSTGRES_PASSWORD=test -e POSTGRES_DB=gaincoon -p 55432:5432 postgres:16-alpine

process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres:test@localhost:55432/gaincoon";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { app, pool, initDB, __setTestAIClient } = require("../server");

let server;
let baseUrl;

before(async () => {
  await initDB();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

beforeEach(() => {
  __setTestAIClient(null);
});

async function api(path, { token, ...options } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

let userCounter = 0;
async function registerUser() {
  userCounter += 1;
  const email = `plan-test-${Date.now()}-${userCounter}@example.com`;
  const { data } = await api("/api/register", {
    method: "POST",
    body: JSON.stringify({ name: "Plan Test", email, password: "password123" }),
  });
  return { token: data.token, userId: data.user.id };
}

const BASE_ONBOARDING_DATA = {
  goal: "general_fitness",
  weekdays: ["mon", "wed", "fri"],
  sessionDurationMinutes: 60,
  location: "gym",
  gymFullyEquipped: "full",
  equipment: ["dumbbells", "barbell", "cable_machine", "bench", "machines"],
  strengthTrainingExperience: "over_2_years",
  hasLimitations: false,
  limitationAreas: [],
  limitationDetails: {},
  hasRecurringSessions: false,
  recurringSessions: [],
};

async function setOnboardingData(token, overrides = {}) {
  await api("/api/onboarding", {
    token,
    method: "PATCH",
    body: JSON.stringify({ step: 11, completed: false, data: { ...BASE_ONBOARDING_DATA, ...overrides } }),
  });
}

function validPlanResponse({ sessions }) {
  return {
    status: "ok",
    conflictReason: null,
    name: "Testplan",
    description: "Ein Testplan.",
    goal: "general_fitness",
    split: "Ganzkörper",
    rationale: "Passt zur Anzahl der Trainingstage.",
    progressionNote: "Double Progression.",
    safetyNote: "Ersetzt keine medizinische Beratung.",
    sessions,
  };
}

function exerciseEntry(exerciseId, overrides = {}) {
  return {
    exerciseId,
    orderIndex: 0,
    workingSets: 3,
    targetType: "repetitions",
    targetMin: 8,
    targetMax: 12,
    restSeconds: 90,
    targetRir: 2,
    note: null,
    ...overrides,
  };
}

function sessionEntry(weekday, exerciseIds, overrides = {}) {
  return {
    weekday,
    orderIndex: 0,
    title: "Ganzkörper",
    focus: "Ganzkörper",
    estimatedDurationMinutes: 45,
    rationale: "Deckt die großen Muskelgruppen ab.",
    exercises: exerciseIds.map((id, i) => exerciseEntry(id, { orderIndex: i })),
    ...overrides,
  };
}

/** Wählt Übungen mit möglichst unterschiedlichen primären Muskelgruppen aus dem
 *  Pool - ein plausibler Ganzkörper-Tag statt zufällig z.B. 4x Brust (die Seed-
 *  Reihenfolge clustert gleiche Kategorien direkt hintereinander). */
function diverseExerciseIds(pool, count) {
  const seenGroups = new Set();
  const picked = [];
  for (const ex of pool) {
    const primary = ex.primaryMuscleGroups[0];
    if (seenGroups.has(primary)) continue;
    seenGroups.add(primary);
    picked.push(ex.exerciseId);
    if (picked.length >= count) break;
  }
  for (const ex of pool) {
    if (picked.length >= count) break;
    if (!picked.includes(ex.exerciseId)) picked.push(ex.exerciseId);
  }
  return picked;
}

/** Baut aus dem tatsächlich an OpenAI übergebenen Pool (voller Objekte, nicht
 *  nur IDs) eine plausible Multi-Muskelgruppen-Session für jeden Wochentag. */
function planFromPool(pool, weekdays) {
  const ids = diverseExerciseIds(pool, Math.min(4, pool.length));
  return validPlanResponse({
    sessions: weekdays.map((wd) => sessionEntry(wd, ids)),
  });
}

function mockAIClient(responseOrFn) {
  let callCount = 0;
  const calls = [];
  return {
    get callCount() {
      return callCount;
    },
    get calls() {
      return calls;
    },
    chat: {
      completions: {
        create: async (args) => {
          callCount += 1;
          calls.push(args);
          const result = typeof responseOrFn === "function" ? await responseOrFn(args, callCount) : responseOrFn;
          if (result instanceof Error) throw result;
          return { choices: [{ message: { content: JSON.stringify(result) } }] };
        },
      },
    },
  };
}

/** Holt den vollen Übungspool, den der Prompt tatsächlich an OpenAI übergeben hat. */
function poolFromLastCall(client) {
  const lastCall = client.calls[client.calls.length - 1];
  const userMsg = lastCall.messages.find((m) => m.role === "user").content;
  const payload = JSON.parse(userMsg.slice(userMsg.indexOf("{")));
  return payload.exercisePool;
}

describe("POST /api/training-plan/generate", () => {
  test("vollständig ausgestattetes Fitnessstudio, Fortgeschrittene, 3 Trainingstage -> Erfolg", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, { weekdays: ["mon", "wed", "fri"] });

    const client = mockAIClient((args) => planFromPool(poolFromLastCall(client), ["mon", "wed", "fri"]));
    __setTestAIClient(client);

    const { status, data } = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-1" }),
    });

    assert.equal(status, 200);
    assert.equal(data.status, "succeeded");
    assert.equal(data.plan.status, "active");
    assert.equal(data.plan.sessions.length, 3);
    assert.equal(client.callCount, 1);

    const me = await api("/api/me", { token });
    assert.equal(me.data.user.onboarding_status, "completed");
  });

  test("eingeschränkte Heimausstattung -> Pool an OpenAI enthält nur passende Übungen", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, {
      location: "home",
      gymFullyEquipped: undefined,
      equipment: ["dumbbells", "bench"],
      weekdays: ["mon", "thu"],
    });

    const client = mockAIClient((args) => planFromPool(poolFromLastCall(client), ["mon", "thu"]));
    __setTestAIClient(client);

    const { status } = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-home" }),
    });
    assert.equal(status, 200);

    const sentPool = JSON.parse(client.calls[0].messages[1].content.slice(client.calls[0].messages[1].content.indexOf("{"))).exercisePool;
    // Klimmzüge (pull_up_bar) darf nicht im Pool sein, Übungen ohne Geräte oder mit dumbbells/bench schon
    assert.ok(!sentPool.some((e) => e.name === "Klimmzüge (Obergriff)"));
    assert.ok(sentPool.some((e) => e.name === "Liegestütz"));
  });

  test("Anfänger -> nur beginner-Übungen im an OpenAI gesendeten Pool", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, { strengthTrainingExperience: "just_starting", weekdays: ["mon", "wed"] });

    const client = mockAIClient((args) => planFromPool(poolFromLastCall(client), ["mon", "wed"]));
    __setTestAIClient(client);

    await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-beginner" }),
    });

    const sentPool = JSON.parse(client.calls[0].messages[1].content.slice(client.calls[0].messages[1].content.indexOf("{"))).exercisePool;
    // Kreuzheben (advanced) darf für Anfänger nicht im Pool sein
    assert.ok(!sentPool.some((e) => e.name.includes("Kreuzheben")));
  });

  test("2 Trainingstage -> Erfolg mit 2 Einheiten", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, { weekdays: ["tue", "fri"] });
    const client = mockAIClient((args) => planFromPool(poolFromLastCall(client), ["tue", "fri"]));
    __setTestAIClient(client);
    const { status, data } = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-2days" }),
    });
    assert.equal(status, 200);
    assert.equal(data.plan.sessions.length, 2);
  });

  test("4 Trainingstage -> Erfolg mit 4 Einheiten", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, { weekdays: ["mon", "tue", "thu", "fri"] });
    const client = mockAIClient((args) => planFromPool(poolFromLastCall(client), ["mon", "tue", "thu", "fri"]));
    __setTestAIClient(client);
    const { status, data } = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-4days" }),
    });
    assert.equal(status, 200);
    assert.equal(data.plan.sessions.length, 4);
  });

  test("mehrere feste Einheiten an einem Tag + hochintensiver Kurs werden korrekt in den Prompt-Kontext übernommen", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, {
      weekdays: ["mon", "wed"],
      hasRecurringSessions: true,
      recurringSessions: [
        { id: "a", name: "BodyAttack", weekday: "mon", category: "endurance", intensity: "high", durationMinutes: 45, time: "18:00" },
        { id: "b", name: "BodyPump", weekday: "mon", category: "strength_endurance", intensity: "medium", durationMinutes: 60, time: "19:00" },
      ],
    });
    const client = mockAIClient((args) => planFromPool(poolFromLastCall(client), ["mon", "wed"]));
    __setTestAIClient(client);
    const { status } = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-fixed" }),
    });
    assert.equal(status, 200);

    const payload = JSON.parse(client.calls[0].messages[1].content.slice(client.calls[0].messages[1].content.indexOf("{")));
    assert.equal(payload.fixedCommitmentsByDay.mon.length, 2);
    assert.equal(payload.fixedCommitmentsByDay.mon[0].name, "BodyAttack");
    assert.equal(payload.fixedCommitmentsByDay.mon[0].intensity, "high");
  });

  test("bevorzugte Übungen werden im Prompt als preferredExerciseIds markiert", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, { weekdays: ["mon"] });

    const catalog = await api("/api/exercise-catalog", { token });
    const pushup = catalog.data.find((e) => e.name === "Liegestütz");
    await api("/api/exercise-preferences", {
      token,
      method: "PUT",
      body: JSON.stringify({ preferences: [{ exerciseId: pushup.id, preference: "preferred" }] }),
    });

    const client = mockAIClient((args) => planFromPool(poolFromLastCall(client), ["mon"]));
    __setTestAIClient(client);
    await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-preferred" }),
    });

    const payload = JSON.parse(client.calls[0].messages[1].content.slice(client.calls[0].messages[1].content.indexOf("{")));
    assert.ok(payload.preferredExerciseIds.includes(pushup.id));
  });

  test("vermiedene Übung taucht nicht im an OpenAI gesendeten Pool auf", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, { weekdays: ["mon"] });

    const catalog = await api("/api/exercise-catalog", { token });
    const pushup = catalog.data.find((e) => e.name === "Liegestütz");
    await api("/api/exercise-preferences", {
      token,
      method: "PUT",
      body: JSON.stringify({ preferences: [{ exerciseId: pushup.id, preference: "avoid" }] }),
    });

    const client = mockAIClient((args) => planFromPool(poolFromLastCall(client), ["mon"]));
    __setTestAIClient(client);
    await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-avoid" }),
    });

    const sentPool = JSON.parse(client.calls[0].messages[1].content.slice(client.calls[0].messages[1].content.indexOf("{"))).exercisePool;
    assert.ok(!sentPool.some((e) => e.exerciseId === pushup.id));
  });

  test("vollständig auszusparender Körperbereich (Knie) -> Kniebeugen etc. nicht im Pool", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, {
      weekdays: ["mon"],
      hasLimitations: true,
      limitationAreas: ["knee"],
      limitationDetails: { knee: { handling: "exclude_area", note: null } },
    });
    const client = mockAIClient((args) => planFromPool(poolFromLastCall(client), ["mon"]));
    __setTestAIClient(client);
    const { status } = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-knee" }),
    });
    assert.equal(status, 200);
    const sentPool = JSON.parse(client.calls[0].messages[1].content.slice(client.calls[0].messages[1].content.indexOf("{"))).exercisePool;
    assert.ok(!sentPool.some((e) => e.primaryMuscleGroups.includes("quads")));
  });

  test("nicht zuverlässig zuordenbarer auszusparender Bereich (other) -> 422 limitation_conflict", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, {
      weekdays: ["mon"],
      hasLimitations: true,
      limitationAreas: ["other"],
      limitationDetails: { other: { handling: "exclude_area", note: "diffus" } },
    });
    __setTestAIClient(mockAIClient(validPlanResponse({ sessions: [] })));
    const { status, data } = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-other" }),
    });
    assert.equal(status, 422);
    assert.equal(data.conflictType, "limitation_conflict");

    const me = await api("/api/me", { token });
    assert.equal(me.data.user.onboarding_status, "in_progress");
  });

  test("mehr feste Einheit-Tage als Trainingstage -> 422 day_conflict, kein Plan gespeichert", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, {
      weekdays: ["mon"],
      hasRecurringSessions: true,
      recurringSessions: [
        { id: "a", name: "A", weekday: "mon", category: "endurance", intensity: "high", durationMinutes: 30 },
        { id: "b", name: "B", weekday: "wed", category: "endurance", intensity: "high", durationMinutes: 30 },
      ],
    });
    const client = mockAIClient(validPlanResponse({ sessions: [] }));
    __setTestAIClient(client);
    const { status, data } = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-dayconflict" }),
    });
    assert.equal(status, 422);
    assert.equal(data.conflictType, "day_conflict");
    assert.equal(client.callCount, 0); // Konflikt wird VOR dem KI-Aufruf erkannt

    const planCheck = await api("/api/training-plan", { token });
    assert.equal(planCheck.status, 404);
  });

  test("kein ausreichend geeigneter Übungspool (alles vermieden) -> 422 pool_conflict", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, { weekdays: ["mon"] });
    const catalog = await api("/api/exercise-catalog", { token });
    await api("/api/exercise-preferences", {
      token,
      method: "PUT",
      body: JSON.stringify({ preferences: catalog.data.map((e) => ({ exerciseId: e.id, preference: "avoid" })) }),
    });
    const client = mockAIClient(validPlanResponse({ sessions: [] }));
    __setTestAIClient(client);
    const { status, data } = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-poolconflict" }),
    });
    assert.equal(status, 422);
    assert.equal(data.conflictType, "pool_conflict");
    assert.equal(client.callCount, 0);
  });

  test("erfundene/unzulässige exerciseId in KI-Antwort -> 502 invalid_ai_output, kein Plan aktiv", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, { weekdays: ["mon"] });
    __setTestAIClient(mockAIClient(validPlanResponse({ sessions: [sessionEntry("mon", [999999999])] })));
    const { status, data } = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-fakeid" }),
    });
    assert.equal(status, 502);
    assert.equal(data.conflictType, "invalid_ai_output");

    const planCheck = await api("/api/training-plan", { token });
    assert.equal(planCheck.status, 404);
    const me = await api("/api/me", { token });
    assert.equal(me.data.user.onboarding_status, "in_progress");
  });

  test("Überschreitung der Trainingsdauer -> 502 invalid_ai_output", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, { weekdays: ["mon"], sessionDurationMinutes: 30 });
    const client = mockAIClient((args) => {
      const ids = poolFromLastCall(client).slice(0, 2).map((e) => e.exerciseId);
      return validPlanResponse({ sessions: [sessionEntry("mon", ids, { estimatedDurationMinutes: 90 })] });
    });
    __setTestAIClient(client);
    const { status, data } = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-toolong" }),
    });
    assert.equal(status, 502);
    assert.equal(data.conflictType, "invalid_ai_output");
  });

  test("Doppelklick: gleicher idempotencyKey liefert denselben Plan, kein zweiter KI-Aufruf", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, { weekdays: ["mon"] });
    const client = mockAIClient((args) => planFromPool(poolFromLastCall(client), ["mon"]));
    __setTestAIClient(client);

    const first = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "same-key" }),
    });
    const second = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "same-key" }),
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.data.plan.id, second.data.plan.id);
    assert.equal(client.callCount, 1);
  });

  test("parallele Requests mit unterschiedlichen Keys: nur einer läuft, der andere bekommt 409", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, { weekdays: ["mon"] });

    let resolveAI;
    const aiGate = new Promise((resolve) => {
      resolveAI = resolve;
    });
    const client = mockAIClient(async (args) => {
      await aiGate;
      return planFromPool(poolFromLastCall(client), ["mon"]);
    });
    __setTestAIClient(client);

    const firstPromise = api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "parallel-a" }),
    });
    // kurz warten, damit der erste Request garantiert zuerst die "pending"-Zeile anlegt
    await new Promise((r) => setTimeout(r, 100));
    const second = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "parallel-b" }),
    });

    assert.equal(second.status, 409);
    assert.equal(second.data.conflictType, "already_in_progress");

    resolveAI();
    const first = await firstPromise;
    assert.equal(first.status, 200);
  });

  test("technischer OpenAI-Fehler -> 502 ai_unavailable, Retry mit neuem Key möglich", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, { weekdays: ["mon"] });
    __setTestAIClient(mockAIClient(new Error("network timeout")));

    const failed = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-fail-1" }),
    });
    assert.equal(failed.status, 502);
    assert.equal(failed.data.conflictType, "ai_unavailable");

    const me = await api("/api/me", { token });
    assert.equal(me.data.user.onboarding_status, "in_progress");

    // Retry mit demselben Key nach Fehler muss erneut versuchen dürfen (nicht für immer blockiert)
    const client = mockAIClient((args) => planFromPool(poolFromLastCall(client), ["mon"]));
    __setTestAIClient(client);
    const retried = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-fail-1" }),
    });
    assert.equal(retried.status, 200);
  });

  test("ungültige strukturierte Ausgabe (kaputtes JSON) -> 502 ai_unavailable", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, { weekdays: ["mon"] });
    __setTestAIClient({
      chat: { completions: { create: async () => ({ choices: [{ message: { content: "{not valid json" } }] }) } },
    });
    const { status, data } = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-badjson" }),
    });
    assert.equal(status, 502);
    assert.equal(data.conflictType, "ai_unavailable");
  });

  test("KI meldet selbst status=conflict -> 422 pool_conflict mit ihrer Begründung", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, { weekdays: ["mon"] });
    __setTestAIClient(
      mockAIClient({
        status: "conflict",
        conflictReason: "Mit nur einem Trainingstag und diesen Einschränkungen ist kein sinnvoller Split möglich.",
        name: "",
        description: "",
        goal: "",
        split: "",
        rationale: "",
        progressionNote: "",
        safetyNote: "",
        sessions: [],
      })
    );
    const { status, data } = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-aiconflict" }),
    });
    assert.equal(status, 422);
    assert.match(data.error, /kein sinnvoller Split/);
  });

  test("unvollständige Onboarding-Daten -> 422 incomplete_onboarding", async () => {
    const { token } = await registerUser();
    // keine setOnboardingData()-Aufruf -> onboarding_data bleibt {}
    __setTestAIClient(mockAIClient(validPlanResponse({ sessions: [] })));
    const { status, data } = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-incomplete" }),
    });
    assert.equal(status, 422);
    assert.equal(data.conflictType, "incomplete_onboarding");
  });

  test("ohne idempotencyKey -> 400", async () => {
    const { token } = await registerUser();
    const { status } = await api("/api/training-plan/generate", { token, method: "POST", body: JSON.stringify({}) });
    assert.equal(status, 400);
  });

  test("ohne Auth -> 401", async () => {
    const { status } = await api("/api/training-plan/generate", {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "x" }),
    });
    assert.equal(status, 401);
  });

  test("neuer Plan archiviert den alten aktiven Plan (nur ein aktiver Plan pro Nutzer)", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, { weekdays: ["mon"] });
    const client = mockAIClient((args) => planFromPool(poolFromLastCall(client), ["mon"]));
    __setTestAIClient(client);

    const first = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "v1" }),
    });
    const second = await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "v2" }),
    });

    assert.notEqual(first.data.plan.id, second.data.plan.id);
    assert.equal(second.data.plan.version, first.data.plan.version + 1);

    const active = await api("/api/training-plan", { token });
    assert.equal(active.data.plan.id, second.data.plan.id);
  });

  test("Speicherfehler (DB lehnt Transaktion ab) -> vollständiger Rollback, kein Halbzustand", async () => {
    const { token, userId } = await registerUser();
    await setOnboardingData(token, { weekdays: ["mon"] });

    const { saveTrainingPlanTransactionally } = require("../training-plan-service");
    const brokenPlan = {
      name: "Broken",
      goal: "general_fitness",
      split: "Ganzkörper",
      description: "x",
      progressionNote: "x",
      safetyNote: "x",
      sessions: [
        {
          weekday: "mon",
          orderIndex: 0,
          title: "GK",
          focus: "GK",
          estimatedDurationMinutes: 45,
          rationale: "x",
          exercises: [
            {
              exerciseId: 999999999, // existiert nicht -> FK-Verletzung
              orderIndex: 0,
              workingSets: 3,
              targetType: "repetitions",
              targetMin: 8,
              targetMax: 12,
              restSeconds: 90,
              targetRir: 2,
              note: null,
            },
          ],
        },
      ],
    };

    await assert.rejects(() => saveTrainingPlanTransactionally(pool, userId, brokenPlan));

    const plans = await pool.query(`SELECT * FROM training_plans WHERE user_id = $1`, [userId]);
    assert.equal(plans.rows.length, 0, "keine Plan-Zeile darf durch den fehlgeschlagenen Save entstehen");

    const sessions = await pool.query(
      `SELECT s.* FROM training_plan_sessions s
       LEFT JOIN training_plans p ON p.id = s.plan_id
       WHERE p.user_id = $1 OR p.id IS NULL`,
      [userId]
    );
    assert.equal(sessions.rows.length, 0, "keine verwaiste Einheiten-Zeile darf zurückbleiben");

    const me = await api("/api/me", { token });
    assert.equal(me.data.user.onboarding_status, "in_progress", "Onboarding darf bei Speicherfehler nicht abgeschlossen werden");
  });
});

describe("GET /api/training-plan", () => {
  test("liefert gespeicherten Plan ohne erneuten KI-Aufruf", async () => {
    const { token } = await registerUser();
    await setOnboardingData(token, { weekdays: ["mon"] });
    const client = mockAIClient((args) => planFromPool(poolFromLastCall(client), ["mon"]));
    __setTestAIClient(client);
    await api("/api/training-plan/generate", {
      token,
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "key-getplan" }),
    });
    assert.equal(client.callCount, 1);

    __setTestAIClient(null); // sicherstellen: GET darf keinen KI-Client brauchen
    const { status, data } = await api("/api/training-plan", { token });
    assert.equal(status, 200);
    assert.equal(data.plan.status, "active");
    assert.ok(data.plan.sessions[0].exercises[0].exerciseName);
  });

  test("kein Plan vorhanden -> 404", async () => {
    const { token } = await registerUser();
    const { status } = await api("/api/training-plan", { token });
    assert.equal(status, 404);
  });
});
