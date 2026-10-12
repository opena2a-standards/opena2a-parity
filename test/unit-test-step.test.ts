import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// A reusable workflow's steps come from the commit a consumer pins in `uses:`, so only a consumer
// pinned at or after the commit that added the `npm test` step runs this repository's unit tests.
// README.md names that commit; these tests keep the name true.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW = ".github/workflows/parity.yml";

// True when a step of some job runs `npm test` as one of its command lines. A comment or a step
// name that mentions it does not count.
export function runsUnitTests(workflowText: string): boolean {
  const doc = parse(workflowText) as { jobs?: Record<string, { steps?: Array<{ run?: unknown }> | null } | null> } | null;
  return Object.values(doc?.jobs ?? {}).some((job) =>
    (job?.steps ?? []).some(
      (step) => typeof step?.run === "string" && step.run.split("\n").some((line) => /^npm test(?:\s|$)/.test(line.trim())),
    ),
  );
}

// The commits README.md names, in backticks, in the paragraph that describes the unit-test step.
export function citedStepCommits(readme: string): string[] {
  const shas = readme
    .split(/\n\s*\n/)
    .filter((paragraph) => paragraph.includes("(`npm test`)"))
    .flatMap((paragraph) => [...paragraph.matchAll(/`([0-9a-f]{7,40})`/g)].map((m) => m[1]));
  return [...new Set(shas)];
}

// A git hook exports GIT_DIR and the other variables that tie git to the hook's repository; git runs
// here without them so it answers for this checkout.
const localEnvVars = (spawnSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).stdout ?? "")
  .split("\n")
  .filter((name) => name !== "");

function git(args: string[]): { ok: boolean; stdout: string } {
  const env = { ...process.env };
  for (const name of localEnvVars) delete env[name];
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", env });
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? "" };
}

// The history check needs this repository's own checkout with the cited commit and its parent. A
// shallow clone, which is what a CI checkout makes by default, does not carry them.
function historySkipReason(sha: string): string | false {
  const top = git(["rev-parse", "--show-toplevel"]);
  if (!top.ok || realpathSync(top.stdout.trim()) !== realpathSync(repoRoot)) {
    return "needs a git checkout of this repository";
  }
  if (!git(["cat-file", "-e", `${sha}^{commit}`]).ok || !git(["cat-file", "-e", `${sha}^^{commit}`]).ok) {
    return `needs the history of ${sha} and its parent; a shallow clone does not carry it`;
  }
  return false;
}

function citedCommit(): string {
  const shas = citedStepCommits(readFileSync(join(repoRoot, "README.md"), "utf8"));
  assert.equal(
    shas.length,
    1,
    "The README.md paragraph about the unit-test step (`npm test`) must name, in backticks, the one commit " +
      `that added the step, so a consumer can tell whether its \`uses:\` pin runs it; found: ${JSON.stringify(shas)}`,
  );
  return shas[0];
}

test("README.md names the commit that added the unit-test step, and the workflow still has the step", () => {
  citedCommit();
  assert.equal(runsUnitTests(readFileSync(join(repoRoot, WORKFLOW), "utf8")), true, `${WORKFLOW} has no \`npm test\` step`);
});

test("the commit README.md names is the one that added the unit-test step to the workflow", (t) => {
  const sha = citedCommit();
  const skip = historySkipReason(sha);
  if (skip) {
    t.skip(skip);
    return;
  }
  const at = git(["show", `${sha}:${WORKFLOW}`]);
  assert.ok(at.ok, `${WORKFLOW} does not exist at ${sha}`);
  assert.equal(runsUnitTests(at.stdout), true, `${WORKFLOW} at ${sha} has no \`npm test\` step`);
  const before = git(["show", `${sha}^:${WORKFLOW}`]);
  assert.equal(before.ok && runsUnitTests(before.stdout), false, `${WORKFLOW} already has the \`npm test\` step before ${sha}`);
});

test("a step that runs npm test counts; a comment, a step name or another command does not", () => {
  const workflow = (steps: string) => `jobs:\n  parity:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
  assert.equal(runsUnitTests(workflow("      - name: Harness unit tests\n        run: npm test\n")), true);
  assert.equal(runsUnitTests(workflow("      - run: |\n          npm ci\n          npm test\n")), true);
  assert.equal(runsUnitTests(workflow("      # npm test\n      - name: npm test\n        run: npm run parity\n")), false);
  assert.equal(runsUnitTests(workflow("      - run: npm test-coverage\n")), false);
  assert.equal(runsUnitTests(""), false);
});

test("the cited commit is read from the paragraph about the unit-test step only", () => {
  assert.deepEqual(citedStepCommits("Pin `abc1234` elsewhere.\n\nRuns `npm test` with no commit."), []);
  assert.deepEqual(citedStepCommits("Runs unit tests (`npm test`) from `main` when its pin is `e7a87e2` or later.\nAt or after `e7a87e2`."), ["e7a87e2"]);
  assert.deepEqual(citedStepCommits("Runs unit tests (`npm test`) from `main`, so every consumer is red."), []);
});
