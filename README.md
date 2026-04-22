# opena2a-parity

Cross-CLI parity gate for the opena2a-org CLI fleet: `hackmyagent`, `opena2a`, `ai-trust`.

## Why this exists

The CLI consolidation plan (CA-034 / CPO-019, committed 2026-04-22) extracts scan, trust lookup, and rendering into shared packages so one change propagates to all three CLIs. This repo provides the CI gate that proves identical output on identical input across the fleet. When a shared-package change lands in any CLI, this harness runs against every fixture and fails the PR if output drifts on a contract-tracked field.

Parent brief: `opena2a-org/briefs/cli-consolidation.md`
Addendum: `opena2a-org/briefs/cli-consolidation-parity-gate.md`

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
    input/                           directory under test (synced from opena2a-org/test/hma/)
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

1. Create `fixtures/<name>/input/` with the input artefacts.
2. Run all three CLIs manually against it; save stable outputs under `fixtures/<name>/expected/`.
3. Write `contract.yaml` naming what must match and what may differ (with reasons).
4. Open a PR; CI runs the harness against your new fixture.

## Intentional-drift demo

`npm run parity:drift-demo` — sets `INTENTIONAL_DRIFT=1`, which the harness applies by mutating one must-match field in the captured output. Expected exit code: non-zero with a clear diff. Used to prove the gate is live.

## Chief decisions

- [CA-034] Option A (three CLIs, shared packages, parity gate). Option B (one CLI) held as rollback. See memory `project_ca_034_cli_consolidation_option_a.md`.
- [CA-035] Harness lives in a standalone private repo (this one), not inside `opena2a` monorepo, not inside a CLI. Rationale: preserves independent release cadences (parent brief line 174) and gives CI a globally checkoutable location.

## Status

**M0 MVP** — harness + 1 fixture + intentional-drift test + CI wiring in 4 repos. See `opena2a-org/todo/2026-04-22-cli-consolidation-sequenced.md` for the full plan.

Follow-up milestones (M1-M4) add the remaining 7 fixtures, skew detector, self-learning intake, and parity dashboard.
