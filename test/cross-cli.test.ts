import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { crossCliDiffs, goldensWithoutMustMatchKey, runFixture } from "../src/run-parity.ts";

// Each leg compares one CLI with that CLI's own golden. That alone passes a fixture whose goldens
// record different values for the same input: it happened in a trial on check-registered-ai, where
// an ai-trust golden set to trustLevel 1 and verdict "blocked" beside hackmyagent's and opena2a's 3
// and "passed" still ended with no fixture failure. The gate's claim is that the CLIs agree, so the
// goldens are compared with each other, and so are the outputs.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// One fixture in a temporary fixtures/ root with a stub per participant: each stub prints `prints`
// (the text of its own golden when omitted) and exits 0. `golden` and `prints` are JSON text.
// Returns the fixture's result and every line the harness printed.
function runStubs(mustMatch: string[], legs: Record<string, { golden: string; prints?: string }>): { rc: number; logged: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "parity-cross-cli-"));
  const fixture = join(dir, "fixtures", "stub");
  mkdirSync(join(fixture, "expected"), { recursive: true });
  const clis = Object.keys(legs);
  writeFileSync(join(fixture, "contract.yaml"), [
    "description: cross-CLI stub",
    "kind: package-name",
    "package: ghost",
    "exercises:",
    ...clis.map((cli) => `  ${cli}: "{BIN}"`),
    "participants:",
    ...clis.map((cli) => `  - ${cli}`),
    "must_match:",
    ...mustMatch.map((key) => `  - ${key}`),
    "may_differ: []",
    "",
  ].join("\n"));
  const bins = { hma: "unused", opena2a: "unused", "ai-trust": "unused" };
  for (const cli of clis) {
    writeFileSync(join(fixture, "expected", `${cli}.json`), legs[cli].golden);
    const out = join(dir, `${cli}.out`);
    writeFileSync(out, legs[cli].prints ?? legs[cli].golden);
    bins[cli as keyof typeof bins] = `cat ${out}`;
  }
  // every CLI that is not a participant is covered by a sentinel, as the harness requires
  for (const cli of Object.keys(bins).filter((name) => !clis.includes(name))) {
    writeFileSync(join(fixture, "expected", `${cli}.skip`), `${cli} does not exercise this stub`);
  }
  const logged: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    return { rc: runFixture("stub", bins, { fixtures: join(dir, "fixtures"), actual: join(dir, "actual") }), logged };
  } finally {
    console.error = origError;
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
}

const j = (value: unknown) => JSON.stringify(value);

test("crossCliDiffs names a must-match key on which two goldens hold different values", () => {
  const diffs = crossCliDiffs(["score", "grade"], [
    { cli: "hma", golden: { score: 93, grade: "A" }, actual: { score: 93, grade: "A" } },
    { cli: "opena2a", golden: { score: 98, grade: "A" }, actual: { score: 98, grade: "A" } },
  ]);
  assert.deepEqual(diffs, [[
    "  at score:",
    "    goldens:",
    "      hma:     93",
    "      opena2a: 98",
    "    outputs:",
    "      hma:     93",
    "      opena2a: 98",
  ].join("\n")]);
});

test("crossCliDiffs leaves a CLI whose golden omits a key out of that key's comparison", () => {
  // check-registered-ai: scanStatus is a must-match key that ai-trust's golden omits on purpose
  const registered = { trustLevel: 3, verdict: "passed" };
  const legs = [
    { cli: "hma", golden: { ...registered, scanStatus: "warnings" }, actual: { ...registered, scanStatus: "warnings" } },
    { cli: "ai-trust", golden: registered, actual: registered },
    { cli: "opena2a", golden: { ...registered, scanStatus: "warnings" }, actual: { ...registered, scanStatus: "warnings" } },
  ];
  assert.deepEqual(crossCliDiffs(["trustLevel", "verdict", "scanStatus"], legs), []);
  // the two CLIs that do carry it are still held to each other
  legs[2] = { cli: "opena2a", golden: { ...registered, scanStatus: "pending" }, actual: { ...registered, scanStatus: "pending" } };
  const diffs = crossCliDiffs(["trustLevel", "verdict", "scanStatus"], legs);
  assert.equal(diffs.length, 1, diffs.join("\n"));
  assert.match(diffs[0], /^ {2}at scanStatus:\n/);
  assert.doesNotMatch(diffs[0], /ai-trust/);
  // a key only one golden carries has nothing to be compared with
  assert.deepEqual(crossCliDiffs(["scanStatus"], [legs[0], legs[1]]), []);
});

