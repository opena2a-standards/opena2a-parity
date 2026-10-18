import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { binCommand, cliRequest, driftModeOn, fixturesDirMessage, harnessVersion, missingBinMessages, USAGE } from "../src/run-parity.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const HMA_REQUIRED = 'env var HMA_BIN is required — e.g. HMA_BIN="node /path/to/dist/cli.js"';
const OTHER_BINS = { OPENA2A_BIN: "node opena2a.js", AI_TRUST_BIN: "node ai-trust.js" };
// The first line the harness prints on every path, --help and --version included.
const HEADER = "opena2a-parity harness\n";

// The harness as `npm run parity` runs it, given PATH and the test's variables and nothing else, so a
// CLI variable or INTENTIONAL_DRIFT set in the shell that runs the tests cannot reach it.
function runHarness(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/run-parity.ts", ...args], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
}

test("missingBinMessages names each CLI variable that is unset or empty, one line each", () => {
  assert.deepEqual(missingBinMessages({ HMA_BIN: "node hma.js", ...OTHER_BINS }), []);
  assert.deepEqual(missingBinMessages({ HMA_BIN: "", OPENA2A_BIN: "node opena2a.js" }), [
    HMA_REQUIRED,
    'env var AI_TRUST_BIN is required — e.g. AI_TRUST_BIN="node /path/to/dist/cli.js"',
  ]);
});

test("missingBinMessages counts a variable that holds only white space as missing, and binCommand trims the rest", () => {
  assert.deepEqual(missingBinMessages({ HMA_BIN: " ", OPENA2A_BIN: "\t\n", AI_TRUST_BIN: "node ai-trust.js" }), [
    HMA_REQUIRED,
    'env var OPENA2A_BIN is required — e.g. OPENA2A_BIN="node /path/to/dist/cli.js"',
  ]);
  assert.equal(binCommand(" node hma.js "), "node hma.js");
  assert.equal(binCommand(" "), undefined);
  assert.equal(binCommand(""), undefined);
  assert.equal(binCommand(undefined), undefined);
});

test("npm run parity without a CLI variable prints one line per variable and exits 2, without a stack trace", () => {
  const r = runHarness([], OTHER_BINS);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr.trim(), HMA_REQUIRED);
  assert.doesNotMatch(r.stderr, /^\s+at /m);
});

test("fixturesDirMessage names the fixtures directory, with the error's own text when it is neither absent nor a file", () => {
  const enoent = Object.assign(new Error("ENOENT: no such file or directory, scandir '/r/fixtures'"), { code: "ENOENT" });
  const enotdir = Object.assign(new Error("ENOTDIR: not a directory, scandir '/r/fixtures'"), { code: "ENOTDIR" });
  const eacces = Object.assign(new Error("EACCES: permission denied, scandir '/r/fixtures'"), { code: "EACCES" });
  assert.equal(fixturesDirMessage("/r/fixtures", enoent), "no fixtures directory at /r/fixtures");
  assert.equal(fixturesDirMessage("/r/fixtures", enotdir), "/r/fixtures is not a directory, so it holds no fixtures");
  assert.equal(
    fixturesDirMessage("/r/fixtures", eacces),
    "cannot list the fixtures directory /r/fixtures: EACCES: permission denied, scandir '/r/fixtures'",
  );
  assert.equal(fixturesDirMessage("/r/fixtures", "boom"), "cannot list the fixtures directory /r/fixtures: boom");
});

// The harness reads the fixtures/ beside its src/, so each case starts a copy of it in a scratch root with
// a node_modules link and either no fixtures entry or a plain file named fixtures. readdirSync's error
// ended both with a stack trace and exit 1; no fixture can run in either, as when fixtures/ holds no
// directory, so both exit 2 with one line.
test("npm run parity with no fixtures/ directory prints one line naming the path and exits 2, without a stack trace", () => {
  // realpath'd: the copy names its fixtures/ from import.meta.url, which node resolves through links
  const base = realpathSync(mkdtempSync(join(tmpdir(), "parity-no-fixtures-")));
  const modules = join(base, "node_modules");
  const fixtures = join(base, "fixtures");
  const start = () =>
    spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/run-parity.ts"], {
      cwd: base,
      env: { PATH: process.env.PATH, HMA_BIN: "node hma.js", OPENA2A_BIN: "node opena2a.js", AI_TRUST_BIN: "node ai-trust.js" },
      encoding: "utf8",
    });
  try {
    mkdirSync(join(base, "src"));
    copyFileSync(join(repoRoot, "src", "run-parity.ts"), join(base, "src", "run-parity.ts"));
    symlinkSync(join(repoRoot, "node_modules"), modules);

    assert.equal(lstatSync(fixtures, { throwIfNoEntry: false }), undefined, `${fixtures} exists`);
    const absent = start();
    assert.equal(absent.status, 2, absent.stderr);
    assert.ok(absent.stdout.startsWith("opena2a-parity harness\n"), absent.stdout);
    assert.equal(absent.stderr, `no fixtures directory at ${fixtures}\n`);

    writeFileSync(fixtures, "");
    const file = start();
    assert.equal(file.status, 2, file.stderr);
    assert.ok(file.stdout.startsWith("opena2a-parity harness\n"), file.stdout);
    assert.equal(file.stderr, `${fixtures} is not a directory, so it holds no fixtures\n`);
  } finally {
    if (lstatSync(modules, { throwIfNoEntry: false })) unlinkSync(modules);
    rmSync(base, { recursive: true, force: true });
  }
});

