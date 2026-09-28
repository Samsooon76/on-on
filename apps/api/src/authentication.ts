import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@onoff/contracts";

// Reads that Postgres protects by row level security alone only need to know who is calling: every
// right is re-evaluated by the database on the same request. For those, an asymmetric access token
// is verified against the project's cached signing keys, which saves one Auth round trip. Everything
// else keeps the authoritative Auth check, so a signed-out or banned session stops working at once:
// every write, and reads that go through the service-role client (statistics, recordings,
// administration, call center, tags, follow-ups, MCP).
export const LOCALLY_VERIFIED_ROUTES: ReadonlySet<string> = new Set([
  "/v1/me",
  "/v1/services",
  "/v1/organizations",
  "/v1/messages/pending",
  "/v1/organizations/:orgId/lines",
  "/v1/organizations/:orgId/contacts",
  "/v1/devices",
  "/v1/contacts/:id",
  "/v1/lines/:lineId/calls",
  "/v1/lines/:lineId/conversations",
  "/v1/conversations/:id/messages",
]);

export function isLocallyVerified(method: string, route: string | undefined): boolean {
  return (method === "GET" || method === "HEAD") && route !== undefined && LOCALLY_VERIFIED_ROUTES.has(route);
}

type Claims = { sub?: unknown; role?: unknown; aud?: unknown; is_anonymous?: unknown };

// Any well-formed UUID: users created by an administrator or imported may not carry a random (v4) one.
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function userIdFromClaims(claims: Claims): string | null {
  // MCP and other delegated tokens are rejected before this point; only
  // regular signed-in users are accepted here.
  if (claims.role !== "authenticated" || claims.aud !== "authenticated" || claims.is_anonymous === true) return null;
  return typeof claims.sub === "string" && USER_ID.test(claims.sub) ? claims.sub : null;
}

/** Returns the user ID behind a bearer token, or null when it must be refused. */
export async function authenticateBearer(client: SupabaseClient<Database>, token: string, verifyLocally: boolean): Promise<string | null> {
  if (verifyLocally) {
    try {
      const { data, error } = await client.auth.getClaims(token);
      if (data) return userIdFromClaims(data.claims);
      // A malformed, expired or wrongly signed token is final. Any other failure (signing keys
      // unreachable or refused, Auth unavailable) says nothing about this token: ask Auth.
      if (error?.code === "invalid_jwt") return null;
    } catch {
      // Unexpected local failure: let Auth decide below rather than refuse a valid session.
    }
  }
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user || data.user.is_anonymous) return null;
  return data.user.id;
}
