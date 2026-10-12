import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  exercisesProblems,
  kindProblems,
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

test("kindProblems names a kind that is neither directory nor package-name, and a package that is not a string", () => {
  assert.deepEqual(kindProblems({}), []);
  assert.deepEqual(kindProblems(parseYaml("kind:")), []);
  assert.deepEqual(kindProblems({ kind: "directory" }), []);
  assert.deepEqual(kindProblems({ kind: "package-name", package: "@scope/name" }), []);
  // a package left without a value is reported when the fixture runs, as a kind=package-name fixture with no package
  assert.deepEqual(kindProblems(parseYaml("kind: package-name\npackage:")), []);
  // a directory fixture does not read package
  assert.deepEqual(kindProblems(parseYaml("package: 5")), []);
  for (const [kind, formatted] of [["dir", '"dir"'], ["Directory", '"Directory"'], ["[directory]", '["directory"]'], ["{ toString: x }", '{"toString":"x"}']]) {
    assert.deepEqual(kindProblems(parseYaml(`kind: ${kind}`)), [`kind is neither directory nor package-name: ${formatted}`], kind);
  }
  for (const [name, formatted] of [["5", "5"], ["[ghost]", '["ghost"]'], ["{ toString: x }", '{"toString":"x"}']]) {
    assert.deepEqual(kindProblems(parseYaml(`kind: package-name\npackage: ${name}`)), [`package is not a package name string: ${formatted}`], name);
  }
});

test("normalizeProblems accepts the rules the committed contracts use, and no normalize list", () => {
  for (const fixtureInputDir of ["", "/fixtures/stub/input"]) {
    assert.deepEqual(normalizeProblems({} as never, fixtureInputDir), []);
    assert.deepEqual(normalizeProblems(parseYaml([
      "normalize:",
      "  - { kind: strip_key, path: timestamp }",
      '  - { kind: replace_regex, pattern: "{FIXTURE_INPUT_DIR}", replacement: "<FIXTURE_INPUT_DIR>" }',
      '  - { kind: replace_regex, pattern: "\\\\d+", replacement: "" }',
    ].join("\n")), fixtureInputDir), []);
  }
});

