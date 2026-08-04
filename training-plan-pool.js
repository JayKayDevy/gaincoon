// Deterministische Vorbereitung für die Trainingsplan-Erstellung: zulässiger
// Übungspool + Tagesplanung. Rein funktional (keine DB/Netzwerk-I/O), damit
// vollständig ohne echte OpenAI-Calls unit-testbar. Läuft VOR dem KI-Aufruf
// ("harte Regeln vor dem KI-Aufruf" laut Architekturvorgabe) - die KI bekommt
// nur noch den bereits gefilterten Pool und die bereits feststehenden Tage.
//
// WICHTIG: Diese Zuordnungen (Ausstattung, Erfahrung->Schwierigkeit,
// Einschränkungsbereich->Muskelgruppe) sind serverseitige Spiegelbilder von
// Konzepten, die im Frontend (public/index.html) mit anderem Vokabular
// existieren (z.B. ONBOARDING_TO_CATALOG_EQUIPMENT dort). Das Frontend sendet
// hier keine fertigen Kopien mit - der Server berechnet das selbst aus den
// persistenten onboarding_data, wie gefordert.

const WEEKDAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const STANDARD_GYM_EQUIPMENT = ["dumbbells", "barbell", "cable_machine", "bench", "machines"];

// Onboarding-Ausstattungscode -> Katalog-Gerätecode. Nur Codes mit echter
// Entsprechung sind gelistet; Katalog-Geräte ohne Entsprechung (z.B. ez_bar,
// back_extension_bench) sind für Nutzer ohne "vollständig ausgestattetes
// Fitnessstudio" nie erreichbar - siehe formatLocationSummary/ONBOARDING_TO_CATALOG_EQUIPMENT
// im Frontend für die identische Abbildung.
const ONBOARDING_TO_CATALOG_EQUIPMENT = {
  resistance_bands: "resistance_band",
  dumbbells: "dumbbells",
  kettlebell: "kettlebell",
  barbell: "barbell",
  bench: "bench",
  pull_up_bar: "pull_up_bar",
  rack: "rack",
  machines: "machine",
  cable_machine: "cable_machine",
};

// Trainingserfahrung (5 Werte im Datenmodell) -> zulässige Katalog-
// Schwierigkeitsgrade. Die fachliche Vorgabe beschreibt nur 3 Stufen
// (Anfänger/Fortgeschrittene/sehr Erfahrene); "returning_after_break" wird
// bewusst vorsichtig wie eine Wiedereinsteiger-Stufe zwischen Anfänger und
// Fortgeschritten behandelt (kein direkter Sprung zu advanced), auch wenn die
// Person vor der Pause weiter war - Sicherheit vor Enthusiasmus.
const EXPERIENCE_TO_DIFFICULTIES = {
  just_starting: ["beginner"],
  under_6_months: ["beginner"],
  "6_months_to_2_years": ["beginner", "intermediate"],
  over_2_years: ["beginner", "intermediate", "advanced"],
  returning_after_break: ["beginner", "intermediate"],
};

// Einschränkungsbereich (11 Werte, Onboarding-Vokabular) -> Katalog-
// Muskelgruppen, deren primäre Belastung bei "vollständig aussparen" verboten
// ist. Dies ist eine fachliche Näherung, kein exaktes anatomisches Mapping
// (der Katalog kennt z.B. keine separate "Nacken/Trapezius"-Gruppe). Bereiche
// mit leerer Zuordnung (cardio_respiratory, other) können nicht zuverlässig
// als "vollständig ausgespart" garantiert werden - siehe UNRELIABLE_EXCLUDE_AREAS.
const LIMITATION_AREA_TO_MUSCLE_GROUPS = {
  shoulder: ["front_delts", "side_delts", "rear_delts"],
  neck: ["upper_back"],
  upper_back: ["upper_back"],
  lower_back: ["lower_back"],
  elbow: ["triceps", "biceps", "forearms"],
  wrist: ["forearms"],
  hip: ["glutes", "adductors", "abductors"],
  knee: ["quads", "hamstrings"],
  ankle_foot: ["calves"],
  cardio_respiratory: [],
  other: [],
};

const UNRELIABLE_EXCLUDE_AREAS = new Set(
  Object.entries(LIMITATION_AREA_TO_MUSCLE_GROUPS)
    .filter(([, groups]) => groups.length === 0)
    .map(([area]) => area)
);

