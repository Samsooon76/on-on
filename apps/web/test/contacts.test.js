import test from "node:test";
import assert from "node:assert/strict";
import { editedContactPhones } from "../src/contact-model.ts";

const contact = { contact_phones: [
  { phone_number: "+33100000001", label: "Bureau" },
  { phone_number: "+33600000002", label: "Mobile" },
] };

test("editing the first phone preserves secondary numbers and their labels", () => {
  assert.deepEqual(editedContactPhones(contact, "+33100000003"), [
    { phoneNumber: "+33100000003", label: "Bureau" },
    { phoneNumber: "+33600000002", label: "Mobile" },
  ]);
  assert.equal(contact.contact_phones[0].phone_number, "+33100000001");
});
test("clearing the first phone does not erase the other numbers", () => {
  assert.deepEqual(editedContactPhones(contact, null), [{ phoneNumber: "+33600000002", label: "Mobile" }]);
});
test("selecting a secondary number as primary does not submit a duplicate", () => {
  assert.deepEqual(editedContactPhones(contact, "+33600000002"), [{ phoneNumber: "+33600000002", label: "Bureau" }]);
});
