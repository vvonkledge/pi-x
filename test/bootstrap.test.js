import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the harness package cannot be published accidentally", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("package.json", root), "utf8"),
  );

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.type, "module");
});

test("the repository states its purpose", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");

  assert.match(readme, /Pi agent harness for SIANA's minions/);
});
