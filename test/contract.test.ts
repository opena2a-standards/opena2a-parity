import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { mayDifferProblems, mustMatchProblems, runFixture, runFixtures } from "../src/run-parity.ts";

// The comparison reads only must_match, so a may_differ entry is checked on load or not at all: an
// entry without its reason, or a key listed under both lists (still compared), would pass silently.
// A must_match that lists no key is checked on load too: with nothing to compare, no leg can fail.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const NO_MUST_MATCH_KEY =
  'must_match lists no key, so the fixture would compare nothing; list at least one key the participating CLIs must agree on (README.md "Contract model")';

test("mustMatchProblems accepts a list that names at least one key", () => {
  assert.deepEqual(mustMatchProblems({ must_match: ["score"] }), []);
  assert.deepEqual(mustMatchProblems({ must_match: ["score", "findings.0.checkId"] }), []);
});

test("mustMatchProblems names a must_match that is empty, left without a value, or missing", () => {
  assert.deepEqual(mustMatchProblems({ must_match: [] }), [NO_MUST_MATCH_KEY]);
  assert.deepEqual(mustMatchProblems({ must_match: null } as never), [NO_MUST_MATCH_KEY]);
  assert.deepEqual(mustMatchProblems({} as never), [NO_MUST_MATCH_KEY]);
});

test("mustMatchProblems names a must_match that is not a list", () => {
  assert.deepEqual(mustMatchProblems({ must_match: "score" } as never), ["must_match is not a list of keys"]);
  assert.deepEqual(mustMatchProblems({ must_match: { score: true } } as never), ["must_match is not a list of keys"]);
});

test("mustMatchProblems names each entry that is not a key string", () => {
  // Without this an entry such as 1 or null passed on load and would otherwise stop the run with a
  // TypeError when the key is looked up, instead of failing its fixture as a malformed contract.
  assert.deepEqual(mustMatchProblems({ must_match: [null] } as never), ["must_match entry 1 is not a key string: null"]);
  assert.deepEqual(mustMatchProblems(parseYaml("must_match: [score, 1, null, [a], { b: c }]")), [
    "must_match entry 2 is not a key string: 1",
    "must_match entry 3 is not a key string: null",
    'must_match entry 4 is not a key string: ["a"]',
    'must_match entry 5 is not a key string: {"b":"c"}',
  ]);
});

test("mustMatchProblems and mayDifferProblems name a self-referencing YAML alias entry instead of throwing", () => {
  // The entry was formatted with JSON.stringify, which throws on a cycle, so the run stopped with a
  // TypeError instead of failing the fixture on load.
  assert.deepEqual(mustMatchProblems(parseYaml("must_match: [score, &a [*a]]")), [
    "must_match entry 2 is not a key string: <ref *1> [ [Circular *1] ]",
  ]);
  assert.deepEqual(mayDifferProblems(parseYaml("must_match: [score]\nmay_differ: [&b [*b]]")), [
    "may_differ entry 1 is not a { path, reason } entry: <ref *1> [ [Circular *1] ]",
  ]);
});

test("mayDifferProblems accepts entries that each carry a path and a reason and do not overlap must_match", () => {
  assert.deepEqual(mayDifferProblems({ must_match: ["score"], may_differ: [{ path: "findings", reason: "scan-only" }] }), []);
  // a contract with nothing that may differ needs no may_differ list
  assert.deepEqual(mayDifferProblems({ must_match: ["score"] } as never), []);
});

test("mayDifferProblems names an entry with no reason, or an empty one", () => {
  assert.deepEqual(
    mayDifferProblems({ must_match: ["score"], may_differ: [{ path: "findings" }, { path: "timestamp", reason: "  " }] as never }),
    [
      "may_differ entry 1 (path: findings) has no reason; say why this key may differ between CLIs",
      "may_differ entry 2 (path: timestamp) has no reason; say why this key may differ between CLIs",
    ],
  );
});

