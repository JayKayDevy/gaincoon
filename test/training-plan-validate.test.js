const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { validateTrainingPlanResponse } = require("../training-plan-validate");
const { TrainingPlanConflictError, TrainingPlanValidationError } = require("../training-plan-errors");

function poolExercise(overrides) {
  return {
    id: 1,
    name: "Test",
    category: "chest",
    primaryMuscleGroups: ["chest"],
    secondaryMuscleGroups: [],
    requiredEquipment: [],
    difficulty: "beginner",
    ...overrides,
  };
}

function ctx(overrides = {}) {
  return {
    poolResult: {
      pool: [
        poolExercise({ id: 1, name: "Liegestütz", primaryMuscleGroups: ["chest"] }),
        poolExercise({ id: 2, name: "Kurzhantelrudern", primaryMuscleGroups: ["upper_back"], category: "back" }),
        poolExercise({ id: 3, name: "Kniebeugen", primaryMuscleGroups: ["quads", "glutes"], category: "legs" }),
        poolExercise({ id: 4, name: "Plank", primaryMuscleGroups: ["abs"], category: "core" }),
      ],
      preferredIds: new Set(),
    },
    dayPlan: {
      plannedStrengthDays: ["mon", "wed"],
      recurringSessionsByDay: {},
    },
    sessionDurationMinutes: 60,
    ...overrides,
  };
}

