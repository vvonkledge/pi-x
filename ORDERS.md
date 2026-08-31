# Project orders: pi-x

This project builds the Pi agent harness used to run SIANA's minions. It is a
separate product boundary from SIANA: SIANA states intent and consumes the harness;
`pi-x` owns agent-process lifecycle, Pi integration, and the exact protocol exposed
to its caller.

## Current state

The repository begins as a validated shell. Do not infer a harness architecture from
the bootstrap test or add speculative framework code. Build only the slice in your
brief.

Before implementing against Pi, read the installed Pi documentation and relevant
examples completely, follow their cross-references, and verify every undocumented
claim against the exact pinned Pi version. Prefer documented SDK and extension
boundaries over private imports.

## Validation

Run:

    just test

It is the same command the delivery pipeline and GitHub CI run. Tests must be
deterministic and offline. Script process and network transports when a failure
cannot be produced on demand, but keep the harness logic and state stores real.

The npm lockfile is part of the product. Add dependencies deliberately, pin them in
the lockfile, and explain why the platform or Pi SDK cannot supply the capability.
The package is private so a harness checkout cannot be published to npm by accident.

## Conventions

- Never use the em dash. Use a plain dash.
- Keep prose at 88 columns.
- Use the minimum code that closes the brief.
- Comments explain why a boundary or refusal exists, not what the next line does.
- A refusal is a product behavior. Test the unsafe case it prevents.
- Never hide a Pi, process, filesystem, or model failure as an empty success.
- Never put credentials, prompts, transcripts, or tool results in logs or fixtures.

## The pipeline

Every ship task here is validated by `siana-pipeline`. The project registry carries
`pipeline: true`, so a ship task verifies with `siana-pipeline check`; `just test` is
the command a pipeline run executes.

From a clean worktree with every change committed, run:

    siana-pipeline run

Read its exit code as the complete protocol:

    0   passed; stop and do not commit again
    1   fix the findings, commit, and run a new round
    2   the finding needs SIANA or the captain; block and relay it verbatim

A passing run is bound to one commit. Committing after it invalidates the result.
The independent QA task runs `just test` again from a separate worktree, and GitHub
runs the same command on the submitted head before an accepted request can squash
into `main`.
