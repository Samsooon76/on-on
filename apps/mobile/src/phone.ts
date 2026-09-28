export type PhoneCountry = "BE" | "FR" | "GB" | "US";

export const phoneCountries: { code: PhoneCountry; name: string; callingCode: string; minNationalLength: number; maxNationalLength: number }[] = [
  { code: "BE", name: "Belgique", callingCode: "+32", minNationalLength: 8, maxNationalLength: 10 },
  { code: "FR", name: "France", callingCode: "+33", minNationalLength: 9, maxNationalLength: 9 },
  { code: "GB", name: "Royaume-Uni", callingCode: "+44", minNationalLength: 9, maxNationalLength: 10 },
  { code: "US", name: "États-Unis", callingCode: "+1", minNationalLength: 10, maxNationalLength: 10 },
];

const e164Pattern = /^\+[1-9]\d{7,14}$/;

function findCountryByCallingCode(digits: string) {
  return [...phoneCountries].sort((left, right) => right.callingCode.length - left.callingCode.length)
    .find((country) => digits.startsWith(country.callingCode.slice(1)));
}

function hasPlausibleNationalLength(country: (typeof phoneCountries)[number], digits: string) {
  const nationalLength = digits.length - country.callingCode.length + 1;
  return nationalLength >= country.minNationalLength && nationalLength <= country.maxNationalLength;
}

/** Infer a country from an international prefix, or a complete unprefixed E.164 number. */
export function getPhoneCountry(value: string): PhoneCountry | null {
  const trimmed = value.trim();
  const explicitInternational = trimmed.startsWith("+") || trimmed.startsWith("00");
  const digits = trimmed.replace(/\D/g, "").replace(/^00/, "");
  const country = findCountryByCallingCode(digits);
  if (!country) return null;
  if (explicitInternational) return country.code;
  return hasPlausibleNationalLength(country, digits) ? country.code : null;
}

export function normalizePhone(value: string, defaultCountry: PhoneCountry = "BE"): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const compact = trimmed.replace(/[\s().-]/g, "");
  let candidate: string;
  if (compact.startsWith("+")) candidate = `+${compact.slice(1).replace(/\D/g, "")}`;
  else if (compact.startsWith("00")) candidate = `+${compact.slice(2).replace(/\D/g, "")}`;
  else {
    const digits = compact.replace(/\D/g, "");
    const detectedCountry = getPhoneCountry(digits);
    if (detectedCountry) candidate = `+${digits}`;
    else {
      const country = phoneCountries.find((item) => item.code === defaultCountry) ?? phoneCountries[0]!;
      const callingCode = country.callingCode.slice(1);
      let nationalNumber = digits;
      if (country.code === "US" && digits.length === 11 && digits.startsWith("1")) candidate = `+${digits}`;
      else {
        if (country.code !== "US" && nationalNumber.startsWith("0")) nationalNumber = nationalNumber.slice(1);
        candidate = `+${callingCode}${nationalNumber}`;
      }
    }
  }

  for (const country of phoneCountries) {
    const callingCode = country.callingCode;
    if (country.code !== "US" && candidate.startsWith(`${callingCode}0`)) {
      candidate = `${callingCode}${candidate.slice(callingCode.length + 1)}`;
      break;
    }
  }
  return candidate;
}

export function isDialableNumber(value: string, defaultCountry: PhoneCountry = "BE"): boolean {
  return /^[+]?[\d\s().-]+$/.test(value.trim()) && e164Pattern.test(normalizePhone(value, defaultCountry));
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
