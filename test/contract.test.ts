import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, rmSync, chmodSync, lstatSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  exerciseCommand,
  exercisesProblems,
  fixtureNames,
  kindProblems,
  mayDifferProblems,
  mustMatchProblems,
  normalizeProblems,
  participantsProblems,
  rulePattern,
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

test("exerciseCommand replaces every {BIN} and {PACKAGE} in a command and puts each value in as it is", () => {
  assert.equal(
    exerciseCommand("{BIN} check {PACKAGE} || {BIN} info {PACKAGE}", "node cli.js", "ghost"),
    "node cli.js check ghost || node cli.js info ghost",
  );
  // Each value was the replacement string of String.prototype.replace, which expands these. The shell
  // expands $` and $$ before a stub CLI sees its arguments, so the command is read here instead.
  for (const sequence of ["$&", "$`", "$'", "$$"]) {
    assert.equal(
      exerciseCommand("{BIN} check {PACKAGE}", `/opt/a${sequence}b/cli.js`, `name${sequence}d`),
      `/opt/a${sequence}b/cli.js check name${sequence}d`,
      sequence,
    );
  }
  // a value that holds the other placeholder is not read again
  assert.equal(exerciseCommand("{BIN} check {PACKAGE}", "/opt/{PACKAGE}/cli.js", "{BIN}"), "/opt/{PACKAGE}/cli.js check {BIN}");
  // a directory fixture has no package, and {PACKAGE} in its command stays as written
  assert.equal(exerciseCommand("{BIN} scan {PACKAGE}", "node cli.js"), "node cli.js scan {PACKAGE}");
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
  const rules = (...lines: string[]) => parseYaml(["normalize:", ...lines].join("\n"));
  const stripKey = "  - { kind: strip_key, path: timestamp }";
  const inputDir = '  - { kind: replace_regex, pattern: "{FIXTURE_INPUT_DIR}", replacement: "<FIXTURE_INPUT_DIR>" }';
  const digits = '  - { kind: replace_regex, pattern: "\\\\d+", replacement: "" }';
  for (const fixtureInputDir of ["", "/fixtures/stub/input"]) {
    assert.deepEqual(normalizeProblems({} as never, fixtureInputDir), []);
    assert.deepEqual(normalizeProblems(rules(stripKey, digits), fixtureInputDir), []);
  }
  // only the directory fixtures carry the rule that is {FIXTURE_INPUT_DIR} alone: a kind: package-name fixture has no input directory
  assert.deepEqual(normalizeProblems(rules(stripKey, inputDir, digits), "/fixtures/stub/input"), []);
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
  // The section said {FIXTURE_INPUT_DIR} stands for an empty string in a kind: package-name fixture; a
  // pattern there that holds it fails on load, since {FIXTURE_INPUT_DIR}.* with an empty replacement
  // deleted every string value.
  assert.doesNotMatch(section, /for an empty string in a `kind: package-name` fixture/);
  assert.match(
    section,
    /So does a `pattern` that holds `\{FIXTURE_INPUT_DIR\}` in a `kind: package-name` fixture, which has no input directory for it to stand for/,
  );
  assert.match(section, /`\{FIXTURE_INPUT_DIR\}\.\*` with an empty `replacement` would delete every string value/);
  // The section named an empty pattern only; one that is not empty and can match empty text fails on load
  // too, unless its replacement is empty, including one that matches empty text only next to a character.
  assert.match(
    section,
    /So does a `pattern` that holds `\{FIXTURE_INPUT_DIR\}` and can match empty text with the input directory there, unless its `replacement` is empty, which inserts nothing/,
  );
  assert.match(section, /`\\b\|\{FIXTURE_INPUT_DIR\}` matches empty text next to each word/);
  // The section said a package that is not a string fails any fixture; a directory fixture with one runs.
  assert.match(
    section,
    /Any other `kind` fails the fixture before any CLI runs, and so does a `package` that is not a string in a `package-name` fixture; a `directory` fixture does not read `package`/,
  );
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

test("normalizeProblems compiles a pattern with the input directory in place of {FIXTURE_INPUT_DIR}", () => {
  // The pattern was compiled with `input` there, so one that is a regular expression only with that
  // value passed on load and stopped the run when the first output was normalized.
  const rule = (pattern: string) => parseYaml(`normalize: [{ kind: replace_regex, pattern: ${JSON.stringify(pattern)}, replacement: "" }]`);
  assert.deepEqual(normalizeProblems(rule("{FIXTURE_INPUT_DIR}*"), "/fixtures/stub/input"), []);
  assert.deepEqual(normalizeProblems(rule("[a-{FIXTURE_INPUT_DIR}]"), "/fixtures/stub/input"), [
    "normalize rule 1 (replace_regex) pattern is not a regular expression with {FIXTURE_INPUT_DIR} standing for the input directory: Invalid regular expression: /[a-/fixtures/stub/input]/g: Range out of order in character class",
  ]);
});

test("normalizeProblems names a pattern that holds {FIXTURE_INPUT_DIR} in a kind: package-name fixture, which has no input directory", () => {
  // The placeholder stood for an empty string there: {FIXTURE_INPUT_DIR}* was *, which is not a regular
  // expression, {FIXTURE_INPUT_DIR} alone was empty and (?:{FIXTURE_INPUT_DIR}) was (?:), which match at every
  // position of every string, and {FIXTURE_INPUT_DIR}.* and {FIXTURE_INPUT_DIR}[^/]* with an empty replacement
  // passed and deleted every string value, as {FIXTURE_INPUT_DIR}.+ did, which can hide a must-match difference.
  assert.equal("hma 1.2.3 high".replace(rulePattern("{FIXTURE_INPUT_DIR}.*", ""), ""), "");
  assert.equal("ab".replace(rulePattern("(?:{FIXTURE_INPUT_DIR})", ""), "<IN>"), "<IN>a<IN>b<IN>");
  const rule = (pattern: string, replacement: string) =>
    parseYaml(`normalize: [{ kind: replace_regex, pattern: ${JSON.stringify(pattern)}, replacement: ${JSON.stringify(replacement)} }]`);
  const holds =
    "normalize rule 1 (replace_regex) pattern holds {FIXTURE_INPUT_DIR}, but a kind: package-name fixture has no input directory for it to stand for";
  const patterns = [
    "{FIXTURE_INPUT_DIR}",
    "{FIXTURE_INPUT_DIR}{FIXTURE_INPUT_DIR}",
    "{FIXTURE_INPUT_DIR}*",
    "(?:{FIXTURE_INPUT_DIR})",
    "{FIXTURE_INPUT_DIR}.*",
    "{FIXTURE_INPUT_DIR}[^/]*",
    "{FIXTURE_INPUT_DIR}.+",
    "a{FIXTURE_INPUT_DIR}b",
  ];
  for (const pattern of patterns) {
    for (const replacement of ["", "<IN>"]) {
      assert.deepEqual(normalizeProblems(rule(pattern, replacement), ""), [holds], `${pattern} -> ${JSON.stringify(replacement)}`);
      // in a directory fixture the placeholder stands for the input directory, and each of these passes
      assert.deepEqual(normalizeProblems(rule(pattern, replacement), "/fixtures/stub/input"), [], `${pattern} -> ${JSON.stringify(replacement)}`);
    }
  }
  // a pattern written empty is still a rule with no pattern, and one without the placeholder is checked as written
  assert.deepEqual(normalizeProblems(rule("", "<IN>"), ""), ["normalize rule 1 (replace_regex) has no pattern"]);
  assert.deepEqual(normalizeProblems(rule("\\d+", ""), ""), []);
  // an input directory named as the replacement sequence that expands to nothing is not an empty string
  assert.deepEqual(normalizeProblems(rule("{FIXTURE_INPUT_DIR}", "<IN>"), "$`"), []);
});

test("normalizeProblems names a pattern that can match empty text with the input directory in place of {FIXTURE_INPUT_DIR}", () => {
  // ({FIXTURE_INPUT_DIR})? matches the empty string, so it matched at every position of every string:
  // "ab" became "<IN>a<IN>b<IN>".
  const rule = (pattern: string) => parseYaml(`normalize: [{ kind: replace_regex, pattern: ${JSON.stringify(pattern)}, replacement: "<IN>" }]`);
  const inputDir = "/in";
  const problem = (compiled: string) =>
    `normalize rule 1 (replace_regex) pattern can match empty text with {FIXTURE_INPUT_DIR} standing for the input directory: ${compiled} would insert the replacement where it matched no text`;
  assert.equal("ab".replace(rulePattern("({FIXTURE_INPUT_DIR})?", inputDir), "<IN>"), "<IN>a<IN>b<IN>");
  for (const [pattern, compiled] of [
    ["({FIXTURE_INPUT_DIR})?", "/(\\/in)?/g"],
    ["(?:|{FIXTURE_INPUT_DIR})", "/(?:|\\/in)/g"],
    ["({FIXTURE_INPUT_DIR})*", "/(\\/in)*/g"],
    ["{FIXTURE_INPUT_DIR}|", "/\\/in|/g"],
    ["^(?:{FIXTURE_INPUT_DIR})?$", "/^(?:\\/in)?$/g"],
  ]) {
    assert.deepEqual(normalizeProblems(rule(pattern), inputDir), [problem(compiled)], pattern);
  }
  // a pattern that must match the input directory passes
  for (const pattern of ["{FIXTURE_INPUT_DIR}", "(?:{FIXTURE_INPUT_DIR})", "({FIXTURE_INPUT_DIR})+", "^{FIXTURE_INPUT_DIR}$", "a?{FIXTURE_INPUT_DIR}b?", "{FIXTURE_INPUT_DIR}/?SOUL\\.md"]) {
    assert.deepEqual(normalizeProblems(rule(pattern), inputDir), [], pattern);
  }
  // a pattern written without the placeholder is what its author wrote: ^$ replaces a value that is an empty string
  assert.deepEqual(normalizeProblems(rule("^$"), inputDir), []);
});

test("normalizeProblems names a pattern with an alternative that matches empty text only next to a character", () => {
  // Run on an empty string alone, \b and (?=b) match no text, but they match empty text next to a word and
  // before a b. Each pattern below, an alternative beside {FIXTURE_INPUT_DIR}, is shown inserting the
  // replacement into its text where it matched no text.
  const rule = (pattern: string) => parseYaml(`normalize: [{ kind: replace_regex, pattern: ${JSON.stringify(pattern)}, replacement: "<IN>" }]`);
  const inputDir = "/in";
  const problem = (compiled: string) =>
    `normalize rule 1 (replace_regex) pattern can match empty text with {FIXTURE_INPUT_DIR} standing for the input directory: ${compiled} would insert the replacement where it matched no text`;
  for (const [alternative, text, normalized] of [
    ["\\b", "ab cd", "<IN>ab<IN> <IN>cd<IN>"],
    ["(?=b)", "ab cd", "a<IN>b cd"],
    ["\\B", "ab", "a<IN>b"],
    ["(?<=a)", "ab", "a<IN>b"],
    ["(?!a)", "a", "a<IN>"],
    // a part that may repeat zero times, however it is written
    ["x{0}", "b", "<IN>b<IN>"],
    ["[a]{0,3}", "b", "<IN>b<IN>"],
    ["(?:a|c?)", "b", "<IN>b<IN>"],
    ["(?i:a*)", "b", "<IN>b<IN>"],
    ["\\x41*", "b", "<IN>b<IN>"],
    ["\\u0041?", "b", "<IN>b<IN>"],
    ["\\101*", "b", "<IN>b<IN>"],
    // without the u flag, \u not followed by four hex digits is a u, here repeated zero times
    ["\\u{0}", "b", "<IN>b<IN>"],
    // a backreference to a group that took no part matches empty text
    ["(a)|\\1", "b", "<IN>b<IN>"],
    ["(?<n>a)|\\k<n>", "b", "<IN>b<IN>"],
    // a class ends at the first ] that is not escaped, so [\]] is one class, which ? lets repeat zero times
    ["[\\]]?", "ab", "<IN>a<IN>b<IN>"],
    // \c before anything but a letter is a backslash, then a c, so the | after it opens an alternative that is empty
    ["\\c|", "ab", "<IN>a<IN>b<IN>"],
  ]) {
    const pattern = `${alternative}|{FIXTURE_INPUT_DIR}`;
    assert.equal(text.replace(rulePattern(pattern, inputDir), "<IN>"), normalized, pattern);
    assert.deepEqual(normalizeProblems(rule(pattern), inputDir), [problem(`/${alternative}|\\/in/g`)], pattern);
  }
  // A pattern each of whose alternatives must match a character passes, whatever it asserts beside it,
  // and makes no match of empty text in a text that holds the characters these patterns name.
  const text = "ab cd x4 a{,2} *? k<n> aa \\c \n A";
  for (const alternative of [
    "\\bx",
    "(?=b)b",
    "(a)\\1",
    // \12 with no group is the octal escape of a line feed; \x and \k without what completes them are an x and a k
    "\\12",
    "\\x4?",
    "\\k<n>",
    // \c before anything but a letter is a backslash, then a c: the quantifier repeats the c alone
    "\\c*",
    // a { that opens no quantifier, and a class, match characters
    "a{,2}",
    "[*?]",
    "[\\]x]+",
  ]) {
    const pattern = `${alternative}|{FIXTURE_INPUT_DIR}`;
    assert.ok([...text.matchAll(rulePattern(pattern, inputDir))].every((m) => m[0] !== ""), pattern);
    assert.deepEqual(normalizeProblems(rule(pattern), inputDir), [], pattern);
  }
});

test("normalizeProblems checks a pattern that nests more groups than the call stack holds calls", () => {
  // The check called itself for each group, so 3,000 nested groups threw a RangeError (Maximum call stack
  // size exceeded) out of the run before the remaining fixtures ran. The engine runs such a pattern.
  const nested = (inner: string) => `${"(?:".repeat(100_000)}${inner}${")".repeat(100_000)}`;
  const rule = (pattern: string) => ({ normalize: [{ kind: "replace_regex" as const, pattern, replacement: "<IN>" }] });
  assert.deepEqual(normalizeProblems(rule(`${nested("x")}{FIXTURE_INPUT_DIR}`), "/in"), []);
  const emptyAlternative = `${nested("x?")}|{FIXTURE_INPUT_DIR}`;
  assert.equal("ab".replace(rulePattern(emptyAlternative, "/in"), "<IN>"), "<IN>a<IN>b<IN>");
  const problems = normalizeProblems(rule(emptyAlternative), "/in");
  assert.equal(problems.length, 1, problems.join("\n").slice(0, 400));
  assert.ok(
    problems[0].startsWith(`normalize rule 1 (replace_regex) pattern can match empty text with {FIXTURE_INPUT_DIR} standing for the input directory: /${nested("x?")}|\\/in/g`),
    problems[0].slice(0, 400),
  );
});

test("normalizeProblems names a pattern the engine accepts but cannot compile when it runs it", () => {
  // new RegExp accepts these, and the engine throws "Regular expression too large" the first time it runs
  // one, out of the check or out of the run when the first output was normalized, before the remaining
  // fixtures ran. Characters wider than Latin-1 compile on text of one-byte characters and throw only on
  // text with a wider one.
  const rule = (pattern: string) => ({ normalize: [{ kind: "replace_regex" as const, pattern, replacement: "<IN>" }] });
  const wide = String.fromCharCode(0x100);
  for (const [pattern, fixtureInputDir, standingFor] of [
    [`${"x".repeat(100_000)}{FIXTURE_INPUT_DIR}`, "/in", " with {FIXTURE_INPUT_DIR} standing for the input directory"],
    ["x".repeat(100_000), "", ""],
    [wide.repeat(40_000), "", ""],
  ]) {
    assert.doesNotThrow(() => rulePattern(pattern, fixtureInputDir));
    const problems = normalizeProblems(rule(pattern), fixtureInputDir);
    assert.equal(problems.length, 1, `${pattern.slice(0, 20)}: ${problems.length} problems`);
    const head = `normalize rule 1 (replace_regex) pattern is not a regular expression${standingFor}: Invalid regular expression: /`;
    assert.ok(problems[0].startsWith(head) && problems[0].endsWith("/g: Regular expression too large"), `${problems[0].slice(0, 200)}...${problems[0].slice(-60)}`);
  }
});

test("normalizeProblems passes a pattern that can match empty text where its replacement is empty", () => {
  // An empty replacement inserts nothing where the pattern matched no text, and deletes what it matched,
  // as {FIXTURE_INPUT_DIR} with an empty replacement does in a directory fixture.
  const rule = (pattern: string) => parseYaml(`normalize: [{ kind: replace_regex, pattern: ${JSON.stringify(pattern)}, replacement: "" }]`);
  const inputDir = "/fixtures/stub/input";
  assert.equal(`ab ${inputDir}`.replace(rulePattern("({FIXTURE_INPUT_DIR})?", inputDir), ""), "ab ");
  assert.deepEqual(normalizeProblems(rule("({FIXTURE_INPUT_DIR})?"), inputDir), []);
  assert.deepEqual(normalizeProblems(rule("{FIXTURE_INPUT_DIR}"), inputDir), []);
  assert.equal("ab cd".replace(rulePattern("\\b|{FIXTURE_INPUT_DIR}", inputDir), ""), "ab cd");
  assert.deepEqual(normalizeProblems(rule("\\b|{FIXTURE_INPUT_DIR}"), inputDir), []);
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
// stub CLI that counts its runs and prints the arguments it was given beside its score. Every fixture
// carries an input/ directory, a golden for hma and a skip sentinel for each CLI (a participant's
// sentinel is not read), so only the contract decides the result, or `golden` where one is given: the
// text of the fixture's own hma golden, or a function that puts something at the golden's path. `arrange`,
// where given, then changes the fixture's directory or the directory its captures are written to before
// either run. `alone.args` is the arguments in the capture of the fixture's own run, undefined where it wrote none.
function runBesideValidFixture(
  name: string,
  contractYaml: string,
  golden: string | ((goldenPath: string) => void) = JSON.stringify({ score: 7 }),
  arrange?: (fixtureDir: string, actualDir: string) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "parity-load-"));
  const counter = join(dir, "n");
  const bin = join(dir, "stub.mjs");
  writeFileSync(counter, "0");
  writeFileSync(bin, `
import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(counter)}, String(Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1));
console.log(JSON.stringify({ score: 7, args: process.argv.slice(2) }));
`);
  const addFixture = (fixtureName: string, yaml: string, goldenText: string | ((goldenPath: string) => void)) => {
    const fixture = join(dir, "fixtures", fixtureName);
    mkdirSync(join(fixture, "expected"), { recursive: true });
    mkdirSync(join(fixture, "input"));
    writeFileSync(join(fixture, "contract.yaml"), yaml);
    const goldenPath = join(fixture, "expected", "hma.json");
    if (typeof goldenText === "string") writeFileSync(goldenPath, goldenText);
    else goldenText(goldenPath);
    for (const cli of ["hma", "opena2a", "ai-trust"]) writeFileSync(join(fixture, "expected", `${cli}.skip`), `${cli} does not exercise this stub`);
  };
  addFixture(name, contractYaml, golden);
  addFixture("valid", stubContract(), JSON.stringify({ score: 7 }));
  arrange?.(join(dir, "fixtures", name), join(dir, "actual"));
  const logged: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const bins = { hma: `node ${bin}`, opena2a: "unused", "ai-trust": "unused" };
    const dirs = { fixtures: join(dir, "fixtures"), actual: join(dir, "actual") };
    const rc = runFixture(name, bins, dirs);
    const capturePath = join(dirs.actual, name, "hma.json");
    // existsSync, since looking up a path under a file throws ENOTDIR whatever throwIfNoEntry says
    const args: unknown = existsSync(capturePath) && lstatSync(capturePath).isFile() ? JSON.parse(readFileSync(capturePath, "utf8")).args : undefined;
    const alone = { rc, logged: [...logged], runs: Number(readFileSync(counter, "utf8")), args };
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
// or passed its fixture, as its entry comment says: with nothing run or compared (a participants list
// that names no CLI), or with hma run and `score` compared and found equal (`kind: dir`,
// `participants: [hma, hma]` and each pattern that holds {FIXTURE_INPUT_DIR} and can match empty text
// or delete every string value). `problem` is the line the load check prints for it after
// `[<fixture>] contract.yaml `, or a pattern for the whole line where it holds a temporary path or a
// pattern too long to write out.
const HOLDS_INPUT_DIR =
  "normalize rule 1 (replace_regex) pattern holds {FIXTURE_INPUT_DIR}, but a kind: package-name fixture has no input directory for it to stand for";
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
    title: "the pattern {FIXTURE_INPUT_DIR}* in a kind: package-name fixture, which has no input directory, where it was *",
    name: "star-after-no-dir",
    contract: stubContract({ normalize: 'normalize: [{ kind: replace_regex, pattern: "{FIXTURE_INPUT_DIR}*", replacement: "" }]' }),
    problem: HOLDS_INPUT_DIR,
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
    // ran hma with an empty regular expression, which matches at every position of every string, and returned 0
    title: "the pattern {FIXTURE_INPUT_DIR} in a kind: package-name fixture, which has no input directory, where it was empty",
    name: "only-no-dir",
    contract: stubContract({ normalize: 'normalize: [{ kind: replace_regex, pattern: "{FIXTURE_INPUT_DIR}", replacement: "<IN>" }]' }),
    problem: HOLDS_INPUT_DIR,
  },
  {
    // ran hma with .*, which deleted every string value, and returned 0
    title: "the pattern {FIXTURE_INPUT_DIR}.* with an empty replacement in a kind: package-name fixture, which has no input directory",
    name: "rest-of-no-dir",
    contract: stubContract({ normalize: 'normalize: [{ kind: replace_regex, pattern: "{FIXTURE_INPUT_DIR}.*", replacement: "" }]' }),
    problem: HOLDS_INPUT_DIR,
  },
  {
    // ran hma with an optional input directory, which matches at every position of every string, and returned 0
    title: "a pattern that matches the empty string with the input directory a directory fixture puts in place of {FIXTURE_INPUT_DIR}",
    name: "optional-dir",
    contract: stubContract({ kind: "kind: directory", normalize: 'normalize: [{ kind: replace_regex, pattern: "({FIXTURE_INPUT_DIR})?", replacement: "<IN>" }]' }),
    problem:
      /^\[optional-dir\] contract\.yaml normalize rule 1 \(replace_regex\) pattern can match empty text with \{FIXTURE_INPUT_DIR\} standing for the input directory: \/\(.*\\\/optional-dir\\\/input\)\?\/g would insert the replacement where it matched no text$/,
  },
  {
    // ran hma with \b beside the input directory, which matches empty text next to each word, and returned 0
    title: "a pattern with an alternative that matches empty text only next to a character, beside {FIXTURE_INPUT_DIR} in a directory fixture",
    name: "boundary-or-dir",
    contract: stubContract({ kind: "kind: directory", normalize: 'normalize: [{ kind: replace_regex, pattern: "\\\\b|{FIXTURE_INPUT_DIR}", replacement: "<IN>" }]' }),
    problem:
      /^\[boundary-or-dir\] contract\.yaml normalize rule 1 \(replace_regex\) pattern can match empty text with \{FIXTURE_INPUT_DIR\} standing for the input directory: \/\\b\|.*\\\/boundary-or-dir\\\/input\/g would insert the replacement where it matched no text$/,
  },
  {
    // RangeError: Maximum call stack size exceeded, thrown by the check itself
    title: "a pattern that nests 100,000 groups and can match empty text, beside {FIXTURE_INPUT_DIR} in a directory fixture",
    name: "deep-or-dir",
    contract: stubContract({
      kind: "kind: directory",
      normalize: `normalize: [{ kind: replace_regex, pattern: "${"(?:".repeat(100_000)}x?${")".repeat(100_000)}|{FIXTURE_INPUT_DIR}", replacement: "<IN>" }]`,
    }),
    problem:
      /^\[deep-or-dir\] contract\.yaml normalize rule 1 \(replace_regex\) pattern can match empty text with \{FIXTURE_INPUT_DIR\} standing for the input directory: \/(?:\(\?:){100000}x\?\){100000}\|.*\\\/deep-or-dir\\\/input\/g would insert the replacement where it matched no text$/,
  },
  {
    // SyntaxError: Invalid regular expression: /x.../g: Regular expression too large, thrown after the CLI had run
    title: "a pattern the engine accepts and cannot compile when it runs it",
    name: "too-large",
    contract: stubContract({ normalize: `normalize: [{ kind: replace_regex, pattern: "${"x".repeat(100_000)}", replacement: "<IN>" }]` }),
    problem:
      /^\[too-large\] contract\.yaml normalize rule 1 \(replace_regex\) pattern is not a regular expression: Invalid regular expression: \/x{100000}\/g: Regular expression too large$/,
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

test("runFixture puts the package in place of every {PACKAGE} in a command, not only the first", () => {
  // The second placeholder reached the CLI as the text {PACKAGE}, and the fixture passed.
  const { alone } = runBesideValidFixture("two-packages", stubContract({ exercises: 'exercises: { hma: "{BIN} {PACKAGE} --peer {PACKAGE}" }' }));
  assert.equal(alone.rc, 0, alone.logged.join("\n"));
  assert.deepEqual(alone.args, ["ghost", "--peer", "ghost"]);
});

test("runFixture runs a directory fixture whose contract carries a package that is not a string", () => {
  // Only a kind: package-name fixture reads package, so its type is checked there and nowhere else,
  // which is what README.md "Contract model" says.
  const { alone } = runBesideValidFixture("package-in-directory", stubContract({ kind: "kind: directory\npackage: 5" }));
  assert.equal(alone.rc, 0, alone.logged.join("\n"));
  assert.equal(alone.runs, 1, "the fixture ran its CLI once");
});

test("runFixtures fails the leg of a participant whose golden is not valid JSON, runs no CLI for it, and runs the next fixture", () => {
  // The SyntaxError was thrown out of runFixture, so the run stopped before the valid fixture ran.
  const { alone, beside } = runBesideValidFixture("open-golden", stubContract(), "{ score: 7,");
  assert.equal(alone.rc, 1, alone.logged.join("\n"));
  assert.deepEqual(alone.logged.slice(1), ["[SKIP] open-golden × opena2a: opena2a does not exercise this stub", "[SKIP] open-golden × ai-trust: ai-trust does not exercise this stub"]);
  assert.match(alone.logged[0], /^\n\[FAIL\] open-golden × hma: the golden at .*hma\.json is not valid JSON \(SyntaxError: .+\)$/);
  assert.equal(alone.runs, 0, "the fixture ran a CLI");
  assert.equal(beside.failed, 1, beside.logged.join("\n"));
  assert.equal(beside.runs, 1, "the valid fixture after it ran its CLI, and nothing else did");
  assert.ok(beside.logged.some((line) => line.startsWith("[OK]   valid × hma:")), beside.logged.join("\n"));
});

const ROOT_SKIP = process.getuid?.() === 0 ? "root reads a file it has no permission bits for" : undefined;

// Each golden below is not a file or could not be opened. The error a directory or a file without read
// permission failed with was thrown out of runFixture, so the run stopped before the valid fixture ran; a
// symbolic link that dangles or loops was reported as a missing golden after its CLI had run. `reason`
// is what the leg's line says of the golden after its path.
const UNREADABLE_GOLDENS: { title: string; name: string; golden: (goldenPath: string) => void; reason: string; skip?: string }[] = [
  {
    title: "a directory",
    name: "directory-golden",
    golden: (goldenPath) => mkdirSync(goldenPath),
    reason: "is a directory, not a file",
  },
  {
    title: "a file it may not read",
    name: "closed-golden",
    golden: (goldenPath) => {
      writeFileSync(goldenPath, JSON.stringify({ score: 7 }));
      chmodSync(goldenPath, 0o000);
    },
    reason: "could not be read (EACCES on open)",
    skip: ROOT_SKIP,
  },
  {
    title: "a symbolic link to no file",
    name: "dangling-golden",
    golden: (goldenPath) => symlinkSync(join(dirname(goldenPath), "nowhere.json"), goldenPath),
    reason: "could not be read (ENOENT on stat)",
  },
  {
    title: "a symbolic link to itself",
    name: "looping-golden",
    golden: (goldenPath) => symlinkSync(goldenPath, goldenPath),
    reason: "could not be read (ELOOP on stat)",
  },
];

for (const { title, name, golden, reason, skip } of UNREADABLE_GOLDENS) {
  test(`runFixtures fails the leg of a participant whose golden is ${title}, runs no CLI for it, and runs the next fixture`, { skip }, () => {
    const { alone, beside } = runBesideValidFixture(name, stubContract(), golden);
    assert.equal(alone.rc, 1, alone.logged.join("\n"));
    assert.deepEqual(alone.logged.slice(1), [`[SKIP] ${name} × opena2a: opena2a does not exercise this stub`, `[SKIP] ${name} × ai-trust: ai-trust does not exercise this stub`]);
    const goldenPath = /the golden at (.*hma\.json) /.exec(alone.logged[0])?.[1] ?? "";
    assert.ok(goldenPath.endsWith(join(name, "expected", "hma.json")), alone.logged.join("\n"));
    assert.equal(alone.logged[0], `\n[FAIL] ${name} × hma: the golden at ${goldenPath} ${reason}`);
    assert.equal(alone.runs, 0, "the fixture ran a CLI");
    assert.equal(beside.failed, 1, beside.logged.join("\n"));
    assert.equal(beside.runs, 1, "the valid fixture after it ran its CLI, and nothing else did");
    assert.ok(beside.logged.some((line) => line.startsWith("[OK]   valid × hma:")), beside.logged.join("\n"));
  });
}

// Each path below is a FIFO. Opening one to read it waits for a program to write to it, and opening one
// to write to it waits for a program to read from it, so a golden or a capture that was one held the run
// before any later leg or fixture ran; a contract.yaml or a skip sentinel that is one is read only after
// its type is looked up, as README.md "Contract model" says. The fixtures run in a child process, so a
// run that waits on the FIFO fails its test on the timeout instead of holding the test run too. `fifo`
// is where the FIFO is made, `report` what the run prints on standard error for it, and `runs` how many
// times the fixture runs its CLI.
const FIFOS: {
  title: string;
  name: string;
  fifo: (fixtureDir: string, actualDir: string) => string;
  report: (fifo: string) => string[];
  runs: number;
}[] = [
  {
    title: "the leg of a participant whose golden is a FIFO, runs no CLI for it,",
    name: "fifo-golden",
    fifo: (fixtureDir) => join(fixtureDir, "expected", "hma.json"),
    report: (fifo) => [`[FAIL] fifo-golden × hma: the golden at ${fifo} is a FIFO, not a file`],
    runs: 0,
  },
  {
    title: "a fixture whose contract.yaml is a FIFO, before running a CLI,",
    name: "fifo-contract",
    fifo: (fixtureDir) => join(fixtureDir, "contract.yaml"),
    report: () => ["[fifo-contract] contract.yaml is a FIFO, not a file"],
    runs: 0,
  },
  {
    title: "a fixture whose skip sentinel is a FIFO",
    name: "fifo-sentinel",
    fifo: (fixtureDir) => join(fixtureDir, "expected", "opena2a.skip"),
    report: (fifo) => [
      `[FAIL] fifo-sentinel × opena2a: the skip sentinel at ${fifo} is a FIFO, not a file`,
      `  Make expected/opena2a.skip a file that says why opena2a does not exercise this fixture (README.md "Contract model").`,
    ],
    runs: 1,
  },
  {
    title: "the leg of a participant whose capture path is a FIFO",
    name: "fifo-capture",
    fifo: (_fixtureDir, actualDir) => join(actualDir, "fifo-capture", "hma.json"),
    report: (fifo) => [`[FAIL] fifo-capture × hma: the capture at ${fifo} is a FIFO, not a file`],
    runs: 1,
  },
];

for (const { title, name, fifo: fifoPath, report, runs } of FIFOS) {
  test(`runFixtures fails ${title} and runs the next fixture`, { skip: process.platform === "win32" ? "mkfifo makes no FIFO on Windows" : undefined }, () => {
    const dir = mkdtempSync(join(tmpdir(), "parity-fifo-"));
    try {
      const counter = join(dir, "n");
      const stub = join(dir, "stub.mjs");
      writeFileSync(counter, "");
      writeFileSync(stub, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(counter)}, ".");\nconsole.log(JSON.stringify({ score: 7 }));\n`);
      for (const fixtureName of [name, "valid"]) {
        const fixture = join(dir, "fixtures", fixtureName);
        mkdirSync(join(fixture, "expected"), { recursive: true });
        writeFileSync(join(fixture, "contract.yaml"), stubContract());
        writeFileSync(join(fixture, "expected", "hma.json"), JSON.stringify({ score: 7 }));
        for (const cli of ["opena2a", "ai-trust"]) writeFileSync(join(fixture, "expected", `${cli}.skip`), `${cli} does not exercise this stub`);
      }
      const fifo = fifoPath(join(dir, "fixtures", name), join(dir, "actual"));
      mkdirSync(dirname(fifo), { recursive: true });
      rmSync(fifo, { force: true });
      execFileSync("mkfifo", [fifo]);
      const script = [
        `import { runFixtures } from ${JSON.stringify(pathToFileURL(join(repoRoot, "src", "run-parity.ts")).href)};`,
        `const bins = { hma: ${JSON.stringify(`node ${stub}`)}, opena2a: "unused", "ai-trust": "unused" };`,
        `const dirs = { fixtures: ${JSON.stringify(join(dir, "fixtures"))}, actual: ${JSON.stringify(join(dir, "actual"))} };`,
        `console.log("failed=" + runFixtures([${JSON.stringify(name)}, "valid"], bins, dirs));`,
      ].join("\n");
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000 });
      assert.equal(r.signal, null, `the run waited on the FIFO until it was stopped\n${r.stdout}${r.stderr}`);
      assert.equal(r.stderr.trim(), report(fifo).join("\n"));
      assert.match(r.stdout, /^\[OK\] {3}valid × hma:/m);
      assert.match(r.stdout, /^failed=1$/m);
      assert.equal(readFileSync(counter, "utf8").length, runs + 1, "the fixture ran its CLI that many times, and the valid fixture once");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// Each file below stopped the run with the error thrown out of runFixture, so the valid fixture after it
// did not run, unless its entry comment says otherwise: a contract.yaml or a skip sentinel that is not a
// file or cannot be opened, and a capture that cannot be written. `line` is what the fixture's own run
// prints for it, `rc` what that run returns and `runs` how many times it runs the CLI.
const replaceWithDirectory = (path: string) => {
  rmSync(path);
  mkdirSync(path);
};
const UNREADABLE_FILES: {
  title: string;
  name: string;
  arrange: (fixtureDir: string, actualDir: string) => void;
  rc: number;
  line: RegExp;
  runs: number;
  skip?: string;
}[] = [
  {
    title: "whose contract.yaml is a directory",
    name: "directory-contract",
    arrange: (fixtureDir) => replaceWithDirectory(join(fixtureDir, "contract.yaml")),
    rc: 2,
    line: /^\[directory-contract\] contract\.yaml is a directory, not a file$/,
    runs: 0,
  },
  {
    title: "whose contract.yaml it may not read",
    name: "closed-contract",
    arrange: (fixtureDir) => chmodSync(join(fixtureDir, "contract.yaml"), 0o000),
    rc: 2,
    line: /^\[closed-contract\] contract\.yaml could not be read \(EACCES on open\)$/,
    runs: 0,
    skip: ROOT_SKIP,
  },
  {
    title: "whose skip sentinel is a directory",
    name: "directory-sentinel",
    arrange: (fixtureDir) => replaceWithDirectory(join(fixtureDir, "expected", "opena2a.skip")),
    rc: 1,
    line: /^\n\[FAIL\] directory-sentinel × opena2a: the skip sentinel at .*\/directory-sentinel\/expected\/opena2a\.skip is a directory, not a file$/,
    runs: 1,
  },
  {
    title: "whose skip sentinel it may not read",
    name: "closed-sentinel",
    arrange: (fixtureDir) => chmodSync(join(fixtureDir, "expected", "ai-trust.skip"), 0o000),
    rc: 1,
    line: /^\n\[FAIL\] closed-sentinel × ai-trust: the skip sentinel at .*\/closed-sentinel\/expected\/ai-trust\.skip could not be read \(EACCES on open\)$/,
    runs: 1,
    skip: ROOT_SKIP,
  },
  {
    title: "whose capture path is a directory",
    name: "directory-capture",
    arrange: (_fixtureDir, actualDir) => mkdirSync(join(actualDir, "directory-capture", "hma.json"), { recursive: true }),
    rc: 1,
    line: /^\n\[FAIL\] directory-capture × hma: the capture at .*\/directory-capture\/hma\.json is a directory, not a file$/,
    runs: 1,
  },
  {
    // the directory its captures go in is made inside the try that fails the leg
    title: "whose directory for captures is a file",
    name: "file-capture-dir",
    arrange: (_fixtureDir, actualDir) => {
      mkdirSync(actualDir, { recursive: true });
      writeFileSync(join(actualDir, "file-capture-dir"), "");
    },
    rc: 1,
    line: /^\n\[FAIL\] file-capture-dir × hma: the capture could not be written at .*\/file-capture-dir\/hma\.json \(EEXIST on mkdir\)$/,
    runs: 1,
  },
  {
    // reported as missing, and left out of `npm run parity` (see fixtureNames)
    title: "whose contract.yaml is a symbolic link to no file",
    name: "dangling-contract",
    arrange: (fixtureDir) => {
      rmSync(join(fixtureDir, "contract.yaml"));
      symlinkSync("missing.yaml", join(fixtureDir, "contract.yaml"));
    },
    rc: 2,
    line: /^\[dangling-contract\] contract\.yaml could not be read \(ENOENT on stat\)$/,
    runs: 0,
  },
  {
    title: "whose contract.yaml is a symbolic link to itself",
    name: "looping-contract",
    arrange: (fixtureDir) => {
      rmSync(join(fixtureDir, "contract.yaml"));
      symlinkSync("contract.yaml", join(fixtureDir, "contract.yaml"));
    },
    rc: 2,
    line: /^\[looping-contract\] contract\.yaml could not be read \(ELOOP on stat\)$/,
    runs: 0,
  },
];

test("fixtureNames lists each fixture with a contract.yaml, a symbolic link that dangles or loops included", () => {
  // existsSync follows the link, so `npm run parity` left such a fixture out without a line and counted
  // one fixture fewer in its summary; runFixture fails it as a contract.yaml it cannot read.
  const dir = mkdtempSync(join(tmpdir(), "parity-names-"));
  try {
    for (const name of ["file", "dangling", "looping", "no-contract"]) mkdirSync(join(dir, name));
    writeFileSync(join(dir, "file", "contract.yaml"), stubContract());
    symlinkSync("missing.yaml", join(dir, "dangling", "contract.yaml"));
    symlinkSync("contract.yaml", join(dir, "looping", "contract.yaml"));
    writeFileSync(join(dir, "README.md"), "not a fixture");
    assert.deepEqual(fixtureNames(dir).sort(), ["dangling", "file", "looping"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const { title, name, arrange, rc, line, runs, skip } of UNREADABLE_FILES) {
  test(`runFixtures fails a fixture ${title} and runs the next fixture`, { skip }, () => {
    const { alone, beside } = runBesideValidFixture(name, stubContract(), undefined, arrange);
    assert.equal(alone.rc, rc, alone.logged.join("\n"));
    assert.equal(alone.logged.filter((logged) => line.test(logged)).length, 1, alone.logged.join("\n"));
    assert.equal(alone.runs, runs, alone.logged.join("\n"));
    assert.equal(beside.failed, 1, beside.logged.join("\n"));
    assert.equal(beside.runs, runs + 1, "the valid fixture after it ran its CLI");
    assert.ok(beside.logged.some((logged) => logged.startsWith("[OK]   valid × hma:")), beside.logged.join("\n"));
  });
}