test("crossCliDiffs leaves out a CLI whose golden omits a key even when that CLI's output carries the key", () => {
  // ai-trust's output carrying scanStatus against its own golden's omission is a drift its own leg
  // reports; between CLIs it is not a difference, whatever value it holds
  const registered = { trustLevel: 3, verdict: "passed" };
  const legs = [
    { cli: "hma", golden: { ...registered, scanStatus: "warnings" }, actual: { ...registered, scanStatus: "warnings" } },
    { cli: "ai-trust", golden: registered, actual: { ...registered, scanStatus: "pending" } },
    { cli: "opena2a", golden: { ...registered, scanStatus: "warnings" }, actual: { ...registered, scanStatus: "warnings" } },
  ];
  assert.deepEqual(crossCliDiffs(["trustLevel", "verdict", "scanStatus"], legs), []);
  // where the CLIs that carry the key do differ, the block names those two and not the omitting one
  legs[2] = { cli: "opena2a", golden: { ...registered, scanStatus: "warnings" }, actual: { ...registered, scanStatus: "failed" } };
  const diffs = crossCliDiffs(["trustLevel", "verdict", "scanStatus"], legs);
  assert.deepEqual(diffs, ['  at scanStatus:\n    outputs:\n      hma:     "warnings"\n      opena2a: "failed"'], diffs.join("\n"));
  assert.doesNotMatch(diffs[0], /ai-trust/);
});

test("crossCliDiffs compares by value: key order is not a difference, null is a value", () => {
  const legs: Parameters<typeof crossCliDiffs>[1] = [
    { cli: "hma", golden: { scores: { a: 1, b: 2 }, level: null }, actual: { scores: { a: 1, b: 2 }, level: null } },
    { cli: "opena2a", golden: { scores: { b: 2, a: 1 }, level: null }, actual: { scores: { b: 2, a: 1 }, level: null } },
  ];
  assert.deepEqual(crossCliDiffs(["scores", "level"], legs), []);
  legs[1] = { cli: "opena2a", golden: { scores: { b: 2, a: 1 }, level: 3 }, actual: { scores: { b: 2, a: 1 }, level: 3 } };
  const diffs = crossCliDiffs(["scores", "level"], legs);
  assert.equal(diffs.length, 1, diffs.join("\n"));
  assert.match(diffs[0], /at level:\n {4}goldens:\n {6}hma: {5}null\n {6}opena2a: 3\n/);
});

test("crossCliDiffs reports outputs that differ under goldens that agree, and skips a leg that has no output", () => {
  const golden = { score: 98 };
  const drifted = crossCliDiffs(["score"], [
    { cli: "hma", golden, actual: { score: 98 } },
    { cli: "opena2a", golden, actual: { score: 95 } },
  ]);
  assert.deepEqual(drifted, ["  at score:\n    outputs:\n      hma:     98\n      opena2a: 95"]);
  // a leg that failed before its comparison takes part with its golden alone
  assert.deepEqual(crossCliDiffs(["score"], [{ cli: "hma", golden, actual: { score: 98 } }, { cli: "opena2a", golden }]), []);
  const goldenOnly = crossCliDiffs(["score"], [{ cli: "hma", golden, actual: { score: 98 } }, { cli: "opena2a", golden: { score: 95 } }]);
  assert.deepEqual(goldenOnly, ["  at score:\n    goldens:\n      hma:     98\n      opena2a: 95"]);
});

test("runFixture fails a fixture whose CLIs each match their own golden while the goldens disagree", () => {
  const r = runStubs(["score"], { hma: { golden: j({ score: 93 }) }, opena2a: { golden: j({ score: 98 }) } });
  // each leg still passes on its own: that is the comparison that could not see this
  assert.ok(r.logged.some((l) => l.startsWith("[OK]   stub × hma")), r.logged.join("\n"));
  assert.ok(r.logged.some((l) => l.startsWith("[OK]   stub × opena2a")), r.logged.join("\n"));
  assert.equal(r.rc, 1, r.logged.join("\n"));
  assert.ok(r.logged.some((l) => l.includes("[FAIL] stub: 1 must-match field(s) differ between CLIs")), r.logged.join("\n"));
  const block = r.logged.find((l) => l.startsWith("  at score:")) ?? "";
  assert.match(block, /goldens:\n {6}hma: {5}93\n {6}opena2a: 98/, r.logged.join("\n"));
  // the report says what to do with a difference that is wanted, and where that is documented: the key
  // moves out of must_match, since a may_differ path also under must_match fails the contract check
  assert.ok(
    r.logged.some((l) => l.includes("move the key from must_match to may_differ, with the reason") && l.includes('README.md "Contract model"')),
    r.logged.join("\n"),
  );
});

