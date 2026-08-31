// The generated model reference. The credential is a command Pi runs at request
// time, so the secret exists only in the OS keychain and in the provider request
// header; it is never in this file, in argv, or in the harness's memory.

import { Refusal } from "./outcome.js";

export function buildModelsConfig(model) {
  const provider = {
    ...(model.providerConfig ?? {}),
    apiKey: `!${model.credentialCommand}`,
  };
  const config = { providers: { [model.provider]: provider } };
  assertNoLiteralApiKey(config);
  return config;
}

// A literal here would put a plaintext credential in a directory whose path the
// minion's own bash tool is handed through PI_CODING_AGENT_DIR.
export function assertNoLiteralApiKey(config) {
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    const apiKey = provider?.apiKey;
    if (typeof apiKey !== "string" || !apiKey.startsWith("!")) {
      throw new Refusal(
        `models.providers.${name}.apiKey`,
        "must be a command reference, never a literal credential",
      );
    }
  }
  return config;
}
