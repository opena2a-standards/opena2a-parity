#!/usr/bin/env -S node --experimental-strip-types
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const FIXTURES_DIR = join(REPO_ROOT, "fixtures");
const ACTUAL_DIR = join(REPO_ROOT, "actual");

type CLI = "hma" | "opena2a" | "ai-trust";

type FixtureKind = "directory" | "package-name";

type FixtureContract = {
  description: string;
  kind?: FixtureKind;
  package?: string;
  exercises: { hma?: string; opena2a?: string; "ai-trust"?: string };
  participants: CLI[];
  must_match: string[];
  may_differ: { path: string; reason: string }[];
  normalize: { kind: "strip_key" | "replace_regex"; path?: string; pattern?: string; replacement?: string }[];
};

type ProbeResult = {
  cli: CLI;
  exitCode: number;
  stdout: string;
  parsed: unknown;
};

function envBinOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`env var ${name} is required — e.g. ${name}="node /path/to/dist/cli.js"`);
  }
  return v;
}

function runCli(invocation: string, positionalArg: string | null): { exitCode: number; stdout: string } {
  const cmd = positionalArg === null ? invocation : `${invocation} "${positionalArg}"`;
  try {
    const stdout = execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { exitCode: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { exitCode: e.status ?? 1, stdout: e.stdout ?? "" };
  }
}

// A registry-backed probe can fail transiently: ai-trust's registry client has a
// 10s default timeout against api.oa2a.org (Azure), and a cold-start request can
// exceed it. On timeout the CLI still emits valid JSON, but of the operational
// shape { error, found: false, ... } with none of the must-match fields, so the
// comparison reads every expected field as undefined and the whole gate reds on
// a flake rather than real drift (measured: CI run 32738932700, the exact same
// fixture returning trustLevel=2/verdict=listed for hackmyagent in the same run).
//
// isTransientProbeFailure detects ONLY that operational signature. A genuine
// value drift (valid JSON, no `error`, wrong values) does not match and is never
// retried, so the gate still catches real drift. A persistent outage exhausts the
// retries and then fails loudly through the normal comparison - transient is
// smoothed, broken is still broken.
const PROBE_RETRIES = 3;
const PROBE_BACKOFF_MS = Number(process.env.PARITY_PROBE_BACKOFF_MS ?? 1500);

function syncSleep(ms: number): void {
  // The harness is synchronous (execSync), so back off synchronously too.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isTransientProbeFailure(parsed: unknown): boolean {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    "error" in parsed &&
    Boolean((parsed as { error?: unknown }).error)
  );
}

// Runs the CLI and parses its JSON, retrying only on a transient probe failure
// (an operational { error } payload, or unparseable/empty output). Returns the
// last attempt's result regardless, so the caller's comparison still runs.
export function probeWithRetry(
  cmd: string,
  positionalArg: string | null,
  label: string,
): { exitCode: number; stdout: string; parsed: unknown; parseOk: boolean } {
  let last: { exitCode: number; stdout: string; parsed: unknown; parseOk: boolean } = {
    exitCode: 1,
    stdout: "",
    parsed: undefined,
    parseOk: false,
  };
  for (let attempt = 1; attempt <= PROBE_RETRIES; attempt++) {
    const { exitCode, stdout } = runCli(cmd, positionalArg);
    let parsed: unknown;
    let parseOk = true;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parseOk = false;
    }
    last = { exitCode, stdout, parsed, parseOk };

    const transient = !parseOk || isTransientProbeFailure(parsed);
    if (!transient || attempt === PROBE_RETRIES) {
      if (transient && attempt === PROBE_RETRIES) {
        console.error(
          `[${label}] probe still failing after ${PROBE_RETRIES} attempts (exit=${exitCode}); treating as a real failure.`,
        );
      }
      return last;
    }
    const why = parseOk ? (parsed as { error?: unknown }).error : "non-JSON output";
    console.error(
      `[${label}] transient probe failure (attempt ${attempt}/${PROBE_RETRIES}): ${String(why)}. Retrying in ${PROBE_BACKOFF_MS * attempt}ms...`,
    );
    syncSleep(PROBE_BACKOFF_MS * attempt);
  }
  return last;
}

