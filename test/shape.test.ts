import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeWithRetry, absentMustMatchKeys, shapeFailureReport, unresolvedMustMatchKeys, goldensWithoutMustMatchKey, keylessGoldenReport, RETRY_CONDITION } from "../src/run-parity.ts";

// A participant that exits 0 with a well-formed JSON document that simply does not carry the
// contract's must-match keys is the third shape the harness meets, after "transient error payload"
// and "value drift". It happened for real: a registry query failed, the CLI fell through to a local
// scan, and emitted a scan document (type, score) with exit 0 where the contract expected the
// registry fields (found, trustLevel, verdict). The retry is keyed on an operational error payload
// or non-JSON output, so it must NOT absorb this, and the report must name the keys that are absent
// rather than printing "expected X actual undefined" per key and calling it drift.

const MUST_MATCH = ["found", "trustLevel", "verdict", "packageType"];

test("absentMustMatchKeys names exactly the contract keys the payload does not carry", () => {
  const scanDoc = { type: "npm-package", name: "@scope/pkg", score: 71, found: true };
  assert.deepEqual(absentMustMatchKeys(scanDoc, MUST_MATCH), ["trustLevel", "verdict", "packageType"]);
  // a complete payload is not a shape failure, whatever its values
  assert.deepEqual(absentMustMatchKeys({ found: true, trustLevel: 9, verdict: "wrong", packageType: "x" }, MUST_MATCH), []);
  // a present key with a null value is present; absence is the key not being there
  assert.deepEqual(absentMustMatchKeys({ found: false, trustLevel: null, verdict: null, packageType: null }, MUST_MATCH), []);
  // dotted paths resolve the same way the comparison does
  assert.deepEqual(absentMustMatchKeys({ result: { verdict: "listed" } }, ["result.verdict", "result.trustLevel"]), ["result.trustLevel"]);
  // a non-object payload is missing every key
  assert.deepEqual(absentMustMatchKeys("a string", ["found"]), ["found"]);
});

test("a key the participant's golden also omits is absence on both sides, not a shape failure", () => {
  // check-registered-ai lists scanStatus under must_match and records that ai-trust's golden
  // omits it on purpose. The payload omitting it too is the contract being met.
  const withScanStatus = ["found", "trustLevel", "verdict", "packageType", "scanStatus"];
  const aiTrustGolden = { found: true, trustLevel: 3, verdict: "passed", packageType: "mcp_server" };
  const aiTrustActual = { found: true, trustLevel: 3, verdict: "passed", packageType: "mcp_server", source: "registry" };
  assert.deepEqual(absentMustMatchKeys(aiTrustActual, withScanStatus, aiTrustGolden), []);
  // a key the golden carries and the payload omits is still absent
  const hmaGolden = { ...aiTrustGolden, scanStatus: "warnings" };
  assert.deepEqual(absentMustMatchKeys(aiTrustActual, withScanStatus, hmaGolden), ["scanStatus"]);
  // the fall-through scan document is a shape failure against a golden that carries the keys
  const scanDoc = { type: "npm-package", name: "@scope/pkg", score: 71 };
  assert.deepEqual(absentMustMatchKeys(scanDoc, MUST_MATCH, aiTrustGolden), MUST_MATCH);
  // and without a golden every absent key counts, as before
  assert.deepEqual(absentMustMatchKeys(aiTrustActual, withScanStatus), ["scanStatus"]);
});

test("unresolvedMustMatchKeys names the keys no participant's golden carries", () => {
  // a key in bracket form or a misspelt one resolves in no golden; the dot form with a numeric
  // segment for the array index does
  const golden = { score: 98, findings: [{ checkId: "GIT-001" }] };
  const keys = ["score", "$.score", "findings[0].checkId", "scroe", "findings.0.checkId"];
  assert.deepEqual(unresolvedMustMatchKeys(keys, [golden]), ["findings[0].checkId", "scroe"]);
  // one golden carrying the key is enough: scanStatus is in hma's golden and omitted from ai-trust's
  const aiTrustGolden = { verdict: "passed" };
  const hmaGolden = { verdict: "passed", scanStatus: "warnings" };
  assert.deepEqual(unresolvedMustMatchKeys(["verdict", "scanStatus"], [aiTrustGolden, hmaGolden]), []);
  assert.deepEqual(unresolvedMustMatchKeys(["verdict", "scanStatus"], [aiTrustGolden]), ["scanStatus"]);
  // a key holding null is carried
  assert.deepEqual(unresolvedMustMatchKeys(["trustLevel"], [{ trustLevel: null }]), []);
  // with no golden yet there is nothing to resolve against; the missing golden is reported on its own
  assert.deepEqual(unresolvedMustMatchKeys(["score"], []), []);
});

