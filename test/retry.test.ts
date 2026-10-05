import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isTransientProbeFailure, probeWithRetry } from "../src/run-parity.ts";

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