const MIN_POOL_SIZE = 4;

const TRAINING_PLAN_GOALS = ["muscle_gain", "fat_loss", "strength", "general_fitness", "balanced_mix"];
const TRAINING_PLAN_TARGET_TYPES = ["repetitions", "duration_seconds"];

function resolveAvailableEquipment(onboardingData) {
  if (onboardingData.location === "gym" && onboardingData.gymFullyEquipped === "full") {
    return null; // null = alles verfügbar (voller aktiver Katalog erlaubt)
  }
  const codes = new Set();
  for (const code of onboardingData.equipment || []) {
    const mapped = ONBOARDING_TO_CATALOG_EQUIPMENT[code];
    if (mapped) codes.add(mapped);
  }
  return codes;
}

function resolveAllowedDifficulties(onboardingData) {
  return (
    EXPERIENCE_TO_DIFFICULTIES[onboardingData.strengthTrainingExperience] || ["beginner"]
  );
}

/**
 * Bestimmt Muskelgruppen, die wegen "vollständig aussparen"-Einschränkungen
 * gemieden werden müssen, und liefert einen Konfliktgrund, falls ein
 * aufgesparter Bereich sich nicht zuverlässig einer Muskelgruppe zuordnen lässt.
 */
function resolveExcludedMuscleGroups(onboardingData) {
  if (!onboardingData.hasLimitations || !Array.isArray(onboardingData.limitationAreas)) {
    return { excludedMuscleGroups: new Set(), conflictReason: null };
  }
  const excludedMuscleGroups = new Set();
  for (const area of onboardingData.limitationAreas) {
    const detail = onboardingData.limitationDetails?.[area];
    if (detail?.handling !== "exclude_area") continue;
    if (UNRELIABLE_EXCLUDE_AREAS.has(area)) {
      return {
        excludedMuscleGroups: new Set(),
        conflictReason: {
          conflictType: "limitation_conflict",
          reason:
            "Für den Bereich, den du vollständig aussparen möchtest, kann Gaincoon das nicht zuverlässig automatisch sicherstellen. " +
            "Bitte beschreibe die Einschränkung im Onboarding genauer oder lass sie ärztlich/physiotherapeutisch abklären, bevor der Plan erstellt wird.",
        },
      };
    }
    for (const mg of LIMITATION_AREA_TO_MUSCLE_GROUPS[area] || []) {
      excludedMuscleGroups.add(mg);
    }
  }
  return { excludedMuscleGroups, conflictReason: null };
}

/**
 * Baut den zulässigen Übungspool aus dem aktiven Katalog, den persistenten
 * Onboarding-Angaben und den Übungsvorlieben. Rein deterministisch, keine KI.
 *
 * @returns {{ok:true, pool:object[], preferredIds:Set<number>, allowedDifficulties:string[]}
 *          | {ok:false, reason:string}}
 */
function buildEligibleExercisePool({ onboardingData, catalogRows, preferences }) {
  const availableEquipment = resolveAvailableEquipment(onboardingData);
  const allowedDifficulties = resolveAllowedDifficulties(onboardingData);
  const avoidIds = new Set(
    preferences.filter((p) => p.preference === "avoid").map((p) => p.exerciseId)
  );
  const preferredIds = new Set(
    preferences.filter((p) => p.preference === "preferred").map((p) => p.exerciseId)
  );

  const { excludedMuscleGroups, conflictReason } = resolveExcludedMuscleGroups(onboardingData);
  if (conflictReason) return { ok: false, ...conflictReason };

  const pool = catalogRows.filter((ex) => {
    const equipmentOk =
      availableEquipment === null ||
      ex.requiredEquipment.every((eq) => availableEquipment.has(eq));
    const difficultyOk = allowedDifficulties.includes(ex.difficulty);
    const notAvoided = !avoidIds.has(ex.id);
    const notExcludedArea = !ex.primaryMuscleGroups.some((mg) => excludedMuscleGroups.has(mg));
    return equipmentOk && difficultyOk && notAvoided && notExcludedArea;
  });

  if (pool.length < MIN_POOL_SIZE) {
    return {
      ok: false,
      conflictType: "pool_conflict",
      reason:
        "Mit deiner aktuellen Ausstattung, Erfahrungsstufe und deinen Einschränkungen findet Gaincoon nicht genügend passende Übungen " +
        "für einen sinnvollen Trainingsplan. Bitte prüfe deine Angaben zu Ausstattung oder vermiedenen Übungen im Onboarding.",
    };
  }

  return { ok: true, pool, preferredIds, allowedDifficulties };
}

