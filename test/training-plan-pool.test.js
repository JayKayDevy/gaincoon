const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildEligibleExercisePool,
  planTrainingDays,
  resolveAvailableEquipment,
  resolveAllowedDifficulties,
} = require("../training-plan-pool");

function catalogRow(overrides) {
  return {
    id: 1,
    slug: "test-exercise",
    name: "Test Exercise",
    category: "chest",
    primaryMuscleGroups: ["chest"],
    secondaryMuscleGroups: [],
    requiredEquipment: [],
    difficulty: "beginner",
    ...overrides,
  };
}

// Ein Pool mit genug Vielfalt (>= MIN_POOL_SIZE), damit reine Filtertests nicht
// zufällig am "zu wenige Übungen"-Konflikt scheitern.
function basePoolRows() {
  return [
    catalogRow({ id: 1, name: "Liegestütz", requiredEquipment: [], difficulty: "beginner", primaryMuscleGroups: ["chest"] }),
    catalogRow({ id: 2, name: "Bankdrücken Langhantel", requiredEquipment: ["barbell", "bench"], difficulty: "intermediate", primaryMuscleGroups: ["chest"] }),
    catalogRow({ id: 3, name: "Kniebeugen Langhantel", requiredEquipment: ["barbell", "rack"], difficulty: "advanced", primaryMuscleGroups: ["quads", "glutes"], category: "legs" }),
    catalogRow({ id: 4, name: "Kurzhantelrudern", requiredEquipment: ["dumbbells", "bench"], difficulty: "beginner", primaryMuscleGroups: ["upper_back"], category: "back" }),
    catalogRow({ id: 5, name: "Plank", requiredEquipment: [], difficulty: "beginner", primaryMuscleGroups: ["abs"], category: "core" }),
    catalogRow({ id: 6, name: "Klimmzüge", requiredEquipment: ["pull_up_bar"], difficulty: "advanced", primaryMuscleGroups: ["lats"], category: "back" }),
    catalogRow({ id: 7, name: "Kurzhantel-Schulterdrücken", requiredEquipment: ["dumbbells"], difficulty: "beginner", primaryMuscleGroups: ["front_delts"], category: "shoulders" }),
    catalogRow({ id: 8, name: "Kurzhantel-Curls", requiredEquipment: ["dumbbells"], difficulty: "beginner", primaryMuscleGroups: ["biceps"], category: "biceps" }),
    catalogRow({ id: 9, name: "Crunches", requiredEquipment: [], difficulty: "beginner", primaryMuscleGroups: ["abs"], category: "core" }),
    catalogRow({ id: 10, name: "Ausfallschritte Kurzhanteln", requiredEquipment: ["dumbbells"], difficulty: "intermediate", primaryMuscleGroups: ["quads", "glutes"], category: "legs" }),
  ];
}

describe("resolveAvailableEquipment", () => {
  test("vollständig ausgestattetes Fitnessstudio -> null (alles verfügbar)", () => {
    const result = resolveAvailableEquipment({ location: "gym", gymFullyEquipped: "full" });
    assert.equal(result, null);
  });

  test("Zuhause -> nur die ausgewählten, gemappten Codes", () => {
    const result = resolveAvailableEquipment({ location: "home", equipment: ["dumbbells", "bench", "mat"] });
    assert.deepEqual([...result].sort(), ["bench", "dumbbells"]);
  });

  test("eingeschränktes Studio -> gemappte Codes, kein Bypass", () => {
    const result = resolveAvailableEquipment({
      location: "gym",
      gymFullyEquipped: "limited",
      equipment: ["barbell", "rack"],
    });
    assert.deepEqual([...result].sort(), ["barbell", "rack"]);
  });
});

describe("resolveAllowedDifficulties", () => {
  test("Anfänger -> nur beginner", () => {
    assert.deepEqual(resolveAllowedDifficulties({ strengthTrainingExperience: "just_starting" }), ["beginner"]);
  });
  test("sehr erfahren -> alle Stufen", () => {
    assert.deepEqual(resolveAllowedDifficulties({ strengthTrainingExperience: "over_2_years" }), [
      "beginner",
      "intermediate",
      "advanced",
    ]);
  });
  test("unbekannter/fehlender Wert -> sicherer Default (beginner)", () => {
    assert.deepEqual(resolveAllowedDifficulties({}), ["beginner"]);
  });
});