test("mayDifferProblems names an entry whose path is also under must_match, however the path is written", () => {
  assert.deepEqual(
    mayDifferProblems({ must_match: ["score", "result.verdict"], may_differ: [
      { path: "score", reason: "r" },
      { path: "$.result.verdict", reason: "r" },
      { path: "result", reason: "r" },
    ] }),
    [
      "may_differ entry 1 (path: score) is also listed under must_match, where it is still compared; list it under one of the two",
      "may_differ entry 2 (path: $.result.verdict) is also listed under must_match, where it is still compared; list it under one of the two",
    ],
  );
});

test("mayDifferProblems names an entry that is not a { path, reason } mapping, or has no path", () => {
  assert.deepEqual(
    mayDifferProblems({ must_match: [], may_differ: ["score", { reason: "r" }] as never }),
    ["may_differ entry 1 is not a { path, reason } entry: \"score\"", "may_differ entry 2 has no path"],
  );
  assert.deepEqual(mayDifferProblems({ must_match: [], may_differ: "score" as never }), [
    "may_differ is not a list of { path, reason } entries",
  ]);
});

test("every committed fixture contract passes the may_differ check", () => {
  const contracts = readdirSync(join(repoRoot, "fixtures"))
    .map((n) => join(repoRoot, "fixtures", n, "contract.yaml"))
    .filter((p) => existsSync(p));
  assert.ok(contracts.length > 0);
  for (const path of contracts) {
    assert.deepEqual(mayDifferProblems(parseYaml(readFileSync(path, "utf8"))), [], path);
  }
});

test("every committed fixture contract lists at least one must-match key", () => {
  const contracts = readdirSync(join(repoRoot, "fixtures"))
    .map((n) => join(repoRoot, "fixtures", n, "contract.yaml"))
    .filter((p) => existsSync(p));
  assert.ok(contracts.length > 0);
  for (const path of contracts) {
    assert.deepEqual(mustMatchProblems(parseYaml(readFileSync(path, "utf8"))), [], path);
  }
});