test("normalizeProblems names a normalize that is not a list, and each rule of the wrong type", () => {
  assert.deepEqual(normalizeProblems({ normalize: { kind: "strip_key" } } as never, ""), ["normalize is not a list of rules"]);
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
  ].join("\n")), ""), [
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

test("every committed fixture contract passes the kind, exercises, participants and normalize checks", () => {
  const contracts = readdirSync(join(repoRoot, "fixtures"))
    .map((n) => join(repoRoot, "fixtures", n, "contract.yaml"))
    .filter((p) => existsSync(p));
  assert.ok(contracts.length > 0);
  for (const path of contracts) {
    const contract = parseYaml(readFileSync(path, "utf8"));
    // what runFixture puts in place of {FIXTURE_INPUT_DIR} for the fixture
    const fixtureInputDir = contract.kind === "package-name" ? "" : join(dirname(path), "input");
    assert.deepEqual(
      [...kindProblems(contract), ...exercisesProblems(contract), ...participantsProblems(contract), ...normalizeProblems(contract, fixtureInputDir)],
      [],
      path,
    );
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
    // A self-referencing YAML alias (such as &a [*a]) in one of these fields is named too: JSON.stringify
    // throws on it ("Converting circular structure to JSON"), so the value is printed with formatEntry.
    "alias-exercises": {
      lines: ['exercises: &e { hma: "{BIN}", self: *e }', ...participants],
      problem: "exercises entry self is not a command string: <ref *1> { hma: '{BIN}', self: [Circular *1] }",
    },
    "alias-participants": {
      lines: [...exercises, "participants: [hma, &a [*a]]"],
      problem: "participants entry 2 is not one of hma, opena2a, ai-trust: <ref *1> [ [Circular *1] ]",
    },
    "alias-normalize-rule": {
      lines: [...exercises, ...participants, "normalize: [&a [*a]]"],
      problem: "normalize rule 1 is not a mapping with a kind: <ref *1> [ [Circular *1] ]",
    },
    "alias-normalize-kind": {
      lines: [...exercises, ...participants, "normalize: [{ kind: &k [*k] }]"],
      problem: "normalize rule 1 kind is neither strip_key nor replace_regex: <ref *1> [ [Circular *1] ]",
    },
    "alias-normalize-replacement": {
      lines: [...exercises, ...participants, "normalize: [{ kind: replace_regex, pattern: x, replacement: &r [*r] }]"],
      problem: "normalize rule 1 (replace_regex) replacement is not a string: <ref *1> [ [Circular *1] ]",
    },
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

test('README.md "Contract model" describes the load checks as the harness applies them', () => {
  // The section said only the first {FIXTURE_INPUT_DIR} is replaced, and named two contracts that stop
  // the run with an error; each now fails its fixture on load.
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const section = (readme.split(/^## /m).find((s) => s.startsWith("Contract model")) ?? "").replace(/\s+/g, " ");
  assert.match(section, /every `\{FIXTURE_INPUT_DIR\}` stands for the fixture's input directory, matched literally/);
  assert.match(section, /A `contract\.yaml` that is not one valid YAML document .* fails the fixture before any CLI runs/);
  assert.match(section, /Any other `kind`, and a `package` that is not a string, fail the fixture before any CLI runs/);
  assert.match(section, /A list that names no CLI would run and compare nothing, and fails the fixture before any CLI runs, as does a CLI listed twice/);
  assert.doesNotMatch(section, /can still stop the run/);
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

test("mayDifferProblems leaves a must_match entry that is not a key string to mustMatchProblems instead of throwing", () => {
  // The overlap set was built with String() over every must_match entry, which throws "Cannot convert
  // object to primitive value" on a mapping with a toString key, alone or inside a list.
  for (const [entry, formatted] of [["{ toString: x }", '{"toString":"x"}'], ["[{ toString: x }]", '[{"toString":"x"}]']]) {
    const contract = parseYaml(`must_match: [score, ${entry}]\nmay_differ: [{ path: score, reason: r }, { path: grade, reason: r }]`);
    assert.deepEqual(mayDifferProblems(contract), [
      "may_differ entry 1 (path: score) is also listed under must_match, where it is still compared; list it under one of the two",
    ], entry);
    assert.deepEqual(mustMatchProblems(contract), [`must_match entry 2 is not a key string: ${formatted}`], entry);
  }
});

test("participantsProblems names a participants that lists no CLI, and each CLI listed again", () => {
  // An empty list ran and compared nothing and passed on its skip sentinels; a CLI listed twice was
  // run twice and reported as agreeing with itself.
  assert.deepEqual(participantsProblems({ participants: [] }), [
    "participants lists no CLI, so the fixture would run and compare nothing; list at least one of hma, opena2a, ai-trust",
  ]);
  assert.deepEqual(participantsProblems(parseYaml("participants: [hma, opena2a, hma, hma, opena2a]")), [
    "participants entry 3 repeats hma; list each CLI once",
    "participants entry 4 repeats hma; list each CLI once",
    "participants entry 5 repeats opena2a; list each CLI once",
  ]);
});

test("normalizeProblems compiles a pattern with what the fixture puts in place of {FIXTURE_INPUT_DIR}", () => {
  // The pattern was compiled with `input` there, so one that is a regular expression only with that
  // value passed on load and stopped the run when the first output was normalized.
  const rule = (pattern: string) => parseYaml(`normalize: [{ kind: replace_regex, pattern: ${JSON.stringify(pattern)}, replacement: "" }]`);
  const head = "normalize rule 1 (replace_regex) pattern is not a regular expression with {FIXTURE_INPUT_DIR} standing for";
  // a kind: package-name fixture has no input directory, so the placeholder is an empty string
  assert.deepEqual(normalizeProblems(rule("{FIXTURE_INPUT_DIR}*"), "/fixtures/stub/input"), []);
  assert.deepEqual(normalizeProblems(rule("{FIXTURE_INPUT_DIR}*"), ""), [
    `${head} an empty string: Invalid regular expression: /*/g: Nothing to repeat`,
  ]);
  assert.deepEqual(normalizeProblems(rule("[a-{FIXTURE_INPUT_DIR}]"), ""), []);
  assert.deepEqual(normalizeProblems(rule("[a-{FIXTURE_INPUT_DIR}]"), "/fixtures/stub/input"), [
    `${head} the input directory: Invalid regular expression: /[a-/fixtures/stub/input]/g: Range out of order in character class`,
  ]);
});

// The contract of a passing kind: package-name stub fixture, with any of its fields replaced.
function stubContract(fields: Partial<Record<"kind" | "exercises" | "participants" | "mustMatch" | "normalize", string>> = {}): string {
  return [
    "description: stub",
    fields.kind ?? "kind: package-name\npackage: ghost",
    fields.exercises ?? 'exercises: { hma: "{BIN}" }',
    fields.participants ?? "participants: [hma]",
    fields.mustMatch ?? "must_match: [score]",
    fields.normalize ?? "normalize: []",
    "",
  ].join("\n");
}

// One fixture with the given contract.yaml, run on its own and then before a valid fixture, each on a
// stub CLI that counts its runs. Every fixture carries an input/ directory, a golden for hma and a skip
// sentinel for each CLI (a participant's sentinel is not read), so only the contract decides the result.
function runBesideValidFixture(name: string, contractYaml: string) {
  const dir = mkdtempSync(join(tmpdir(), "parity-load-"));
  const counter = join(dir, "n");
  const bin = join(dir, "stub.mjs");
  writeFileSync(counter, "0");
  writeFileSync(bin, `
import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(counter)}, String(Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1));
console.log(JSON.stringify({ score: 7 }));
`);
  const addFixture = (fixtureName: string, yaml: string) => {
    const fixture = join(dir, "fixtures", fixtureName);
    mkdirSync(join(fixture, "expected"), { recursive: true });
    mkdirSync(join(fixture, "input"));
    writeFileSync(join(fixture, "contract.yaml"), yaml);
    writeFileSync(join(fixture, "expected", "hma.json"), JSON.stringify({ score: 7 }));
    for (const cli of ["hma", "opena2a", "ai-trust"]) writeFileSync(join(fixture, "expected", `${cli}.skip`), `${cli} does not exercise this stub`);
  };
  addFixture(name, contractYaml);
  addFixture("valid", stubContract());
  const logged: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const bins = { hma: `node ${bin}`, opena2a: "unused", "ai-trust": "unused" };
    const dirs = { fixtures: join(dir, "fixtures"), actual: join(dir, "actual") };
    const rc = runFixture(name, bins, dirs);
    const alone = { rc, logged: [...logged], runs: Number(readFileSync(counter, "utf8")) };
    logged.length = 0;
    const failed = runFixtures([name, "valid"], bins, dirs);
    return { alone, beside: { failed, logged: [...logged], runs: Number(readFileSync(counter, "utf8")) - alone.runs } };
  } finally {
    console.error = origError;
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
}

// Each contract below stopped the run with an error thrown out of runFixture, so no later fixture ran,
// or passed its fixture with nothing run or nothing compared. `problem` is the line the load check
// prints for it after `[<fixture>] contract.yaml `, or a pattern where the line holds a temporary path.
const UNRUNNABLE_CONTRACTS: { title: string; name: string; contract: string; problem: string | RegExp }[] = [
  {
    // TypeError: Cannot convert object to primitive value
    title: "a must_match entry that is a mapping with a toString key",
    name: "to-string-key",
    contract: stubContract({ mustMatch: "must_match: [score, { toString: x }]" }),
    problem: 'must_match entry 2 is not a key string: {"toString":"x"}',
  },
  {
    title: "a must_match entry that is a list holding a mapping with a toString key",
    name: "to-string-key-in-list",
    contract: stubContract({ mustMatch: "must_match: [score, [{ toString: x }]]" }),
    problem: 'must_match entry 2 is not a key string: [{"toString":"x"}]',
  },
  {
    // SyntaxError: Invalid regular expression: /*/g: Nothing to repeat, thrown after the CLI had run
    title: "a pattern that is not a regular expression with the empty string a kind: package-name fixture puts in place of {FIXTURE_INPUT_DIR}",
    name: "star-after-no-dir",
    contract: stubContract({ normalize: 'normalize: [{ kind: replace_regex, pattern: "{FIXTURE_INPUT_DIR}*", replacement: "" }]' }),
    problem:
      "normalize rule 1 (replace_regex) pattern is not a regular expression with {FIXTURE_INPUT_DIR} standing for an empty string: Invalid regular expression: /*/g: Nothing to repeat",
  },
  {
    // SyntaxError: ... Range out of order in character class, thrown after the CLI had run
    title: "a pattern that is not a regular expression with the input directory a directory fixture puts in place of {FIXTURE_INPUT_DIR}",
    name: "range-to-dir",
    contract: stubContract({ kind: "kind: directory", normalize: 'normalize: [{ kind: replace_regex, pattern: "[a-{FIXTURE_INPUT_DIR}]", replacement: "" }]' }),
    problem:
      /^\[range-to-dir\] contract\.yaml normalize rule 1 \(replace_regex\) pattern is not a regular expression with \{FIXTURE_INPUT_DIR\} standing for the input directory: Invalid regular expression: .*: Range out of order in character class$/,
  },
  {
    // YAMLParseError, as are the next two
    title: "a contract.yaml with a YAML syntax error",
    name: "open-list",
    contract: stubContract({ exercises: "exercises: [" }),
    problem: "is not one valid YAML document: Flow sequence in block collection must be sufficiently indented and end with a ] at line 5, column 1",
  },
  {
    title: "a contract.yaml that holds a second YAML document",
    name: "second-document",
    contract: `${stubContract()}---\nmust_match: [grade]\n`,
    problem: "is not one valid YAML document: Source contains multiple documents; please use YAML.parseAllDocuments() at line 8, column 1",
  },
  {
    title: "a contract.yaml that repeats a key",
    name: "repeated-key",
    contract: `${stubContract()}must_match: [grade]\n`,
    problem: "is not one valid YAML document: Map keys must be unique at line 8, column 1",
  },
  {
    // ReferenceError
    title: "a contract.yaml with an alias to an anchor it does not set",
    name: "unset-anchor",
    contract: stubContract({ participants: "participants: *clis" }),
    problem: "is not one valid YAML document: Unresolved alias (the anchor must be set before the alias): clis",
  },
  {
    // ran with no input/ check and an empty string in place of {FIXTURE_INPUT_DIR}
    title: "a kind that is neither directory nor package-name",
    name: "unknown-kind",
    contract: stubContract({ kind: "kind: dir" }),
    problem: 'kind is neither directory nor package-name: "dir"',
  },
  {
    // TypeError: Cannot convert object to primitive value
    title: "a package that is a mapping with a toString key",
    name: "to-string-package",
    contract: stubContract({ kind: "kind: package-name\npackage: { toString: x }", exercises: 'exercises: { hma: "{BIN} {PACKAGE}" }' }),
    problem: 'package is not a package name string: {"toString":"x"}',
  },
  {
    // returned 0 after three [SKIP] lines
    title: "a participants list that names no CLI",
    name: "no-participant",
    contract: stubContract({ exercises: "exercises: {}", participants: "participants: []" }),
    problem: "participants lists no CLI, so the fixture would run and compare nothing; list at least one of hma, opena2a, ai-trust",
  },
  {
    // ran hma twice, printed its [OK] line twice and returned 0
    title: "a participant listed twice",
    name: "repeated-participant",
    contract: stubContract({ participants: "participants: [hma, hma]" }),
    problem: "participants entry 2 repeats hma; list each CLI once",
  },
];

for (const { title, name, contract, problem } of UNRUNNABLE_CONTRACTS) {
  test(`runFixtures fails a fixture on load for ${title}, runs no CLI for it, and runs the next fixture`, () => {
    const { alone, beside } = runBesideValidFixture(name, contract);
    assert.equal(alone.rc, 2, alone.logged.join("\n"));
    if (typeof problem === "string") {
      assert.deepEqual(alone.logged, [`[${name}] contract.yaml ${problem}`]);
    } else {
      assert.equal(alone.logged.length, 1, alone.logged.join("\n"));
      assert.match(alone.logged[0], problem);
    }
    assert.equal(alone.runs, 0, "the fixture ran a CLI");
    assert.equal(beside.failed, 1, beside.logged.join("\n"));
    assert.equal(beside.runs, 1, "the valid fixture after it ran its CLI, and nothing else did");
    assert.ok(beside.logged.some((line) => line.startsWith("[OK]   valid × hma:")), beside.logged.join("\n"));
  });
}
