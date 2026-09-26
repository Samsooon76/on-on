import { normalizePhoneNumber } from "@onoff/contracts";
import type { Contact } from "./conversation-model";

export const outcomes = [
  { id: "interested", label: "Intéressé", key: "1" },
  { id: "callback", label: "À rappeler", key: "2" },
  { id: "not-interested", label: "Pas intéressé", key: "3" },
  { id: "no-answer", label: "Sans réponse", key: "4" },
  { id: "voicemail", label: "Répondeur", key: "5" },
] as const;
export type Outcome = typeof outcomes[number]["id"];
export type DialerContact = { id: string; contactId: string; name: string; number: string; email: string | null; phoneLabel: string };
export type QueueEntry = DialerContact & {
  status: "pending" | "calling" | "done" | "skipped";
  notes: string;
  outcome: Outcome | null;
  qualificationSource: "manual" | null;
  // Correlation for the future server-side call/JEV integration. Never infer
  // an argued call, a business outcome or remote pickup from an SDK event.
  intentId: string | null;
  attemptedAt: string | null;
  endedAt: string | null;
};
export type DialerState = {
  entries: QueueEntry[];
  activeId: string | null;
  phase: "ready" | "starting" | "calling" | "ending" | "wrapup" | "between" | "complete";
  running: boolean;
  remaining: number;
  error: string;
};
export const initialDialerState: DialerState = { entries: [], activeId: null, phase: "ready", running: false, remaining: 0, error: "" };
export type DialerAction =
  | { type: "add"; contacts: DialerContact[] }
  | { type: "remove"; id: string }
  | { type: "start"; at: string }
  | { type: "started"; id: string; intentId: string }
  | { type: "qualify"; outcome: Outcome; delay: number; at: string }
  | { type: "ended"; delay: number; at: string; failed?: boolean }
  | { type: "failed"; message: string }
  | { type: "pause"; message?: string }
  | { type: "tick" }
  | { type: "skip" }
  | { type: "notes"; id: string; notes: string }
  | { type: "reset" };

export function dialerContacts(contacts: Contact[]): DialerContact[] {
  const seen = new Set<string>();
  return contacts.flatMap((contact) => contact.contact_phones.flatMap((phone) => {
    const number = normalizePhoneNumber(phone.phone_number);
    if (!number || seen.has(number)) return [];
    seen.add(number);
    return [{ id: number, contactId: contact.id, name: contact.display_name, number, email: contact.email, phoneLabel: phone.label }];
  }));
}

export function isDialing(state: DialerState): boolean {
  return ["starting", "calling", "ending"].includes(state.phase);
}

function advance(state: DialerState, entries: QueueEntry[], delay: number): DialerState {
  const next = entries.find((entry) => entry.status === "pending");
  const countdown = Boolean(next && state.running && delay > 0);
  return { ...state, entries, activeId: next?.id ?? null, phase: !next ? "complete" : countdown ? "between" : "ready", remaining: countdown ? delay : 0, running: countdown, error: "" };
}

export function dialerReducer(state: DialerState, action: DialerAction): DialerState {
  const current = state.entries.find((entry) => entry.id === state.activeId);
  switch (action.type) {
    case "add": {
      const seen = new Set(state.entries.map((entry) => entry.number));
      const additions = action.contacts.filter((contact) => {
        if (seen.has(contact.number)) return false;
        seen.add(contact.number); return true;
      }).map((contact): QueueEntry => ({ ...contact, status: "pending", notes: "", outcome: null, qualificationSource: null, intentId: null, attemptedAt: null, endedAt: null }));
      const entries = [...state.entries, ...additions];
      return { ...state, entries, activeId: state.activeId ?? additions[0]?.id ?? null, phase: additions.length && state.phase === "complete" ? "ready" : state.phase };
    }
    case "remove": {
      if (isDialing(state) || state.phase === "wrapup" || state.running) return state;
      const entries = state.entries.filter((entry) => entry.id !== action.id || entry.status !== "pending");
      return { ...state, entries, activeId: entries.some((entry) => entry.id === state.activeId) ? state.activeId : entries.find((entry) => entry.status === "pending")?.id ?? null };
    }
    case "start":
      if (!current || current.status !== "pending" || !["ready", "between"].includes(state.phase)) return state;
      return { ...state, phase: "starting", running: true, error: "", entries: state.entries.map((entry) => entry.id === current.id ? { ...entry, status: "calling", attemptedAt: action.at } : entry) };
    case "started":
      return { ...state, phase: state.activeId === action.id && state.phase === "starting" ? "calling" : state.phase, entries: state.entries.map((entry) => entry.id === action.id ? { ...entry, intentId: action.intentId } : entry) };
    case "qualify": {
      if (!current || !["calling", "wrapup"].includes(state.phase)) return state;
      const entries = state.entries.map((entry): QueueEntry => entry.id === current.id ? { ...entry, outcome: action.outcome, qualificationSource: "manual", ...(state.phase === "wrapup" ? { status: "done", endedAt: entry.endedAt ?? action.at } : {}) } : entry);
      return state.phase === "wrapup" ? advance(state, entries, action.delay) : { ...state, entries, phase: "ending" };
    }
    case "ended": {
      if (!current || !isDialing(state)) return state;
      const entries = state.entries.map((entry): QueueEntry => entry.id === current.id ? { ...entry, endedAt: action.at, status: entry.outcome ? "done" : "calling" } : entry);
      const nextState = { ...state, running: action.failed ? false : state.running };
      return current.outcome ? advance(nextState, entries, action.delay) : { ...nextState, entries, phase: "wrapup", error: action.failed ? "L’appel a été interrompu. Qualifiez-le avant de reprendre." : "" };
    }
    case "failed":
      if (!isDialing(state)) return state;
      return { ...state, phase: "ready", running: false, error: action.message, entries: state.entries.map((entry) => entry.id === state.activeId ? { ...entry, status: "pending", outcome: null, qualificationSource: null } : entry) };
    case "pause":
      return { ...state, running: false, phase: state.phase === "between" ? "ready" : state.phase, remaining: 0, error: action.message ?? state.error };
    case "tick":
      return state.phase === "between" && state.running ? { ...state, remaining: Math.max(0, state.remaining - 1) } : state;
    case "skip":
      if (!current || state.phase !== "ready") return state;
      return advance({ ...state, running: false }, state.entries.map((entry) => entry.id === current.id ? { ...entry, status: "skipped" } : entry), 0);
    case "notes":
      return { ...state, entries: state.entries.map((entry) => entry.id === action.id ? { ...entry, notes: action.notes } : entry) };
    case "reset":
      return isDialing(state) || state.phase === "wrapup" ? state : initialDialerState;
  }
}
