import assert from "node:assert/strict";
import test from "node:test";

import { JsonlReader, ProtocolViolation } from "../src/jsonl.js";

test("records split on LF only", () => {
  const reader = new JsonlReader();
  const records = reader.push('{"type":"a"}\n{"type":"b"}\n');
  assert.deepEqual(records.map((record) => record.type), ["a", "b"]);
});

test("a record split across chunks is reassembled", () => {
  const reader = new JsonlReader();
  assert.deepEqual(reader.push('{"type":"a","x":'), []);
  assert.deepEqual(reader.push('1}\n').map((record) => record.x), [1]);
});

test("U+2028 and U+2029 inside a string never split a record", () => {
  // Node readline splits on both, which is why RPC mode warns against generic
  // line readers: a record carrying one would be torn in half.
  const text = "a\u2028b\u2029c";
  const payload = JSON.stringify({ type: "message_update", text });
  assert.ok(payload.includes("\u2028"), "the separators must survive serialization");
  assert.ok(payload.includes("\u2029"), "the separators must survive serialization");

  const records = new JsonlReader().push(`${payload}\n`);
  assert.equal(records.length, 1);
  assert.equal(records[0].text, text);
});

test("CRLF is accepted by stripping only the trailing CR", () => {
  const records = new JsonlReader().push('{"type":"a","text":"x\\r\\ny"}\r\n');
  assert.equal(records.length, 1);
  assert.equal(records[0].text, "x\r\ny");
});

test("blank lines are not records", () => {
  assert.deepEqual(new JsonlReader().push('\n\n{"type":"a"}\n').map((r) => r.type), ["a"]);
});

test("a malformed record fails closed", () => {
  assert.throws(() => new JsonlReader().push("not json\n"), ProtocolViolation);
  assert.throws(() => new JsonlReader().push("[1,2]\n"), ProtocolViolation);
  assert.throws(() => new JsonlReader().push('{"no":"type"}\n'), ProtocolViolation);
});

test("a stream ending mid-record fails closed", () => {
  const reader = new JsonlReader();
  reader.push('{"type":"a"}\n{"type":"b"');
  assert.throws(() => reader.end(), ProtocolViolation);
});

test("a stream ending on a record boundary is clean", () => {
  const reader = new JsonlReader();
  reader.push('{"type":"a"}\n');
  reader.end();
});

test("data after end of stream fails closed", () => {
  const reader = new JsonlReader();
  reader.end();
  assert.throws(() => reader.push('{"type":"a"}\n'), ProtocolViolation);
});