test("runFixture fails a fixture whose must_match lists no key, before running a CLI, and prints no [OK]", () => {
  // The contract measured in the report: each CLI printed its own golden, each leg printed
  // "[NONE] ... no must-match field compared", the next line said the CLIs "agree on every must-match
  // field their goldens carry", and the fixture passed.
  for (const mustMatch of ["must_match: []", "must_match:", ""]) {
    const dir = mkdtempSync(join(tmpdir(), "parity-no-key-"));
    const fixture = join(dir, "fixtures", "stub");
    mkdirSync(join(fixture, "expected"), { recursive: true });
    writeFileSync(join(fixture, "contract.yaml"), [
      "description: no must-match key stub",
      "kind: package-name",
      "package: ghost",
      "exercises:",
      '  hma: "{BIN}"',
      '  opena2a: "{BIN}"',
      "participants:",
      "  - hma",
      "  - opena2a",
      mustMatch,
      "may_differ: []",
      "",
    ].join("\n"));
    for (const cli of ["hma", "opena2a"]) writeFileSync(join(fixture, "expected", `${cli}.json`), JSON.stringify({ score: 7 }));
    writeFileSync(join(fixture, "expected", "ai-trust.skip"), "ai-trust does not exercise this stub");
    const counter = join(dir, "n");
    const bin = join(dir, "stub.mjs");
    writeFileSync(counter, "0");
    writeFileSync(bin, `
import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(counter)}, String(Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1));
console.log(JSON.stringify({ score: 7 }));
`);
    const logged: string[] = [];
    const origError = console.error;
    const origLog = console.log;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    try {
      const rc = runFixture("stub", { hma: `node ${bin}`, opena2a: `node ${bin}`, "ai-trust": "unused" }, { fixtures: join(dir, "fixtures"), actual: join(dir, "actual") });
      assert.equal(rc, 2, `${mustMatch || "(no must_match)"}\n${logged.join("\n")}`);
      assert.deepEqual(logged, [`[stub] contract.yaml ${NO_MUST_MATCH_KEY}`], mustMatch || "(no must_match)");
      assert.equal(readFileSync(counter, "utf8"), "0");
    } finally {
      console.error = origError;
      console.log = origLog;
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("runFixture fails a fixture whose must_match or may_differ entry is a self-referencing YAML alias, before running a CLI", () => {
  for (const [lists, expected] of [
    [["must_match: [score, &a [*a]]", "may_differ: []"], "must_match entry 2 is not a key string: <ref *1> [ [Circular *1] ]"],
    [["must_match: [score]", "may_differ: [&b [*b]]"], "may_differ entry 1 is not a { path, reason } entry: <ref *1> [ [Circular *1] ]"],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), "parity-alias-"));
    const fixture = join(dir, "fixtures", "stub");
    mkdirSync(join(fixture, "expected"), { recursive: true });
    writeFileSync(join(fixture, "contract.yaml"), [
      "description: self-referencing alias stub",
      "kind: package-name",
      "package: ghost",
      "exercises:",
      '  hma: "{BIN}"',
      "participants:",
      "  - hma",
      ...lists,
      "",
    ].join("\n"));
    writeFileSync(join(fixture, "expected", "hma.json"), JSON.stringify({ score: 7 }));
    const counter = join(dir, "n");
    const bin = join(dir, "stub.mjs");
    writeFileSync(counter, "0");
    writeFileSync(bin, `
import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(counter)}, String(Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1));
console.log(JSON.stringify({ score: 7 }));
`);
    const logged: string[] = [];
    const origError = console.error;
    const origLog = console.log;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    try {
      const rc = runFixture("stub", { hma: `node ${bin}`, opena2a: "unused", "ai-trust": "unused" }, { fixtures: join(dir, "fixtures"), actual: join(dir, "actual") });
      assert.equal(rc, 2, `${lists.join(" / ")}\n${logged.join("\n")}`);
      assert.deepEqual(logged, [`[stub] contract.yaml ${expected}`], lists.join(" / "));
      assert.equal(readFileSync(counter, "utf8"), "0");
    } finally {
      console.error = origError;
      console.log = origLog;
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('README.md "Contract model" says a must_match that lists no key fails the fixture', () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const section = readme.split(/^## /m).find((s) => s.startsWith("Contract model")) ?? "";
  assert.ok(section !== "", 'README.md has no "Contract model" section');
  assert.match(section.replace(/\s+/g, " "), /A `must_match` that lists no key compares nothing too, and fails the fixture before any CLI runs/);
});

test("runFixture fails a fixture whose may_differ has no reasons and overlaps must_match, before running a CLI", () => {
  // The contract measured in the report: it printed "[OK] ... 1 must-match fields equal" and passed.
  const dir = mkdtempSync(join(tmpdir(), "parity-contract-"));
  const fixture = join(dir, "fixtures", "stub");
  mkdirSync(join(fixture, "expected"), { recursive: true });
  writeFileSync(join(fixture, "contract.yaml"), `
description: contract stub
kind: package-name
package: ghost
exercises:
  hma: "{BIN}"
participants:
  - hma
must_match:
  - score
may_differ:
  - path: score
  - path: findings
`);
  writeFileSync(join(fixture, "expected", "hma.json"), JSON.stringify({ score: 7, findings: [] }));
  const counter = join(dir, "n");
  const bin = join(dir, "stub.mjs");
  writeFileSync(counter, "0");
  writeFileSync(bin, `
import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(counter)}, String(Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1));
console.log(JSON.stringify({ score: 7, findings: ["x"] }));
`);
  const logged: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const rc = runFixture("stub", { hma: `node ${bin}`, opena2a: "unused", "ai-trust": "unused" }, { fixtures: join(dir, "fixtures"), actual: join(dir, "actual") });
    assert.notEqual(rc, 0, logged.join("\n"));
    assert.deepEqual(logged, [
      "[stub] contract.yaml may_differ entry 1 (path: score) has no reason; say why this key may differ between CLIs",
      "[stub] contract.yaml may_differ entry 1 (path: score) is also listed under must_match, where it is still compared; list it under one of the two",
      "[stub] contract.yaml may_differ entry 2 (path: findings) has no reason; say why this key may differ between CLIs",
    ]);
    assert.equal(readFileSync(counter, "utf8"), "0");
  } finally {
    console.error = origError;
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runFixtures counts a fixture that fails on its contract once, as it counts a fixture with a failed leg", () => {
  // runFixture returns 2 for a contract it cannot run; the run summary counted that return value, so
  // one such fixture read as two fixture failures.
  const dir = mkdtempSync(join(tmpdir(), "parity-count-"));
  const bin = join(dir, "stub.mjs");
  writeFileSync(bin, `console.log(JSON.stringify({ score: 7 }));`);
  const addFixture = (name: string, mayDiffer: string, golden: unknown) => {
    const fixture = join(dir, "fixtures", name);
    mkdirSync(join(fixture, "expected"), { recursive: true });
    writeFileSync(join(fixture, "contract.yaml"), [
      `description: ${name} stub`,
      "kind: package-name",
      "package: ghost",
      "exercises:",
      '  hma: "{BIN}"',
      "participants:",
      "  - hma",
      "must_match:",
      "  - score",
      mayDiffer,
      "",
    ].join("\n"));
    writeFileSync(join(fixture, "expected", "hma.json"), JSON.stringify(golden));
    for (const cli of ["opena2a", "ai-trust"]) writeFileSync(join(fixture, "expected", `${cli}.skip`), `${cli} does not exercise this stub`);
  };
  addFixture("no-reason", "may_differ:\n  - path: grade", { score: 7 });
  addFixture("drifted", "may_differ: []", { score: 8 });
  addFixture("passing", "may_differ: []", { score: 7 });
  const logged: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const bins = { hma: `node ${bin}`, opena2a: "unused", "ai-trust": "unused" };
    const dirs = { fixtures: join(dir, "fixtures"), actual: join(dir, "actual") };
    assert.equal(runFixture("no-reason", bins, dirs), 2, logged.join("\n"));
    assert.equal(runFixtures(["no-reason", "passing"], bins, dirs), 1, logged.join("\n"));
    assert.equal(runFixtures(["no-reason", "drifted", "passing"], bins, dirs), 2, logged.join("\n"));
    assert.equal(runFixtures(["passing"], bins, dirs), 0, logged.join("\n"));
  } finally {
    console.error = origError;
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runFixtures fails a fixture with a must_match entry that is not a key string and still runs the next fixture", () => {
  // Before the check on load, `must_match: [score, 1]` reached the key lookup, which threw
  // "TypeError: path.replace is not a function" and stopped the run before the valid fixture ran.
  const dir = mkdtempSync(join(tmpdir(), "parity-non-string-key-"));
  const bin = join(dir, "stub.mjs");
  writeFileSync(bin, `console.log(JSON.stringify({ score: 98 }));`);
  const addFixture = (name: string, mustMatch: string) => {
    const fixture = join(dir, "fixtures", name);
    mkdirSync(join(fixture, "expected"), { recursive: true });
    writeFileSync(join(fixture, "contract.yaml"), [
      `description: ${name} stub`,
      "kind: package-name",
      "package: ghost",
      "exercises:",
      '  hma: "{BIN}"',
      "participants:",
      "  - hma",
      mustMatch,
      "may_differ: []",
      "",
    ].join("\n"));
    writeFileSync(join(fixture, "expected", "hma.json"), JSON.stringify({ score: 98 }));
    for (const cli of ["opena2a", "ai-trust"]) writeFileSync(join(fixture, "expected", `${cli}.skip`), `${cli} does not exercise this stub`);
  };
  addFixture("non-string-key", "must_match: [score, 1]");
  addFixture("valid", "must_match: [score]");
  const logged: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const bins = { hma: `node ${bin}`, opena2a: "unused", "ai-trust": "unused" };
    const dirs = { fixtures: join(dir, "fixtures"), actual: join(dir, "actual") };
    assert.equal(runFixtures(["non-string-key", "valid"], bins, dirs), 1, logged.join("\n"));
    assert.ok(logged.includes("[non-string-key] contract.yaml must_match entry 2 is not a key string: 1"), logged.join("\n"));
    assert.ok(logged.some((line) => line.startsWith("[OK]   valid × hma:")), logged.join("\n"));
  } finally {
    console.error = origError;
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
});
