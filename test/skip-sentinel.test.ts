import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { runFixture } from "../src/run-parity.ts";

// A CLI that is not one of a fixture's participants is covered by expected/<cli>.skip, which says why
// it does not exercise the fixture. A CLI with neither used to be skipped without a line, so a fixture
// that left a CLI out by mistake looked complete.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const ALL_CLIS = ["hma", "opena2a", "ai-trust"];

// One fixture in a temporary fixtures/ root with hma as its only participant, run against a stub that
// prints hma's golden. `skips` names the CLIs that get a sentinel, `emptySkips` the CLIs that get one
// holding only whitespace. Returns the fixture's result and every line the harness printed.
function runHmaOnly(skips: string[], emptySkips: string[] = []): { rc: number; logged: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "parity-skip-"));
  const fixture = join(dir, "fixtures", "stub");
  mkdirSync(join(fixture, "expected"), { recursive: true });
  writeFileSync(join(fixture, "contract.yaml"), [
    "description: skip sentinel stub",
    "kind: package-name",
    "package: ghost",
    "exercises:",
    '  hma: "{BIN}"',
    "participants:",
    "  - hma",
    "must_match:",
    "  - score",
    "may_differ: []",
    "",
  ].join("\n"));
  const golden = join(fixture, "expected", "hma.json");
  writeFileSync(golden, JSON.stringify({ score: 98 }));
  for (const cli of skips) writeFileSync(join(fixture, "expected", `${cli}.skip`), `${cli} does not exercise this stub`);
  for (const cli of emptySkips) writeFileSync(join(fixture, "expected", `${cli}.skip`), " \n");
  const logged: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const bins = { hma: `cat ${golden}`, opena2a: "unused", "ai-trust": "unused" };
    return { rc: runFixture("stub", bins, { fixtures: join(dir, "fixtures"), actual: join(dir, "actual") }), logged };
  } finally {
    console.error = origError;
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("runFixture prints a [SKIP] line for each non-participant that has a sentinel, and passes", () => {
  const r = runHmaOnly(["opena2a", "ai-trust"]);
  assert.equal(r.rc, 0, r.logged.join("\n"));
  assert.ok(r.logged.includes("[SKIP] stub × opena2a: opena2a does not exercise this stub"), r.logged.join("\n"));
  assert.ok(r.logged.includes("[SKIP] stub × ai-trust: ai-trust does not exercise this stub"), r.logged.join("\n"));
  assert.ok(!r.logged.some((l) => l.includes("[FAIL]")), r.logged.join("\n"));
});

test("runFixture fails a fixture whose non-participant CLI has no sentinel, and names the CLI and the file to add", () => {
  const r = runHmaOnly(["opena2a"]);
  assert.equal(r.rc, 1, r.logged.join("\n"));
  // the participant itself still passes: the failure is the uncovered CLI, not the comparison
  assert.ok(r.logged.some((l) => l.startsWith("[OK]   stub × hma")), r.logged.join("\n"));
  assert.ok(r.logged.includes("[SKIP] stub × opena2a: opena2a does not exercise this stub"), r.logged.join("\n"));
  const fail = r.logged.find((l) => l.includes("[FAIL] stub × ai-trust")) ?? "";
  assert.match(fail, /not a participant and has no skip sentinel at .*expected\/ai-trust\.skip/, r.logged.join("\n"));
  assert.ok(r.logged.some((l) => l.includes("participants") && l.includes("expected/ai-trust.skip")), r.logged.join("\n"));
  assert.ok(!r.logged.some((l) => l.startsWith("[SKIP] stub × ai-trust")), r.logged.join("\n"));
});

test("runFixture reports every uncovered CLI, not only the first", () => {
  const r = runHmaOnly([]);
  assert.equal(r.rc, 1, r.logged.join("\n"));
  assert.ok(r.logged.some((l) => l.includes("[FAIL] stub × opena2a: not a participant")), r.logged.join("\n"));
  assert.ok(r.logged.some((l) => l.includes("[FAIL] stub × ai-trust: not a participant")), r.logged.join("\n"));
});

test("runFixture fails a fixture whose non-participant CLI has an empty sentinel, which says no more than a missing one", () => {
  const r = runHmaOnly(["opena2a"], ["ai-trust"]);
  assert.equal(r.rc, 1, r.logged.join("\n"));
  assert.ok(r.logged.some((l) => l.startsWith("[OK]   stub × hma")), r.logged.join("\n"));
  assert.ok(r.logged.includes("[SKIP] stub × opena2a: opena2a does not exercise this stub"), r.logged.join("\n"));
  const fail = r.logged.find((l) => l.includes("[FAIL] stub × ai-trust")) ?? "";
  assert.match(fail, /the skip sentinel at .*expected\/ai-trust\.skip is empty/, r.logged.join("\n"));
  assert.ok(r.logged.some((l) => l.includes("Write in expected/ai-trust.skip why ai-trust does not exercise this fixture")), r.logged.join("\n"));
  assert.ok(!r.logged.some((l) => l.startsWith("[SKIP] stub × ai-trust")), r.logged.join("\n"));
});

test("runFixture returns 1 after every leg printed [OK] when the failure is outside any leg", () => {
  // a missing and an empty sentinel each fail the fixture while the one leg, hma, passes
  for (const r of [runHmaOnly(["opena2a"]), runHmaOnly(["opena2a"], ["ai-trust"])]) {
    assert.equal(r.rc, 1, r.logged.join("\n"));
    assert.ok(r.logged.some((l) => l.startsWith("[OK]   stub × hma")), r.logged.join("\n"));
    assert.ok(!r.logged.some((l) => l.includes("[FAIL] stub × hma")), r.logged.join("\n"));
    assert.ok(r.logged.some((l) => l.includes("[FAIL] stub × ai-trust")), r.logged.join("\n"));
  }
});

test("every committed fixture covers each CLI with a participant entry or a skip sentinel that says why", () => {
  const fixtures = readdirSync(join(repoRoot, "fixtures")).filter((name) => existsSync(join(repoRoot, "fixtures", name, "contract.yaml")));
  assert.ok(fixtures.length > 0, "expected at least one fixtures/*/contract.yaml");
  const uncovered: string[] = [];
  for (const name of fixtures) {
    const contract = parseYaml(readFileSync(join(repoRoot, "fixtures", name, "contract.yaml"), "utf8")) as { participants: string[] };
    for (const cli of ALL_CLIS) {
      if (contract.participants.includes(cli)) continue;
      const skipPath = join(repoRoot, "fixtures", name, "expected", `${cli}.skip`);
      if (!existsSync(skipPath) || readFileSync(skipPath, "utf8").trim() === "") uncovered.push(`${name} × ${cli}`);
    }
  }
  assert.deepEqual(uncovered, []);
});

test('docs/adding-a-fixture.md "Adding a fixture" tells a contributor to create the skip sentinel for each CLI left out', () => {
  const doc = readFileSync(join(repoRoot, "docs", "adding-a-fixture.md"), "utf8");
  const section = doc.split(/^# /m).find((s) => s.startsWith("Adding a fixture")) ?? "";
  assert.ok(section !== "", 'docs/adding-a-fixture.md has no "Adding a fixture" section');
  // a fixture added by following the steps without one fails with "not a participant and has no skip sentinel"
  assert.match(section.replace(/\s+/g, " "), /create `fixtures\/<name>\/expected\/<cli>\.skip` saying why/);
});
