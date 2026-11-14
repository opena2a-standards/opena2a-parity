import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import * as parity from "../src/run-parity.ts";

// A contract's paths map says where a participant carries a must_match key when that is not at the key
// itself: { <participant>: { <must_match key>: <dotted path> } }. Both comparisons, each CLI's output with
// its golden and the CLIs with each other, read a mapped key at the mapped path for that participant and
// compare its value as they compare any must_match value. A map that names a key outside must_match, or a
// CLI not listed under participants, is read by no comparison, so it fails the contract before any CLI
// runs. A contract without paths reads every key at the key, as before (the rest of the suite holds that).

type Leg = { golden: unknown; prints?: unknown };

// One kind: package-name fixture in a temporary fixtures/ root, with a stub per participant that records
// that it ran and prints `prints` (its golden when omitted). `paths` is the contract's paths block as YAML
// lines, or none. Returns the fixture's result, every line the harness printed and the CLIs that ran.
function runStubs(mustMatch: string[], paths: string[], legs: Record<string, Leg>): { rc: number; logged: string[]; ran: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "parity-paths-"));
  const fixture = join(dir, "fixtures", "stub");
  mkdirSync(join(fixture, "expected"), { recursive: true });
  const clis = Object.keys(legs);
  writeFileSync(join(fixture, "contract.yaml"), [
    "description: paths stub",
    "kind: package-name",
    "package: ghost",
    "exercises:",
    ...clis.map((cli) => `  ${cli}: "{BIN}"`),
    "participants:",
    ...clis.map((cli) => `  - ${cli}`),
    "must_match:",
    ...mustMatch.map((key) => `  - ${JSON.stringify(key)}`),
    "may_differ: []",
    ...paths,
    "",
  ].join("\n"));
  const bins = { hma: "unused", opena2a: "unused", "ai-trust": "unused" };
  for (const cli of clis) {
    writeFileSync(join(fixture, "expected", `${cli}.json`), JSON.stringify(legs[cli].golden));
    const out = join(dir, `${cli}.out`);
    writeFileSync(out, JSON.stringify(legs[cli].prints ?? legs[cli].golden));
    bins[cli as keyof typeof bins] = `touch "${join(dir, `${cli}.ran`)}" && cat "${out}"`;
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
    const rc = parity.runFixture("stub", bins, { fixtures: join(dir, "fixtures"), actual: join(dir, "actual") });
    return { rc, logged, ran: clis.filter((cli) => existsSync(join(dir, `${cli}.ran`))) };
  } finally {
    console.error = origError;
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
}

// Whether the harness printed `text` as one entry, or an entry that starts with it; a report it opens
// with a blank line counts without that line.
const printed = (logged: string[], text: string) => logged.some((l) => l.replace(/^\n/, "") === text);
const printedStart = (logged: string[], text: string) => logged.some((l) => l.replace(/^\n/, "").startsWith(text));

// The value each test compares, built here; only its position in a document matters.
const served = (n: number) => ({ level: n, label: `level-${n}` });
const mapHmaKAtAB = ["paths:", "  hma:", "    k: a.b"];

test("a mapped key compares with its participant's golden at the mapped path, on both sides", () => {
  // hma carries k at a.b in its output and in its golden; a k at the top of either is not the one compared
  const golden = { k: "top", a: { b: served(3) } };
  const same = runStubs(["k"], mapHmaKAtAB, { hma: { golden, prints: { k: "other", a: { b: served(3) } } } });
  assert.equal(same.rc, 0, same.logged.join("\n"));
  assert.ok(printed(same.logged, "[OK]   stub × hma: 1 must-match fields equal apart from object key order"), same.logged.join("\n"));
  // a different value at the mapped path is a drift, named with the key and the path it was read at
  const drifted = runStubs(["k"], mapHmaKAtAB, { hma: { golden, prints: { k: "top", a: { b: served(4) } } } });
  assert.equal(drifted.rc, 1, drifted.logged.join("\n"));
  assert.ok(printed(drifted.logged, "[FAIL] stub × hma: 1 must-match field(s) drifted"), drifted.logged.join("\n"));
  assert.ok(
    printed(drifted.logged, `  at k (read at a.b):\n    expected: ${JSON.stringify({ label: "level-3", level: 3 })}\n    actual:   ${JSON.stringify({ label: "level-4", level: 4 })}`),
    drifted.logged.join("\n"),
  );
  // the value is still compared exactly: the same digit as a string is a drift
  const retyped = runStubs(["k"], mapHmaKAtAB, { hma: { golden: { a: { b: 3 } }, prints: { a: { b: "3" } } } });
  assert.equal(retyped.rc, 1, retyped.logged.join("\n"));
  assert.ok(printed(retyped.logged, '  at k (read at a.b):\n    expected: 3\n    actual:   "3"'), retyped.logged.join("\n"));
});

