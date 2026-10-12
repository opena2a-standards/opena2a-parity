import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { mayDifferProblems, runFixture, runFixtures } from "../src/run-parity.ts";

// The comparison reads only must_match, so a may_differ entry is checked on load or not at all: an
// entry without its reason, or a key listed under both lists (still compared), would pass silently.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

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
