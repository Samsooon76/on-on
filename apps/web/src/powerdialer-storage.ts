import { normalizePhoneNumber } from "@onoff/contracts";
import { dialerReducer, initialDialerState, outcomes, settingsError, type DialerState } from "./powerdialer-model.ts";

export function dialerStorageKey(scope: { userId: string; organizationId: string; lineId: string }): string {
  return `onoff:powerdialer:v2:${scope.userId}:${scope.organizationId}:${scope.lineId}`;
}
export function serializeDialer(state: DialerState): string { return JSON.stringify({ version: 2, state }); }
export function restoreDialer(raw: string | null, at: string): DialerState {
  if (!raw) return initialDialerState;
  const parsed = JSON.parse(raw);
  if (parsed.version !== 2) throw new Error("Version de sauvegarde inconnue.");
  const state = parsed.state as DialerState;
  if (!state || !Array.isArray(state.entries) || state.entries.length > 1000 || settingsError(state.settings) || typeof state.settings.autoAdvance !== "boolean" || typeof state.settings.retryEnabled !== "boolean" || typeof state.settings.hours.enabled !== "boolean" || !Array.isArray(state.excludedNumbers) || state.excludedNumbers.some((number) => normalizePhoneNumber(number) !== number)) throw new Error("Sauvegarde invalide.");
  const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
  const outcome = (value: unknown) => value === null || outcomes.some((item) => item.id === value);
  const ids = new Set<string>();
  for (const entry of state.entries) {
    if (!entry || normalizePhoneNumber(entry.number) !== entry.number || entry.id !== entry.number || ids.has(entry.id) || typeof entry.name !== "string" || typeof entry.notes !== "string" || entry.notes.length > 5000 || !["pending", "calling", "scheduled", "done", "skipped"].includes(entry.status) || !outcome(entry.outcome) || !Array.isArray(entry.attempts) || entry.attempts.some((attempt) => !date(attempt.attemptedAt) || (attempt.endedAt !== null && !date(attempt.endedAt)) || !outcome(attempt.outcome) || typeof attempt.notes !== "string") || (entry.nextAttemptAt !== null && !date(entry.nextAttemptAt)) || (entry.status === "scheduled" && (!entry.nextAttemptAt || !["retry", "callback"].includes(entry.scheduleKind ?? "")))) throw new Error("Sauvegarde invalide.");
    ids.add(entry.id);
  }
  const interrupted = state.entries.filter((entry) => entry.status === "calling");
  if (interrupted.length > 1) throw new Error("Sauvegarde invalide.");
  const paused = { ...state, running: false, remaining: 0, phase: "ready" as const, error: "" };
  if (interrupted[0]) {
    // The remote outcome is unknown after reload. Never redial an interrupted call.
    return { ...paused, activeId: interrupted[0].id, phase: "wrapup", error: "Session récupérée après interruption. Vérifiez le dernier appel et qualifiez-le avant de reprendre." };
  }
  return dialerReducer(paused, { type: "refresh", at });
}
