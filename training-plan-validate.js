// Serverseitige Validierung der (bereits strikt JSON-Schema-konformen)
// OpenAI-Antwort gegen den zuvor deterministisch ermittelten Pool und die
// harten Regeln. "Vertraue der Modellausgabe niemals ungeprüft" - das JSON
// Schema garantiert nur die STRUKTUR, nicht dass IDs/Werte fachlich zulässig
// sind. Wirft TrainingPlanValidationError bei jedem Verstoß; liefert bei
// Erfolg ein normalisiertes, speicherbereites Plan-Objekt.

const { WEEKDAY_ORDER, TRAINING_PLAN_TARGET_TYPES } = require("./training-plan-pool");
const { TrainingPlanConflictError, TrainingPlanValidationError } = require("./training-plan-errors");

const MAX_EXERCISES_PER_SESSION = 12;
const MAX_WORKING_SETS = 10;
const MAX_TARGET_VALUE = 100;
const MAX_REST_SECONDS = 600;
const MIN_COVERED_MUSCLE_GROUPS = 3;

function fail(message) {
  throw new TrainingPlanValidationError(message);
}

function isPlainInteger(value) {
  return Number.isInteger(value);
}

/**
 * @param {object} raw - rohe, JSON-Schema-konforme Modellantwort
 * @param {object} ctx - { poolResult, dayPlan, sessionDurationMinutes }
 * @returns {object} normalisierter Plan, bereit zum Speichern
 */
