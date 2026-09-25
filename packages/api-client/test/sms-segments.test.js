import assert from "node:assert/strict";
import test from "node:test";
import { getSmsSegmentInfo } from "../dist/index.js";

test("French accented GSM-7 text counts one septet per character", () => {
  const text = "Ça va déjà, merci !";
  assert.deepEqual(getSmsSegmentInfo(text), {
    encoding: "GSM-7",
    characterCount: text.length,
    segments: 1,
    singleSegmentLimit: 160,
    multipartSegmentLimit: 153,
  });
});

test("GSM-7 extension characters use two septets", () => {
  assert.deepEqual(getSmsSegmentInfo("a^b"), {
    encoding: "GSM-7",
    characterCount: 4,
    segments: 1,
    singleSegmentLimit: 160,
    multipartSegmentLimit: 153,
  });
});

test("long GSM-7 bodies use concatenated-message limits", () => {
  assert.equal(getSmsSegmentInfo("a".repeat(160)).segments, 1);
  assert.equal(getSmsSegmentInfo("a".repeat(161)).segments, 2);
  assert.equal(getSmsSegmentInfo("a".repeat(306)).segments, 2);
  assert.equal(getSmsSegmentInfo("a".repeat(307)).segments, 3);
});

test("emoji use Unicode code units and Unicode concatenation limits", () => {
  assert.deepEqual(getSmsSegmentInfo("🙂"), {
    encoding: "Unicode",
    characterCount: 2,
    segments: 1,
    singleSegmentLimit: 70,
    multipartSegmentLimit: 67,
  });
  assert.equal(getSmsSegmentInfo("🙂".repeat(36)).segments, 2);
  assert.equal(getSmsSegmentInfo("🙂".repeat(35)).segments, 1);
});