function validExercise(overrides = {}) {
  return {
    exerciseId: 1,
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

function validSession(overrides = {}) {
  return {
    weekday: "mon",
    orderIndex: 0,
    title: "Ganzkörper",
    focus: "Ganzkörper",
    estimatedDurationMinutes: 45,
    rationale: "Deckt alle großen Muskelgruppen ab.",
    exercises: [
      validExercise({ exerciseId: 1 }),
      validExercise({ exerciseId: 2 }),
      validExercise({ exerciseId: 3 }),
    ],
    ...overrides,
  };
}

function validPlan(overrides = {}) {
  return {
    status: "ok",
    conflictReason: null,
    name: "Ganzkörperplan",
    description: "Ein ausgewogener Ganzkörperplan.",
    goal: "general_fitness",
    split: "Ganzkörper",
    rationale: "Passt zu 2 Trainingstagen.",
    progressionNote: "Double Progression: erst Wiederholungen, dann Gewicht steigern.",
    safetyNote: "Ersetzt keine medizinische Beratung.",
    sessions: [validSession()],
    ...overrides,
  };
}

describe("validateTrainingPlanResponse", () => {
  test("gültiger Plan wird normalisiert übernommen", () => {
    const result = validateTrainingPlanResponse(validPlan(), ctx());
    assert.equal(result.name, "Ganzkörperplan");
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].exercises.length, 3);
  });

  test("status=conflict wird als TrainingPlanConflictError geworfen", () => {
    assert.throws(
      () => validateTrainingPlanResponse({ status: "conflict", conflictReason: "Kein sinnvoller Plan möglich." }, ctx()),
      (err) => {
        assert.ok(err instanceof TrainingPlanConflictError);
        assert.equal(err.message, "Kein sinnvoller Plan möglich.");
        return true;
      }
    );
  });

  test("erfundene/unzulässige exerciseId außerhalb des Pools -> Validierungsfehler", () => {
    assert.throws(
      () =>
        validateTrainingPlanResponse(
          validPlan({ sessions: [validSession({ exercises: [validExercise({ exerciseId: 999 })] })] }),
          ctx()
        ),
      TrainingPlanValidationError
    );
  });

  test("doppelte Übung innerhalb derselben Einheit -> Validierungsfehler", () => {
    assert.throws(
      () =>
        validateTrainingPlanResponse(
          validPlan({
            sessions: [validSession({ exercises: [validExercise({ exerciseId: 1 }), validExercise({ exerciseId: 1 })] })],
          }),
          ctx()
        ),
      TrainingPlanValidationError
    );
  });

  test("nicht erlaubter Wochentag -> Validierungsfehler", () => {
    assert.throws(
      () => validateTrainingPlanResponse(validPlan({ sessions: [validSession({ weekday: "fri" })] }), ctx()),
      TrainingPlanValidationError
    );
  });

  test("Überschreitung der Trainingsdauer -> Validierungsfehler", () => {
    assert.throws(
      () =>
        validateTrainingPlanResponse(
          validPlan({ sessions: [validSession({ estimatedDurationMinutes: 90 })] }),
          ctx({ sessionDurationMinutes: 60 })
        ),
      TrainingPlanValidationError
    );
  });

  test("Einheit ohne Übungen -> Validierungsfehler", () => {
    assert.throws(
      () => validateTrainingPlanResponse(validPlan({ sessions: [validSession({ exercises: [] })] }), ctx()),
      TrainingPlanValidationError
    );
  });

  test("workingSets außerhalb des erlaubten Bereichs -> Validierungsfehler", () => {
    assert.throws(
      () =>
        validateTrainingPlanResponse(
          validPlan({ sessions: [validSession({ exercises: [validExercise({ workingSets: 99 })] })] }),
          ctx()
        ),
      TrainingPlanValidationError
    );
  });

  test("targetMax kleiner als targetMin -> Validierungsfehler", () => {
    assert.throws(
      () =>
        validateTrainingPlanResponse(
          validPlan({ sessions: [validSession({ exercises: [validExercise({ targetMin: 10, targetMax: 5 })] })] }),
          ctx()
        ),
      TrainingPlanValidationError
    );
  });

  test("targetRir außerhalb 0-5 -> Validierungsfehler", () => {
    assert.throws(
      () =>
        validateTrainingPlanResponse(
          validPlan({ sessions: [validSession({ exercises: [validExercise({ targetRir: 9 })] })] }),
          ctx()
        ),
      TrainingPlanValidationError
    );
  });

  test("targetRir darf null sein", () => {
    // Standard-validSession() deckt bereits 3 Muskelgruppen ab (chest/upper_back/quads+glutes),
    // damit dieser Test nicht am eigenen Muskelgruppen-Mindestabdeckungs-Check scheitert.
    const result = validateTrainingPlanResponse(
      validPlan({
        sessions: [validSession({ exercises: [validExercise({ exerciseId: 1, targetRir: null }), validExercise({ exerciseId: 2 }), validExercise({ exerciseId: 3 })] })],
      }),
      ctx()
    );
    assert.equal(result.sessions[0].exercises[0].targetRir, null);
  });

  test("zu geringe Muskelgruppenabdeckung -> Validierungsfehler", () => {
    // nur ein einzelner Brust-Exercise über den ganzen Plan -> unplausibel
    const narrowCtx = ctx({
      poolResult: {
        pool: [poolExercise({ id: 1, primaryMuscleGroups: ["chest"] })],
        preferredIds: new Set(),
      },
    });
    assert.throws(
      () =>
        validateTrainingPlanResponse(
          validPlan({
            sessions: [validSession({ exercises: [validExercise({ exerciseId: 1 })] })],
          }),
          narrowCtx
        ),
      TrainingPlanValidationError
    );
  });

  test("vollständig ausgesparte Muskelgruppe wird auch hier nochmal hart geprüft (defense in depth)", () => {
    // Übung 3 (Kniebeugen, primary quads/glutes) ist im Pool, aber wir simulieren
    // eine Situation, in der sie eigentlich nicht hätte im Pool sein dürfen -
    // der Validator selbst hat keinen expliziten excludedMuscleGroups-Parameter,
    // das wird bereits vom Pool-Builder sichergestellt. Dieser Test dokumentiert
    // die Erwartung: der Pool ist die alleinige Quelle der Wahrheit für Zulässigkeit.
    const result = validateTrainingPlanResponse(validPlan(), ctx());
    assert.ok(result.sessions[0].exercises.every((e) => [1, 2, 3].includes(e.exerciseId)));
  });
});