test("README.md tells a reader whose CLIs differ on purpose to move the key from must_match, not only to list it under may_differ", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8").replace(/\s+/g, " ");
  // a key listed under both fails the fixture before any CLI runs (mayDifferProblems)
  assert.doesNotMatch(readme, /(?:list the key under|the key belongs under) `may_differ`/);
  // the cross-CLI section and the re-baselining step both give the advice
  assert.equal(readme.match(/move the key from `must_match` to `may_differ`, with the reason/g)?.length, 2, readme);
});

test("runFixture fails the registered-package trial: one golden at another trust level and verdict", () => {
  const mustMatch = ["trustLevel", "name", "verdict", "packageType", "scanStatus"];
  const registered = { name: "@scope/server", trustLevel: 3, verdict: "passed", packageType: "mcp_server" };
  const scanned = j({ ...registered, scanStatus: "warnings" });
  // ai-trust omits scanStatus, as its committed golden does: that alone is not a difference
  const agreed = runStubs(mustMatch, { hma: { golden: scanned }, "ai-trust": { golden: j(registered) }, opena2a: { golden: scanned } });
  assert.equal(agreed.rc, 0, agreed.logged.join("\n"));
  assert.ok(
    agreed.logged.includes("[OK]   stub: hma, ai-trust, opena2a agree on every must-match field their goldens carry"),
    agreed.logged.join("\n"),
  );
  // left out of the comparison between CLIs, not unchecked: its own leg holds its output to the omission
  const printed = runStubs(mustMatch, { hma: { golden: scanned }, "ai-trust": { golden: j(registered), prints: scanned }, opena2a: { golden: scanned } });
  assert.equal(printed.rc, 1, printed.logged.join("\n"));
  assert.ok(printed.logged.some((l) => l.includes("[FAIL] stub × ai-trust: 1 must-match field(s) drifted")), printed.logged.join("\n"));
  const blocked = j({ ...registered, trustLevel: 1, verdict: "blocked" });
  const r = runStubs(mustMatch, { hma: { golden: scanned }, "ai-trust": { golden: blocked }, opena2a: { golden: scanned } });
  assert.equal(r.rc, 1, r.logged.join("\n"));
  assert.ok(r.logged.some((l) => l.includes("[FAIL] stub: 2 must-match field(s) differ between CLIs")), r.logged.join("\n"));
  assert.ok(r.logged.some((l) => /^ {2}at trustLevel:\n {4}goldens:\n {6}hma: {6}3\n {6}ai-trust: 1\n {6}opena2a: {2}3\n/.test(l)), r.logged.join("\n"));
  assert.ok(r.logged.some((l) => l.startsWith("  at verdict:") && l.includes('ai-trust: "blocked"')), r.logged.join("\n"));
  assert.ok(!r.logged.some((l) => l.startsWith("[OK]   stub:")), r.logged.join("\n"));
});

test("runFixture names the CLIs' outputs when one drifts from goldens that agree", () => {
  const golden = j({ score: 98 });
  const r = runStubs(["score"], { hma: { golden }, opena2a: { golden, prints: j({ score: 95 }) } });
  assert.equal(r.rc, 1, r.logged.join("\n"));
  assert.ok(r.logged.some((l) => l.includes("[FAIL] stub × opena2a: 1 must-match field(s) drifted")), r.logged.join("\n"));
  assert.ok(r.logged.includes("  at score:\n    outputs:\n      hma:     98\n      opena2a: 95"), r.logged.join("\n"));
});

test("runFixture prints no cross-CLI line for a single participant, and none that says the CLIs agree after a failed leg", () => {
  const one = runStubs(["score"], { hma: { golden: j({ score: 98 }) } });
  assert.equal(one.rc, 0, one.logged.join("\n"));
  assert.deepEqual(one.logged, [
    "[OK]   stub × hma: 1 must-match fields equal apart from object key order",
    "[SKIP] stub × opena2a: opena2a does not exercise this stub",
    "[SKIP] stub × ai-trust: ai-trust does not exercise this stub",
  ]);
  // hma prints no JSON, so its output was never compared with opena2a's
  const golden = j({ score: 98 });
  const failed = runStubs(["score"], { hma: { golden, prints: "not json" }, opena2a: { golden } });
  assert.equal(failed.rc, 1, failed.logged.join("\n"));
  assert.ok(!failed.logged.some((l) => l.includes("agree on every must-match field")), failed.logged.join("\n"));
  assert.ok(!failed.logged.some((l) => l.includes("differ between CLIs")), failed.logged.join("\n"));
});

