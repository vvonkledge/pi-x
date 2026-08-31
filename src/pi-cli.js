// The narrow set of `pi` invocations `pix` makes outside a run. Each one is a
// documented CLI surface, runs with the same scrubbed environment and generated
// config directory the agent will get, and starts no agent.

import { execFileSync } from "node:child_process";

import { Refusal } from "./outcome.js";

// Pi is 0.x. Every behavior this harness leans on - a missing orders file
// appended as literal text, an invalid thinking level warned and ignored, exit 0
// on a total provider failure - is observed, not contractual, so a version
// outside the range that was verified is refused rather than assumed.
export const SUPPORTED_PI_RANGE = Object.freeze({
  min: "0.84.2",
  belowExclusive: "0.85.0",
});

const PROBE_TIMEOUT_MS = 30_000;

export function piVersion(bin, env, cwd) {
  const stdout = runPi(bin, ["--version"], env, cwd, "pi.version");
  const version = stdout.trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Refusal("pi.version", "pi --version printed no version");
  }
  return version;
}

export function assertSupportedVersion(version) {
  if (
    compare(version, SUPPORTED_PI_RANGE.min) < 0 ||
    compare(version, SUPPORTED_PI_RANGE.belowExclusive) >= 0
  ) {
    throw new Refusal(
      "pi.version",
      `observed ${version}; pix supports >=${SUPPORTED_PI_RANGE.min} <${SUPPORTED_PI_RANGE.belowExclusive}`,
    );
  }
  return version;
}

// `pi auth check` reports credential presence for a provider without printing
// the credential, unless --credentials is passed, which pix never passes.
export function authStatus(bin, env, cwd, provider) {
  // A not_ready provider exits non-zero and still prints its JSON verdict, so a
  // non-zero exit here is an answer rather than a failure to get one.
  const stdout = runPi(bin, ["auth", "check", "--provider", provider, "--json"], env, cwd, "pi.auth", {
    verdictOnFailure: true,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Refusal("pi.auth", "pi auth check printed no JSON verdict");
  }
}

// `pi --list-models` prints a fixed-width table whose first two columns are the
// provider and the model id. Pi resolves an unknown id only when the process
// starts, so listing is how a preflight refuses one before anything is created.
export function modelIsResolvable(bin, env, cwd, provider, id) {
  const stdout = runPi(bin, ["--list-models", id], env, cwd, "pi.models");
  const lines = stdout.split("\n").slice(1);
  return lines.some((line) => {
    const [column, model] = line.trim().split(/\s+/);
    return column === provider && model === id;
  });
}

function runPi(bin, args, env, cwd, check, { verdictOnFailure = false } = {}) {
  try {
    return execFileSync(bin, args, {
      env,
      cwd,
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (verdictOnFailure && typeof error.stdout === "string" && error.stdout.trim() !== "") {
      return error.stdout;
    }
    // The reason is authored here and never taken from the error, because
    // execFileSync puts the whole captured stderr in its message and a refusal
    // reason is printed on stdout.
    throw new Refusal(check, describeFailure(bin, error));
  }
}

function describeFailure(bin, error) {
  if (error?.code === "ENOENT") return `pi executable not found at ${bin}`;
  if (error?.killed) return `pi did not answer within ${PROBE_TIMEOUT_MS} ms`;
  if (typeof error?.status === "number") return `pi exited ${error.status}`;
  if (error?.signal) return `pi was killed by ${error.signal}`;
  return "pi could not be run";
}

function compare(left, right) {
  const parse = (version) =>
    version.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}
