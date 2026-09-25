import assert from "node:assert/strict";
import test from "node:test";
import { contactCreateSchema, contactUpdateSchema, e164Schema, normalizePhoneNumber } from "../dist/index.js";

test("E.164 numbers are accepted and malformed destinations are rejected", () => {
  assert.equal(e164Schema.safeParse("+32470000000").success, true);
  assert.equal(e164Schema.safeParse("0470000000").success, false);
});

test("phone normalization shares E.164 handling with the French dialer", () => {
  assert.equal(normalizePhoneNumber("06 11 11 11 11"), "+33611111111");
  assert.equal(normalizePhoneNumber("0033 (0)6 11 11 11 11"), "+33611111111");
  assert.equal(normalizePhoneNumber("0033 6 11 11 11 11"), "+33611111111");
  assert.equal(normalizePhoneNumber("+32 (470) 00-00-00"), "+32470000000");
  assert.equal(normalizePhoneNumber("tel:+33611111111"), null);
  assert.equal(normalizePhoneNumber("+33++611111111"), null);
});

test("contact creation trims fields and supplies an empty phone list", () => {
  const parsed = contactCreateSchema.parse({
    organizationId: "7aa49c6e-bfbd-4a32-93a6-231681988513",
    displayName: "  Alex Martin  ",
  });
  assert.equal(parsed.displayName, "Alex Martin");
  assert.deepEqual(parsed.phones, []);
});

test("contacts reject invalid phones and require a version for updates", () => {
  const base = {
    organizationId: "7aa49c6e-bfbd-4a32-93a6-231681988513",
    displayName: "Alex Martin",
    phones: [{ phoneNumber: "+32470000000", label: "Mobile" }],
  };
  assert.equal(contactCreateSchema.safeParse({ ...base, phones: [{ phoneNumber: "invalid", label: "Mobile" }] }).success, false);
  const { organizationId: _organizationId, ...update } = base;
  assert.equal(contactUpdateSchema.safeParse(update).success, false);
  assert.equal(contactUpdateSchema.safeParse({ ...update, version: 1 }).success, true);
});
