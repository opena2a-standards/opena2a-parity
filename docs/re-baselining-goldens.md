# Re-baselining goldens (golden-first)

When a CLI intentionally changes contract-tracked output, the golden moves FIRST.
A consumer repo that requires `parity / parity` blocks its CLI PR on a red parity
leg, so landing the golden before the CLI change merges is the only ordering that
does not strand it. Consumers resolve this harness and its goldens from this repo's
`main` on every cross-repo call (the workflow pin covers only workflow steps), so a
golden landed here is live for them immediately — no pin bump.

1. Build the changed CLI locally and run the harness against it ([Quickstart](../README.md#quickstart) env vars).
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
