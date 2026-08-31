// The rule the harness exists to keep: no credential in the repository, in a
// fixture, or in anything pix writes. Cheap to check, so it is checked.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { looksLikeCredentialKey, looksLikeSecret } from "../src/secrets.js";
import { CREDENTIAL_PLACEHOLDER, FAKE_SECRETS, repoRoot } from "./helpers/lab.mjs";

// Deliberately narrower than the value scan the product applies to a spec.
// Source that assigns a field named apiKey, or a placeholder that says it is not
// a credential, is ordinary repository content; a provider key prefix or a PEM
// private key header never legitimately appears here.
const COMMITTED_SECRET = [
  /(?:^|[^A-Za-z0-9])(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

test("the value scan recognises the shapes a spec must be refused for", () => {
  for (const value of [
    FAKE_SECRETS.providerKey,
    FAKE_SECRETS.captainKey,
    FAKE_SECRETS.opaque,
    FAKE_SECRETS.privateKeyHeader,
    `ANTHROPIC${"_"}API_KEY=abcdefghijkl`,
  ]) {
    assert.equal(looksLikeSecret(value), true, value);
  }
  for (const value of [
    "security find-generic-password -ws pi-x-minion",
    "/Users/someone/.local/state/pi-x/runs/build-pix-one-shot/sessions",
    "claude-opus-4-5-20251101",
    CREDENTIAL_PLACEHOLDER,
    // A git object id is opaque and is not a credential.
    "3d3c42e5aac5ba805825da76410c181273ba90b1",
  ]) {
    assert.equal(looksLikeSecret(value), false, value);
  }
});

test("the key scan recognises names that announce themselves as credentials", () => {
  for (const key of ["ANTHROPIC_API_KEY", "GH_TOKEN", "MY_SECRET", "DB_PASSWORD"]) {
    assert.equal(looksLikeCredentialKey(key), true, key);
  }
  for (const key of ["SIANA_HOME", "SIANA_TASK_ID", "PATH", "CI"]) {
    assert.equal(looksLikeCredentialKey(key), false, key);
  }
});

test("no tracked file carries a committed credential", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter((file) => file !== "");
  assert.ok(files.length > 0, "the scan found no files to scan");

  for (const file of files) {
    const contents = fs.readFileSync(path.join(repoRoot, file), "utf8");
    for (const [index, line] of contents.split("\n").entries()) {
      for (const pattern of COMMITTED_SECRET) {
        assert.equal(
          pattern.test(line),
          false,
          `${file}:${index + 1} looks like it carries a credential`,
        );
      }
    }
  }
});