test("goldensWithoutMustMatchKey names the participants whose golden carries none of the must-match keys", () => {
  // score resolves in two goldens, so it is not a key in no golden; ai-trust's golden carries none of the list
  const scored = { score: 7 };
  const legs = [{ cli: "hma", golden: scored }, { cli: "opena2a", golden: scored }, { cli: "ai-trust", golden: { other: 1 } }];
  assert.deepEqual(unresolvedMustMatchKeys(["score"], legs.map((leg) => leg.golden)), []);
  assert.deepEqual(goldensWithoutMustMatchKey(["score"], legs), ["ai-trust"]);
  // one key carried is enough, whatever it holds and however the key is written
  const partial = [{ cli: "ai-trust", golden: { verdict: null } }, { cli: "hma", golden: { result: { scanStatus: "warnings" } } }];
  assert.deepEqual(goldensWithoutMustMatchKey(["verdict", "$.result.scanStatus"], partial), []);
  assert.deepEqual(goldensWithoutMustMatchKey(["verdict"], partial), ["hma"]);
  // a golden that is not an object carries no key, and neither does an inherited property
  const keyless = [null, 5, "score", [], {}].map((golden, i) => ({ cli: `cli-${i}`, golden }));
  assert.deepEqual(goldensWithoutMustMatchKey(["score", "constructor"], keyless), keyless.map((leg) => leg.cli));
  // the report names the participant and every key, and says what to do in either case
  const report = keylessGoldenReport("check-registered-ai", "ai-trust", ["trustLevel", "verdict"]);
  assert.match(report, /^\[CONTRACT\] check-registered-ai × ai-trust: its golden carries none of the 2 must-match key\(s\): trustLevel, verdict$/m);
  assert.match(report, /README\.md "Re-baselining goldens"/);
  assert.match(report, /take it out of participants and add expected\/ai-trust\.skip saying why \(README\.md "Contract model"\)/);
});

test("a must-match path segment that names an inherited property is absent unless the payload carries it", () => {
  // Read as `cur[p]`, "__proto__" resolved to Object.prototype and "constructor" to Object on a
  // payload that carries neither, so neither was ever reported absent.
  const inherited = ["__proto__", "constructor", "toString", "result.__proto__", "result.hasOwnProperty"];
  assert.deepEqual(absentMustMatchKeys({ found: true, result: {} }, ["found", ...inherited]), inherited);
  // a JSON payload carrying the key holds it as an own property, so it is present
  const carried = JSON.parse('{"__proto__": {"x": 1}, "constructor": null, "result": {"__proto__": 0}}');
  assert.deepEqual(absentMustMatchKeys(carried, ["__proto__", "__proto__.x", "constructor", "result.__proto__"]), []);
  // a golden that carries it and a payload that omits it is a shape failure, not "absent == absent"
  assert.deepEqual(absentMustMatchKeys({ found: true }, ["__proto__"], carried), ["__proto__"]);
  // array indices and length are own properties and still resolve
  assert.deepEqual(absentMustMatchKeys({ items: ["a"] }, ["items.0", "items.length", "items.1"]), ["items.1"]);
});

test("a participant returning exit 0 with the must-match keys absent is a shape failure the retry does not absorb", () => {
  const dir = mkdtempSync(join(tmpdir(), "parity-shape-"));
  const counter = join(dir, "n");
  const bin = join(dir, "fallthrough.mjs");
  writeFileSync(counter, "0");
  // Always exits 0 with a scan document: no `error`, none of the registry fields.
  writeFileSync(bin, `
import { readFileSync, writeFileSync } from "node:fs";
const c = Number(readFileSync(${JSON.stringify(counter)}, "utf8"));
writeFileSync(${JSON.stringify(counter)}, String(c + 1));
console.log(JSON.stringify({ type: "npm-package", name: "@scope/pkg", score: 71 }));
`);
  try {
    const r = probeWithRetry(`node ${bin} check --no-scan --json`, "@scope/pkg", "test shape");
    assert.equal(r.exitCode, 0);
    assert.equal(r.parseOk, true);
    // exactly one invocation: the retry is not keyed on this shape
    assert.equal(readFileSync(counter, "utf8"), "1");
    const absent = absentMustMatchKeys(r.parsed, MUST_MATCH);
    assert.deepEqual(absent, MUST_MATCH);
    const report = shapeFailureReport("check-registered-ai hma", r.exitCode, absent, MUST_MATCH.length);
    assert.match(report, /\[SHAPE\]/);
    assert.match(report, /exit=0/);
    for (const k of MUST_MATCH) assert.ok(report.includes(k), `report names ${k}`);
    assert.match(report, /not retried/);
    assert.doesNotMatch(report, /drift/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the retry's own log line says which condition it is keyed on", () => {
  // The next reader must not assume the retry covers shape. The condition is a constant so the
  // log line and this assertion cannot drift apart.
  assert.match(RETRY_CONDITION, /operational \{ error \} payload/);
  assert.match(RETRY_CONDITION, /non-JSON/);
  assert.match(RETRY_CONDITION, /absent must-match keys are never retried/);
  const dir = mkdtempSync(join(tmpdir(), "parity-retryline-"));
  const bin = join(dir, "timeout.mjs");
  writeFileSync(bin, `console.log(JSON.stringify({ found: false, error: "Registry request timed out after 10000ms" })); process.exit(1);`);
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  try {
    probeWithRetry(`node ${bin} check`, "pip:x", "test line");
  } finally {
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
  const retryLines = errs.filter((l) => l.includes("transient probe failure"));
  assert.ok(retryLines.length >= 1, "a retry line was logged");
  for (const l of retryLines) assert.ok(l.includes(RETRY_CONDITION), `retry line carries its condition: ${l}`);
});
