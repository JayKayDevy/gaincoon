// Orchestriert die drei Stufen der Trainingsplan-Erstellung: deterministische
// Vorbereitung -> OpenAI-Generierung -> Validierung -> transaktionales
// Speichern. Lädt alle Onboarding-Daten serverseitig aus der DB (nicht vom
// Frontend übernommen) und speichert Plan+Einheiten+Übungen sowie Archivierung
// des alten Plans und Onboarding-Abschluss in EINER Transaktion.

const { buildEligibleExercisePool, planTrainingDays } = require("./training-plan-pool");
const { generateTrainingPlanWithAI } = require("./training-plan-ai");
const { validateTrainingPlanResponse } = require("./training-plan-validate");
const { TrainingPlanConflictError } = require("./training-plan-errors");

async function loadGenerationInputs(pool, userId) {
  const userResult = await pool.query(
    `SELECT onboarding_data FROM users WHERE id = $1`,
    [userId]
  );
  if (!userResult.rows[0]) {
    throw new TrainingPlanConflictError("incomplete_onboarding", "Nutzer nicht gefunden.");
  }
  const onboardingData = userResult.rows[0].onboarding_data || {};

  const catalogResult = await pool.query(
    `SELECT id, slug, name, category,
            primary_muscle_groups AS "primaryMuscleGroups",
            secondary_muscle_groups AS "secondaryMuscleGroups",
            required_equipment AS "requiredEquipment",
            difficulty
     FROM exercise_catalog WHERE is_active = true`
  );

  const preferencesResult = await pool.query(
    `SELECT exercise_id AS "exerciseId", preference FROM exercise_preferences WHERE user_id = $1`,
    [userId]
  );

  return { onboardingData, catalogRows: catalogResult.rows, preferences: preferencesResult.rows };
}

const REQUIRED_ONBOARDING_FIELDS = ["goal", "weekdays", "sessionDurationMinutes", "strengthTrainingExperience", "location"];

function assertOnboardingComplete(onboardingData) {
  const missing = REQUIRED_ONBOARDING_FIELDS.filter((f) => {
    const v = onboardingData[f];
    return v === undefined || v === null || (Array.isArray(v) && v.length === 0);
  });
  if (missing.length > 0) {
    throw new TrainingPlanConflictError(
      "incomplete_onboarding",
      "Für die Planerstellung fehlen noch Angaben aus dem Onboarding. Bitte schließe die vorherigen Schritte vollständig ab."
    );
  }
}

/**
 * Speichert einen validierten Plan transaktional: archiviert den bisherigen
 * aktiven Plan (falls vorhanden), legt den neuen als aktiv an, und setzt erst
 * bei Erfolg der gesamten Transaktion den Onboarding-Status auf "completed".
 */
async function saveTrainingPlanTransactionally(pool, userId, validatedPlan) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE training_plans SET status = 'archived' WHERE user_id = $1 AND status = 'active'`,
      [userId]
    );

    const versionResult = await client.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM training_plans WHERE user_id = $1`,
      [userId]
    );
    const nextVersion = versionResult.rows[0].next_version;

    const planResult = await client.query(
      `INSERT INTO training_plans
         (user_id, name, goal, split, status, version, description, progression_note, safety_note)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8)
       RETURNING id`,
      [
        userId,
        validatedPlan.name,
        validatedPlan.goal,
        validatedPlan.split,
        nextVersion,
        validatedPlan.description,
        validatedPlan.progressionNote,
        validatedPlan.safetyNote,
      ]
    );
    const planId = planResult.rows[0].id;

    for (const session of validatedPlan.sessions) {
      const sessionResult = await client.query(
        `INSERT INTO training_plan_sessions
           (plan_id, weekday, order_index, title, focus, estimated_duration_minutes, rationale)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          planId,
          session.weekday,
          session.orderIndex,
          session.title,
          session.focus,
          session.estimatedDurationMinutes,
          session.rationale,
        ]
      );
      const sessionId = sessionResult.rows[0].id;

      for (const ex of session.exercises) {
        await client.query(
          `INSERT INTO training_plan_exercises
             (session_id, exercise_id, order_index, working_sets, target_type, target_min, target_max, rest_seconds, target_rir, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            sessionId,
            ex.exerciseId,
            ex.orderIndex,
            ex.workingSets,
            ex.targetType,
            ex.targetMin,
            ex.targetMax,
            ex.restSeconds,
            ex.targetRir,
            ex.note,
          ]
        );
      }
    }

    await client.query(
      `UPDATE users SET onboarding_status = 'completed' WHERE id = $1`,
      [userId]
    );

    await client.query("COMMIT");
    return planId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lädt einen gespeicherten Plan vollständig (Einheiten + Übungen inkl.
 * Katalog-Metadaten) für die read-only Ansicht - ohne jeden erneuten KI-Aufruf.
 */
