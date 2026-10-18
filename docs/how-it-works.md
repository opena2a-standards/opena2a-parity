# How it works

## Why this exists

The three CLIs overlap: `opena2a` passes `scan` and `check` through to `hackmyagent`, and scan, trust lookup and rendering are being moved into packages the three CLIs share, so that one change reaches all three. This repo provides the CI gate that checks the three CLIs, given the same input, hold identical values on each fixture's contract-tracked fields: the keys its `contract.yaml` lists under `must_match`. Other keys, including the findings lists, may differ between the CLIs; `may_differ` names the ones known to differ and why. Comparing whole outputs needs an output schema the three CLIs share, which does not exist yet. When a shared-package change lands in any CLI, this harness runs against every fixture and reports a failing check on the PR if output drifts on a contract-tracked field. The PR is blocked from merging only where that CLI's repository lists `parity / parity` as a required status check on `main`; elsewhere the failing check is visible but does not stop the merge.

## Design decisions

- Three CLIs that share packages, with this gate checking they agree on each fixture's contract-tracked fields. Merging them into a single CLI was the alternative considered; it is kept as the rollback.
- The harness lives in its own public repository, not inside the `opena2a` monorepo and not inside a CLI. Each CLI keeps its own release cadence, and the CI of every CLI repository can check this one out.
- The harness runs its gate only when it is the entry module, so the tests can import its functions. The check compares both paths resolved through symbolic links, with the URL decoded, because node resolves the entry's links into `import.meta.url` and percent-encodes it, while `process.argv[1]` keeps the path as typed.
