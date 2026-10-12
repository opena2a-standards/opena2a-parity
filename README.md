# opena2a-parity

Parity gate for the three OpenA2A CLIs: `hackmyagent`, `opena2a` and `ai-trust`.

## Why this exists

The three CLIs overlap: `opena2a` passes `scan` and `check` through to `hackmyagent`, and scan, trust lookup and rendering are being moved into packages the three CLIs share, so that one change reaches all three. This repo provides the CI gate that checks the three CLIs, given the same input, hold identical values on each fixture's contract-tracked fields: the keys its `contract.yaml` lists under `must_match`. Other keys, including the findings lists, may differ between the CLIs; `may_differ` names the ones known to differ and why. Comparing whole outputs needs an output schema the three CLIs share, which does not exist yet. When a shared-package change lands in any CLI, this harness runs against every fixture and reports a failing check on the PR if output drifts on a contract-tracked field. The PR is blocked from merging only where that CLI's repository lists `parity / parity` as a required status check on `main`; elsewhere the failing check is visible but does not stop the merge.

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

- `kind` — `directory` (the default) or `package-name`. A `directory` fixture has an `input/`
  directory, and each command is run with its path as the last argument. A `package-name` fixture
  has none: every `{PACKAGE}` in a command stands for the contract's `package`, a string. Any other
  `kind` fails the fixture before any CLI runs, and so does a `package` that is not a string in a
  `package-name` fixture; a `directory` fixture does not read `package`
- `exercises` — which CLI commands the fixture runs, a mapping from each participant to its command string, where every `{BIN}` stands for the command that runs that CLI (`HMA_BIN`, `OPENA2A_BIN` or `AI_TRUST_BIN`)
- `participants` — list of CLIs (`hma`, `opena2a`, `ai-trust`) for which a golden exists, each listed once. Every other CLI is skipped and needs a sentinel file, `expected/<cli>.skip`, saying why it does not exercise the fixture; a CLI that is neither a participant nor covered by a sentinel fails the fixture, and so does an empty sentinel. A list that names no CLI would run and compare nothing, and fails the fixture before any CLI runs, as does a CLI listed twice
- `must_match` — list of keys equal across participating CLIs apart from object key order. A key is
  a dot-separated path, with a numeric segment for an array index (`findings.0.checkId`, not
  `findings[0].checkId`). A key that resolves in no participant's golden fails the fixture, since it
  would compare nothing. A participant whose golden carries none of the `must_match` keys fails the
  fixture too: its leg would compare nothing, whatever its CLI prints. A `must_match` that lists no
  key compares nothing too, and fails the fixture before any CLI runs, as does an entry that is not
  a key string (`1`, `null`)
- `may_differ` — list of `{ path, reason }` entries naming keys per-CLI variation is allowed on.
  The harness fails the fixture before running any CLI if an entry has no `reason`, or if its
  `path` is also listed under `must_match` (a key there is compared whatever `may_differ` says)
- `normalize` — rules applied to CLI output before diffing (timestamps, absolute paths, tmp dirs).
  A rule is `strip_key` with a `path`, or `replace_regex` with a `pattern` (a regular expression,
  where every `{FIXTURE_INPUT_DIR}` stands for the fixture's input directory, matched literally, or
  for an empty string in a `kind: package-name` fixture, which has none) and a `replacement`

A `contract.yaml` that is not one valid YAML document (a syntax error, a second document, a
repeated key) or that is not a mapping fails the fixture before any CLI runs, and the run goes on
to the next fixture. So do an `exercises` that is not a mapping or that maps a CLI to a number,
list or mapping, a `participants` entry that names no CLI, and a `normalize` rule with a numeric
`path` or a `pattern` that is empty or not a regular expression with what the fixture puts in
place of `{FIXTURE_INPUT_DIR}`: in a `kind: package-name` fixture `{FIXTURE_INPUT_DIR}*` is `*`,
which is not one, and `{FIXTURE_INPUT_DIR}` alone is empty, which would match at every position
of every string. So does a `pattern` that holds `{FIXTURE_INPUT_DIR}` and matches the empty string
with that value: there `(?:{FIXTURE_INPUT_DIR})` is `(?:)`, which is not empty and matches at every
position of every string too, and `({FIXTURE_INPUT_DIR})?` matches the empty string in any fixture.

A golden that is not valid JSON, or that cannot be read (a directory, or a file without read
permission), fails its participant's leg without running that CLI, and the run goes on to the
remaining legs and fixtures.

See `fixtures/secure-dirty-skill/contract.yaml` for the first fixture.

A `must_match` key is checked twice. Each CLI's output is compared with that CLI's own golden,
and then the CLIs are compared with each other: the goldens of the participating CLIs, and their
outputs, hold the same value for the key. A CLI whose golden omits a key is left out of that
key's comparison between CLIs (ai-trust's `scanStatus` on `check-registered-ai`), and its output
must omit the key too. A fixture whose goldens disagree on a `must_match` key fails even when
every CLI matches its own golden. If the CLIs differ on purpose, move the key from `must_match`
to `may_differ`, with the reason.

An `error` in a CLI's output is checked against that CLI's own golden, after normalization,
even where the contract lists `error` under `may_differ` (which lets the wording differ between
CLIs). An error the golden does not record is tried up to three times (two retries), and if it
still differs after the last attempt the leg fails. On `check-not-found`, ai-trust's registry timeout carries
the same `name`, `found` and `ecosystem` as a real not-found, so the error is what tells them
apart. hackmyagent's payload for an unreachable registry (a timeout, a 5xx and a network error
share one payload) carries `name` and `found: false` but no `ecosystem`, so its leg fails as a
`[SHAPE]` failure naming the absent key instead of through the error comparison. A CLI that
rewords its error on purpose re-baselines its golden first, like any other intended output
change; if the rewording was not intended, it is a CLI regression and the golden stays as it is.

