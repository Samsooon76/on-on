import assert from "node:assert/strict";
import test from "node:test";
import { normalizePhoneNumber } from "@onoff/contracts";
import { readPagePhones } from "../src/page.ts";

test("page scan finds formatted numbers, tel links and distinct adjacent French numbers", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { getSelection: () => "06 11 11 11 11" } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    body: { innerText: "Contact 06 11 11 11 11 / 01.23.45.67.89\n+33 (0)6 22 33 44 55\n0044 20 7946 0958\n06 33 44 55 66 07 44 55 66 77\nRéférence ABC0612345678Z\n2026-09-28" },
    querySelectorAll: () => [{ getAttribute: () => "tel:%2B33123456789;ext=42" }, { getAttribute: () => "tel:%broken" }],
  } });
  try {
    const phones = [...new Set(readPagePhones().map(normalizePhoneNumber).filter(Boolean))];
    assert.deepEqual(phones, ["+33611111111", "+33123456789", "+33622334455", "+442079460958", "+33633445566", "+33744556677"]);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document");
  }
});
