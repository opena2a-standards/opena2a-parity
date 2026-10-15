# Adding a fixture

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
