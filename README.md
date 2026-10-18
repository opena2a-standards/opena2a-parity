# opena2a-parity

Parity gate for the three OpenA2A CLIs: `hackmyagent`, `opena2a` and `ai-trust`.

## Quickstart

Node 24 or later is required: `engines` in `package.json` is `>=24.0.0`, and the harness runs its TypeScript source through `node --experimental-strip-types`.

Each variable below holds the command that runs one CLI. Build the three first: clone `opena2a-org/hackmyagent`, `opena2a-org/opena2a` and `opena2a-org/ai-trust`, run `npm ci && npm run build` in each checkout, as the CI workflow does, and point the variables at the built files. A variable is a shell command string, so it can also hold `npx <package>@<version>` for a published version of a CLI.

```
npm install
HMA_BIN="node /path/to/hackmyagent/dist/cli.js" \
OPENA2A_BIN="node /path/to/opena2a/packages/cli/dist/index.js" \
AI_TRUST_BIN="node /path/to/ai-trust/dist/index.js" \
npm run parity
```

What `npm run parity` prints, trimmed ([full output](docs/captures/parity.txt)):

```
opena2a-parity harness
  fixtures dir: /home/runner/work/opena2a-parity/opena2a-parity/fixtures
  drift mode:   off
[OK]   check-not-found × hma: 3 must-match fields equal apart from object key order
[OK]   check-not-found × ai-trust: 3 must-match fields equal apart from object key order
[OK]   check-not-found × opena2a: 3 must-match fields equal apart from object key order
[OK]   check-not-found: hma, ai-trust, opena2a agree on every must-match field their goldens carry
...
```

The harness checks that the three CLIs, given the same input, hold identical values on each fixture's contract-tracked fields: the keys its `contract.yaml` lists under `must_match`.

It exits 0 when every fixture passes, 1 when any fails, and 2 when `HMA_BIN`, `OPENA2A_BIN` or `AI_TRUST_BIN` is unset or empty or when `fixtures/` is absent, is not a directory or holds no directory. A directory under `fixtures/` with no `contract.yaml` is run and fails with `[<name>] missing contract.yaml`. Started by any path, including through a symbolic link or from a directory whose name holds a space, the harness prints the `opena2a-parity harness` header first and never exits 0 without it.

A variable that holds only white space counts as unset. An argument other than `--help`, `-h` and `--version` also exits 2, with `unexpected argument: <argument>` on stderr and no fixture run.

`npm run parity -- --help` (or `-h`) prints the usage under the `opena2a-parity harness` header: the three variables, `INTENTIONAL_DRIFT`, `PARITY_PROBE_BACKOFF_MS` and the exit codes. `npm run parity -- --version` prints the harness version from `package.json` under the same header. Both exit 0 and run no fixture.

In CI, the workflow sets these env vars from freshly-built CLIs and calls the same script.

A failing run shows as a failing check on the PR, which blocks the merge only where that CLI's repository lists `parity / parity` as a required status check on `main`.

## Contract model

Each fixture under `fixtures/<name>/` has a `contract.yaml`, a golden under `expected/` for each CLI in `participants`, and for each CLI left out of it a sentinel `expected/<cli>.skip` saying why.

`must_match` lists the keys the CLIs must agree on, at least one; `may_differ` lists keys allowed to differ, each with a reason.

If the CLIs differ on purpose, move the key from `must_match` to `may_differ`, with the reason.

Every field and the checks the harness applies on load: [docs/contract-model.md](docs/contract-model.md). To add a fixture: [docs/adding-a-fixture.md](docs/adding-a-fixture.md).

## Re-baselining goldens

When a CLI changes contract-tracked output on purpose, its golden lands here before the CLI change merges.

Run the harness against the changed CLI, check that every drifted field in its capture is intended, then copy the capture over the golden: `cp actual/<fixture>/<cli>.json fixtures/<fixture>/expected/<cli>.json`. Full procedure: [docs/re-baselining-goldens.md](docs/re-baselining-goldens.md).

## Intentional-drift demo

`npm run parity:drift-demo` — sets `INTENTIONAL_DRIFT=1`, which the harness applies by mutating one must-match field in the captured output. Any value other than empty or white space only, `0`, `false`, `no` and `off`, in any letter case, turns drift mode on as well, and the `drift mode:` header line reports which way the value was read.

Expected exit code: non-zero with a clear diff. Used to prove the gate is live.

## Documentation

- [How it works](docs/how-it-works.md): why the gate exists, what it compares, and the design decisions
- [Contract model](docs/contract-model.md): every `contract.yaml` field and the checks the harness applies on load
- [Adding a fixture](docs/adding-a-fixture.md)
- [Re-baselining goldens](docs/re-baselining-goldens.md): golden-first ordering, and the unit tests a consumer's parity job runs
- [Scanning this repository](docs/scanning-this-repository.md): the `hackmyagent secure` finding accepted for the fixture inputs
- [Status](docs/status.md): the fixtures in place and what is planned
- [Contributing](CONTRIBUTING.md): repository layout

## License

[Apache-2.0](LICENSE)
