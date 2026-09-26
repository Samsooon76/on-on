import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";

const orgId = "00000000-0000-4000-8000-000000000001", id = "00000000-0000-4000-8000-000000000002";
const config = loadConfig({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "publishable-test" });
function setup(t, phoneError = false) {
  const queries = [];
  const app = createApp(config, { createSupabaseClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user", is_anonymous: false } }, error: null }) },
    from: table => {
      const filters = []; queries.push({ table, filters });
      const query = { then: (resolve, reject) => Promise.resolve({ data: table === "contact_phones" ? [{ contact_id: id }] : [], error: phoneError && table === "contact_phones" ? { code: "unavailable" } : null }).then(resolve, reject) };
      for (const method of ["select", "eq", "in", "is", "order", "limit", "or", "ilike"]) query[method] = (...args) => { filters.push([method, ...args]); return query; };
      return query;
    },
  }) });
  t.after(() => app.close());
  return { queries, search: q => app.inject({ method: "GET", url: `/v1/organizations/${orgId}/contacts?${new URLSearchParams({ q })}`, headers: { authorization: "Bearer session" } }) };
}
test("phone search normalizes numbers, scopes the lookup and preserves all contact phones", async t => {
  const { queries, search } = setup(t); const response = await search("06 00 00 00 01");
  assert.equal(response.statusCode, 200);
  assert.ok(queries.find(q => q.table === "contact_phones").filters.some(f => f[0] === "eq" && f[1] === "organization_id" && f[2] === orgId));
  assert.ok(queries.find(q => q.table === "contact_phones").filters.some(f => f[0] === "eq" && f[1] === "phone_number" && f[2] === "+33600000001"));
  assert.ok(queries.find(q => q.table === "contacts").filters.some(f => f[0] === "in" && f[1] === "id" && f[2][0] === id));
  assert.ok(!queries.find(q => q.table === "contacts").filters.some(f => f[1] === "contact_phones.phone_number"));
});
test("provider lookup errors are not presented as empty search results", async t => {
  const { search } = setup(t, true); assert.equal((await search("+33600000001")).statusCode, 503);
});
test("email searches and wildcard-like names remain literal scoped filters", async t => {
  const { queries, search } = setup(t); await search("name@example.test"); await search("100%_name");
  assert.ok(queries.some(q => q.filters.some(f => f[0] === "ilike" && f[1] === "email")));
  assert.ok(queries.some(q => q.filters.some(f => f[0] === "ilike" && f[2] === "%100\\%\\_name%")));
});
