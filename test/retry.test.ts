import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isTransientProbeFailure, probeWithRetry, runFixture, unexpectedErrorReport } from "../src/run-parity.ts";

test("isTransientProbeFailure fires only on an operational error payload", () => {
  // the exact timeout shape ai-trust emits
  assert.equal(isTransientProbeFailure({ name: "anthropic", found: false, error: "Registry request timed out after 10000ms", ecosystem: "pypi" }), true);
  // a healthy result must NOT be transient
  assert.equal(isTransientProbeFailure({ name: "anthropic", found: true, trustLevel: 2, verdict: "listed", packageType: "ai_tool" }), false);
  // a genuine not-found WITHOUT an error field must NOT be retried (real state, not a flake)
  assert.equal(isTransientProbeFailure({ name: "ghost", found: false }), false);
  // value drift (valid JSON, wrong values, no error) must NOT be retried
  assert.equal(isTransientProbeFailure({ name: "anthropic", found: true, trustLevel: 9, verdict: "wrong" }), false);
  assert.equal(isTransientProbeFailure({ error: "" }), false); // empty error is not a failure
  assert.equal(isTransientProbeFailure("not an object"), false);
});

test("probeWithRetry retries a transient timeout then returns the recovered result", () => {
  const dir = mkdtempSync(join(tmpdir(), "parity-retry-"));
  const counter = join(dir, "n");
  const bin = join(dir, "flaky.mjs");
  writeFileSync(counter, "0");
  // A stub CLI: first call emits the timeout shape + exit 1, then the real payload.
  writeFileSync(bin, `
import { readFileSync, writeFileSync } from "node:fs";
const c = Number(readFileSync(${JSON.stringify(counter)}, "utf8"));
writeFileSync(${JSON.stringify(counter)}, String(c + 1));
if (c === 0) { console.log(JSON.stringify({ name: "anthropic", found: false, error: "Registry request timed out after 10000ms", ecosystem: "pypi" })); process.exit(1); }
console.log(JSON.stringify({ name: "anthropic", found: true, packageType: "ai_tool", verdict: "listed", trustLevel: 2, source: "registry" }));
`);
  try {
    const r = probeWithRetry(`node ${bin} check`, "pip:anthropic", "test anthropic");
    assert.equal(r.parseOk, true);
    const p = r.parsed as Record<string, unknown>;
    assert.equal(p.found, true);
    assert.equal(p.trustLevel, 2);
    assert.equal(p.verdict, "listed");
    assert.equal(p.packageType, "ai_tool");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeWithRetry does NOT retry a value drift, and returns it for the comparison to catch", () => {
  const dir = mkdtempSync(join(tmpdir(), "parity-drift-"));
  const counter = join(dir, "n");
  const bin = join(dir, "drift.mjs");
  writeFileSync(counter, "0");
  // Always emits a WRONG-but-valid payload (no error field). Must be returned as-is on attempt 1.
  writeFileSync(bin, `
import { readFileSync, writeFileSync } from "node:fs";
const c = Number(readFileSync(${JSON.stringify(counter)}, "utf8"));
writeFileSync(${JSON.stringify(counter)}, String(c + 1));
console.log(JSON.stringify({ name: "anthropic", found: true, packageType: "ai_tool", verdict: "wrong", trustLevel: 9 }));
`);
  try {
    const r = probeWithRetry(`node ${bin} check`, "pip:anthropic", "test drift");
    const p = r.parsed as Record<string, unknown>;
    assert.equal(p.verdict, "wrong"); // returned unretried so the caller's diff fails loudly
    // exactly one invocation: no retry on a real drift
    assert.equal(readFileSync(counter, "utf8"), "1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The check-not-found goldens carry an error: an error payload is the expected outcome there,
// not a transient condition, so it must be compared on the first attempt rather than retried.
const NOT_FOUND_GOLDEN = {
  name: "ghost",
  found: false,
  error: 'Package "ghost" not found in the OpenA2A Registry.',
  ecosystem: "npm",
};

test("isTransientProbeFailure does not fire when the participant's golden expects an error payload", () => {
  assert.equal(isTransientProbeFailure(NOT_FOUND_GOLDEN, NOT_FOUND_GOLDEN), false);
  // a golden without an error still treats an error payload as transient (the timeout case)
  const timeout = { name: "anthropic", found: false, error: "Registry request timed out after 10000ms", ecosystem: "pypi" };
  assert.equal(isTransientProbeFailure(timeout, { name: "anthropic", found: true, trustLevel: 2, verdict: "listed" }), true);
  assert.equal(isTransientProbeFailure(timeout, { error: "" }), true); // an empty golden error expects none
  assert.equal(isTransientProbeFailure(timeout, undefined), true);
});

test("probeWithRetry returns an expected error payload on the first attempt, without a failure log", () => {
  const dir = mkdtempSync(join(tmpdir(), "parity-notfound-"));
  const counter = join(dir, "n");
  const bin = join(dir, "notfound.mjs");
  writeFileSync(counter, "0");
  // Always emits the not-found payload its golden records, with the CLI's non-zero exit.
  writeFileSync(bin, `
import { readFileSync, writeFileSync } from "node:fs";
const c = Number(readFileSync(${JSON.stringify(counter)}, "utf8"));
writeFileSync(${JSON.stringify(counter)}, String(c + 1));
console.log(${JSON.stringify(JSON.stringify(NOT_FOUND_GOLDEN))});
process.exit(2);
`);
  const logged: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const r = probeWithRetry(`node ${bin} check`, null, "test not-found", NOT_FOUND_GOLDEN);
    console.error = origError;
    assert.equal(r.parseOk, true);
    assert.deepEqual(r.parsed, NOT_FOUND_GOLDEN);
    assert.equal(r.exitCode, 2);
    // exactly one invocation: the expected outcome is not retried
    assert.equal(readFileSync(counter, "utf8"), "1");
    assert.deepEqual(logged, []);
  } finally {
    console.error = origError;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isTransientProbeFailure fires on an error payload that differs from the error the golden expects", () => {
  const timeout = { ...NOT_FOUND_GOLDEN, error: "Registry request timed out after 10000ms" };
  assert.equal(isTransientProbeFailure(timeout, NOT_FOUND_GOLDEN), true);
});

test("probeWithRetry retries a registry timeout on a fixture whose golden expects a different error", () => {
  const dir = mkdtempSync(join(tmpdir(), "parity-notfound-timeout-"));
  const counter = join(dir, "n");
  const bin = join(dir, "notfound-timeout.mjs");
  writeFileSync(counter, "0");
  // First call emits the registry timeout shape, then the not-found payload its golden records.
  writeFileSync(bin, `
import { readFileSync, writeFileSync } from "node:fs";
const c = Number(readFileSync(${JSON.stringify(counter)}, "utf8"));
writeFileSync(${JSON.stringify(counter)}, String(c + 1));
if (c === 0) { console.log(JSON.stringify({ name: "ghost", found: false, error: "Registry request timed out after 10000ms", ecosystem: "npm" })); process.exit(1); }
console.log(${JSON.stringify(JSON.stringify(NOT_FOUND_GOLDEN))});
process.exit(2);
`);
  const origError = console.error;
  console.error = () => {};
  try {
    const r = probeWithRetry(`node ${bin} check`, null, "test not-found timeout", NOT_FOUND_GOLDEN);
    console.error = origError;
    assert.equal(r.parseOk, true);
    assert.deepEqual(r.parsed, NOT_FOUND_GOLDEN);
    // the timeout was retried once, and the recovered payload is what the comparison sees
    assert.equal(readFileSync(counter, "utf8"), "2");
  } finally {
    console.error = origError;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runFixture hands the participant's golden to the probe, so an expected not-found is compared on the first attempt", () => {
  const dir = mkdtempSync(join(tmpdir(), "parity-fixture-"));
  const fixtures = join(dir, "fixtures");
  const actual = join(dir, "actual");
  const fixture = join(fixtures, "check-not-found");
  mkdirSync(join(fixture, "expected"), { recursive: true });
  // The shape of the real check-not-found contract, narrowed to one participant.
  writeFileSync(join(fixture, "contract.yaml"), `
description: not-found stub
kind: package-name
package: ghost
exercises:
  hma: "{BIN} check {PACKAGE} --no-scan --json"
participants:
  - hma
must_match:
  - name
  - found
  - ecosystem
may_differ: []
`);
  writeFileSync(join(fixture, "expected", "hma.json"), JSON.stringify(NOT_FOUND_GOLDEN));
  const counter = join(dir, "n");
  const bin = join(dir, "notfound.mjs");
  writeFileSync(counter, "0");
  // Counts its invocations and always emits the payload the golden records, with a non-zero exit.
  writeFileSync(bin, `
import { readFileSync, writeFileSync } from "node:fs";
const c = Number(readFileSync(${JSON.stringify(counter)}, "utf8"));
writeFileSync(${JSON.stringify(counter)}, String(c + 1));
console.log(${JSON.stringify(JSON.stringify(NOT_FOUND_GOLDEN))});
process.exit(1);
`);
  const logged: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const rc = runFixture("check-not-found", { hma: `node ${bin}`, opena2a: "unused", "ai-trust": "unused" }, { fixtures, actual });
    console.error = origError;
    console.log = origLog;
    assert.equal(rc, 0);
    // exactly one invocation: without the golden the probe reads the error payload as transient and retries it
    assert.equal(readFileSync(counter, "utf8"), "1");
    assert.deepEqual(logged.filter((l) => /transient probe failure|still failing/.test(l)), []);
    assert.ok(logged.some((l) => l.startsWith("[OK]   check-not-found × hma")), logged.join("\n"));
    assert.ok(existsSync(join(actual, "check-not-found", "hma.json")));
  } finally {
    console.error = origError;
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

// One fixture in a temporary fixtures/ root, run end to end by runFixture against a stub hma that
// counts its invocations and always prints `payload` with `exit`. Returns the fixture's result, the
// invocation count, every line the harness printed and the capture it wrote (undefined if none).
// `encode` turns the golden and the payload into JSON text; `String` hands over text as it is.
function runStubFixture(
  contract: string,
  golden: unknown,
  payload: unknown,
  exit = 1,
  encode: (value: unknown) => string = (value) => JSON.stringify(value),
): { rc: number; invocations: number; logged: string[]; capture: string | undefined } {
  const dir = mkdtempSync(join(tmpdir(), "parity-stub-fixture-"));
  const fixture = join(dir, "fixtures", "stub");
  mkdirSync(join(fixture, "expected"), { recursive: true });
  writeFileSync(join(fixture, "contract.yaml"), contract);
  writeFileSync(join(fixture, "expected", "hma.json"), encode(golden));
  const counter = join(dir, "n");
  const bin = join(dir, "stub.mjs");
  writeFileSync(counter, "0");
  writeFileSync(bin, `
import { readFileSync, writeFileSync } from "node:fs";
const c = Number(readFileSync(${JSON.stringify(counter)}, "utf8"));
writeFileSync(${JSON.stringify(counter)}, String(c + 1));
console.log(${JSON.stringify(encode(payload))});
// exitCode rather than exit(): a pipe is written asynchronously on macOS, and exit() can cut a long payload short.
process.exitCode = ${exit};
`);
  const logged: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const rc = runFixture("stub", { hma: `node ${bin}`, opena2a: "unused", "ai-trust": "unused" }, { fixtures: join(dir, "fixtures"), actual: join(dir, "actual") });
    const capturePath = join(dir, "actual", "stub", "hma.json");
    const capture = existsSync(capturePath) ? readFileSync(capturePath, "utf8") : undefined;
    return { rc, invocations: Number(readFileSync(counter, "utf8")), logged, capture };
  } finally {
    console.error = origError;
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
}

// check-not-found narrowed to one participant: error is under may_differ, and only name, found and
// ecosystem are must-match keys.
const NOT_FOUND_CONTRACT = `
description: not-found stub
kind: package-name
package: ghost
exercises:
  hma: "{BIN} check {PACKAGE} --no-scan --json"
participants:
  - hma
must_match:
  - name
  - found
  - ecosystem
may_differ:
  - path: error
    reason: wording differs between CLIs
`;

test("runFixture fails the leg when a reworded error still differs from the golden's after the last attempt", () => {
  const reworded = { ...NOT_FOUND_GOLDEN, error: 'No package named "ghost" on npm.' };
  const r = runStubFixture(NOT_FOUND_CONTRACT, NOT_FOUND_GOLDEN, reworded);
  assert.equal(r.invocations, 3);
  // the retry log calls it a real failure, and the verdict agrees
  assert.ok(r.logged.some((l) => /probe still failing after 3 attempts/.test(l)), r.logged.join("\n"));
  assert.equal(r.rc, 1);
  assert.ok(r.logged.some((l) => l.includes("[FAIL] stub × hma") && l.includes('No package named \\"ghost\\" on npm.')), r.logged.join("\n"));
  assert.ok(!r.logged.some((l) => l.startsWith("[OK]")), r.logged.join("\n"));
});

test("the unexpected-error report offers re-baselining as a conditional, not a verdict that the error is intended", () => {
  // the golden records no error and the CLI prints one on every attempt: a regression reads the same way
  const report = unexpectedErrorReport("stub × hma", 1, { name: "ghost", found: true, error: "TypeError: x is undefined" }, { name: "ghost", found: true });
  // a golden that records an error gets the same conditional for a reworded one
  const reworded = unexpectedErrorReport("stub × hma", 1, { name: "ghost", found: true, error: "TypeError: x is undefined" }, { name: "ghost", found: true, error: "gone" });
  for (const [kind, r] of [["new", report], ["reworded", reworded]] as const) {
    assert.ok(r.startsWith("[FAIL] stub × hma"), r);
    assert.doesNotMatch(r, /intended output change:/, r);
    // the advice wraps across lines, so read it as one sentence
    assert.match(
      r.replace(/\n\s+/g, " "),
      new RegExp(
        `A ${kind} error is an intended output change only if the CLI now reports it on purpose: if so, re-baseline golden-first ` +
          `\\(README\\.md "Re-baselining goldens"\\); if not, it is a CLI regression and the golden stays as it is\\.$`,
      ),
      r,
    );
  }
});

test("runFixture fails a not-found leg on a registry timeout that carries every must-match key", () => {
  // name, found: false and ecosystem all match the golden; only the error says the registry was not reached
  const timeout = { name: "ghost", found: false, error: "Registry request timed out after 10000ms", ecosystem: "npm" };
  const r = runStubFixture(NOT_FOUND_CONTRACT, NOT_FOUND_GOLDEN, timeout);
  assert.equal(r.invocations, 3);
  assert.equal(r.rc, 1);
  assert.ok(r.logged.some((l) => l.includes("[FAIL] stub × hma") && l.includes("Registry request timed out after 10000ms")), r.logged.join("\n"));
  assert.ok(!r.logged.some((l) => l.startsWith("[OK]")), r.logged.join("\n"));
});

// A golden may record a structured error; an equal object is the same error, not a reworded one.
const OBJECT_ERROR_GOLDEN = { name: "ghost", found: false, ecosystem: "npm", error: { code: "NOT_FOUND", message: "ghost" } };

test("isTransientProbeFailure compares an object-valued error by value, not by reference", () => {
  assert.equal(isTransientProbeFailure(structuredClone(OBJECT_ERROR_GOLDEN), OBJECT_ERROR_GOLDEN), false);
  const otherCode = { ...OBJECT_ERROR_GOLDEN, error: { code: "TIMEOUT", message: "ghost" } };
  assert.equal(isTransientProbeFailure(otherCode, OBJECT_ERROR_GOLDEN), true);
});

test("runFixture passes a leg on the first attempt when its object-valued error matches the golden's", () => {
  const r = runStubFixture(NOT_FOUND_CONTRACT, OBJECT_ERROR_GOLDEN, OBJECT_ERROR_GOLDEN);
  assert.equal(r.invocations, 1, r.logged.join("\n"));
  assert.equal(r.rc, 0, r.logged.join("\n"));
  assert.ok(!r.logged.some((l) => l.includes("[FAIL]")), r.logged.join("\n"));
});

// A golden copied from a capture has sorted keys; a CLI emits its own order. The same error in another order is the same error.
const REORDERED_OBJECT_ERROR = { ...OBJECT_ERROR_GOLDEN, error: { message: "ghost", code: "NOT_FOUND" } };

test("isTransientProbeFailure matches an object-valued error whose keys are in a different order from the golden's", () => {
  assert.equal(isTransientProbeFailure(REORDERED_OBJECT_ERROR, OBJECT_ERROR_GOLDEN), false);
  const otherCode = { ...OBJECT_ERROR_GOLDEN, error: { message: "ghost", code: "TIMEOUT" } };
  assert.equal(isTransientProbeFailure(otherCode, OBJECT_ERROR_GOLDEN), true);
});

test("runFixture passes a leg on the first attempt when its object-valued error matches the golden's in another key order", () => {
  const r = runStubFixture(NOT_FOUND_CONTRACT, OBJECT_ERROR_GOLDEN, REORDERED_OBJECT_ERROR);
  assert.equal(r.invocations, 1, r.logged.join("\n"));
  assert.equal(r.rc, 0, r.logged.join("\n"));
  assert.ok(!r.logged.some((l) => l.includes("[FAIL]")), r.logged.join("\n"));
});

// A key named "__proto__" in the CLI's JSON text is a key like any other to the comparison. (Parsed
// from text on purpose: in an object literal it would set the prototype instead of creating the key.)
const PROTO_KEY_ERROR = JSON.parse('{"name":"ghost","found":false,"ecosystem":"npm","error":{"code":"NOT_FOUND","message":"ghost","__proto__":{"cause":"timeout"}}}');

test("isTransientProbeFailure does not drop a key named __proto__ before comparing an object-valued error", () => {
  assert.equal(isTransientProbeFailure(PROTO_KEY_ERROR, OBJECT_ERROR_GOLDEN), true);
  const goldenWithProtoKey = JSON.parse(JSON.stringify(PROTO_KEY_ERROR));
  assert.equal(isTransientProbeFailure(PROTO_KEY_ERROR, goldenWithProtoKey), false);
});

test("runFixture fails a leg whose object-valued error differs from the golden's only under a __proto__ key", () => {
  const r = runStubFixture(NOT_FOUND_CONTRACT, OBJECT_ERROR_GOLDEN, PROTO_KEY_ERROR);
  assert.equal(r.rc, 1, r.logged.join("\n"));
  assert.ok(r.logged.some((l) => l.includes("[FAIL] stub × hma")), r.logged.join("\n"));
});

test("runFixture fails a leg whose object-valued must-match key differs from the golden's only under a __proto__ key", () => {
  const contract = `
description: object-valued must-match stub
kind: package-name
package: ghost
exercises:
  hma: "{BIN} check {PACKAGE} --no-scan --json"
participants:
  - hma
must_match:
  - name
  - scores
may_differ: []
`;
  const golden = { name: "ghost", scores: { a: 1 } };
  const payload = JSON.parse('{"name":"ghost","scores":{"a":1,"__proto__":{"admin":true}}}');
  const r = runStubFixture(contract, golden, payload, 0);
  assert.equal(r.rc, 1, r.logged.join("\n"));
  assert.ok(r.logged.some((l) => l.includes("[FAIL] stub × hma") && l.includes("1 must-match field(s) drifted")), r.logged.join("\n"));
  assert.ok(r.logged.some((l) => l.includes("__proto__")), r.logged.join("\n"));
  // the capture records the key too, so a re-baseline copies what the CLI emitted
  assert.deepEqual(JSON.parse(r.capture ?? "null"), payload);
});

test("runFixture compares an object-valued must-match key regardless of key order", () => {
  const contract = `
description: object-valued must-match stub
kind: package-name
package: ghost
exercises:
  hma: "{BIN} check {PACKAGE} --no-scan --json"
participants:
  - hma
must_match:
  - name
  - scores
may_differ: []
`;
  const golden = { name: "ghost", scores: { a: 1, b: { c: 2, d: 3 } } };
  const r = runStubFixture(contract, golden, { scores: { b: { d: 3, c: 2 }, a: 1 }, name: "ghost" }, 0);
  assert.equal(r.rc, 0, r.logged.join("\n"));
  // the line says what was compared: equality apart from key order, not identical bytes
  assert.ok(r.logged.includes("[OK]   stub × hma: 2 must-match fields equal apart from object key order"), r.logged.join("\n"));
  // a changed value in the same reordered object is still drift
  const drift = runStubFixture(contract, golden, { scores: { b: { d: 4, c: 2 }, a: 1 }, name: "ghost" }, 0);
  assert.equal(drift.rc, 1, drift.logged.join("\n"));
  assert.ok(drift.logged.some((l) => l.includes("[FAIL] stub × hma: 1 must-match field(s) drifted")), drift.logged.join("\n"));
});

// name and scores as must-match keys, scores holding an object.
const SCORES_CONTRACT = `
description: object-valued must-match stub
kind: package-name
package: ghost
exercises:
  hma: "{BIN} check {PACKAGE} --no-scan --json"
participants:
  - hma
must_match:
  - name
  - scores
may_differ: []
`;

test("runFixture keeps a __proto__ key through a replace_regex rule, in the comparison and in the capture", () => {
  const contract = `${SCORES_CONTRACT}normalize:
  - kind: replace_regex
    pattern: "request-[0-9]+"
    replacement: "<REQUEST_ID>"
`;
  const golden = { name: "ghost", scores: { a: 1 } };
  const payload = JSON.parse('{"name":"ghost","scores":{"a":1,"__proto__":{"admin":true}}}');
  const r = runStubFixture(contract, golden, payload, 0);
  assert.equal(r.rc, 1, r.logged.join("\n"));
  assert.ok(r.logged.some((l) => l.includes("[FAIL] stub × hma: 1 must-match field(s) drifted")), r.logged.join("\n"));
  assert.ok(r.logged.some((l) => l.includes('"__proto__":{"admin":true}')), r.logged.join("\n"));
  assert.deepEqual(JSON.parse(r.capture ?? "null"), payload);
});

// JSON text with `depth` objects nested under scores. Built as text, so the test never encodes a
// value that deep itself.
function deeplyNestedScores(depth: number): string {
  return `{"name":"ghost","scores":${'{"k":'.repeat(depth)}1${"}".repeat(depth)}}`;
}

test("runFixture fails the leg, instead of throwing, on a payload nested deeper than the comparison can recurse", () => {
  const deep = deeplyNestedScores(100_000);
  const r = runStubFixture(SCORES_CONTRACT, deep, deep, 0, String);
  assert.equal(r.rc, 1, r.logged.join("\n").slice(0, 2000));
  assert.ok(
    r.logged.some((l) => l.includes("[FAIL] stub × hma: the payload or its golden is nested too deeply to compare (RangeError:")),
    r.logged.join("\n").slice(0, 2000),
  );
  assert.ok(!r.logged.some((l) => l.startsWith("[OK]")), r.logged.join("\n").slice(0, 2000));
  // a golden that deep fails the comparison of a shallow payload the same way
  const g = runStubFixture(SCORES_CONTRACT, deep, '{"name":"ghost","scores":1}', 0, String);
  assert.equal(g.rc, 1, g.logged.join("\n").slice(0, 2000));
  assert.ok(
    g.logged.some((l) => l.includes("[FAIL] stub × hma: the payload or its golden is nested too deeply to compare (RangeError:")),
    g.logged.join("\n").slice(0, 2000),
  );
});

test("unexpectedErrorReport prints the actual error key-sorted whether or not the golden records an error", () => {
  const actual = { name: "ghost", error: { message: "ghost", code: "TIMEOUT" } };
  const sorted = '    actual:   {"code":"TIMEOUT","message":"ghost"}';
  const withGoldenError = unexpectedErrorReport("stub × hma", 1, actual, { name: "ghost", error: { code: "NOT_FOUND", message: "ghost" } });
  assert.ok(withGoldenError.split("\n").includes(sorted), withGoldenError);
  const withoutGoldenError = unexpectedErrorReport("stub × hma", 1, actual, { name: "ghost" });
  assert.ok(withoutGoldenError.split("\n").includes(sorted), withoutGoldenError);
});

test("unexpectedErrorReport names a golden without an error instead of diffing against undefined", () => {
  const report = unexpectedErrorReport("x × hma", 1, { name: "a", error: "boom" }, { name: "a", found: true });
  assert.match(report, /^\[FAIL\] x × hma: exit=1, error payload still present after 3 attempts; the golden records no error$/m);
  assert.match(report, /actual: {3}"boom"/);
  assert.doesNotMatch(report, /undefined|differs from the golden's/);
  assert.match(report, /A new error is an$/m);
  assert.doesNotMatch(report, /reworded/);
  // a golden that records an error keeps the diff
  const reworded = unexpectedErrorReport("x × hma", 1, { name: "a", error: "boom" }, { name: "a", error: "gone" });
  assert.match(reworded, /error payload still differs from the golden's after 3 attempts/);
  assert.match(reworded, /expected: "gone"\n {4}actual: {3}"boom"/);
  assert.match(reworded, /A reworded error is an$/m);
  assert.doesNotMatch(reworded, /A new error/);
  // an empty or null error key records no error either: the branch follows the value, not the key's presence
  for (const empty of ["", null]) {
    const blank = unexpectedErrorReport("x × hma", 1, { name: "a", error: "boom" }, { name: "a", error: empty });
    assert.match(blank, /^\[FAIL\] x × hma: exit=1, error payload still present after 3 attempts; the golden records no error$/m, `error: ${JSON.stringify(empty)}`);
    assert.match(blank, /A new error is an$/m, `error: ${JSON.stringify(empty)}`);
    assert.doesNotMatch(blank, /differs from the golden's|expected:/, `error: ${JSON.stringify(empty)}`);
  }
});

test("runFixture says the golden records no error when a timeout outlasts the retries on a fixture that expects none", () => {
  const { error: _, ...found } = NOT_FOUND_GOLDEN;
  const timeout = { ...found, error: "Registry request timed out after 10000ms" };
  const r = runStubFixture(NOT_FOUND_CONTRACT, found, timeout);
  assert.equal(r.invocations, 3);
  assert.equal(r.rc, 1);
  const report = r.logged.find((l) => l.includes("[FAIL] stub × hma")) ?? "";
  assert.ok(report.includes("the golden records no error") && report.includes("Registry request timed out after 10000ms"), r.logged.join("\n"));
  assert.ok(!report.includes("undefined"), report);
});

test("runFixture decides whether an error is expected on the normalized payload the golden was copied from", () => {
  const contract = `${NOT_FOUND_CONTRACT}normalize:
  - kind: replace_regex
    pattern: "request-[0-9]+"
    replacement: "<REQUEST_ID>"
`;
  const golden = { ...NOT_FOUND_GOLDEN, error: "ghost not found (<REQUEST_ID>)" };
  const raw = { ...NOT_FOUND_GOLDEN, error: "ghost not found (request-4711)" };
  const r = runStubFixture(contract, golden, raw);
  assert.equal(r.invocations, 1);
  assert.deepEqual(r.logged.filter((l) => /transient probe failure|still failing/.test(l)), []);
  assert.equal(r.rc, 0);
  assert.ok(r.logged.some((l) => l.startsWith("[OK]   stub × hma")), r.logged.join("\n"));
});

test("runFixture hands the golden to the shape check, so a must-match key the golden also omits is not a SHAPE failure", () => {
  // check-registered-ai's ai-trust leg: scanStatus is a must-match key its golden omits on purpose
  const contract = `
description: registered stub
kind: package-name
package: "@scope/server"
exercises:
  hma: "{BIN} check {PACKAGE} --no-scan --json"
participants:
  - hma
must_match:
  - trustLevel
  - name
  - verdict
  - packageType
  - scanStatus
may_differ: []
`;
  const golden = { name: "@scope/server", found: true, trustLevel: 3, verdict: "passed", packageType: "mcp_server" };
  const r = runStubFixture(contract, golden, { ...golden, source: "registry" }, 0);
  assert.equal(r.invocations, 1);
  assert.ok(!r.logged.some((l) => l.includes("[SHAPE]")), r.logged.join("\n"));
  assert.equal(r.rc, 0);
  assert.ok(r.logged.some((l) => l.startsWith("[OK]   stub × hma: 5 must-match fields")), r.logged.join("\n"));
});
