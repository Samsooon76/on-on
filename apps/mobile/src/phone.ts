export function normalizePhone(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("+")) return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.startsWith("0")) return `+32${digits.slice(1)}`;
  return digits ? `+32${digits}` : "";
}

export function isDialableNumber(value: string): boolean {
  return /^\+?[\d\s().-]+$/.test(value.trim()) && /^\+[1-9]\d{7,14}$/.test(normalizePhone(value));
}

export function editDialNumber(value: string, selection: { start: number; end: number }, digit: string | null) {
  const start = Math.max(0, Math.min(selection.start, value.length));
  const end = Math.max(start, Math.min(selection.end, value.length));
  const from = digit === null && start === end ? Math.max(0, start - 1) : start;
  const next = `${value.slice(0, from)}${digit ?? ""}${value.slice(end)}`.slice(0, 32);
  const cursor = Math.min(from + (digit?.length ?? 0), next.length);
  return { value: next, selection: { start: cursor, end: cursor } };
}

export function isMissedCall(call: { direction: string; status: string }): boolean {
  return call.direction === "inbound" && ["missed", "no-answer", "busy", "canceled"].includes(call.status);
}

export function callStatusLabel(status: string): string {
  return ({ completed: "Terminé", "no-answer": "Sans réponse", missed: "Manqué", busy: "Occupé", canceled: "Annulé", failed: "Échec", ringing: "Sonnerie", queued: "En attente", "in-progress": "En cours", initiated: "Connexion" } as Record<string, string>)[status] ?? status;
}

export function messageStatusLabel(status: string): string {
  return ({ queued: "En attente", sending: "Envoi…", submitting: "Envoi…", sent: "Envoyé", delivered: "Remis", received: "Reçu", failed: "Échec", undelivered: "Non remis", unknown: "À vérifier" } as Record<string, string>)[status] ?? status;
}

export function relativeCallDate(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("fr-BE", { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  return date.toDateString() === yesterday.toDateString() ? "Hier" : date.toLocaleDateString("fr-BE", { day: "numeric", month: "short" });
}