test("the comparison between CLIs reads a mapped key at the mapped path and an unmapped one at the key", () => {
  // ai-trust carries k at a.b; hma carries it at the top
  const paths = ["paths:", "  ai-trust:", "    k: a.b"];
  const agree = runStubs(["k"], paths, { hma: { golden: { k: served(3) } }, "ai-trust": { golden: { a: { b: served(3) } } } });
  assert.equal(agree.rc, 0, agree.logged.join("\n"));
  assert.ok(printed(agree.logged, "[OK]   stub × ai-trust: 1 must-match fields equal apart from object key order"), agree.logged.join("\n"));
  assert.ok(printed(agree.logged, "[OK]   stub: hma, ai-trust agree on every must-match field their goldens carry"), agree.logged.join("\n"));
  // a different value is a difference between CLIs, named by the key, with the path read for the mapped CLI
  const differ = runStubs(["k"], paths, { hma: { golden: { k: 3 } }, "ai-trust": { golden: { a: { b: 4 } } } });
  assert.equal(differ.rc, 1, differ.logged.join("\n"));
  assert.ok(printed(differ.logged, "[FAIL] stub: 1 must-match field(s) differ between CLIs"), differ.logged.join("\n"));
  assert.ok(
    printed(differ.logged, [
      "  at k:",
      "    goldens:",
      "      hma:                    3",
      "      ai-trust (read at a.b): 4",
      "    outputs:",
      "      hma:                    3",
      "      ai-trust (read at a.b): 4",
    ].join("\n")),
    differ.logged.join("\n"),
  );
});

test("crossCliDiffs reads a leg's mapped key at the mapped path in its golden and its output", () => {
  const keyPaths = { k: "a.b" };
  const legs: Parameters<typeof parity.crossCliDiffs>[1] = [
    { cli: "hma", golden: { k: 3 }, actual: { k: 3 } },
    { cli: "ai-trust", golden: { a: { b: 3 } }, actual: { a: { b: 3 } }, keyPaths },
  ];
  assert.deepEqual(parity.crossCliDiffs(["k"], legs), []);
  legs[1] = { cli: "ai-trust", golden: { a: { b: 3 } }, actual: { a: { b: 5 } }, keyPaths };
  assert.deepEqual(parity.crossCliDiffs(["k"], legs), ["  at k:\n    outputs:\n      hma:                    3\n      ai-trust (read at a.b): 5"]);
});

test("a participant that carries three of five must-match keys under another object agrees with two that carry them at the top", () => {
  const mustMatch = ["trustLevel", "name", "verdict", "packageType", "scanStatus"];
  const record = { trustLevel: 2, verdict: "listed", scanStatus: "pending" };
  const top = { name: "pkg", packageType: "library", ...record };
  const nested = { name: "pkg", packageType: "library", registryData: record };
  const paths = [
    "paths:",
    "  ai-trust:",
    "    trustLevel: registryData.trustLevel",
    "    verdict: registryData.verdict",
    "    scanStatus: registryData.scanStatus",
  ];
  const agree = runStubs(mustMatch, paths, { hma: { golden: top }, "ai-trust": { golden: nested }, opena2a: { golden: top } });
  assert.equal(agree.rc, 0, agree.logged.join("\n"));
  assert.ok(printed(agree.logged, "[OK]   stub × ai-trust: 5 must-match fields equal apart from object key order"), agree.logged.join("\n"));
  assert.ok(printed(agree.logged, "[OK]   stub: hma, ai-trust, opena2a agree on every must-match field their goldens carry"), agree.logged.join("\n"));
  // a served value the mapped participant holds differently is a difference between CLIs
  const differ = runStubs(mustMatch, paths, {
    hma: { golden: top },
    "ai-trust": { golden: { ...nested, registryData: { ...record, verdict: "blocked" } } },
    opena2a: { golden: top },
  });
  assert.equal(differ.rc, 1, differ.logged.join("\n"));
  assert.ok(printed(differ.logged, "[FAIL] stub: 1 must-match field(s) differ between CLIs"), differ.logged.join("\n"));
  assert.ok(differ.logged.some((l) => l.startsWith("  at verdict:\n    goldens:\n") && l.includes('ai-trust (read at registryData.verdict): "blocked"')), differ.logged.join("\n"));
});

test("an output that does not carry a mapped path its golden carries is a SHAPE failure naming the key and the path", () => {
  const r = runStubs(["k"], mapHmaKAtAB, { hma: { golden: { a: { b: 3 } }, prints: { k: 3 } } });
  assert.equal(r.rc, 1, r.logged.join("\n"));
  assert.ok(
    printedStart(r.logged, "[SHAPE] stub × hma: exit=0, 1 of 1 must-match key(s) ABSENT from the payload: k (read at a.b)\n"),
    r.logged.join("\n"),
  );
  assert.deepEqual(parity.absentMustMatchKeys({ k: 3 }, ["k"], { a: { b: 3 } }, { k: "a.b" }), ["k"]);
  assert.deepEqual(parity.absentMustMatchKeys({ a: { b: 3 } }, ["k"], { a: { b: 3 } }, { k: "a.b" }), []);
});

