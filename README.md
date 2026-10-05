# opena2a-parity

Parity gate for the three OpenA2A CLIs: `hackmyagent`, `opena2a` and `ai-trust`.

## Why this exists

The three CLIs overlap: `opena2a` passes `scan` and `check` through to `hackmyagent`, and scan, trust lookup and rendering are being moved into packages the three CLIs share, so that one change reaches all three. This repo provides the CI gate that proves identical output on identical input across the three CLIs. When a shared-package change lands in any CLI, this harness runs against every fixture and fails the PR if output drifts on a contract-tracked field.

## Quickstart

```
npm install
HMA_BIN="node /path/to/hackmyagent/dist/cli.js" \
OPENA2A_BIN="node /path/to/opena2a/packages/cli/dist/index.js" \
AI_TRUST_BIN="node /path/to/ai-trust/dist/index.js" \
npm run parity
```

In CI, the workflow sets these env vars from freshly-built CLIs and calls the same script.

## Layout

```
src/run-parity.ts                    harness (Node 24, --experimental-strip-types)
fixtures/
  secure-dirty-skill/
    input/                           directory under test (a deliberately insecure sample project)
    contract.yaml                    must-match / may-differ rules for this fixture
    expected/
      hma.json                       golden output
      opena2a.json                   golden output
      ai-trust.skip                  sentinel: ai-trust does not exercise this fixture
```

## Contract model

`contract.yaml` per fixture. Fields:

- `exercises` — which CLI commands the fixture runs
- `participants` — list of CLIs for which a golden exists (others are skipped with a sentinel file)
- `must_match` — list of JSONPath-ish keys byte-identical across participating CLIs
- `may_differ` — list of keys per-CLI variation is allowed on (documented reason required)
- `normalize` — rules applied to CLI output before diffing (timestamps, absolute paths, tmp dirs)

See `fixtures/secure-dirty-skill/contract.yaml` for the first fixture.

## Adding a fixture

1. Create `fixtures/<name>/input/` with the input artefacts. The root `.gitignore` re-includes
   everything under `fixtures/`, so a contributor-local ignore rule cannot hide an input; an
   input's own `.gitignore` still applies inside the fixture, so add the files it lists with
   `git add -f`. Check `git status` shows every input before committing.
2. Run all three CLIs manually against it; save stable outputs under `fixtures/<name>/expected/`.
3. Write `contract.yaml` naming what must match and what may differ (with reasons).
4. Open a PR; CI runs the harness against your new fixture.

## Re-baselining goldens (golden-first)

When a CLI intentionally changes contract-tracked output, the golden moves FIRST.
A consumer repo that requires `parity / parity` blocks its CLI PR on a red parity
leg, so landing the golden before the CLI change merges is the only ordering that
does not strand it. Consumers resolve this harness and its goldens from this repo's
`main` on every cross-repo call (the workflow pin covers only workflow steps), so a
golden landed here is live for them immediately — no pin bump.

1. Build the changed CLI locally and run the harness against it (Quickstart env vars).
2. Read the capture under `actual/<fixture>/<cli>.json`. Every drifted field must be an
   intended consequence of the CLI change. An unintended drift is a bug in the CLI
   change — fix it there; do not re-baseline over it.
3. Copy the verified capture over the golden:
   `cp actual/<fixture>/<cli>.json fixtures/<fixture>/expected/<cli>.json`
4. Commit to `main` with a message naming the CLI change that motivated the
   re-baseline (e.g. the consumer PR number). This repo intentionally has no required
   checks on `main` so a golden lands in minutes, not hours.
5. Re-run the consumer PR's parity leg (re-run the failed job, or push an empty
   update). It now diffs against the new golden.

Ordering the other way (CLI merges first, golden follows) leaves the consumer's `main`
red on parity until the golden lands. If a re-baseline ever costs more than a day,
record the measurement and reopen the ordering decision.

A consumer's parity job also runs this repo's harness unit tests (`npm test`) from
`main`, so a unit test that fails on `main` turns every consumer's parity leg red.
`test/ignore-file.test.ts` checks only this repo's own ignore rules, so it skips itself
when `GITHUB_REPOSITORY` names another repository; the remaining unit tests cover the
harness that consumers run and stay on everywhere. A `.gitignore` change lands together
with its `EXPECTED_RULES` update in that test.

## Intentional-drift demo

`npm run parity:drift-demo` — sets `INTENTIONAL_DRIFT=1`, which the harness applies by mutating one must-match field in the captured output. Expected exit code: non-zero with a clear diff. Used to prove the gate is live.

## Scanning this repository

The fixture inputs are deliberately insecure test data, so a `hackmyagent secure` scan of
the repository root reports their findings. One of them is accepted for this repository:
GIT-002 names the two key files under `fixtures/secure-dirty-skill/input/` as committable.
They must stay tracked for the fixture to mean anything, which is why the root `.gitignore`
re-includes everything under `fixtures/` after ignoring `.env`, `secrets.json`, `*.pem` and
`*.key` everywhere else. Any GIT-002 file outside `fixtures/` is a real finding.

## Design decisions

- Three CLIs that share packages, with this gate proving they agree. Merging them into a single CLI was the alternative considered; it is kept as the rollback.
- The harness lives in its own public repository, not inside the `opena2a` monorepo and not inside a CLI. Each CLI keeps its own release cadence, and the CI of every CLI repository can check this one out.

## Status

The harness, the intentional-drift self-test and the reusable CI workflow are in place. Fixtures: `check-not-found`, `check-registered-ai`, `check-registered-ai-pypi`, `scan-soul-hardened`, `secure-dirty-skill`, `secure-empty-dir`.

Planned: more fixtures, a version-skew detector and a parity dashboard.