test("runFixture fails the fixture, instead of throwing, on a golden nested too deeply to compare with another CLI's", () => {
  // Built as text, so the test never encodes a value that deep itself. hma prints no JSON, so its leg
  // ends before its own comparison and the golden first meets the encoder in the cross-CLI one.
  const deep = `{"scores":${'{"k":'.repeat(100_000)}1${"}".repeat(100_000)}}`;
  const r = runStubs(["scores"], { hma: { golden: deep, prints: "not json" }, opena2a: { golden: j({ scores: 1 }) } });
  assert.equal(r.rc, 1, r.logged.join("\n").slice(0, 2000));
  assert.ok(
    r.logged.some((l) => l.includes("[FAIL] stub across CLIs: the payload or its golden is nested too deeply to compare (RangeError:")),
    r.logged.join("\n").slice(0, 2000),
  );
});

// A key a participant's golden omits is absence on both sides for that participant's leg, and one
// golden carrying a key is enough for the key to count as resolved. So a golden that carried none of
// the must-match keys, beside two that carried them, gave its leg no field to compare: the leg printed
// "[OK] ... 1 must-match fields equal" for a CLI that printed 5, {} or null, and the fixture passed.
test("runFixture fails a fixture with a participant whose golden carries none of the must-match keys, whatever its CLI prints", () => {
  const scored = j({ score: 7 });
  for (const prints of ["5", "{}", "null", j({ other: 1 })]) {
    const r = runStubs(["score"], { hma: { golden: scored }, opena2a: { golden: scored }, "ai-trust": { golden: j({ other: 1 }), prints } });
    const lines = `ai-trust prints ${prints}\n${r.logged.join("\n")}`;
    assert.equal(r.rc, 1, lines);
    const report = r.logged.find((l) => l.includes("[CONTRACT]")) ?? "";
    assert.ok(report.includes("[CONTRACT] stub × ai-trust: its golden carries none of the 1 must-match key(s): score"), lines);
    // the report says what to do in either case: a golden that should carry the keys, or a CLI that should not take part
    assert.ok(report.includes('README.md "Re-baselining goldens"') && report.includes("expected/ai-trust.skip"), lines);
    // the leg compared no field, so it has nothing to call equal; the two legs that compared one still do
    assert.ok(r.logged.includes("[NONE] stub × ai-trust: no must-match field compared; not compared: score (not in its golden)"), lines);
    assert.ok(!r.logged.some((l) => l.startsWith("[OK]   stub × ai-trust")), lines);
    assert.ok(r.logged.includes("[OK]   stub × hma: 1 must-match fields equal apart from object key order"), lines);
    assert.ok(r.logged.includes("[OK]   stub × opena2a: 1 must-match fields equal apart from object key order"), lines);
    assert.ok(!r.logged.some((l) => l.includes("agree on every must-match field")), lines);
  }
});

test("runFixture reports a golden that carries no must-match key when it is not an object, and still reports an output that carries one", () => {
  const scored = j({ score: 7 });
  for (const golden of ["null", "5", "[]", "{}"]) {
    const r = runStubs(["score"], { hma: { golden: scored }, opena2a: { golden } });
    assert.equal(r.rc, 1, `golden ${golden}\n${r.logged.join("\n")}`);
    assert.ok(
      r.logged.some((l) => l.includes("[CONTRACT] stub × opena2a: its golden carries none of the 1 must-match key(s): score")),
      `golden ${golden}\n${r.logged.join("\n")}`,
    );
  }
  // the output carrying a key its golden omits is a drift of that leg, as it is for a golden that omits one key
  const printed = runStubs(["score"], { hma: { golden: scored }, opena2a: { golden: j({ other: 1 }), prints: scored } });
  assert.equal(printed.rc, 1, printed.logged.join("\n"));
  assert.ok(printed.logged.some((l) => l.includes("[CONTRACT] stub × opena2a: its golden carries none of the 1 must-match key(s): score")), printed.logged.join("\n"));
  assert.ok(printed.logged.some((l) => l.includes("[FAIL] stub × opena2a: 1 must-match field(s) drifted")), printed.logged.join("\n"));
  assert.ok(!printed.logged.some((l) => l.startsWith("[NONE]") || l.startsWith("[OK]   stub × opena2a")), printed.logged.join("\n"));
});

