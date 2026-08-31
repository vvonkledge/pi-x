import assert from "node:assert/strict";
import test from "node:test";

import { assertNoLiteralApiKey, buildModelsConfig } from "../src/models-config.js";
import { Refusal } from "../src/outcome.js";
import { DEFAULT_CREDENTIAL_COMMAND } from "../src/spec.js";
import { FAKE_SECRETS } from "./helpers/lab.mjs";

test("the generated model reference is a command, never a value", () => {
  const config = buildModelsConfig({
    provider: "anthropic",
    id: "claude-opus-4-5",
    thinking: "high",
    credentialCommand: DEFAULT_CREDENTIAL_COMMAND,
    providerConfig: null,
  });
  assert.deepEqual(config, {
    providers: {
      anthropic: { apiKey: `!${DEFAULT_CREDENTIAL_COMMAND}` },
    },
  });
  // The dedicated fleet entry, not the captain's own credential.
  assert.match(config.providers.anthropic.apiKey, /pi-x-minion$/);
});

test("a provider config is merged but never allowed to supply the credential", () => {
  const config = buildModelsConfig({
    provider: "fake",
    id: "scripted-1",
    thinking: "off",
    credentialCommand: "printf placeholder",
    providerConfig: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions" },
  });
  assert.equal(config.providers.fake.baseUrl, "http://127.0.0.1:1/v1");
  assert.equal(config.providers.fake.apiKey, "!printf placeholder");
});

test("a literal apiKey is refused rather than written to disk", () => {
  // The minion's own bash tool is handed the path of the directory this file
  // lives in through PI_CODING_AGENT_DIR.
  assert.throws(
    () => assertNoLiteralApiKey({ providers: { anthropic: { apiKey: FAKE_SECRETS.providerKey } } }),
    Refusal,
  );
  assert.throws(() => assertNoLiteralApiKey({ providers: { anthropic: {} } }), Refusal);
});