function getPath(obj: unknown, path: string): unknown {
  if (path === "" || path === "$") return obj;
  const parts = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function stripKey(obj: unknown, path: string): void {
  if (path === "" || path === "$") return;
  const parts = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  if (parts.length === 0) return;
  const last = parts.pop()!;
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return;
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur && typeof cur === "object") {
    delete (cur as Record<string, unknown>)[last];
  }
}

function replaceInStrings(obj: unknown, pattern: RegExp, replacement: string): unknown {
  if (typeof obj === "string") return obj.replace(pattern, replacement);
  if (Array.isArray(obj)) return obj.map((x) => replaceInStrings(x, pattern, replacement));
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = replaceInStrings(v, pattern, replacement);
    return out;
  }
  return obj;
}

function normalize(parsed: unknown, rules: FixtureContract["normalize"], fixtureInputDir: string): unknown {
  let out = structuredClone(parsed);
  for (const rule of rules) {
    if (rule.kind === "strip_key" && rule.path) {
      stripKey(out, rule.path);
    } else if (rule.kind === "replace_regex" && rule.pattern != null && rule.replacement != null) {
      const pattern = rule.pattern.replace("{FIXTURE_INPUT_DIR}", fixtureInputDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      out = replaceInStrings(out, new RegExp(pattern, "g"), rule.replacement);
    }
  }
  return out;
}

function applyIntentionalDrift(obj: unknown, cli: CLI): unknown {
  if (process.env.INTENTIONAL_DRIFT !== "1") return obj;
  if (cli !== "opena2a") return obj;
  const cloned = structuredClone(obj) as Record<string, unknown>;
  if (typeof cloned.platform === "string") {
    cloned.platform = cloned.platform + "+drift-demo";
  }
  return cloned;
}

function stableStringify(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as object).sort ? sortKeysReplacer() : null, 2);
}

function sortKeysReplacer() {
  const seen = new WeakSet();
  return function (_key: string, value: unknown) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (seen.has(value as object)) return value;
      seen.add(value as object);
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as object).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  };
}

function diffKey(actual: unknown, golden: unknown, path: string): string | null {
  const a = getPath(actual, path);
  const g = getPath(golden, path);
  const aj = JSON.stringify(a);
  const gj = JSON.stringify(g);
  if (aj === gj) return null;
  return `  at ${path}:\n    expected: ${gj}\n    actual:   ${aj}`;
}

