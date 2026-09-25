import { normalizePhoneNumber } from "@onoff/contracts";

const phoneCandidate = /(?:\+|00)?\d[\d\s().-]{4,}\d/g;

/** Return one unambiguous, valid number from the text the user selected. */
export function extractSelectedPhone(text: string): string | null {
  if (text.length > 2_000) return null;

  const candidates = new Set<string>();
  for (const match of text.matchAll(phoneCandidate)) {
    const normalized = normalizePhoneNumber(match[0]);
    if (normalized) candidates.add(normalized);
    if (candidates.size > 1) return null;
  }
  return candidates.values().next().value ?? null;
}

/** Allow HTTPS applications and HTTP only on loopback for local development. */
export function normalizeWebAppUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    return url.toString();
  } catch {
    return null;
  }
}

export function createComposeUrl(baseUrl: string, destination: string): string | null {
  const normalizedBaseUrl = normalizeWebAppUrl(baseUrl);
  const normalizedDestination = normalizePhoneNumber(destination);
  if (!normalizedBaseUrl || !normalizedDestination) return null;

  const url = new URL(normalizedBaseUrl);
  url.searchParams.set("callTo", normalizedDestination);
  return url.toString();
}