function validateTrainingPlanResponse(raw, { poolResult, dayPlan, sessionDurationMinutes }) {
  if (!raw || typeof raw !== "object") fail("Antwort ist kein Objekt.");

  if (raw.status === "conflict") {
    throw new TrainingPlanConflictError(
      "pool_conflict",
      typeof raw.conflictReason === "string" && raw.conflictReason.trim()
        ? raw.conflictReason.trim()
        : "Anhand deiner Angaben konnte kein sinnvoller Trainingsplan erstellt werden."
    );
  }
  if (raw.status !== "ok") fail(`Unbekannter status "${raw.status}".`);

  for (const field of ["name", "description", "goal", "split", "rationale", "progressionNote", "safetyNote"]) {
    if (typeof raw[field] !== "string" || !raw[field].trim()) fail(`Feld "${field}" fehlt oder ist leer.`);
  }
  if (!Array.isArray(raw.sessions) || raw.sessions.length === 0) {
    fail("Plan enthält keine Trainingseinheiten.");
  }

  const poolById = new Map(poolResult.pool.map((ex) => [ex.id, ex]));
  const plannedDaysSet = new Set(dayPlan.plannedStrengthDays);
  const usedDays = new Set();
  const coveredMuscleGroups = new Set();
  const normalizedSessions = [];

  raw.sessions.forEach((session, sessionIdx) => {
    const where = `Einheit #${sessionIdx + 1}`;
    if (!WEEKDAY_ORDER.includes(session.weekday)) fail(`${where}: ungültiger Wochentag "${session.weekday}".`);
    if (!plannedDaysSet.has(session.weekday)) {
      fail(`${where}: Wochentag "${session.weekday}" gehört nicht zu den erlaubten Trainingstagen.`);
    }
    if (typeof session.title !== "string" || !session.title.trim()) fail(`${where}: Titel fehlt.`);
    if (typeof session.focus !== "string" || !session.focus.trim()) fail(`${where}: Fokus fehlt.`);
    if (typeof session.rationale !== "string" || !session.rationale.trim()) fail(`${where}: Begründung fehlt.`);
    if (!isPlainInteger(session.estimatedDurationMinutes) || session.estimatedDurationMinutes <= 0) {
      fail(`${where}: ungültige geschätzte Dauer.`);
    }
    if (session.estimatedDurationMinutes > sessionDurationMinutes) {
      fail(`${where}: geschätzte Dauer (${session.estimatedDurationMinutes} Min) überschreitet die gewünschte Trainingsdauer (${sessionDurationMinutes} Min).`);
    }
    if (!Array.isArray(session.exercises) || session.exercises.length === 0) {
      fail(`${where}: enthält keine gültige Übung.`);
    }
    if (session.exercises.length > MAX_EXERCISES_PER_SESSION) {
      fail(`${where}: zu viele Übungen (${session.exercises.length}) für eine plausible Einheit.`);
    }

    usedDays.add(session.weekday);
    const seenExerciseIds = new Set();
    const normalizedExercises = session.exercises.map((ex, exIdx) => {
      const exWhere = `${where}, Übung #${exIdx + 1}`;
      const catalogExercise = poolById.get(ex.exerciseId);
      if (!catalogExercise) {
        fail(`${exWhere}: exerciseId ${ex.exerciseId} existiert nicht oder gehört nicht zum zulässigen Pool.`);
      }
      if (seenExerciseIds.has(ex.exerciseId)) {
        fail(`${exWhere}: Übung "${catalogExercise.name}" kommt in derselben Einheit mehrfach vor.`);
      }
      seenExerciseIds.add(ex.exerciseId);

      if (!TRAINING_PLAN_TARGET_TYPES.includes(ex.targetType)) fail(`${exWhere}: ungültiger targetType.`);
      if (!isPlainInteger(ex.workingSets) || ex.workingSets < 1 || ex.workingSets > MAX_WORKING_SETS) {
        fail(`${exWhere}: workingSets außerhalb des erlaubten Bereichs.`);
      }
      if (!isPlainInteger(ex.targetMin) || ex.targetMin < 1 || ex.targetMin > MAX_TARGET_VALUE) {
        fail(`${exWhere}: targetMin außerhalb des erlaubten Bereichs.`);
      }
      if (!isPlainInteger(ex.targetMax) || ex.targetMax < ex.targetMin || ex.targetMax > MAX_TARGET_VALUE) {
        fail(`${exWhere}: targetMax außerhalb des erlaubten Bereichs oder kleiner als targetMin.`);
      }
      if (!isPlainInteger(ex.restSeconds) || ex.restSeconds < 0 || ex.restSeconds > MAX_REST_SECONDS) {
        fail(`${exWhere}: restSeconds außerhalb des erlaubten Bereichs.`);
      }
      if (ex.targetRir !== null && (!isPlainInteger(ex.targetRir) || ex.targetRir < 0 || ex.targetRir > 5)) {
        fail(`${exWhere}: targetRir außerhalb des erlaubten Bereichs.`);
      }
      if (ex.note !== null && typeof ex.note !== "string") fail(`${exWhere}: note muss Text oder null sein.`);

      for (const mg of catalogExercise.primaryMuscleGroups) coveredMuscleGroups.add(mg);

      return {
        exerciseId: ex.exerciseId,
        orderIndex: isPlainInteger(ex.orderIndex) ? ex.orderIndex : exIdx,
        workingSets: ex.workingSets,
        targetType: ex.targetType,
        targetMin: ex.targetMin,
        targetMax: ex.targetMax,
        restSeconds: ex.restSeconds,
        targetRir: ex.targetRir,
        note: ex.note,
      };
    });

    normalizedSessions.push({
      weekday: session.weekday,
      orderIndex: isPlainInteger(session.orderIndex) ? session.orderIndex : sessionIdx,
      title: session.title.trim(),
      focus: session.focus.trim(),
      estimatedDurationMinutes: session.estimatedDurationMinutes,
      rationale: session.rationale.trim(),
      exercises: normalizedExercises,
    });
  });

  // Konsistenz der Trainingstage-Anzahl: KI-Einheiten dürfen zusammen mit den
  // festen Einheiten die Zielanzahl nicht überschreiten (plannedDaysSet ist
  // bereits exakt darauf begrenzt, s.o.) - hier zusätzlich prüfen, dass nicht
  // mehr unterschiedliche Tage genutzt wurden als tatsächlich geplant.
  if (usedDays.size > dayPlan.plannedStrengthDays.length) {
    fail("Die Anzahl unterschiedlicher Trainingstage im generierten Plan ist inkonsistent.");
  }

  if (coveredMuscleGroups.size < MIN_COVERED_MUSCLE_GROUPS) {
    fail("Die Muskelgruppenabdeckung des generierten Plans ist unplausibel gering.");
  }

  return {
    name: raw.name.trim(),
    description: raw.description.trim(),
    goal: raw.goal.trim(),
    split: raw.split.trim(),
    rationale: raw.rationale.trim(),
    progressionNote: raw.progressionNote.trim(),
    safetyNote: raw.safetyNote.trim(),
    sessions: normalizedSessions,
  };
}

module.exports = {
  MAX_EXERCISES_PER_SESSION,
  MAX_WORKING_SETS,
  MAX_TARGET_VALUE,
  MAX_REST_SECONDS,
  MIN_COVERED_MUSCLE_GROUPS,
  validateTrainingPlanResponse,
};