## Adding a fixture

1. Create `fixtures/<name>/input/` with the input artefacts. The root `.gitignore` re-includes
   paths under `fixtures/`, so its secret-file rules and a contributor-local rule that matches a
   file there do not hide an input. Three cases still do, and need `git add -f`: inputs matching
   `node_modules`, `*.log` or `.DS_Store`, which stay ignored under `fixtures/` too; files an
   input's own `.gitignore` lists; and every input, if a contributor-local rule ignores the
   `fixtures` directory itself (git cannot re-include a file whose parent directory is excluded).
   Check `git status` shows every input before committing.
2. Run each CLI that exercises it manually against it; save stable outputs under `fixtures/<name>/expected/`.
3. Write `contract.yaml` naming what must match (at least one key) and what may differ (with reasons).
4. For each CLI that does not exercise the fixture, leave it out of `participants` and create
   `fixtures/<name>/expected/<cli>.skip` saying why it does not. The harness fails the fixture
   for a non-participant CLI with no sentinel or an empty one.
5. Open a PR; CI runs the harness against your new fixture.

## Re-baselining goldens (golden-first)

When a CLI intentionally changes contract-tracked output, the golden moves FIRST.
A consumer repo that requires `parity / parity` blocks its CLI PR on a red parity
leg, so landing the golden before the CLI change merges is the only ordering that
does not strand it. Consumers resolve this harness and its goldens from this repo's
`main` on every cross-repo call (the workflow pin covers only workflow steps), so a
golden landed here is live for them immediately — no pin bump.

1. Build the changed CLI locally and run the harness against it (Quickstart env vars).
2. Read the capture under `actual/<fixture>/<cli>.json`: the CLI's output after the contract's
   `normalize` rules, keys sorted, with a key named `__proto__` kept like any other. Every drifted
   field must be an intended consequence of the CLI change. An unintended drift is a bug in the CLI
   change — fix it there; do not re-baseline over it.
3. Copy the verified capture over the golden:
   `cp actual/<fixture>/<cli>.json fixtures/<fixture>/expected/<cli>.json`
   The harness also compares the goldens with each other, so a `must_match` field moved in one
   CLI's golden alone fails the fixture for every consumer. Move it in the golden of every CLI
   that carries it, or move the key from `must_match` to `may_differ`, with the reason, until the
   CLIs agree again.
   `npm test` checks the committed goldens for this without the CLIs.
4. Commit to `main` with a message naming the CLI change that motivated the
   re-baseline (e.g. the consumer PR number). This repo intentionally has no required
   checks on `main` so a golden lands in minutes, not hours.
5. Re-run the consumer PR's parity leg (re-run the failed job, or push an empty
   update). It now diffs against the new golden.

Ordering the other way (CLI merges first, golden follows) leaves the consumer's `main`
red on parity until the golden lands. If a re-baseline ever costs more than a day,
record the measurement and reopen the ordering decision.

A consumer's parity job also runs this repo's harness unit tests (`npm test`) from
`main` when its `uses:` pin is commit `e7a87e2` or later, the commit that added that step.
A reusable workflow's steps come from the pinned commit, so a consumer pinned to an earlier
commit runs no unit tests; bumping its pin turns them on. For a consumer pinned at or after
`e7a87e2`, a unit test that fails on `main` turns its parity leg red.
The three checks of this repo's own ignore file in `test/ignore-file.test.ts` skip when
`GITHUB_REPOSITORY` names another repository, and the one that asks git about this repo's
checkout also skips in a tree that is not its own git checkout. The three tests in
`test/typecheck.test.ts` that run the compiler skip for another repository as well. Both
files' tests of their helper functions, and the remaining unit tests, which cover the harness
that consumers run, stay on everywhere.
A `.gitignore` change lands together with its `EXPECTED_RULES` update in `test/ignore-file.test.ts`.

`npm test` also type-checks the harness and its tests. Node runs both by stripping their type
annotations without checking them, so `test/typecheck.test.ts` runs `tsc` over them with the
strict options in `tsconfig.json`. `npm run typecheck` runs that check on its own.

## Intentional-drift demo

`npm run parity:drift-demo` — sets `INTENTIONAL_DRIFT=1`, which the harness applies by mutating one must-match field in the captured output. Expected exit code: non-zero with a clear diff. Used to prove the gate is live.

## Scanning this repository

The fixture inputs are deliberately insecure test data, so a `hackmyagent secure` scan of
the repository root reports their findings. One of them is accepted for this repository:
GIT-002 names the two key files under `fixtures/secure-dirty-skill/input/` as committable.
They must stay tracked for the fixture to mean anything, which is why the root `.gitignore`
ignores `.env`, `secrets.json`, `*.pem` and `*.key` and then re-includes paths under
`fixtures/`, so those four rules do not apply there. Any GIT-002 file outside `fixtures/` is a
real finding.

## Design decisions

- Three CLIs that share packages, with this gate checking they agree on each fixture's contract-tracked fields. Merging them into a single CLI was the alternative considered; it is kept as the rollback.
- The harness lives in its own public repository, not inside the `opena2a` monorepo and not inside a CLI. Each CLI keeps its own release cadence, and the CI of every CLI repository can check this one out.

## Status

The harness, the intentional-drift self-test and the reusable CI workflow are in place. Fixtures: `check-not-found`, `check-registered-ai`, `check-registered-ai-pypi`, `scan-soul-hardened`, `secure-dirty-skill`, `secure-empty-dir`.

Planned: more fixtures, a version-skew detector and a parity dashboard.
