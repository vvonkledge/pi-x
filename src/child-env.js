// The child starts from a scrubbed base, not from the harness's environment. A
// default spawn inherits whatever the captain's shell carries, including
// provider API keys and the captain's own Pi configuration.

// Passed through when present. Anything else the child needs must be named in
// the spec's bounded allowlist.
const SAFE_BASE_KEYS = ["PATH", "HOME", "TERM", "TZ", "LANG"];

export function buildChildEnv({ processEnv, specEnv, agentDir }) {
  const env = {};
  for (const key of SAFE_BASE_KEYS) {
    const value = processEnv[key];
    if (typeof value === "string") env[key] = value;
  }
  for (const [key, value] of Object.entries(processEnv)) {
    if (key.startsWith("LC_") && typeof value === "string") env[key] = value;
  }

  // A minion never needs Pi's update checks, package refresh or telemetry, and a
  // harness whose startup depends on the network is not deterministic.
  env.PI_OFFLINE = "1";
  // The whole isolation boundary: the child reads this directory instead of the
  // captain's ~/.pi/agent, so it sees no captain package, extension, skill,
  // prompt template, theme, model preference or credential.
  env.PI_CODING_AGENT_DIR = agentDir;

  for (const [key, value] of Object.entries(specEnv)) {
    env[key] = value;
  }
  return env;
}