function runFixture(fixtureName: string, bins: Record<CLI, string>): number {
  const fixtureDir = join(FIXTURES_DIR, fixtureName);
  const inputDir = join(fixtureDir, "input");
  const contractPath = join(fixtureDir, "contract.yaml");
  const expectedDir = join(fixtureDir, "expected");

  if (!existsSync(contractPath)) {
    console.error(`[${fixtureName}] missing contract.yaml`);
    return 2;
  }
  const contract = parseYaml(readFileSync(contractPath, "utf8")) as FixtureContract;
  const kind: FixtureKind = contract.kind ?? "directory";

  if (kind === "directory" && !existsSync(inputDir)) {
    console.error(`[${fixtureName}] missing input/ directory (kind=directory)`);
    return 2;
  }
  if (kind === "package-name" && !contract.package) {
    console.error(`[${fixtureName}] kind=package-name requires 'package:' field`);
    return 2;
  }

  mkdirSync(join(ACTUAL_DIR, fixtureName), { recursive: true });

  const results: Record<string, ProbeResult> = {};
  let failures = 0;

  for (const cli of contract.participants) {
    const invocation = contract.exercises[cli];
    if (!invocation) {
      console.error(`[${fixtureName}] participant ${cli} has no exercises entry`);
      failures++;
      continue;
    }
    const bin = bins[cli];
    let cmd = invocation.replace("{BIN}", bin);
    let positionalArg: string | null;
    if (kind === "package-name") {
      cmd = cmd.replace("{PACKAGE}", contract.package!);
      positionalArg = null;
    } else {
      positionalArg = inputDir;
    }
    const { exitCode, stdout, parsed, parseOk } = probeWithRetry(cmd, positionalArg, `${fixtureName} ${cli}`);
    if (!parseOk) {
      console.error(`[${fixtureName}] ${cli} produced non-JSON output (exit=${exitCode}). First 400 chars:\n${stdout.slice(0, 400)}`);
      failures++;
      continue;
    }
    let parsedVal: unknown = parsed;
    parsedVal = normalize(parsedVal, contract.normalize ?? [], kind === "directory" ? inputDir : "");
    parsedVal = applyIntentionalDrift(parsedVal, cli);

    const actualPath = join(ACTUAL_DIR, fixtureName, `${cli}.json`);
    writeFileSync(actualPath, stableStringify(parsedVal));

    results[cli] = { cli, exitCode, stdout, parsed: parsedVal };
  }

  for (const cli of contract.participants) {
    const goldenPath = join(expectedDir, `${cli}.json`);
    if (!existsSync(goldenPath)) {
      console.error(`[${fixtureName}] ${cli} missing golden at ${goldenPath}`);
      failures++;
      continue;
    }
    const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
    const actual = results[cli]?.parsed;
    if (actual === undefined) continue;

    const diffs: string[] = [];
    for (const key of contract.must_match) {
      const d = diffKey(actual, golden, key);
      if (d) diffs.push(d);
    }
    if (diffs.length > 0) {
      console.error(`\n[FAIL] ${fixtureName} × ${cli}: ${diffs.length} must-match field(s) drifted`);
      for (const d of diffs) console.error(d);
      console.error(`  (actual captured at ${join("actual", fixtureName, `${cli}.json`)})`);
      console.error(`  Intended output change? Re-baseline golden-first: README.md "Re-baselining goldens".`);
      failures += diffs.length;
    } else {
      console.log(`[OK]   ${fixtureName} × ${cli}: ${contract.must_match.length} must-match fields byte-identical`);
    }
  }

  const allCLIs: CLI[] = ["hma", "opena2a", "ai-trust"];
  for (const cli of allCLIs) {
    if (contract.participants.includes(cli)) continue;
    const skipPath = join(expectedDir, `${cli}.skip`);
    if (existsSync(skipPath)) {
      console.log(`[SKIP] ${fixtureName} × ${cli}: ${readFileSync(skipPath, "utf8").trim()}`);
    }
  }

  return failures > 0 ? 1 : 0;
}

function main() {
  console.log("opena2a-parity harness");
  console.log(`  fixtures dir: ${FIXTURES_DIR}`);
  console.log(`  drift mode:   ${process.env.INTENTIONAL_DRIFT === "1" ? "ON (expect fail)" : "off"}`);

  const bins: Record<CLI, string> = {
    hma: envBinOrThrow("HMA_BIN"),
    opena2a: envBinOrThrow("OPENA2A_BIN"),
    "ai-trust": envBinOrThrow("AI_TRUST_BIN"),
  };

  const fixtures = readdirSync(FIXTURES_DIR).filter((n) => {
    const p = join(FIXTURES_DIR, n);
    return existsSync(join(p, "contract.yaml"));
  });

  if (fixtures.length === 0) {
    console.error("no fixtures found");
    process.exit(2);
  }

  let totalFailures = 0;
  for (const name of fixtures) {
    const rc = runFixture(name, bins);
    totalFailures += rc;
  }

  console.log(`\n${fixtures.length} fixture(s) run, ${totalFailures} fixture failure(s)`);
  process.exit(totalFailures === 0 ? 0 : 1);
}

// Run the gate only when executed directly (e.g. `npm run parity`). Importing
// this module (the retry helpers are unit-tested) must not trigger a full run.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
