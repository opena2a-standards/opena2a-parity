import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The committed ignore file covers what working in this repository produces: installed
// dependencies, logs, OS metadata, the harness's run output (actual/) and the CLI checkouts the CI
// workflow creates (ext/). It also ignores the secret-shaped names a hackmyagent scan of the
// repository root expects (GIT-002), and re-includes paths under fixtures/ so that neither those
// rules nor a contributor-local rule matching a file there can hide a fixture input from git. It
// cannot re-include an input under a directory a local rule excludes (fixtures/ itself), and the
// node_modules/, *.log and .DS_Store rules still apply inside fixtures/. Exclusions for a
// contributor's personal editor or tooling state belong in that contributor's .git/info/exclude or
// global ignore file, not here. Adding a rule is a deliberate change to this list.

const EXPECTED_RULES = [
  ".env",
  "secrets.json",
  "*.pem",
  "*.key",
  "!/fixtures/**",
  "node_modules/",
  "*.log",
  ".DS_Store",
  "/actual/",
  "/ext/",
];

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// A consumer's parity job runs `npm test` from this repository's main on every cross-repository
// call. These tests check this repository's own ignore file, which has no bearing on a consumer's
// CLI parity, so they run locally and in this repository's own CI only.
export function skipReason(repository: string | undefined): string | false {
  if (!repository || repository.endsWith("/opena2a-parity")) return false;
  return `checks opena2a-parity's own ignore file; not run on behalf of ${repository}`;
}

// Git applies a rule as written: leading spaces are part of the pattern, so "  /actual/" no longer
// ignores actual/. Only a trailing carriage return is removed before comparing. Blank lines and
// comment lines are not rules.
export function committedRules(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim() !== "" && !l.startsWith("#"));
}

const skip = skipReason(process.env.GITHUB_REPOSITORY);

test(".gitignore carries only the repository's own rules", { skip }, () => {
  const rules = committedRules(readFileSync(join(repoRoot, ".gitignore"), "utf8"));
  assert.deepEqual(
    rules,
    EXPECTED_RULES,
    "A rule must start in column 1 (git treats leading spaces as part of the pattern). A personal " +
      "exclusion belongs in .git/info/exclude or your global ignore file (core.excludesFile), not " +
      "in .gitignore; a deliberate .gitignore change updates EXPECTED_RULES in the same commit.",
  );
});

test("git ignores run output and checkouts, and contributor-local rules cannot hide a fixture input", { skip }, () => {
  // Stand-in for a contributor's global ignore file that excludes editor state and env files.
  const dir = mkdtempSync(join(tmpdir(), "parity-ignore-"));
  const localExcludes = join(dir, "excludes");
  writeFileSync(localExcludes, ".env\n.env.local\n.cursorrules\n.claude/\nCLAUDE.md\n");
  const ignored = (path: string): boolean => {
    const r = spawnSync("git", ["-c", `core.excludesFile=${localExcludes}`, "check-ignore", "-q", "--no-index", path], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.ok(r.status === 0 || r.status === 1, `git check-ignore ${path} failed: ${r.stderr}`);
    return r.status === 0;
  };
  try {
    for (const path of [
      "actual/secure-dirty-skill/hma.json",
      "ext/hackmyagent/package.json",
      "node_modules/yaml/package.json",
      ".env",
      "server.key",
      "fixtures/example/input/node_modules/pkg/index.js",
      "fixtures/example/input/debug.log",
      "fixtures/example/input/.DS_Store",
    ]) {
      assert.equal(ignored(path), true, `${path} should be ignored`);
    }
    // A fixture input that carries its own .gitignore still applies it inside that fixture (git gives
    // the deeper file precedence), so this uses a fixture without one; inputs such a file lists are
    // added with `git add -f`.
    for (const path of [
      "fixtures/example/input/.env",
      "fixtures/example/input/.env.local",
      "fixtures/example/input/.cursorrules",
      "fixtures/example/input/.claude/settings.json",
      "fixtures/example/input/CLAUDE.md",
      "fixtures/example/input/fake-private.key",
      "fixtures/example/input/fake-cert.pem",
    ]) {
      assert.equal(ignored(path), false, `${path} is a fixture input and must not be ignored`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an indented rule is compared as written, and comment lines are not rules", () => {
  assert.deepEqual(committedRules("# personal\n  /actual/\r\n\n   \n/ext/\r\n"), ["  /actual/", "/ext/"]);
});

test("the ignore-file checks run locally and in this repository, and skip for a consumer", () => {
  assert.equal(skipReason(undefined), false);
  assert.equal(skipReason(""), false);
  assert.equal(skipReason("opena2a-org/opena2a-parity"), false);
  assert.equal(skipReason("opena2a-standards/opena2a-parity"), false);
  assert.match(String(skipReason("opena2a-org/hackmyagent")), /not run on behalf of opena2a-org\/hackmyagent/);
});