test("npm run parity with commands that cannot start reports each leg once, with Node's own line, and exits 1 without a retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "parity-cli-missing-"));
  const bin = `node ${join(dir, "missing.mjs")}`;
  try {
    // PARITY_PROBE_BACKOFF_MS is not passed on, so the default backoff is in force: a retried leg sleeps 4.5 s.
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/run-parity.ts"], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, HMA_BIN: bin, OPENA2A_BIN: bin, AI_TRUST_BIN: bin },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(r.status, 1, `${r.error ?? ""}\n${r.stderr}`);
    assert.ok(r.stderr.includes("could not start (exit=1): Error: Cannot find module"), r.stderr);
    assert.ok(!r.stderr.includes("transient probe failure"), r.stderr);
    assert.ok(!r.stderr.includes("First 400 chars"), r.stderr);
    const summary = r.stdout.split("\n").filter((line) => line.trim() !== "").at(-1) ?? "";
    assert.match(summary, /^(\d+) fixture\(s\) run, \1 fixture failure\(s\)$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("npm run parity with a CLI variable that holds only white space exits 2 with the same line instead of probing", () => {
  const r = runHarness([], { HMA_BIN: " ", ...OTHER_BINS, PARITY_PROBE_BACKOFF_MS: "1" });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr.trim(), HMA_REQUIRED);
  assert.doesNotMatch(r.stdout + r.stderr, /probe/);
});

test("driftModeOn reads 1 and the other common spellings as on, and unset, empty, 0, false, no and off as off", () => {
  for (const on of ["1", "true", "TRUE", "yes", "on", " 1 ", "maybe"]) assert.equal(driftModeOn(on), true, JSON.stringify(on));
  for (const off of [undefined, "", " ", "0", "false", "False", "no", "off", "OFF"]) assert.equal(driftModeOn(off), false, JSON.stringify(off));
});

test("the header reports drift mode ON for INTENTIONAL_DRIFT=true and off for INTENTIONAL_DRIFT=false", () => {
  const on = runHarness([], { INTENTIONAL_DRIFT: "true" });
  assert.match(on.stdout, /^ {2}drift mode: {3}ON \(expect fail\)$/m, on.stdout);
  const off = runHarness([], { INTENTIONAL_DRIFT: "false" });
  assert.match(off.stdout, /^ {2}drift mode: {3}off$/m, off.stdout);
});

test("cliRequest reads --help and -h, --version on its own and no argument, and reports any other argument", () => {
  assert.deepEqual(cliRequest([]), { kind: "run" });
  assert.deepEqual(cliRequest(["--help"]), { kind: "help" });
  assert.deepEqual(cliRequest(["-h"]), { kind: "help" });
  assert.deepEqual(cliRequest(["bogus", "--help"]), { kind: "help" });
  assert.deepEqual(cliRequest(["--version"]), { kind: "version" });
  assert.deepEqual(cliRequest(["bogus"]), { kind: "unknown", argument: "bogus" });
  assert.deepEqual(cliRequest(["--version", "bogus"]), { kind: "unknown", argument: "bogus" });
  assert.deepEqual(cliRequest(["--version", "--version"]), { kind: "unknown", argument: "--version" });
  assert.deepEqual(cliRequest(["--versoin"]), { kind: "unknown", argument: "--versoin" });
});

test("--help and -h print the header and the usage and exit 0 with the CLI variables unset", () => {
  for (const args of [["--help"], ["-h"], ["bogus", "--help"]]) {
    const r = runHarness(args, {});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.equal(r.stdout, HEADER + USAGE + "\n", args.join(" "));
  }
  for (const needle of ["HMA_BIN", "OPENA2A_BIN", "AI_TRUST_BIN", "INTENTIONAL_DRIFT=1", "PARITY_PROBE_BACKOFF_MS", "could not start is not retried", "\n  0  ", "\n  1  ", "\n  2  "]) {
    assert.ok(USAGE.includes(needle), `usage names ${JSON.stringify(needle)}`);
  }
});

test("--version prints the header and the version package.json carries and exits 0", () => {
  const { version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
  assert.equal(harnessVersion(), version);
  const r = runHarness(["--version"], {});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, HEADER + version + "\n");
});

test("an argument other than --help, -h and --version is reported after the header and exits 2 before the gate", () => {
  for (const args of [["bogus"], ["--versoin"], ["--version", "bogus"]]) {
    const r = runHarness(args, { HMA_BIN: "node hma.js", ...OTHER_BINS, PARITY_PROBE_BACKOFF_MS: "1" });
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, HEADER, args.join(" "));
    assert.equal(r.stderr.split("\n")[0], `unexpected argument: ${args[args.length - 1]}`);
    assert.doesNotMatch(r.stderr, /^\s+at /m);
  }
});