/**
 * Bestimmt deterministisch, an welchen Wochentagen Krafttraining eingeplant
 * wird. Zielanzahl = Anzahl der als möglich markierten Wochentage (es gibt
 * bewusst kein separates "Anzahl gewünschter Trainingstage"-Feld, siehe
 * [[project_gaincoon]] - die Anzahl ergibt sich aus der Wochentage-Auswahl
 * selbst). "Der Plan darf nur mögliche bzw. bereits durch feste Einheiten
 * belegte Trainingstage verwenden" heißt: ein Tag mit fester Einheit zählt
 * IMMER als belegter Trainingstag und beansprucht Budget aus der Zielanzahl -
 * auch wenn dieser Wochentag nicht explizit als "möglich" markiert wurde
 * (ein bestehender fester Termin ist ein stärkerer Beleg für Verfügbarkeit an
 * diesem Tag als die reine Checkbox-Auswahl). Feste Kurstage werden deshalb
 * zuerst ins Budget eingerechnet, der Rest wird aus den übrigen möglichen
 * Wochentagen aufgefüllt (deterministisch in Wochenreihenfolge - die feinere
 * Verteilung/Regenerationsplanung übernimmt anschließend die KI mit vollem
 * Kontext zu den Kurstagen und deren Intensität).
 *
 * @returns {{ok:true, targetDayCount:number, availableWeekdays:string[],
 *            plannedStrengthDays:string[], recurringSessionsByDay:Record<string,object[]>}
 *          | {ok:false, reason:string}}
 */
function planTrainingDays({ onboardingData }) {
  const byWeekdayOrder = (a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b);
  const availableWeekdays = (
    Array.isArray(onboardingData.weekdays) ? [...onboardingData.weekdays] : []
  ).sort(byWeekdayOrder);
  if (availableWeekdays.length === 0) {
    return {
      ok: false,
      conflictType: "incomplete_onboarding",
      reason: "Es wurden keine möglichen Trainingstage angegeben.",
    };
  }
  const targetDayCount = availableWeekdays.length;

  const recurringSessions = onboardingData.hasRecurringSessions
    ? onboardingData.recurringSessions || []
    : [];
  const recurringSessionsByDay = {};
  for (const s of recurringSessions) {
    (recurringSessionsByDay[s.weekday] ??= []).push(s);
  }
  for (const day of Object.keys(recurringSessionsByDay)) {
    recurringSessionsByDay[day].sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
  }
  const recurringDays = Object.keys(recurringSessionsByDay).sort(byWeekdayOrder);

  if (recurringDays.length > targetDayCount) {
    return {
      ok: false,
      conflictType: "day_conflict",
      reason:
        "Du hast bereits an mehr unterschiedlichen Wochentagen feste Kurse oder Einheiten als gewünschte Trainingstage angegeben. " +
        "Bitte passe entweder deine gewünschten Wochentage oder deine festen Einheiten im Onboarding an.",
    };
  }

  const remaining = availableWeekdays.filter((d) => !recurringDays.includes(d));
  const extraNeeded = targetDayCount - recurringDays.length;
  const extraDays = remaining.slice(0, extraNeeded);

  const plannedStrengthDays = [...recurringDays, ...extraDays].sort(byWeekdayOrder);

  return {
    ok: true,
    targetDayCount,
    availableWeekdays,
    plannedStrengthDays,
    recurringSessionsByDay,
  };
}

module.exports = {
  WEEKDAY_ORDER,
  STANDARD_GYM_EQUIPMENT,
  ONBOARDING_TO_CATALOG_EQUIPMENT,
  EXPERIENCE_TO_DIFFICULTIES,
  LIMITATION_AREA_TO_MUSCLE_GROUPS,
  UNRELIABLE_EXCLUDE_AREAS,
  MIN_POOL_SIZE,
  TRAINING_PLAN_GOALS,
  TRAINING_PLAN_TARGET_TYPES,
  resolveAvailableEquipment,
  resolveAllowedDifficulties,
  resolveExcludedMuscleGroups,
  buildEligibleExercisePool,
  planTrainingDays,
};
