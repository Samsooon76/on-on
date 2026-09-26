import { normalizePhoneNumber } from "@onoff/contracts";
import type { Contact } from "./conversation-model";

export const MAX_DIALER_CONTACTS = 1000;
export const outcomes = [
  { id: "interested", label: "Intéressé", key: "1" },
  { id: "callback", label: "À rappeler", key: "2" },
  { id: "not-interested", label: "Pas intéressé", key: "3" },
  { id: "no-answer", label: "Sans réponse", key: "4" },
  { id: "voicemail", label: "Répondeur", key: "5" },
  { id: "busy", label: "Occupé", key: "6" },
  { id: "wrong-number", label: "Mauvais numéro", key: "7" },
  { id: "do-not-call", label: "Ne plus appeler", key: "8" },
] as const;
export type Outcome = typeof outcomes[number]["id"];
export type RetryOutcome = "no-answer" | "voicemail" | "busy";
export type DialerSettings = {
  name: string; script: string; autoAdvance: boolean; delay: number;
  retryEnabled: boolean; maxAttempts: number; retryMinutes: Record<RetryOutcome, number | null>;
  priority: "new-first" | "retries-first";
  hours: { enabled: boolean; timeZone: string; days: number[]; start: string; end: string };
};
export const defaultDialerSettings: DialerSettings = {
  name: "Ma campagne", script: "", autoAdvance: true, delay: 5,
  retryEnabled: false, maxAttempts: 3, retryMinutes: { "no-answer": 60, busy: 15, voicemail: null },
  priority: "new-first", hours: { enabled: false, timeZone: "Europe/Paris", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
};
export type DialerContact = { id: string; contactId: string | null; name: string; number: string; email: string | null; phoneLabel: string; company?: string; initialNotes?: string; source?: string };
export type CallAttempt = { attemptedAt: string; endedAt: string | null; intentId: string | null; outcome: Outcome | null; notes: string };
export type QueueEntry = DialerContact & {
  status: "pending" | "calling" | "scheduled" | "done" | "skipped";
  notes: string; outcome: Outcome | null; qualificationSource: "manual" | null;
  intentId: string | null; attemptedAt: string | null; endedAt: string | null;
  attempts: CallAttempt[]; nextAttemptAt: string | null; scheduleKind: "retry" | "callback" | null;
};
export type DialerState = {
  entries: QueueEntry[]; activeId: string | null;
  phase: "ready" | "starting" | "calling" | "ending" | "wrapup" | "between" | "waiting" | "complete";
  running: boolean; remaining: number; error: string;
  settings: DialerSettings;
  // Exclusions survive resetting this campaign, within the same browser/user/org/line.
  excludedNumbers: string[];
};
export const initialDialerState: DialerState = { entries: [], activeId: null, phase: "ready", running: false, remaining: 0, error: "", settings: defaultDialerSettings, excludedNumbers: [] };
export type DialerAction =
  | { type: "add"; contacts: DialerContact[]; at?: string }
  | { type: "remove"; id: string; at?: string }
  | { type: "start"; at: string }
  | { type: "started"; id: string; intentId: string; at?: string }
  | { type: "qualify"; outcome: Outcome; delay: number; at: string; callbackAt?: string | undefined }
  | { type: "ended"; delay: number; at: string; failed?: boolean }
  | { type: "failed"; message: string }
  | { type: "pause"; message?: string }
  | { type: "tick" }
  | { type: "refresh"; at: string }
  | { type: "skip"; at?: string }
  | { type: "notes"; id: string; notes: string }
  | { type: "settings"; settings: DialerSettings; at: string }
  | { type: "reschedule"; id: string; at: string; scheduledAt: string | null }
  | { type: "restore"; state: DialerState }
  | { type: "reset" };

export function dialerContacts(contacts: Contact[]): DialerContact[] {
  const seen = new Set<string>();
  return contacts.flatMap((contact) => contact.contact_phones.flatMap((phone) => {
    const number = normalizePhoneNumber(phone.phone_number);
    if (!number || seen.has(number)) return [];
    seen.add(number);
    return [{ id: number, contactId: contact.id, name: contact.display_name, number, email: contact.email, phoneLabel: phone.label, source: "directory" }];
  }));
}
export function isDialing(state: DialerState): boolean { return ["starting", "calling", "ending"].includes(state.phase); }
export function settingsError(settings: DialerSettings): string {
  if (!settings.name.trim() || settings.name.length > 100 || settings.script.length > 5000) return "Indiquez un nom de campagne (100 caractères maximum).";
  if (!Number.isInteger(settings.delay) || settings.delay < 3 || settings.delay > 120) return "Le délai entre appels doit être compris entre 3 et 120 secondes.";
  if (!Number.isInteger(settings.maxAttempts) || settings.maxAttempts < 1 || settings.maxAttempts > 10) return "Choisissez entre 1 et 10 tentatives maximum.";
  if (Object.values(settings.retryMinutes).some((minutes) => minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 43200))) return "Les relances doivent être espacées de 1 minute à 30 jours.";
  if (!["new-first", "retries-first"].includes(settings.priority)) return "Priorité invalide.";
  const hours = settings.hours;
  try { new Intl.DateTimeFormat("fr-FR", { timeZone: hours.timeZone }).format(); } catch { return "Choisissez un fuseau horaire valide."; }
  if (!hours.days.length || hours.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hours.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hours.end) || hours.start >= hours.end) return "Choisissez au moins un jour et une heure de fin après l’heure de début.";
  return "";
}
export function withinCallingHours(settings: DialerSettings, at: string): boolean {
  if (!settings.hours.enabled) return true;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: settings.hours.timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const time = `${get("hour")}:${get("minute")}`;
  return settings.hours.days.includes(day) && time >= settings.hours.start && time < settings.hours.end;
}
export function nextDialerEntry(state: DialerState, at: string): QueueEntry | undefined {
  const eligible = state.entries.filter((entry) => !state.excludedNumbers.includes(entry.number) &&
    (entry.status === "pending" || (entry.status === "scheduled" && Boolean(entry.nextAttemptAt) && Date.parse(entry.nextAttemptAt!) <= Date.parse(at))));
  const callbacks = eligible.filter((entry) => entry.scheduleKind === "callback").sort((a, b) => (a.nextAttemptAt ?? "").localeCompare(b.nextAttemptAt ?? ""));
  if (callbacks.length) return callbacks[0];
  const retries = eligible.filter((entry) => entry.scheduleKind === "retry").sort((a, b) => (a.nextAttemptAt ?? "").localeCompare(b.nextAttemptAt ?? ""));
  const fresh = eligible.find((entry) => entry.scheduleKind !== "retry");
  return state.settings.priority === "retries-first" ? retries[0] ?? fresh : fresh ?? retries[0];
}
function advance(state: DialerState, entries: QueueEntry[], delay: number, at: string): DialerState {
  const next = nextDialerEntry({ ...state, entries }, at);
  const unfinished = entries.some((entry) => ["pending", "scheduled"].includes(entry.status));
  const inHours = withinCallingHours(state.settings, at);
  const countdown = Boolean(next && inHours && state.running && delay > 0);
  // Once there is no immediately callable contact, require an explicit resume.
  return { ...state, entries, activeId: next?.id ?? null, phase: !unfinished ? "complete" : !next || !inHours ? "waiting" : countdown ? "between" : "ready", remaining: countdown ? delay : 0, running: countdown, error: "" };
}
function finishEntry(entry: QueueEntry, settings: DialerSettings, at: string): QueueEntry {
  let nextAttemptAt = entry.outcome === "callback" ? entry.nextAttemptAt : null;
  let scheduleKind: QueueEntry["scheduleKind"] = nextAttemptAt ? "callback" : null;
  const minutes = settings.retryMinutes[entry.outcome as RetryOutcome];
  if (["no-answer", "busy", "voicemail"].includes(entry.outcome ?? "") && settings.retryEnabled && entry.attempts.length < settings.maxAttempts && minutes != null) {
    nextAttemptAt = new Date(Date.parse(at) + minutes * 60_000).toISOString(); scheduleKind = "retry";
  }
  return { ...entry, status: nextAttemptAt ? "scheduled" : "done", endedAt: entry.endedAt ?? at, nextAttemptAt, scheduleKind };
}
function updateAttempt(entry: QueueEntry, update: Partial<CallAttempt>): CallAttempt[] {
  return entry.attempts.map((attempt, index) => index === entry.attempts.length - 1 ? { ...attempt, ...update } : attempt);
}

