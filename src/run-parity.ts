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

const BIN_VARS: Record<CLI, string> = { hma: "HMA_BIN", opena2a: "OPENA2A_BIN", "ai-trust": "AI_TRUST_BIN" };

// One line per CLI variable that is unset or empty. main() prints them and exits 2, as it does for
// "no fixtures found": a missing variable is a usage error, not a crash with a stack trace.
export function missingBinMessages(env: Record<string, string | undefined>): string[] {
  return Object.values(BIN_VARS)
    .filter((name) => !env[name])
    .map((name) => `env var ${name} is required — e.g. ${name}="node /path/to/dist/cli.js"`);
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
// retries and then fails the leg - transient is smoothed, broken is still broken.
//
// Where the participant's golden itself carries an error (the check-not-found
// fixtures), a payload carrying that same error is the expected outcome, not a
// transient one: it goes to the comparison on the first attempt instead of
// burning the retry budget and logging a real failure on a run that passes. A
// different error on that fixture (a registry timeout) is still retried, and if
// it still differs after the last attempt runFixture fails the leg whatever the
// must-match keys say: a timeout payload there carries name, found: false and
// ecosystem with the expected values, so the error is the only field that tells
// "not found" from "not reached". A CLI that rewords that error re-baselines its
// golden first, like any other intended output change.
//
// Goldens are copied from normalized captures, so the decision is made on the
// normalized payload, never the raw one.
const PROBE_RETRIES = 3;

// What the retry is keyed on, in the retry's own log line, so the next reader does not assume it
// covers shape. It does not: a participant that exits 0 with a well-formed document that lacks the
// contract's must-match keys (measured: a registry miss falling through to a local scan, emitting
// { type, score } where { found, trustLevel, verdict } were expected) is returned unretried and is
// reported by runFixture as a SHAPE failure naming the absent keys.
export const RETRY_CONDITION =
  "keyed on an operational { error } payload the golden does not expect, or non-JSON output only; absent must-match keys are never retried";
const PROBE_BACKOFF_MS = Number(process.env.PARITY_PROBE_BACKOFF_MS ?? 1500);

function syncSleep(ms: number): void {
  // The harness is synchronous (execSync), so back off synchronously too.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function carriesError(doc: unknown): boolean {
  return typeof doc === "object" && doc !== null && "error" in doc && Boolean((doc as { error?: unknown }).error);
}

export function isTransientProbeFailure(parsed: unknown, golden?: unknown): boolean {
  if (!carriesError(parsed)) return false;
  // Only the exact error the golden records is expected; any other error is still operational.
  return !carriesError(golden) || (parsed as { error?: unknown }).error !== (golden as { error?: unknown }).error;
}

// Runs the CLI and parses its JSON, retrying only on a transient probe failure
// (an operational { error } payload the golden does not expect, or
// unparseable/empty output). `prepare` (runFixture passes the fixture's
// normalization) runs on each parsed payload before that decision, and `parsed`
// is the prepared payload. Returns the last attempt's result regardless, so the
// caller's comparison still runs.
export function probeWithRetry(
  cmd: string,
  positionalArg: string | null,
  label: string,
  golden?: unknown,
  prepare: (parsed: unknown) => unknown = (parsed) => parsed,
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
    if (parseOk) parsed = prepare(parsed);
    last = { exitCode, stdout, parsed, parseOk };

    const transient = !parseOk || isTransientProbeFailure(parsed, golden);
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
      `[${label}] transient probe failure (attempt ${attempt}/${PROBE_RETRIES}): ${String(why)}. Retrying in ${PROBE_BACKOFF_MS * attempt}ms... (${RETRY_CONDITION})`,
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

// The contract keys a payload does not carry at all. Absence is the key resolving to undefined;
// a present key holding null or a wrong value is a value question for the comparison, not a shape one.
//
// A key the participant's own golden also omits is absence on both sides, which is what the
// contract recorded for ai-trust's `scanStatus` (check-registered-ai, 2026-06-10: "absent ==
// absent") and what #21 broke: it read every absent must-match key as a wrong-shape document and
// turned hackmyagent main's required parity context red on ai-trust rows that had not changed.
// Without a golden every absent key counts, so the fall-through case #21 was written for (a scan
// document where the golden carries found, trustLevel, verdict) is still a SHAPE failure.
export function absentMustMatchKeys(parsed: unknown, mustMatch: string[], golden?: unknown): string[] {
  return mustMatch.filter(
    (key) => getPath(parsed, key) === undefined && (golden === undefined || getPath(golden, key) !== undefined),
  );
}

// One line per participant, naming every absent key. Distinct from [FAIL] (value drift) on purpose:
// a document of the wrong shape is not a drift of the right one, and it was never a retry candidate.
export function shapeFailureReport(label: string, exitCode: number, absent: string[], total: number, errorField?: unknown): string {
  const head = `[SHAPE] ${label}: exit=${exitCode}, ${absent.length} of ${total} must-match key(s) ABSENT from the payload: ${absent.join(", ")}`;
  const why = errorField
    ? `operational error payload after ${PROBE_RETRIES} attempts (error: ${String(errorField)})`
    : "a well-formed document of a different shape (exit 0 is not evidence of the right work)";
  return `${head}\n  ${why}; not retried: the retry is ${RETRY_CONDITION}`;
}

function diffKey(actual: unknown, golden: unknown, path: string): string | null {
  const a = getPath(actual, path);
  const g = getPath(golden, path);
  const aj = JSON.stringify(a);
  const gj = JSON.stringify(g);
  if (aj === gj) return null;
  return `  at ${path}:\n    expected: ${gj}\n    actual:   ${aj}`;
}

// The verdict for an error payload the golden does not expect that outlasted every retry. The probe
// has already logged it as a real failure; this line makes the leg's result say the same.
export function unexpectedErrorReport(label: string, exitCode: number, actual: unknown, golden: unknown): string {
  return [
    `[FAIL] ${label}: exit=${exitCode}, error payload still differs from the golden's after ${PROBE_RETRIES} attempts`,
    diffKey(actual, golden, "error"),
    `  An unreachable registry fails here even when the must-match fields agree. A reworded error is an`,
    `  intended output change: re-baseline golden-first (README.md "Re-baselining goldens").`,
  ].join("\n");
}

// Exported, with the two roots overridable, so a unit test can drive one fixture end to end
// against a stub CLI in a temporary directory instead of the repository's own fixtures/ and actual/.
export function runFixture(
  fixtureName: string,
  bins: Record<CLI, string>,
  dirs: { fixtures: string; actual: string } = { fixtures: FIXTURES_DIR, actual: ACTUAL_DIR },
): number {
  const fixtureDir = join(dirs.fixtures, fixtureName);
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

  mkdirSync(join(dirs.actual, fixtureName), { recursive: true });

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
    // The golden decides which error payloads are expected and which absences are shape failures;
    // a missing golden is reported below.
    const shapeGoldenPath = join(expectedDir, `${cli}.json`);
    const shapeGolden = existsSync(shapeGoldenPath) ? JSON.parse(readFileSync(shapeGoldenPath, "utf8")) : undefined;
    // Normalized inside the probe, so the expected-error decision sees what the golden was copied from.
    const fixtureNormalize = (doc: unknown) => normalize(doc, contract.normalize ?? [], kind === "directory" ? inputDir : "");
    const { exitCode, stdout, parsed, parseOk } = probeWithRetry(cmd, positionalArg, `${fixtureName} ${cli}`, shapeGolden, fixtureNormalize);
    if (!parseOk) {
      console.error(`[${fixtureName}] ${cli} produced non-JSON output (exit=${exitCode}). First 400 chars:\n${stdout.slice(0, 400)}`);
      failures++;
      continue;
    }
    const parsedVal = applyIntentionalDrift(parsed, cli);

    const actualPath = join(dirs.actual, fixtureName, `${cli}.json`);
    writeFileSync(actualPath, stableStringify(parsedVal));

    const absent = absentMustMatchKeys(parsedVal, contract.must_match, shapeGolden);
    if (absent.length > 0) {
      const errorField = isTransientProbeFailure(parsedVal, shapeGolden) ? (parsedVal as { error?: unknown }).error : undefined;
      console.error(`\n${shapeFailureReport(`${fixtureName} × ${cli}`, exitCode, absent, contract.must_match.length, errorField)}`);
      console.error(`  (actual captured at ${join("actual", fixtureName, `${cli}.json`)})`);
      failures += absent.length;
      continue; // no golden comparison for a document of the wrong shape; the keys are named above
    }

    // An error the golden does not expect, still there after the last retry, fails the leg even when
    // every must-match key agrees (a missing golden is reported below instead).
    if (shapeGolden !== undefined && isTransientProbeFailure(parsedVal, shapeGolden)) {
      console.error(`\n${unexpectedErrorReport(`${fixtureName} × ${cli}`, exitCode, parsedVal, shapeGolden)}`);
      console.error(`  (actual captured at ${join("actual", fixtureName, `${cli}.json`)})`);
      failures++;
      continue;
    }

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

  const missing = missingBinMessages(process.env);
  if (missing.length > 0) {
    for (const line of missing) console.error(line);
    process.exit(2);
  }
  const bins = Object.fromEntries(
    Object.entries(BIN_VARS).map(([cli, name]) => [cli, process.env[name] as string]),
  ) as Record<CLI, string>;

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
