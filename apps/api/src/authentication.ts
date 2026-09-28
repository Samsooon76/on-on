import type { SupabaseClient } from "@supabase/supabase-js";
import { uuidSchema, type Database } from "@onoff/contracts";

// Reads only need to know who is calling: Postgres re-evaluates every right
// through RLS on the same request. Asymmetric access tokens can therefore be
// verified against the project's cached signing keys, which saves one Auth
// round trip per read. Anything that changes state keeps the authoritative
// Auth check, so a signed-out or banned session stops working immediately.
const LOCALLY_VERIFIED_METHODS = new Set(["GET", "HEAD"]);

type Claims = { sub?: unknown; role?: unknown; aud?: unknown; is_anonymous?: unknown };

function userIdFromClaims(claims: Claims): string | null {
  // MCP and other delegated tokens are rejected before this point; only
  // regular signed-in users are accepted here.
  if (claims.role !== "authenticated" || claims.aud !== "authenticated" || claims.is_anonymous === true) return null;
  const subject = uuidSchema.safeParse(claims.sub);
  return subject.success ? subject.data : null;
}

/** Returns the user ID behind a bearer token, or null when it must be refused. */
export async function authenticateBearer(client: SupabaseClient<Database>, token: string, method: string): Promise<string | null> {
  if (LOCALLY_VERIFIED_METHODS.has(method)) {
    try {
      const { data, error } = await client.auth.getClaims(token);
      if (data) return userIdFromClaims(data.claims);
      // Malformed, expired or wrongly signed tokens, and tokens Auth itself refused,
      // are final: asking Auth a second time cannot change the answer.
      if (typeof error?.status === "number" && error.status >= 400 && error.status < 500) return null;
    } catch {
      // Unexpected local failure: let Auth decide below rather than refuse a valid session.
    }
    // Signing keys unreachable or unusable: fall back to the authoritative check.
  }
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user || data.user.is_anonymous) return null;
  return data.user.id;
}
