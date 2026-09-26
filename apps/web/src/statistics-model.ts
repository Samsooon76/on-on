import type { StatisticsCall, StatisticsSnapshot } from "@onoff/contracts";

export const WEEKDAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
export const OUTCOMES = { connected: "Mis en relation", missed: "Manqué", failed: "Échec", voicemail: "Messagerie", unconfirmed: "Sans connexion confirmée", ongoing: "En cours" };
export type Outcome = keyof typeof OUTCOMES;
export type StatisticsFilters = {
  from: string; to: string; timezone: string; direction: string; userIds: string[]; teamIds: string[]; lineIds: string[];
  outcome: string; routing: string; minDuration: string; maxDuration: string; weekdays: number[]; startHour: number; endHour: number; search: string;
};
export type TimedCall = StatisticsCall & { date: string; weekday: number; hour: number };
export function shiftDate(date: string, days: number) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10); }
export function dateInZone(date: Date, timezone: string) { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date); }
export function defaultFilters(now = new Date()): StatisticsFilters {
  const today = dateInZone(now, "Europe/Paris");
  return { from: shiftDate(today, -29), to: today, timezone: "Europe/Paris", direction: "all", userIds: [], teamIds: [], lineIds: [], outcome: "all", routing: "all", minDuration: "", maxDuration: "", weekdays: [], startHour: 0, endHour: 24, search: "" };
}
export function periodDays(from: string, to: string) { return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1; }
export function validateFilters(filters: StatisticsFilters) {
  const days = periodDays(filters.from, filters.to);
  if (!Number.isFinite(days) || days < 1 || days > 90) return "Choisissez une période de 1 à 90 jours.";
  if (filters.startHour >= filters.endHour) return "L’heure de fin doit être après l’heure de début.";
  const min = filters.minDuration === "" ? null : Number(filters.minDuration), max = filters.maxDuration === "" ? null : Number(filters.maxDuration);
  if ([min, max].some(value => value !== null && (!Number.isFinite(value) || value < 0)) || (min !== null && max !== null && min > max)) return "Vérifiez les durées minimale et maximale.";
  return "";
}
export function previousPeriod(filters: StatisticsFilters) { const days = periodDays(filters.from, filters.to); return { from: shiftDate(filters.from, -days), to: shiftDate(filters.from, -1) }; }
export function queryWindow(filters: StatisticsFilters) {
  const previous = previousPeriod(filters);
  // Fetch a superset for all supported timezones; exact local-date filtering is
  // performed below, including 23/25-hour days across daylight-saving changes.
  return { from: `${shiftDate(previous.from, -1)}T00:00:00Z`, to: `${shiftDate(filters.to, 2)}T00:00:00Z` };
}
export function timedCalls(calls: StatisticsCall[], timezone: string): TimedCall[] {
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23" });
  return calls.map(call => {
    const parts = formatter.formatToParts(new Date(call.createdAt)), part = (type: string) => parts.find(item => item.type === type)!.value;
    return { ...call, date: `${part("year")}-${part("month")}-${part("day")}`, weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(part("weekday")), hour: Number(part("hour")) };
  });
}
export function outcome(call: StatisticsCall): Outcome {
  if (call.voicemailCount || call.resultCode === "voicemail") return "voicemail";
  if (call.connected) return "connected";
  if (call.status === "failed") return "failed";
  if (["missed", "canceled"].includes(call.status)) return "missed";
  return call.ended ? "unconfirmed" : "ongoing";
}
export function filterCalls(calls: TimedCall[], filters: StatisticsFilters, teams: StatisticsSnapshot["teams"], period = { from: filters.from, to: filters.to }) {
  const teamUsers = new Set(teams.filter(team => filters.teamIds.includes(team.id)).flatMap(team => team.userIds));
  const search = filters.search.trim().toLowerCase().replace(/[\s().-]/g, "");
  return calls.filter(call => call.date >= period.from && call.date <= period.to
    && (filters.direction === "all" || call.direction === filters.direction)
    && (!filters.lineIds.length || filters.lineIds.includes(call.lineId))
    && (!filters.userIds.length || call.userIds.some(id => filters.userIds.includes(id)) || (!call.userIds.length && filters.userIds.includes("unassigned")))
    && (!filters.teamIds.length || call.userIds.some(id => teamUsers.has(id)))
    && (filters.outcome === "all" || outcome(call) === filters.outcome)
    && (filters.routing === "all" || call.routing === filters.routing)
    && (!filters.weekdays.length || filters.weekdays.includes(call.weekday))
    && call.hour >= filters.startHour && call.hour < filters.endHour
    && (filters.minDuration === "" || (call.durationSeconds !== null && call.durationSeconds >= Number(filters.minDuration)))
    && (filters.maxDuration === "" || (call.durationSeconds !== null && call.durationSeconds <= Number(filters.maxDuration)))
    && (!search || call.remoteNumber.toLowerCase().replace(/[\s().-]/g, "").includes(search)));
}
export function summarize(calls: StatisticsCall[]) {
  const ended = calls.filter(call => call.ended), connected = calls.filter(call => call.connected);
  const durations = calls.flatMap(call => call.connected && call.durationSeconds !== null ? [call.durationSeconds] : []);
  const totalDuration = durations.reduce((sum, value) => sum + value, 0);
  return {
    total: calls.length, inbound: calls.filter(call => call.direction === "inbound").length, outbound: calls.filter(call => call.direction === "outbound").length,
    connected: connected.length, missed: calls.filter(call => outcome(call) === "missed").length,
    connectionRate: ended.length ? ended.filter(call => call.connected).length / ended.length * 100 : null,
    averageDuration: durations.length ? totalDuration / durations.length : null, totalDuration: durations.length ? totalDuration : null, durationSamples: durations.length,
    routed: calls.filter(call => call.routing !== "direct").length, transfers: calls.reduce((sum, call) => sum + call.transfers, 0),
    voicemailCount: calls.reduce((sum, call) => sum + call.voicemailCount, 0), voicemailSeconds: calls.reduce((sum, call) => sum + call.voicemailSeconds, 0),
  };
}
export type HeatMetric = "volume" | "missed" | "duration" | "connection";
export function heatmap(calls: TimedCall[], metric: HeatMetric) {
  const buckets = Array.from({ length: 168 }, () => [] as TimedCall[]);
  calls.forEach(call => buckets[call.weekday * 24 + call.hour]!.push(call));
  return buckets.map((bucket, index) => {
    const summary = summarize(bucket);
    return { weekday: Math.floor(index / 24), hour: index % 24, count: bucket.length, value: metric === "volume" ? bucket.length : metric === "missed" ? summary.missed : metric === "duration" ? summary.averageDuration : summary.connectionRate };
  });
}
export function dailySeries(calls: TimedCall[], from: string, to: string) {
  const buckets = new Map<string, { date: string; inbound: number; outbound: number }>();
  for (let date = from; date <= to; date = shiftDate(date, 1)) buckets.set(date, { date, inbound: 0, outbound: 0 });
  for (const call of calls) { const day = buckets.get(call.date); if (day) day[call.direction]++; }
  return [...buckets.values()];
}
export function duration(value: number | null) {
  if (value === null) return "—";
  const seconds = Math.round(value);
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h ${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}
export function percentage(value: number | null) { return value === null ? "—" : `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(value)} %`; }
export function csv(calls: StatisticsCall[], snapshot: StatisticsSnapshot, timezone: string) {
  const safe = (value: unknown) => { let text = String(value ?? ""); if (/^\s*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
  const rows = [["ID", `Date (${timezone})`, "Sens", "Numéro distant", "Ligne", "Utilisateurs", "Résultat", "Durée (s)", "Routage", "Messages vocaux", "Transferts"]];
  for (const call of calls) rows.push([call.id, new Date(call.createdAt).toLocaleString("fr-FR", { timeZone: timezone }), call.direction, call.remoteNumber, snapshot.lines.find(line => line.id === call.lineId)?.number ?? call.lineId, call.userIds.map(id => snapshot.users.find(user => user.id === id)?.name ?? id).join(", "), OUTCOMES[outcome(call)], call.durationSeconds === null ? "" : String(call.durationSeconds), call.routing, String(call.voicemailCount), String(call.transfers)]);
  return "\uFEFF" + rows.map(row => row.map(safe).join(";")).join("\r\n");
}
