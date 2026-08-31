#!/usr/bin/env node
// pix - the pi-x one-shot harness CLI.
//
//   pix preflight --spec <path>
//   pix run --spec <path> [--trace <path>]

import fs from "node:fs";
import path from "node:path";

import { exitCodeFor, PROTOCOL, Refusal, refusalOutcome, toRefusal } from "../src/outcome.js";
import { preflight } from "../src/preflight.js";
import { runSpec } from "../src/run.js";
import { taskHint, validateSpec } from "../src/spec.js";

const USAGE = `pix - one-shot Pi agent harness

  pix preflight --spec <path>
  pix run --spec <path> [--trace <path>]

preflight exits 0 and prints nothing when the spec is satisfiable.
run prints exactly one protocol ${PROTOCOL} outcome object on stdout.
`;

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }

  let request;
  try {
    request = parseArgs(argv);
  } catch (error) {
    return report(refusalOutcome(null, toRefusal(error)));
  }

  let text;
  try {
    text = fs.readFileSync(request.spec, "utf8");
  } catch {
    return report(refusalOutcome(null, new Refusal("spec", "spec file cannot be read")));
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return report(refusalOutcome(null, new Refusal("spec", "spec file is not valid JSON")));
  }
  let spec;
  try {
    spec = validateSpec(raw);
  } catch (error) {
    return report(refusalOutcome(taskHint(raw), toRefusal(error)));
  }

  if (request.command === "preflight") {
    try {
      preflight(spec, { tracePath: request.trace });
    } catch (error) {
      return report(refusalOutcome(spec.identity.task, toRefusal(error)));
    }
    return 0;
  }

  const outcome = await runSpec(spec, { tracePath: request.trace });
  return report(outcome);
}

function report(outcome) {
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  return exitCodeFor(outcome.outcome);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "run" && command !== "preflight") {
    throw new Refusal("cli", "expected the command run or preflight");
  }
  const request = { command, spec: null, trace: null };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--spec" || flag === "--trace") {
      const value = rest[index + 1];
      index += 1;
      if (value === undefined) throw new Refusal("cli", `${flag} needs a path`);
      if (!path.isAbsolute(value)) {
        throw new Refusal("cli", `${flag} must be an absolute path`);
      }
      request[flag === "--spec" ? "spec" : "trace"] = value;
      continue;
    }
    throw new Refusal("cli", `unknown option "${flag}"`);
  }
  if (request.spec === null) throw new Refusal("cli", "--spec is required");
  if (command === "preflight" && request.trace !== null) {
    throw new Refusal("cli", "--trace applies to run, not preflight");
  }
  return request;
}
