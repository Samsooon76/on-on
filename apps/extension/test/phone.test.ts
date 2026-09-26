import assert from "node:assert/strict";
import test from "node:test";
import { createComposeUrl, createTagsUrl, extractSelectedPhone, normalizeWebAppUrl } from "../src/phone.ts";

test("selection parsing returns only one valid number and never the surrounding page text", () => {
  assert.equal(extractSelectedPhone("Appeler le 06 11 11 11 11 dès demain"), "+33611111111");
  assert.equal(extractSelectedPhone("06 11 11 11 11 ou 01 23 45 67 89"), null);
  assert.equal(extractSelectedPhone("aucun numéro"), null);
  assert.equal(extractSelectedPhone("06 11 11 11 11".repeat(300)), null);
});

test("web app URLs require HTTPS except for loopback development", () => {
  assert.equal(normalizeWebAppUrl("https://app.example.test/onoff"), "https://app.example.test/onoff/");
  assert.equal(normalizeWebAppUrl("http://localhost:5173"), "http://localhost:5173/");
  assert.equal(normalizeWebAppUrl("http://app.example.test"), null);
  assert.equal(normalizeWebAppUrl("javascript:alert(1)"), null);
  assert.equal(normalizeWebAppUrl("https://user:password@app.example.test"), null);
});

test("compose links carry only a normalized number as an untrusted draft", () => {
  const result = createComposeUrl("https://app.example.test", "06 11 11 11 11");
  assert.equal(result, "https://app.example.test/?callTo=%2B33611111111");
  assert.equal(createComposeUrl("https://app.example.test", "not a number"), null);
  assert.equal(createComposeUrl("https://evil.example.test", "+33611111111"), "https://evil.example.test/?callTo=%2B33611111111");
});

test("tag settings reuse the trusted app URL without tokens", () => {
  assert.equal(createTagsUrl("https://app.example.test/onoff"), "https://app.example.test/onoff/?settings=tags#call-tags");
  assert.equal(createTagsUrl("http://localhost:5173"), "http://localhost:5173/?settings=tags#call-tags");
  for (const url of ["javascript:alert(1)", "https://user:pass@app.example.test", "https://app.example.test?token=secret", "http://remote.test"]) assert.equal(createTagsUrl(url), null);
});
