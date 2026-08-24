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
