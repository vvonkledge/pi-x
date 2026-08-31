// The closed outcome and exit-code table. A run reports one member of `OUTCOMES`
// and exits with the mapped code; nothing else may reach the caller, because the
// exit status of `pi` itself is meaningless for success (it is 0 for a settled
// run, a total provider failure, an abort, and a truncated stream alike).

export const EXIT_CODES = Object.freeze({
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

export const OUTCOMES = Object.freeze(Object.keys(EXIT_CODES));

export const PROTOCOL = 1;

export function exitCodeFor(outcome) {
  const code = EXIT_CODES[outcome];
  if (code === undefined) {
    throw new Error(`unknown outcome: ${outcome}`);
  }
  return code;
}

// A refusal carries the failed check and a reason, never the offending value,
// because a spec field can hold a path or a credential-shaped string.
export class Refusal extends Error {
  constructor(check, reason) {
    super(`${check}: ${reason}`);
    this.name = "Refusal";
    this.check = check;
    this.reason = reason;
  }
}

// Any failure before a child exists is a refused precondition, whatever class it
// was thrown as. A probe that could not be run must reach the caller as one
// bounded refusal on both commands, not as a stack trace and an exit code
// outside the table on one of them.
export function toRefusal(error) {
  if (error instanceof Refusal) return error;
  // Every expected failure is already a Refusal with a reason this harness wrote.
  // This is the fallback for a harness bug, so it is truncated: an unbounded
  // message would be printed on stdout as part of the outcome object.
  return new Refusal("pix", String(error?.message ?? "unknown error").slice(0, 200));
}

export function refusalOutcome(task, refusal) {
  return {
    protocol: PROTOCOL,
    task,
    outcome: "preflight-refused",
    detail: { check: refusal.check, reason: refusal.reason },
  };
}
