import assert from "node:assert/strict";
import test from "node:test";

import { EXIT_CODES, exitCodeFor, OUTCOMES } from "../src/outcome.js";
import { classifySettled } from "../src/run.js";

test("the outcome and exit-code table is exactly the published one", () => {
  assert.deepEqual(EXIT_CODES, {
    "settled-ok": 0,
    "settled-error": 10,
    "settled-truncated": 11,
    cancelled: 12,
    rejected: 20,
    "timeout-startup": 21,
    "timeout-idle": 22,
    "timeout-wall": 23,
    crashed: 30,
    "preflight-refused": 40,
  });
  assert.equal(OUTCOMES.length, 10);
  assert.equal(new Set(Object.values(EXIT_CODES)).size, 10);
});

test("an outcome outside the closed set is an error, never a silent zero", () => {
  assert.throws(() => exitCodeFor("succeeded"), /unknown outcome/);
});

test("stopReason decides the settled outcome and only stop or toolUse is success", () => {
  assert.equal(classifySettled("stop"), "settled-ok");
  assert.equal(classifySettled("toolUse"), "settled-ok");
  assert.equal(classifySettled("error"), "settled-error");
  assert.equal(classifySettled("length"), "settled-truncated");
  assert.equal(classifySettled("aborted"), "cancelled");
  // Settled with no assistant message is not a success.
  assert.equal(classifySettled(null), "settled-error");
  assert.equal(classifySettled(undefined), "settled-error");
});
