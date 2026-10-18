import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// The harness runs its gate only when it is the module node was started with, so the tests can import
// its functions. That check compared process.argv[1], the path as typed, with import.meta.url, which node
// resolves through symbolic links and percent-encodes: started through a link or from a directory whose
// name holds a space, the harness printed nothing and exited 0. Each test here starts it in one of those
// shapes with no CLI variable set and asserts two things: the `opena2a-parity harness` header on stdout,
// which says main ran, and exit 2 with one line per variable on stderr, which says the usage check ran.
// Each test also proves its shape (the links it starts through are links, the spaced path holds none):
// on a Linux runner tmpdir() is not a link, and a test that relied on it would pass without starting the
// harness through one.
//
// The controls are in other files: the `npm run parity` test in test/cli.test.ts starts the harness by its
// relative path from the repository root, and every test file that imports ../src/run-parity.ts shows that
// importing it runs nothing (main would print the header and exit 2, and that file would fail).
//
// Not covered: what the check returns when realpathSync throws. No test can start node on an entry whose
// path realpathSync then rejects, since node resolved that same path to load it. import.meta.main is not
// used for the check: it would pass both tests on a Node that carries the field, and on a Node that does
// not it is undefined, which is the same exit 0 with nothing printed, on a Node this suite cannot run.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// What main prints on stderr, in this order, when HMA_BIN, OPENA2A_BIN and AI_TRUST_BIN are all unset.
const VARIABLE_LINES = ["HMA_BIN", "OPENA2A_BIN", "AI_TRUST_BIN"]
  .map((name) => `env var ${name} is required — e.g. ${name}="node /path/to/dist/cli.js"\n`)
  .join("");

function startHarness(entry: string, cwd: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", entry], {
    cwd,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
}

function assertGateRan(r: SpawnSyncReturns<string>, entry: string): void {
  const detail = `${entry}\nstatus ${r.status}\nstdout ${JSON.stringify(r.stdout)}\nstderr ${JSON.stringify(r.stderr)}`;
  assert.equal(r.status, 2, detail);
  assert.ok(r.stdout.startsWith("opena2a-parity harness\n"), detail);
  assert.equal(r.stderr, VARIABLE_LINES, detail);
  assert.doesNotMatch(r.stderr, /^\s+at /m, detail);
}

// The symbolic links a test made into the repository are unlinked before its scratch directory is removed.
function removeScratch(dir: string, links: string[]): void {
  for (const link of links) if (lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link);
  rmSync(dir, { recursive: true, force: true });
}

test("started through a symbolic link to the harness or to the repository, the harness prints its header and exits 2 with no CLI variable set", () => {
  // realpath'd first: on macOS tmpdir() is itself under a link, and the test must know which link it starts through
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "parity-entry-")));
  const fileLink = join(dir, "run-parity.ts");
  const repoLink = join(dir, "repo");
  try {
    symlinkSync(join(repoRoot, "src", "run-parity.ts"), fileLink);
    symlinkSync(repoRoot, repoLink);
    for (const link of [fileLink, repoLink]) {
      assert.ok(lstatSync(link).isSymbolicLink(), `${link} is not a symbolic link`);
      assert.notEqual(realpathSync(link), link, `${link} resolves to itself`);
    }
    for (const entry of [fileLink, join(repoLink, "src", "run-parity.ts")]) assertGateRan(startHarness(entry, dir), entry);
  } finally {
    removeScratch(dir, [fileLink, repoLink]);
  }
});

test("started from a directory whose name holds a space, the harness prints its header and exits 2 with no CLI variable set", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "parity entry-")));
  const modules = join(base, "node_modules");
  try {
    assert.match(base, /\s/);
    assert.equal(realpathSync(base), base, `${base} holds a symbolic link`);
    mkdirSync(join(base, "src"));
    const entry = join(base, "src", "run-parity.ts");
    copyFileSync(join(repoRoot, "src", "run-parity.ts"), entry);
    // so the copy's yaml import resolves; the link is not on the path the harness is started by
    symlinkSync(join(repoRoot, "node_modules"), modules);
    assert.equal(realpathSync(entry), entry, `${entry} holds a symbolic link`);
    // The copy reads the fixtures/ under base, which has none; the variable check exits 2 before that.
    assertGateRan(startHarness(entry, base), entry);
  } finally {
    removeScratch(base, [modules]);
  }
});