test("runFixture reports a participant's golden only when it carries none of the must-match keys, and once where no golden carries any", () => {
  // one key carried is enough: ai-trust's golden omits scanStatus on check-registered-ai and carries the rest
  const registered = { name: "@scope/server", trustLevel: 3 };
  const scanned = j({ ...registered, scanStatus: "warnings" });
  const partial = runStubs(["name", "trustLevel", "scanStatus"], { hma: { golden: scanned }, "ai-trust": { golden: j(registered) }, opena2a: { golden: scanned } });
  assert.equal(partial.rc, 0, partial.logged.join("\n"));
  assert.ok(!partial.logged.some((l) => l.includes("[CONTRACT]")), partial.logged.join("\n"));
  // every key in no golden is one problem, reported for the fixture and not again for each participant
  const scored = j({ score: 7 });
  const misspelt = runStubs(["scroe"], { hma: { golden: scored }, opena2a: { golden: scored } });
  assert.equal(misspelt.rc, 1, misspelt.logged.join("\n"));
  assert.deepEqual(
    misspelt.logged.filter((l) => l.includes("[CONTRACT]")).map((l) => l.trim().split("\n")[0]),
    ["[CONTRACT] stub: 1 must-match key(s) resolve in no participant's golden: scroe"],
    misspelt.logged.join("\n"),
  );
  // beside a key in no golden, the participant's report still names every key its golden lacks
  const both = runStubs(["score", "scroe"], { hma: { golden: scored }, opena2a: { golden: j({ other: 1 }) } });
  assert.equal(both.rc, 1, both.logged.join("\n"));
  assert.deepEqual(
    both.logged.filter((l) => l.includes("[CONTRACT]")).map((l) => l.trim().split("\n")[0]),
    [
      "[CONTRACT] stub: 1 must-match key(s) resolve in no participant's golden: scroe",
      "[CONTRACT] stub × opena2a: its golden carries none of the 2 must-match key(s): score, scroe",
    ],
    both.logged.join("\n"),
  );
  assert.ok(both.logged.includes("[NONE] stub × opena2a: no must-match field compared; not compared: score, scroe (not in its golden)"), both.logged.join("\n"));
  assert.ok(both.logged.includes("[OK]   stub × hma: 1 must-match fields equal apart from object key order; not compared: scroe (in no golden)"), both.logged.join("\n"));
});

test('README.md "Contract model" says a participant whose golden carries none of the must_match keys fails the fixture', () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const section = readme.split(/^## /m).find((s) => s.startsWith("Contract model")) ?? "";
  assert.ok(section !== "", 'README.md has no "Contract model" section');
  assert.match(section.replace(/\s+/g, " "), /A participant whose golden carries none of the `must_match` keys fails the fixture too/);
});

test("every committed participant golden carries at least one of its fixture's must-match keys", () => {
  const fixtures = readdirSync(join(repoRoot, "fixtures")).filter((name) => existsSync(join(repoRoot, "fixtures", name, "contract.yaml")));
  assert.ok(fixtures.length > 0, "expected at least one fixtures/*/contract.yaml");
  let goldens = 0;
  for (const name of fixtures) {
    const contract = parseYaml(readFileSync(join(repoRoot, "fixtures", name, "contract.yaml"), "utf8")) as { participants: string[]; must_match: string[] };
    const legs = contract.participants.map((cli) => ({
      cli,
      golden: JSON.parse(readFileSync(join(repoRoot, "fixtures", name, "expected", `${cli}.json`), "utf8")) as unknown,
    }));
    goldens += legs.length;
    assert.deepEqual(goldensWithoutMustMatchKey(contract.must_match, legs), [], `fixtures/${name}: a participant's golden carries no must-match key`);
  }
  assert.ok(goldens > 0, "expected at least one participant golden");
});

test("the committed goldens of every fixture agree on each must-match key across the CLIs that carry it", () => {
  const fixtures = readdirSync(join(repoRoot, "fixtures")).filter((name) => existsSync(join(repoRoot, "fixtures", name, "contract.yaml")));
  assert.ok(fixtures.length > 0, "expected at least one fixtures/*/contract.yaml");
  let compared = 0;
  for (const name of fixtures) {
    const contract = parseYaml(readFileSync(join(repoRoot, "fixtures", name, "contract.yaml"), "utf8")) as { participants: string[]; must_match: string[] };
    const legs = contract.participants.map((cli) => ({
      cli,
      golden: JSON.parse(readFileSync(join(repoRoot, "fixtures", name, "expected", `${cli}.json`), "utf8")) as unknown,
    }));
    if (legs.length > 1) compared++;
    assert.deepEqual(crossCliDiffs(contract.must_match, legs), [], `fixtures/${name}: goldens disagree on a must-match key`);
  }
  assert.ok(compared > 0, "expected at least one fixture with two or more participants");
});
