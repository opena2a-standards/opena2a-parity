import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  exercisesProblems,
  mayDifferProblems,
  mustMatchProblems,
  normalizeProblems,
  participantsProblems,
  runFixture,
  runFixtures,
} from "../src/run-parity.ts";

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

test("exercisesProblems names an exercises that is not a mapping, and each command that is not a string", () => {
  assert.deepEqual(exercisesProblems({ exercises: { hma: "{BIN} scan", opena2a: "{BIN} scan" } }), []);
  // an entry left without a value is reported when the fixture runs, as a participant with no exercises entry
  assert.deepEqual(exercisesProblems(parseYaml("exercises:\n  hma:\n")), []);
  for (const exercises of [undefined, null, "{BIN} scan", ["{BIN} scan"]]) {
    assert.deepEqual(exercisesProblems({ exercises } as never), ["exercises is not a mapping from each participant to its command"], String(exercises));
  }
  assert.deepEqual(exercisesProblems(parseYaml("exercises: { hma: 1, opena2a: [scan], ai-trust: ok }")), [
    "exercises entry hma is not a command string: 1",
    'exercises entry opena2a is not a command string: ["scan"]',
  ]);
});

test("participantsProblems names a participants that is not a list, and each entry that names no CLI", () => {
  assert.deepEqual(participantsProblems({ participants: ["hma", "opena2a", "ai-trust"] }), []);
  for (const participants of [undefined, null, "hma", { hma: true }]) {
    assert.deepEqual(participantsProblems({ participants } as never), ["participants is not a list of CLIs (hma, opena2a, ai-trust)"], String(participants));
  }
  assert.deepEqual(participantsProblems(parseYaml("participants: [hma, hackmyagent, 1, null]")), [
    'participants entry 2 is not one of hma, opena2a, ai-trust: "hackmyagent"',
    "participants entry 3 is not one of hma, opena2a, ai-trust: 1",
    "participants entry 4 is not one of hma, opena2a, ai-trust: null",
  ]);
});

test("normalizeProblems accepts the rules the committed contracts use, and no normalize list", () => {
  assert.deepEqual(normalizeProblems({} as never), []);
  assert.deepEqual(normalizeProblems(parseYaml([
    "normalize:",
    "  - { kind: strip_key, path: timestamp }",
    '  - { kind: replace_regex, pattern: "{FIXTURE_INPUT_DIR}", replacement: "<FIXTURE_INPUT_DIR>" }',
    '  - { kind: replace_regex, pattern: "\\\\d+", replacement: "" }',
  ].join("\n"))), []);
});

test("normalizeProblems names a normalize that is not a list, and each rule of the wrong type", () => {
  assert.deepEqual(normalizeProblems({ normalize: { kind: "strip_key" } } as never), ["normalize is not a list of rules"]);
  assert.deepEqual(normalizeProblems(parseYaml([
    "normalize:",
    "  - timestamp",
    "  - { kind: strip_key, path: 5 }",
    "  - { kind: strip_key }",
    "  - { kind: replace_regex, pattern: 2026, replacement: x }",
    '  - { kind: replace_regex, pattern: "(", replacement: 1 }',
    "  - { kind: replace_regex, pattern: x }",
    "  - { kind: strip-key, path: timestamp }",
    "  - { path: timestamp }",
  ].join("\n"))), [
    'normalize rule 1 is not a mapping with a kind: "timestamp"',
    "normalize rule 2 (strip_key) path is not a string: 5",
    "normalize rule 3 (strip_key) has no path",
    "normalize rule 4 (replace_regex) pattern is not a string: 2026",
    "normalize rule 5 (replace_regex) pattern is not a regular expression: Invalid regular expression: /(/g: Unterminated group",
    "normalize rule 5 (replace_regex) replacement is not a string: 1",
    "normalize rule 6 (replace_regex) has no replacement",
    'normalize rule 7 kind is neither strip_key nor replace_regex: "strip-key"',
    "normalize rule 8 has no kind; a rule is strip_key or replace_regex",
  ]);
});

test("every committed fixture contract passes the exercises, participants and normalize checks", () => {
  const contracts = readdirSync(join(repoRoot, "fixtures"))
    .map((n) => join(repoRoot, "fixtures", n, "contract.yaml"))
    .filter((p) => existsSync(p));
  assert.ok(contracts.length > 0);
  for (const path of contracts) {
    const contract = parseYaml(readFileSync(path, "utf8"));
    assert.deepEqual([...exercisesProblems(contract), ...participantsProblems(contract), ...normalizeProblems(contract)], [], path);
  }
});

test("runFixtures fails a fixture whose contract holds a field of the wrong type, before running a CLI, and runs the next fixture", () => {
  // Each of these stopped the run with a TypeError, and no later fixture ran:
  // "contract.participants is not iterable", "Cannot read properties of undefined (reading 'hma')",
  // "path.replace is not a function" and, for an empty contract.yaml, "Cannot read properties of null".
  const dir = mkdtempSync(join(tmpdir(), "parity-types-"));
  const counter = join(dir, "n");
  const bin = join(dir, "stub.mjs");
  writeFileSync(counter, "0");
  writeFileSync(bin, `
import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(counter)}, String(Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1));
console.log(JSON.stringify({ score: 7 }));
`);
  const exercises = ["exercises:", '  hma: "{BIN}"'];
  const participants = ["participants:", "  - hma"];
  const cases: Record<string, { lines: string[] | null; problem: string }> = {
    "no-participants": { lines: exercises, problem: "participants is not a list of CLIs (hma, opena2a, ai-trust)" },
    "no-exercises": { lines: participants, problem: "exercises is not a mapping from each participant to its command" },
    "numeric-path": {
      lines: [...exercises, ...participants, "normalize:", "  - kind: strip_key", "    path: 5"],
      problem: "normalize rule 1 (strip_key) path is not a string: 5",
    },
    "empty-contract": { lines: null, problem: 'is not a mapping of contract fields (README.md "Contract model")' },
  };
  const addFixture = (name: string, lines: string[] | null) => {
    const fixture = join(dir, "fixtures", name);
    mkdirSync(join(fixture, "expected"), { recursive: true });
    const body = lines === null ? "" : ["description: d", "kind: package-name", "package: ghost", ...lines, "must_match:", "  - score", ""].join("\n");
    writeFileSync(join(fixture, "contract.yaml"), body);
    writeFileSync(join(fixture, "expected", "hma.json"), JSON.stringify({ score: 7 }));
    for (const cli of ["opena2a", "ai-trust"]) writeFileSync(join(fixture, "expected", `${cli}.skip`), `${cli} does not exercise this stub`);
  };
  for (const [name, { lines }] of Object.entries(cases)) addFixture(name, lines);
  addFixture("passing", [...exercises, ...participants]);
  const logged: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const bins = { hma: `node ${bin}`, opena2a: "unused", "ai-trust": "unused" };
    const dirs = { fixtures: join(dir, "fixtures"), actual: join(dir, "actual") };
    for (const [name, { problem }] of Object.entries(cases)) {
      logged.length = 0;
      assert.equal(runFixture(name, bins, dirs), 2, `${name}\n${logged.join("\n")}`);
      assert.deepEqual(logged, [`[${name}] contract.yaml ${problem}`], name);
    }
    assert.equal(readFileSync(counter, "utf8"), "0");
    assert.equal(runFixtures([...Object.keys(cases), "passing"], bins, dirs), Object.keys(cases).length, logged.join("\n"));
    assert.equal(readFileSync(counter, "utf8"), "1", "the fixture after the broken ones ran its CLI");
  } finally {
    console.error = origError;
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
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
