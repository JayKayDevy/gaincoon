// Typisierte Fehler für die Trainingsplan-Erstellung. Getrennte Klassen statt
// Nachrichtentext-Matching, damit die API zuverlässig zwischen den vom
// Frontend geforderten Fehlerkategorien unterscheiden kann, ohne rohe
// Backend-/DB-/OpenAI-Fehlermeldungen durchzureichen.

class TrainingPlanConflictError extends Error {
  constructor(conflictType, message) {
    super(message);
    this.name = "TrainingPlanConflictError";
    this.conflictType = conflictType; // incomplete_onboarding | day_conflict | pool_conflict | limitation_conflict
  }
}

class TrainingPlanAIError extends Error {
  constructor(message) {
    super(message);
    this.name = "TrainingPlanAIError"; // technischer OpenAI-Fehler (Netzwerk, Timeout, API-Fehler)
  }
}

class TrainingPlanValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TrainingPlanValidationError"; // strukturell korrekte, aber inhaltlich ungültige Modellausgabe
  }
}

function classifyTrainingPlanError(err) {
  if (err instanceof TrainingPlanConflictError) {
    return { httpStatus: 422, publicMessage: err.message, conflictType: err.conflictType };
  }
  if (err instanceof TrainingPlanAIError) {
    return {
      httpStatus: 502,
      publicMessage: "Der KI-Dienst für die Planerstellung ist gerade nicht erreichbar. Bitte versuche es in Kürze erneut.",
      conflictType: "ai_unavailable",
    };
  }
  if (err instanceof TrainingPlanValidationError) {
    return {
      httpStatus: 502,
      publicMessage: "Die generierte Antwort war ungültig und konnte nicht sicher übernommen werden. Bitte versuche es erneut.",
      conflictType: "invalid_ai_output",
    };
  }
  console.error("Trainingsplan-Erstellung fehlgeschlagen:", err);
  return {
    httpStatus: 500,
    publicMessage: "Der Trainingsplan konnte nicht gespeichert werden. Bitte versuche es erneut.",
    conflictType: "storage_error",
  };
}

module.exports = {
  TrainingPlanConflictError,
  TrainingPlanAIError,
  TrainingPlanValidationError,
  classifyTrainingPlanError,
};