async function loadFullPlan(pool, userId, planId) {
  const planResult = await pool.query(
    `SELECT id, name, goal, split, status, version, description,
            progression_note AS "progressionNote", safety_note AS "safetyNote", created_at AS "createdAt"
     FROM training_plans WHERE id = $1 AND user_id = $2`,
    [planId, userId]
  );
  const plan = planResult.rows[0];
  if (!plan) return null;

  const sessionsResult = await pool.query(
    `SELECT id, weekday, order_index AS "orderIndex", title, focus,
            estimated_duration_minutes AS "estimatedDurationMinutes", rationale
     FROM training_plan_sessions WHERE plan_id = $1 ORDER BY order_index, id`,
    [plan.id]
  );

  const exercisesResult = await pool.query(
    `SELECT pe.id, pe.session_id AS "sessionId", pe.order_index AS "orderIndex",
            pe.working_sets AS "workingSets", pe.target_type AS "targetType",
            pe.target_min AS "targetMin", pe.target_max AS "targetMax",
            pe.rest_seconds AS "restSeconds", pe.target_rir AS "targetRir", pe.note,
            ec.id AS "exerciseId", ec.name AS "exerciseName", ec.category,
            ec.primary_muscle_groups AS "primaryMuscleGroups",
            ec.required_equipment AS "requiredEquipment"
     FROM training_plan_exercises pe
     JOIN exercise_catalog ec ON ec.id = pe.exercise_id
     JOIN training_plan_sessions s ON s.id = pe.session_id
     WHERE s.plan_id = $1
     ORDER BY pe.order_index, pe.id`,
    [plan.id]
  );

  const exercisesBySession = {};
  for (const ex of exercisesResult.rows) {
    (exercisesBySession[ex.sessionId] ??= []).push(ex);
  }

  return {
    ...plan,
    sessions: sessionsResult.rows.map((s) => ({ ...s, exercises: exercisesBySession[s.id] || [] })),
  };
}

async function loadActivePlan(pool, userId) {
  const result = await pool.query(
    `SELECT id FROM training_plans WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );
  if (!result.rows[0]) return null;
  return loadFullPlan(pool, userId, result.rows[0].id);
}

/**
 * Führt die vollständige Erstellung durch: Vorbereitung -> KI -> Validierung
 * -> transaktionales Speichern. `aiClient` ist injizierbar (Tests/Mocks).
 * Wirft TrainingPlanConflictError / TrainingPlanAIError / TrainingPlanValidationError.
 */
async function generateAndSaveTrainingPlan(pool, userId, { aiClient } = {}) {
  const { onboardingData, catalogRows, preferences } = await loadGenerationInputs(pool, userId);
  assertOnboardingComplete(onboardingData);

  const dayPlan = planTrainingDays({ onboardingData });
  if (!dayPlan.ok) throw new TrainingPlanConflictError(dayPlan.conflictType, dayPlan.reason);

  const poolResult = buildEligibleExercisePool({ onboardingData, catalogRows, preferences });
  if (!poolResult.ok) throw new TrainingPlanConflictError(poolResult.conflictType, poolResult.reason);

  const rawResponse = await generateTrainingPlanWithAI({
    onboardingData,
    poolResult,
    dayPlan,
    client: aiClient,
  });

  const validatedPlan = validateTrainingPlanResponse(rawResponse, {
    poolResult,
    dayPlan,
    sessionDurationMinutes: onboardingData.sessionDurationMinutes,
  });

  const planId = await saveTrainingPlanTransactionally(pool, userId, validatedPlan);
  return loadFullPlan(pool, userId, planId);
}

module.exports = {
  loadGenerationInputs,
  assertOnboardingComplete,
  saveTrainingPlanTransactionally,
  loadFullPlan,
  loadActivePlan,
  generateAndSaveTrainingPlan,
};