export function dialerReducer(state: DialerState, action: DialerAction): DialerState {
  const current = state.entries.find((entry) => entry.id === state.activeId);
  switch (action.type) {
    case "add": {
      const seen = new Set([...state.entries.map((entry) => entry.number), ...state.excludedNumbers]);
      const additions = action.contacts.flatMap((contact): QueueEntry[] => {
        const number = normalizePhoneNumber(contact.number);
        if (!number || seen.has(number)) return [];
        seen.add(number);
        return [{ ...contact, id: number, number, status: "pending", notes: contact.initialNotes ?? "", outcome: null, qualificationSource: null, intentId: null, attemptedAt: null, endedAt: null, attempts: [], nextAttemptAt: null, scheduleKind: null }];
      });
      if (state.entries.length + additions.length > MAX_DIALER_CONTACTS) return { ...state, error: `Une campagne peut contenir ${MAX_DIALER_CONTACTS} numéros maximum.` };
      const entries = [...state.entries, ...additions];
      return isDialing(state) || state.phase === "wrapup" || state.running ? { ...state, entries } : advance(state, entries, 0, action.at ?? new Date().toISOString());
    }
    case "remove": {
      if (isDialing(state) || state.phase === "wrapup" || state.running) return state;
      const entries = state.entries.filter((entry) => entry.id !== action.id || entry.status !== "pending" || entry.attempts.length > 0);
      return advance(state, entries, 0, action.at ?? new Date().toISOString());
    }
    case "start": {
      if (!current || !["pending", "scheduled"].includes(current.status) || !["ready", "between"].includes(state.phase) || state.excludedNumbers.includes(current.number) || (current.nextAttemptAt && Date.parse(current.nextAttemptAt) > Date.parse(action.at))) return state;
      if (!withinCallingHours(state.settings, action.at)) return { ...state, phase: "waiting", running: false, remaining: 0 };
      return { ...state, phase: "starting", running: true, error: "", entries: state.entries.map((entry) => entry.id === current.id ? { ...entry, status: "calling", attemptedAt: action.at, endedAt: null, intentId: null, outcome: null, qualificationSource: null, attempts: [...entry.attempts, { attemptedAt: action.at, endedAt: null, intentId: null, outcome: null, notes: entry.notes }] } : entry) };
    }
    case "started":
      return { ...state, phase: state.activeId === action.id && state.phase === "starting" ? "calling" : state.phase, entries: state.entries.map((entry) => entry.id === action.id ? { ...entry, intentId: action.intentId, attempts: entry.attempts.map((attempt) => attempt.attemptedAt === (action.at ?? entry.attemptedAt) ? { ...attempt, intentId: action.intentId } : attempt) } : entry) };
    case "qualify": {
      if (!current || !["calling", "wrapup"].includes(state.phase)) return state;
      if (action.outcome === "callback" && (!action.callbackAt || !Number.isFinite(Date.parse(action.callbackAt)) || Date.parse(action.callbackAt) <= Date.parse(action.at))) return { ...state, error: "Choisissez une date de rappel dans le futur." };
      const entries = state.entries.map((entry): QueueEntry => {
        if (entry.id !== current.id) return entry;
        const qualified = { ...entry, outcome: action.outcome, qualificationSource: "manual" as const, nextAttemptAt: action.callbackAt ?? null, scheduleKind: null, attempts: updateAttempt(entry, { outcome: action.outcome, notes: entry.notes }) };
        return state.phase === "wrapup" ? finishEntry(qualified, state.settings, action.at) : qualified;
      });
      const nextState = { ...state, error: "", excludedNumbers: action.outcome === "do-not-call" ? [...new Set([...state.excludedNumbers, current.number])] : state.excludedNumbers };
      return state.phase === "wrapup" ? advance(nextState, entries, action.delay, action.at) : { ...nextState, entries, phase: "ending" };
    }
    case "ended": {
      if (!current || !isDialing(state)) return state;
      const entries = state.entries.map((entry): QueueEntry => {
        if (entry.id !== current.id) return entry;
        const ended = { ...entry, endedAt: action.at, attempts: updateAttempt(entry, { endedAt: action.at, notes: entry.notes }) };
        return entry.outcome ? finishEntry(ended, state.settings, action.at) : ended;
      });
      const nextState = { ...state, running: action.failed ? false : state.running };
      return current.outcome ? advance(nextState, entries, action.delay, action.at) : { ...nextState, entries, phase: "wrapup", error: action.failed ? "L’appel a été interrompu. Qualifiez-le avant de reprendre." : "" };
    }
    case "failed":
      if (!isDialing(state)) return state;
      return { ...state, phase: "ready", running: false, error: action.message, entries: state.entries.map((entry) => entry.id === state.activeId ? { ...entry, status: "pending", outcome: null, qualificationSource: null, attempts: entry.attempts.slice(0, -1), attemptedAt: entry.attempts.at(-2)?.attemptedAt ?? null } : entry) };
    case "pause":
      if (!state.running && action.message === undefined) return state;
      return { ...state, running: false, phase: state.phase === "between" ? "ready" : state.phase, remaining: 0, error: action.message ?? state.error };
    case "tick": return state.phase === "between" && state.running ? { ...state, remaining: Math.max(0, state.remaining - 1) } : state;
    case "refresh": {
      if (isDialing(state) || state.phase === "wrapup") return state;
      if (state.running && withinCallingHours(state.settings, action.at)) return state;
      const next = advance(state, state.entries, 0, action.at);
      return next.phase === state.phase && next.activeId === state.activeId ? state : { ...next, error: state.error };
    }
    case "skip":
      if (!current || state.phase !== "ready") return state;
      return advance({ ...state, running: false }, state.entries.map((entry) => entry.id === current.id ? { ...entry, status: "skipped", nextAttemptAt: null, scheduleKind: null } : entry), 0, action.at ?? new Date().toISOString());
    case "notes": return { ...state, entries: state.entries.map((entry) => entry.id === action.id ? { ...entry, notes: action.notes.slice(0, 5000) } : entry) };
    case "settings": {
      if (isDialing(state) || state.phase === "wrapup") return state;
      const error = settingsError(action.settings);
      if (error) return { ...state, error };
      const entries = state.entries.map((entry): QueueEntry => entry.scheduleKind === "retry" && (!action.settings.retryEnabled || entry.attempts.length >= action.settings.maxAttempts || action.settings.retryMinutes[entry.outcome as RetryOutcome] == null) ? { ...entry, status: "done", nextAttemptAt: null, scheduleKind: null } : entry);
      return advance({ ...state, settings: action.settings, running: false }, entries, 0, action.at);
    }
    case "reschedule": {
      if (isDialing(state) || state.phase === "wrapup" || state.running) return state;
      if (action.scheduledAt && (!Number.isFinite(Date.parse(action.scheduledAt)) || Date.parse(action.scheduledAt) <= Date.parse(action.at))) return { ...state, error: "Choisissez une date de rappel dans le futur." };
      const entries = state.entries.map((entry): QueueEntry => entry.id === action.id && entry.status === "scheduled" ? { ...entry, status: action.scheduledAt ? "scheduled" : "done", nextAttemptAt: action.scheduledAt, scheduleKind: action.scheduledAt ? entry.scheduleKind : null } : entry);
      return advance(state, entries, 0, action.at);
    }
    case "restore": return action.state;
    case "reset": return isDialing(state) || state.phase === "wrapup" ? state : { ...initialDialerState, excludedNumbers: state.excludedNumbers };
  }
}