describe("buildEligibleExercisePool", () => {
  test("vollständig ausgestattetes Studio: Ausstattungsfilter greift nicht", () => {
    const result = buildEligibleExercisePool({
      onboardingData: { location: "gym", gymFullyEquipped: "full", strengthTrainingExperience: "over_2_years" },
      catalogRows: basePoolRows(),
      preferences: [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.pool.length, 10);
  });

  test("eingeschränkte Heimausstattung: nur passende Übungen", () => {
    const result = buildEligibleExercisePool({
      onboardingData: { location: "home", equipment: ["dumbbells", "bench"], strengthTrainingExperience: "over_2_years" },
      catalogRows: basePoolRows(),
      preferences: [],
    });
    assert.equal(result.ok, true);
    const ids = result.pool.map((e) => e.id).sort((a, b) => a - b);
    // alle ohne Geräte oder mit nur dumbbells/bench
    assert.deepEqual(ids, [1, 4, 5, 7, 8, 9, 10]);
  });

  test("Anfänger: nur beginner-Übungen", () => {
    const result = buildEligibleExercisePool({
      onboardingData: { location: "gym", gymFullyEquipped: "full", strengthTrainingExperience: "just_starting" },
      catalogRows: basePoolRows(),
      preferences: [],
    });
    assert.equal(result.ok, true);
    assert.ok(result.pool.every((e) => e.difficulty === "beginner"));
    assert.deepEqual(result.pool.map((e) => e.id).sort((a, b) => a - b), [1, 4, 5, 7, 8, 9]);
  });

  test("Fortgeschrittene (6 Monate - 2 Jahre): beginner + intermediate", () => {
    const result = buildEligibleExercisePool({
      onboardingData: { location: "gym", gymFullyEquipped: "full", strengthTrainingExperience: "6_months_to_2_years" },
      catalogRows: basePoolRows(),
      preferences: [],
    });
    assert.equal(result.ok, true);
    assert.ok(result.pool.every((e) => e.difficulty !== "advanced"));
  });

  test("vermiedene Übung wird aus dem Pool entfernt", () => {
    const result = buildEligibleExercisePool({
      onboardingData: { location: "gym", gymFullyEquipped: "full", strengthTrainingExperience: "over_2_years" },
      catalogRows: basePoolRows(),
      preferences: [{ exerciseId: 2, preference: "avoid" }],
    });
    assert.equal(result.ok, true);
    assert.ok(!result.pool.some((e) => e.id === 2));
  });

  test("bevorzugte Übung bleibt im Pool und wird als preferredIds markiert", () => {
    const result = buildEligibleExercisePool({
      onboardingData: { location: "gym", gymFullyEquipped: "full", strengthTrainingExperience: "over_2_years" },
      catalogRows: basePoolRows(),
      preferences: [{ exerciseId: 1, preference: "preferred" }],
    });
    assert.equal(result.ok, true);
    assert.ok(result.preferredIds.has(1));
  });

  test("vollständig auszusparender Bereich (Knie) entfernt primär betroffene Übungen", () => {
    const result = buildEligibleExercisePool({
      onboardingData: {
        location: "gym",
        gymFullyEquipped: "full",
        strengthTrainingExperience: "over_2_years",
        hasLimitations: true,
        limitationAreas: ["knee"],
        limitationDetails: { knee: { handling: "exclude_area" } },
      },
      catalogRows: basePoolRows(),
      preferences: [],
    });
    assert.equal(result.ok, true);
    // id 3 (Kniebeugen, primary quads) muss raus, id 4 (upper_back) bleibt drin
    assert.ok(!result.pool.some((e) => e.id === 3));
    assert.ok(result.pool.some((e) => e.id === 4));
  });

  test("nicht zuverlässig zuordenbarer Bereich (other) + exclude_area -> Konflikt statt stiller Annahme", () => {
    const result = buildEligibleExercisePool({
      onboardingData: {
        location: "gym",
        gymFullyEquipped: "full",
        strengthTrainingExperience: "over_2_years",
        hasLimitations: true,
        limitationAreas: ["other"],
        limitationDetails: { other: { handling: "exclude_area", note: "irgendwas" } },
      },
      catalogRows: basePoolRows(),
      preferences: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.conflictType, "limitation_conflict");
    assert.match(result.reason, /nicht zuverlässig/);
  });

  test("reduce_load (nicht exclude_area) filtert nicht hart", () => {
    const result = buildEligibleExercisePool({
      onboardingData: {
        location: "gym",
        gymFullyEquipped: "full",
        strengthTrainingExperience: "over_2_years",
        hasLimitations: true,
        limitationAreas: ["knee"],
        limitationDetails: { knee: { handling: "reduce_load" } },
      },
      catalogRows: basePoolRows(),
      preferences: [],
    });
    assert.equal(result.ok, true);
    assert.ok(result.pool.some((e) => e.id === 3)); // Kniebeugen bleibt im Pool
  });

  test("zu kleiner Pool -> Konflikt", () => {
    const result = buildEligibleExercisePool({
      onboardingData: { location: "home", equipment: [], strengthTrainingExperience: "just_starting" },
      catalogRows: [catalogRow({ id: 1, requiredEquipment: ["barbell"] })], // nicht verfügbar, Pool leer
      preferences: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.conflictType, "pool_conflict");
    assert.match(result.reason, /nicht genügend/);
  });
});

describe("planTrainingDays", () => {
  test("2 Trainingstage, keine festen Einheiten", () => {
    const result = planTrainingDays({ onboardingData: { weekdays: ["mon", "thu"] } });
    assert.equal(result.ok, true);
    assert.equal(result.targetDayCount, 2);
    assert.deepEqual(result.plannedStrengthDays, ["mon", "thu"]);
  });

  test("Zielanzahl ergibt sich immer aus der Wochentage-Auswahl - alle verfügbaren Tage werden geplant", () => {
    const result = planTrainingDays({ onboardingData: { weekdays: ["fri", "mon", "wed"] } });
    assert.equal(result.ok, true);
    assert.equal(result.targetDayCount, 3);
    // sortiert Montag zuerst, unabhängig von der Eingabereihenfolge
    assert.deepEqual(result.plannedStrengthDays, ["mon", "wed", "fri"]);
  });

  test("fester Kurs an einem nicht als möglich markierten Wochentag zählt trotzdem als belegter Trainingstag", () => {
    const result = planTrainingDays({
      onboardingData: {
        weekdays: ["mon", "wed"],
        hasRecurringSessions: true,
        recurringSessions: [{ id: "a", name: "Sonntagslauf", weekday: "sun", category: "endurance", intensity: "medium", durationMinutes: 60 }],
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.targetDayCount, 2);
    // "sun" beansprucht ein Budget-Slot; nur einer der beiden möglichen Tage (mon) wird zusätzlich gefüllt
    assert.deepEqual(result.plannedStrengthDays, ["mon", "sun"]);
    assert.deepEqual(Object.keys(result.recurringSessionsByDay), ["sun"]);
  });

  test("4 Trainingstage mit einer festen Einheit am Montag -> Montag zählt mit", () => {
    const result = planTrainingDays({
      onboardingData: {
        weekdays: ["mon", "tue", "wed", "thu"],
        hasRecurringSessions: true,
        recurringSessions: [{ id: "a", name: "BodyPump", weekday: "mon", category: "strength_endurance", intensity: "high", durationMinutes: 60 }],
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.plannedStrengthDays.length, 4);
    assert.ok(result.plannedStrengthDays.includes("mon"));
    assert.deepEqual(Object.keys(result.recurringSessionsByDay), ["mon"]);
  });

  test("mehrere Einheiten am selben Tag zählen als ein Trainingstag", () => {
    const result = planTrainingDays({
      onboardingData: {
        weekdays: ["mon", "wed"],
        hasRecurringSessions: true,
        recurringSessions: [
          { id: "a", name: "BodyAttack", weekday: "mon", category: "endurance", intensity: "high", durationMinutes: 45, time: "18:00" },
          { id: "b", name: "BodyPump", weekday: "mon", category: "strength_endurance", intensity: "medium", durationMinutes: 60, time: "19:00" },
        ],
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.targetDayCount, 2);
    assert.equal(result.plannedStrengthDays.length, 2);
    assert.equal(result.recurringSessionsByDay.mon.length, 2);
    // nach Uhrzeit sortiert
    assert.equal(result.recurringSessionsByDay.mon[0].name, "BodyAttack");
  });

  test("mehr feste Einheit-Tage als gewünschte Trainingstage -> Konflikt", () => {
    const result = planTrainingDays({
      onboardingData: {
        weekdays: ["mon"],
        hasRecurringSessions: true,
        recurringSessions: [
          { id: "a", weekday: "mon", category: "endurance", intensity: "high", durationMinutes: 45 },
          { id: "b", weekday: "wed", category: "endurance", intensity: "high", durationMinutes: 45 },
        ],
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.conflictType, "day_conflict");
    assert.match(result.reason, /mehr unterschiedlichen Wochentagen/);
  });

  test("keine verfügbaren Wochentage -> Konflikt", () => {
    const result = planTrainingDays({ onboardingData: { weekdays: [] } });
    assert.equal(result.ok, false);
  });
});