test("a mapped path the participant's golden does not carry fails the fixture, and the leg still runs", () => {
  // a misspelt path would otherwise compare nothing on hma's leg and leave hma out of k's comparison
  const r = runStubs(["k", "n"], ["paths:", "  hma:", "    k: a.c"], { hma: { golden: { n: 1, a: { b: 3 } } }, opena2a: { golden: { n: 1, k: 3 } } });
  assert.equal(r.rc, 1, r.logged.join("\n"));
  assert.ok(
    printedStart(r.logged, "[CONTRACT] stub × hma: its golden carries nothing at 1 path(s) its paths entry maps a must-match key to: k (read at a.c)\n"),
    r.logged.join("\n"),
  );
  assert.deepEqual(r.ran, ["hma", "opena2a"]);
  assert.deepEqual(parity.mappedKeysNotInGolden(["k", "n"], { n: 1, a: { b: 3 } }, { k: "a.c" }), ["k"]);
  assert.deepEqual(parity.mappedKeysNotInGolden(["k", "n"], { n: 1, a: { c: null } }, { k: "a.c" }), []);
});

test("runFixture fails a contract whose paths entry maps a key outside must_match, naming the participant and the key, before running a CLI", () => {
  const r = runStubs(["k"], ["paths:", "  hma:", "    other: a.b"], { hma: { golden: { k: 3, a: { b: 3 } } } });
  assert.equal(r.rc, 2, r.logged.join("\n"));
  assert.deepEqual(r.logged, [
    "[stub] contract.yaml paths entry hma maps other, which is not listed under must_match, so no comparison reads it; map only must_match keys",
  ]);
  assert.deepEqual(r.ran, []);
});

test("runFixture fails a contract whose paths entry names a CLI not listed under participants, before running a CLI", () => {
  const r = runStubs(["k"], ["paths:", "  opena2a:", "    k: a.b"], { hma: { golden: { k: 3 } } });
  assert.equal(r.rc, 2, r.logged.join("\n"));
  assert.deepEqual(r.logged, [
    "[stub] contract.yaml paths entry opena2a names a CLI that is not listed under participants, so no comparison reads it; list the CLI there or remove its entry",
  ]);
  assert.deepEqual(r.ran, []);
});

test("pathsProblems accepts a map of listed participants and must_match keys, however the key is written, and no map", () => {
  const contract = { participants: ["hma", "ai-trust"], must_match: ["k", "$.v"] } as const;
  const accepted = [
    { ...contract, paths: { "ai-trust": { k: "a.b", v: "a.c" } } },
    { ...contract, paths: { hma: { "$.k": "x.y" }, "ai-trust": {} } },
    { ...contract, paths: {} },
    { ...contract, paths: null },
    contract,
  ];
  for (const c of accepted) assert.deepEqual(parity.pathsProblems(c as never), [], JSON.stringify(c));
  assert.equal(parity.keyPath("$.v", { v: "a.c" }), "a.c");
  assert.equal(parity.keyPath("k", { v: "a.c" }), "k");
  assert.equal(parity.keyPath("k"), "k");
});

test("pathsProblems names each entry that is not a listed participant's map of must_match keys to dotted paths", () => {
  const contract = { participants: ["hma"], must_match: ["k", "v"] };
  const problems = (paths: string) => parity.pathsProblems({ ...contract, paths: parseYaml(paths) } as never);
  assert.deepEqual(problems("[hma]"), ["paths is not a mapping from each participant to its { must_match key: dotted path } entries"]);
  assert.deepEqual(problems("hma: [k]"), ['paths entry hma is not a mapping from must_match keys to dotted paths: ["k"]']);
  assert.deepEqual(problems("ai-trust: 1"), [
    "paths entry ai-trust names a CLI that is not listed under participants, so no comparison reads it; list the CLI there or remove its entry",
    "paths entry ai-trust is not a mapping from must_match keys to dotted paths: 1",
  ]);
  assert.deepEqual(problems("hma: { k: '', v: }"), ["paths entry hma maps k to no dotted path", "paths entry hma maps v to no dotted path"]);
  assert.deepEqual(problems("hma: { k: 1, v: [a] }"), [
    "paths entry hma maps k to a value that is not a dotted path string: 1",
    'paths entry hma maps v to a value that is not a dotted path string: ["a"]',
  ]);
  assert.deepEqual(problems("hma: { k: a.b, $.k: a.c, w: a.d }"), [
    "paths entry hma maps $.k, the key it already maps as k; map each must_match key once",
    "paths entry hma maps w, which is not listed under must_match, so no comparison reads it; map only must_match keys",
  ]);
});
