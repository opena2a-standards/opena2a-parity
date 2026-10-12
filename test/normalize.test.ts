import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rulePattern, runFixture } from "../src/run-parity.ts";

// In a replace_regex rule, {FIXTURE_INPUT_DIR} stands for the fixture's input directory, matched
// literally, or for an empty string in a kind: package-name fixture, which has none. No test read
// that substitution: with the placeholder misspelt in the harness, the suite still passed.

// One fixture with hma as its only participant and one replace_regex rule, run on a stub CLI that
// prints the object `print` evaluates to, where `dir` is the last argument the harness passed: the
// input directory for a directory fixture, nothing for a kind: package-name one. The contract's
// must_match keys are the golden's. Returns the result, the lines printed and hma's capture.
function runWithRule(o: {
  fixture?: string;
  kind: "directory" | "package-name";
  pattern: string;
  replacement: string;
  print: string;
  golden: Record<string, unknown>;
}): { rc: number; logged: string[]; capture: unknown } {
  const dir = mkdtempSync(join(tmpdir(), "parity-normalize-"));
  const name = o.fixture ?? "stub";
  const fixture = join(dir, "fixtures", name);
  mkdirSync(join(fixture, "expected"), { recursive: true });
  if (o.kind === "directory") mkdirSync(join(fixture, "input"));
  writeFileSync(join(fixture, "contract.yaml"), [
    "description: normalize stub",
    ...(o.kind === "directory" ? [] : ["kind: package-name", "package: ghost"]),
    "exercises:",
    '  hma: "{BIN}"',
    "participants:",
    "  - hma",
    "must_match:",
    ...Object.keys(o.golden).map((key) => `  - ${key}`),
    "normalize:",
    "  - kind: replace_regex",
    `    pattern: ${JSON.stringify(o.pattern)}`,
    `    replacement: ${JSON.stringify(o.replacement)}`,
    "",
  ].join("\n"));
  writeFileSync(join(fixture, "expected", "hma.json"), JSON.stringify(o.golden));
  for (const cli of ["opena2a", "ai-trust"]) writeFileSync(join(fixture, "expected", `${cli}.skip`), `${cli} does not exercise this stub`);
  const bin = join(dir, "stub.mjs");
  writeFileSync(bin, `const dir = process.argv[2];\nconsole.log(JSON.stringify(${o.print}));\n`);
  const logged: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const rc = runFixture(name, { hma: `node ${bin}`, opena2a: "unused", "ai-trust": "unused" }, { fixtures: join(dir, "fixtures"), actual: join(dir, "actual") });
    const capturePath = join(dir, "actual", name, "hma.json");
    return { rc, logged, capture: existsSync(capturePath) ? JSON.parse(readFileSync(capturePath, "utf8")) : undefined };
  } finally {
    console.error = origError;
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("{FIXTURE_INPUT_DIR} in a directory fixture's rule matches the input directory its CLI was given", () => {
  const golden = { score: 7, where: "<FIXTURE_INPUT_DIR>/SOUL.md" };
  const r = runWithRule({
    kind: "directory",
    pattern: "{FIXTURE_INPUT_DIR}",
    replacement: "<FIXTURE_INPUT_DIR>",
    print: '{ score: 7, where: dir + "/SOUL.md" }',
    golden,
  });
  assert.equal(r.rc, 0, r.logged.join("\n"));
  assert.deepEqual(r.capture, golden);
});

test("{FIXTURE_INPUT_DIR} in a kind: package-name fixture's rule is an empty string", () => {
  const golden = { score: 7, note: "<AB>" };
  const r = runWithRule({
    kind: "package-name",
    pattern: "a{FIXTURE_INPUT_DIR}b",
    replacement: "<AB>",
    print: '{ score: 7, note: "ab" }',
    golden,
  });
  assert.equal(r.rc, 0, r.logged.join("\n"));
  assert.deepEqual(r.capture, golden);
});

test("every {FIXTURE_INPUT_DIR} in a pattern stands for the input directory, not only the first", () => {
  // The second placeholder stayed in the pattern as literal text, so the pattern matched nothing, the
  // capture kept both paths and the leg reported a drift.
  const golden = { score: 7, both: "<BOTH>" };
  const r = runWithRule({
    kind: "directory",
    pattern: "{FIXTURE_INPUT_DIR} and {FIXTURE_INPUT_DIR}",
    replacement: "<BOTH>",
    print: '{ score: 7, both: dir + " and " + dir }',
    golden,
  });
  assert.equal(r.rc, 0, r.logged.join("\n"));
  assert.deepEqual(r.capture, golden);
});

test("{FIXTURE_INPUT_DIR} matches an input directory whose path holds $& or $'", () => {
  // The path was the replacement string of String.prototype.replace, which expands both sequences, so
  // the compiled pattern no longer held the path and matched nothing.
  for (const fixture of ["a$&b", "a$'b"]) {
    const golden = { score: 7, where: "<FIXTURE_INPUT_DIR>" };
    const r = runWithRule({
      fixture,
      kind: "directory",
      pattern: "{FIXTURE_INPUT_DIR}",
      replacement: "<FIXTURE_INPUT_DIR>",
      print: "{ score: 7, where: dir }",
      golden,
    });
    assert.equal(r.rc, 0, `${fixture}\n${r.logged.join("\n")}`);
    assert.deepEqual(r.capture, golden, fixture);
  }
});

test("rulePattern puts the input directory in as it is, whatever replacement sequence its path holds", () => {
  // The shell expands $` and $$ before a stub CLI sees the path, so these are compiled directly.
  for (const sequence of ["$&", "$`", "$'", "$$"]) {
    const dir = `/tmp/a${sequence}b/input`;
    assert.equal(`in ${dir}/SOUL.md`.replace(rulePattern("{FIXTURE_INPUT_DIR}", dir), "<IN>"), "in <IN>/SOUL.md", sequence);
  }
});

test("rulePattern matches the input directory literally", () => {
  const pattern = () => rulePattern("{FIXTURE_INPUT_DIR}", "/tmp/a.b+c/input");
  assert.equal("/tmp/a.b+c/input".replace(pattern(), "<IN>"), "<IN>");
  assert.equal("/tmp/aXbbc/input".replace(pattern(), "<IN>"), "/tmp/aXbbc/input");
});
