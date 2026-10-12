#!/usr/bin/env -S node --experimental-strip-types
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
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
// must-match keys say: ai-trust's timeout payload there carries name, found: false
// and ecosystem with the expected values, so the error is the only field that
// tells "not found" from "not reached". hackmyagent's unreachable-registry payload
// (timeout, 5xx and network error alike) carries no ecosystem, so runFixture
// reports that leg as a SHAPE failure before the error comparison is reached. A
// CLI that rewords that error on purpose re-baselines its golden first, like any
// other intended output change; if the rewording was not intended, it is a CLI
// regression and the golden stays as it is.
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
  // Compared by canonical encoding, as diffKey does, so an object-valued error equal to the golden's
  // matches whatever order the CLI emitted its keys in.
  return (
    !carriesError(golden) ||
    canonicalJson((parsed as { error?: unknown }).error) !== canonicalJson((golden as { error?: unknown }).error)
  );
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

// Each segment is read only as an own key: a plain `cur[p]` resolves a segment named "__proto__" or
// "constructor" to Object.prototype or Object on a payload that does not carry it, so the key would
// compare inherited values and never be reported absent. A JSON payload that does carry such a key
// holds it as an own property, so it still resolves.
function getPath(obj: unknown, path: string): unknown {
  if (path === "" || path === "$") return obj;
  const parts = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object" || !Object.hasOwn(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// A path as getPath reads it, so "$.score" and "score" name the same key.
function canonicalPath(path: string): string {
  return path.replace(/^\$\.?/, "").split(".").filter(Boolean).join(".");
}

// A contract entry as a reader wrote it, for a load-time problem line. JSON.stringify throws on a
// self-referencing YAML alias (such as &a [*a]), which stopped the run with a TypeError instead of
// failing the fixture; util.inspect marks the cycle instead of following it.
function formatEntry(entry: unknown): string {
  try {
    return JSON.stringify(entry) ?? inspect(entry);
  } catch {
    return inspect(entry, { depth: 2, breakLength: Infinity });
  }
}

// A contract that lists no must-match key gives a leg, and the comparison between the CLIs, no field
// to disagree on, so the fixture passed with nothing compared. One line when must_match is missing,
// empty or not a list, and one per entry that is not a key string (such as 1 or null), which would
// otherwise stop the run with a TypeError when the key is looked up; runFixture fails the fixture on
// any of them before it runs a CLI.
export function mustMatchProblems(contract: Pick<FixtureContract, "must_match">): string[] {
  const keys: unknown = contract.must_match ?? [];
  if (!Array.isArray(keys)) return ["must_match is not a list of keys"];
  if (keys.length > 0) {
    return keys.flatMap((key: unknown, i) =>
      typeof key === "string" ? [] : [`must_match entry ${i + 1} is not a key string: ${formatEntry(key)}`],
    );
  }
  return [
    'must_match lists no key, so the fixture would compare nothing; list at least one key the participating CLIs must agree on (README.md "Contract model")',
  ];
}

// may_differ tells a reader which keys may vary between CLIs and why; the comparison reads only
// must_match, so nothing else notices an entry without its reason, or a key listed under both lists
// (which is still compared, whatever may_differ says). One line per offending entry, naming it;
// runFixture fails the fixture on any of them before it runs a CLI.
export function mayDifferProblems(contract: Pick<FixtureContract, "must_match" | "may_differ">): string[] {
  const entries: unknown = contract.may_differ ?? [];
  if (!Array.isArray(entries)) return ["may_differ is not a list of { path, reason } entries"];
  const mustMatch = new Set((Array.isArray(contract.must_match) ? contract.must_match : []).map(String).map(canonicalPath));
  const problems: string[] = [];
  entries.forEach((entry: unknown, i) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`may_differ entry ${i + 1} is not a { path, reason } entry: ${formatEntry(entry)}`);
      return;
    }
    const { path, reason } = entry as { path?: unknown; reason?: unknown };
    const hasPath = typeof path === "string" && path.trim() !== "";
    const name = `may_differ entry ${i + 1}${hasPath ? ` (path: ${path})` : ""}`;
    if (!hasPath) problems.push(`${name} has no path`);
    if (typeof reason !== "string" || reason.trim() === "") problems.push(`${name} has no reason; say why this key may differ between CLIs`);
    if (hasPath && mustMatch.has(canonicalPath(path as string))) {
      problems.push(`${name} is also listed under must_match, where it is still compared; list it under one of the two`);
    }
  });
  return problems;
}

// The checks below cover the fields runFixture reads as the types FixtureContract gives them. A
// contract that held another type there stopped the run with a TypeError ("contract.participants is
// not iterable", "path.replace is not a function") before the remaining fixtures ran. One line per
// offending field or entry, naming it; runFixture fails the fixture on any of them before it runs a CLI.
export function exercisesProblems(contract: Pick<FixtureContract, "exercises">): string[] {
  const exercises: unknown = contract.exercises;
  if (exercises === null || typeof exercises !== "object" || Array.isArray(exercises)) {
    return ["exercises is not a mapping from each participant to its command"];
  }
  // An entry left without a value is reported when the fixture runs, as a participant with no exercises entry.
  return Object.entries(exercises).flatMap(([cli, command]) =>
    command == null || typeof command === "string" ? [] : [`exercises entry ${cli} is not a command string: ${formatEntry(command)}`],
  );
}

export function participantsProblems(contract: Pick<FixtureContract, "participants">): string[] {
  const clis = Object.keys(BIN_VARS);
  const entries: unknown = contract.participants;
  if (!Array.isArray(entries)) return [`participants is not a list of CLIs (${clis.join(", ")})`];
  return entries.flatMap((cli: unknown, i) =>
    typeof cli === "string" && clis.includes(cli) ? [] : [`participants entry ${i + 1} is not one of ${clis.join(", ")}: ${formatEntry(cli)}`],
  );
}

// A rule field that is missing or not a string. An empty replacement is a string: it deletes what the pattern matches.
function ruleFieldProblems(name: string, field: string, value: unknown, emptyAllowed = false): string[] {
  if (value == null || (value === "" && !emptyAllowed)) return [`${name} has no ${field}`];
  return typeof value === "string" ? [] : [`${name} ${field} is not a string: ${formatEntry(value)}`];
}

export function normalizeProblems(contract: Pick<FixtureContract, "normalize">): string[] {
  const rules: unknown = contract.normalize ?? [];
  if (!Array.isArray(rules)) return ["normalize is not a list of rules"];
  const problems: string[] = [];
  rules.forEach((rule: unknown, i) => {
    const name = `normalize rule ${i + 1}`;
    if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
      problems.push(`${name} is not a mapping with a kind: ${formatEntry(rule)}`);
      return;
    }
    const { kind, path, pattern, replacement } = rule as Record<string, unknown>;
    if (kind === "strip_key") {
      problems.push(...ruleFieldProblems(`${name} (strip_key)`, "path", path));
    } else if (kind === "replace_regex") {
      const patternProblems = ruleFieldProblems(`${name} (replace_regex)`, "pattern", pattern);
      if (patternProblems.length === 0) {
        try {
          // The input directory is inserted as a literal, so any literal stands for it here.
          rulePattern(pattern as string, "input");
        } catch (err) {
          patternProblems.push(`${name} (replace_regex) pattern is not a regular expression: ${(err as Error).message}`);
        }
      }
      problems.push(...patternProblems, ...ruleFieldProblems(`${name} (replace_regex)`, "replacement", replacement, true));
    } else {
      problems.push(
        kind == null
          ? `${name} has no kind; a rule is strip_key or replace_regex`
          : `${name} kind is neither strip_key nor replace_regex: ${formatEntry(kind)}`,
      );
    }
  });
  return problems;
}

// A replace_regex pattern as normalize applies it: {FIXTURE_INPUT_DIR} stands for the fixture's input
// directory, matched literally.
function rulePattern(pattern: string, fixtureInputDir: string): RegExp {
  return new RegExp(pattern.replace("{FIXTURE_INPUT_DIR}", fixtureInputDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "g");
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
    // Built with Object.fromEntries, which defines each key: assigning a key named "__proto__" on a
    // plain object sets the prototype instead, dropping that key (and all under it) from the
    // comparison and the capture.
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, replaceInStrings(v, pattern, replacement)]));
  }
  return obj;
}

function normalize(parsed: unknown, rules: FixtureContract["normalize"], fixtureInputDir: string): unknown {
  let out = structuredClone(parsed);
  for (const rule of rules) {
    if (rule.kind === "strip_key" && rule.path) {
      stripKey(out, rule.path);
    } else if (rule.kind === "replace_regex" && rule.pattern != null && rule.replacement != null) {
      out = replaceInStrings(out, rulePattern(rule.pattern, fixtureInputDir), rule.replacement);
    }
  }
  return out;
}

function applyIntentionalDrift(obj: unknown, cli: CLI): unknown {
  if (process.env.INTENTIONAL_DRIFT !== "1") return obj;
  if (cli !== "opena2a") return obj;
  // A payload is any JSON value, the literal null included, and null has no key to read.
  const cloned = structuredClone(obj) as Record<string, unknown> | null;
  if (cloned !== null && typeof cloned.platform === "string") {
    cloned.platform = cloned.platform + "+drift-demo";
  }
  return cloned;
}

// The text a capture is written as. The replacer sorts the keys of each object it meets and passes
// every other value through, so this reads no key of the payload itself: a participant that prints
// null gets a capture and a verdict like any other, instead of a TypeError that stops the run.
function stableStringify(obj: unknown): string {
  return JSON.stringify(obj, sortKeysReplacer(), 2);
}

// The key-sorting encoding stableStringify writes captures with, unindented. A golden copied from a
// capture has sorted keys; a CLI emits its own order, so a value comparison goes through this on both sides.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, sortKeysReplacer());
}

function sortKeysReplacer() {
  const seen = new WeakSet();
  return function (_key: string, value: unknown) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (seen.has(value as object)) return value;
      seen.add(value as object);
      // A copy without a prototype: on a plain object, assigning a key named "__proto__" sets the
      // prototype instead of creating a key, which would drop that key (and all under it) from the
      // comparison on both sides and from the capture file.
      const sorted: Record<string, unknown> = Object.create(null);
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
// document where the golden carries found, trustLevel, verdict) is still a SHAPE failure. A golden
// that omits every key leaves nothing here to be absent; runFixture reports that golden itself.
export function absentMustMatchKeys(parsed: unknown, mustMatch: string[], golden?: unknown): string[] {
  return mustMatch.filter(
    (key) => getPath(parsed, key) === undefined && (golden === undefined || getPath(golden, key) !== undefined),
  );
}

// One line per participant, naming every absent key. Distinct from [FAIL] (value drift) on purpose:
// a document of the wrong shape is not a drift of the right one, and it was never a retry candidate.
// The remark about exit 0 is printed only for a leg that exited 0: on a non-zero exit it described
// an exit code the same line had just reported otherwise.
export function shapeFailureReport(label: string, exitCode: number, absent: string[], total: number, errorField?: unknown): string {
  const head = `[SHAPE] ${label}: exit=${exitCode}, ${absent.length} of ${total} must-match key(s) ABSENT from the payload: ${absent.join(", ")}`;
  const exitZeroRemark = exitCode === 0 ? " (exit 0 is not evidence of the right work)" : "";
  const why = errorField
    ? `operational error payload after ${PROBE_RETRIES} attempts (error: ${String(errorField)})`
    : `a well-formed document of a different shape${exitZeroRemark}`;
  return `${head}\n  ${why}; not retried: the retry is ${RETRY_CONDITION}`;
}

// The contract keys no participant's golden carries. A key in another syntax (`findings[0].checkId`)
// or a misspelt one resolves to nothing in the golden and the payload alike, the shape check reads
// that as absence on both sides, and nothing equals nothing, so it was counted equal without being
// compared. One golden carrying the key is enough: check-registered-ai's scanStatus is in the hma and
// opena2a goldens and omitted from ai-trust's on purpose. With no golden yet there is nothing to
// resolve a key against, and each missing golden is reported on its own.
export function unresolvedMustMatchKeys(mustMatch: string[], goldens: unknown[]): string[] {
  if (goldens.length === 0) return [];
  return mustMatch.filter((key) => goldens.every((golden) => getPath(golden, key) === undefined));
}

export function unresolvedKeysReport(fixtureName: string, unresolved: string[]): string {
  return [
    `[CONTRACT] ${fixtureName}: ${unresolved.length} must-match key(s) resolve in no participant's golden: ${unresolved.join(", ")}`,
    `  A key is a dot-separated path with a numeric segment for an array index (findings.0.checkId).`,
    `  A key no golden carries compares nothing, so it fails the fixture instead of counting as equal.`,
  ].join("\n");
}

// The participants whose golden carries none of the contract's must-match keys. A key a golden omits
// is absence on both sides for that participant's leg, and one golden carrying a key keeps it out of
// unresolvedMustMatchKeys. So a golden that omitted every key, beside one that carried them, left its
// leg no field to compare, and the leg counted every key equal whatever the CLI printed: a number, an
// empty object, null. A golden that is not an object carries no key either.
export function goldensWithoutMustMatchKey(mustMatch: string[], legs: { cli: string; golden: unknown }[]): string[] {
  return legs.filter((leg) => mustMatch.every((key) => getPath(leg.golden, key) === undefined)).map((leg) => leg.cli);
}

export function keylessGoldenReport(fixtureName: string, cli: string, mustMatch: string[]): string {
  return [
    `[CONTRACT] ${fixtureName} × ${cli}: its golden carries none of the ${mustMatch.length} must-match key(s): ${mustMatch.join(", ")}`,
    `  A leg whose golden carries no must-match key compares nothing, so it fails the fixture instead of counting as equal.`,
    `  If ${cli} prints the keys, copy its verified capture over the golden (README.md "Re-baselining goldens"); if it does not exercise`,
    `  this fixture, take it out of participants and add expected/${cli}.skip saying why (README.md "Contract model").`,
  ].join("\n");
}

function diffKey(actual: unknown, golden: unknown, path: string): string | null {
  const a = getPath(actual, path);
  const g = getPath(golden, path);
  const aj = canonicalJson(a);
  const gj = canonicalJson(g);
  if (aj === gj) return null;
  return `  at ${path}:\n    expected: ${gj}\n    actual:   ${aj}`;
}

// The verdict for an error payload the golden does not expect that outlasted every retry. The probe
// has already logged it as a real failure; this line makes the leg's result say the same.
//
// A golden without an error has none for the payload to differ from, so that case is named as
// such rather than diffed against an "expected: undefined".
export function unexpectedErrorReport(label: string, exitCode: number, actual: unknown, golden: unknown): string {
  const goldenHasError = carriesError(golden);
  return [
    goldenHasError
      ? `[FAIL] ${label}: exit=${exitCode}, error payload still differs from the golden's after ${PROBE_RETRIES} attempts`
      : `[FAIL] ${label}: exit=${exitCode}, error payload still present after ${PROBE_RETRIES} attempts; the golden records no error`,
    goldenHasError ? diffKey(actual, golden, "error") : `  at error:\n    actual:   ${canonicalJson(getPath(actual, "error"))}`,
    `  An unreachable registry fails here even when the must-match fields agree. A ${goldenHasError ? "reworded" : "new"} error is an`,
    `  intended output change only if the CLI now reports it on purpose: if so, re-baseline golden-first`,
    `  (README.md "Re-baselining goldens"); if not, it is a CLI regression and the golden stays as it is.`,
  ].join("\n");
}

// The must-match keys on which two CLIs hold different values, one block per key. Each leg compares a
// CLI with its own golden only, so the legs alone pass a fixture whose goldens record different values
// for the same input, and re-baselining copies one CLI's capture over that CLI's golden without looking
// at the others. Here the goldens are compared with each other, and so are the outputs.
//
// A CLI whose golden omits a key is left out of that key's comparison: the omission is that CLI's
// recorded absence (ai-trust's `scanStatus` on check-registered-ai), and its own leg holds its output
// to it. A leg that failed before its own comparison has no `actual` and takes part with its golden.
export function crossCliDiffs(mustMatch: string[], legs: { cli: string; golden: unknown; actual?: unknown }[]): string[] {
  const diffs: string[] = [];
  for (const key of mustMatch) {
    const carriers = legs.filter((leg) => getPath(leg.golden, key) !== undefined);
    if (carriers.length < 2) continue;
    const width = Math.max(...carriers.map((leg) => leg.cli.length)) + 1;
    const sides: string[] = [];
    for (const [title, side] of [["goldens", "golden"], ["outputs", "actual"]] as const) {
      const held = carriers
        .filter((leg) => getPath(leg[side], key) !== undefined)
        .map((leg) => ({ cli: leg.cli, value: canonicalJson(getPath(leg[side], key)) }));
      if (new Set(held.map((h) => h.value)).size < 2) continue;
      sides.push(`    ${title}:`, ...held.map((h) => `      ${`${h.cli}:`.padEnd(width)} ${h.value}`));
    }
    if (sides.length > 0) diffs.push([`  at ${key}:`, ...sides].join("\n"));
  }
  return diffs;
}

// JSON.parse accepts a document nested deeper than the call stack allows, but the clone, the key sort
// and the comparison recurse and throw a RangeError on it. That fails its own leg instead of stopping
// the harness before the remaining legs and fixtures run. A RangeError from anything else, such as a
// size limit on reading or encoding a document, fails the leg too, without being called a nesting failure.
function comparisonFailureReport(label: string, err: RangeError): string {
  const reason = err.message.includes("Maximum call stack size exceeded")
    ? "is nested too deeply to compare"
    : "could not be compared";
  return `[FAIL] ${label}: the payload or its golden ${reason} (RangeError: ${err.message})`;
}

// How runFixture reads a participant's golden. A unit test passes its own, since the RangeError a golden
// over the size limit throws cannot be produced with a committed fixture.
export type GoldenReader = (goldenPath: string) => unknown;
const readGoldenFile: GoldenReader = (goldenPath) => JSON.parse(readFileSync(goldenPath, "utf8"));

// Exported, with the two roots overridable, so a unit test can drive one fixture end to end
// against a stub CLI in a temporary directory instead of the repository's own fixtures/ and actual/.
// Returns 0 for a fixture that passes, 1 for any failure found while running the fixture and 2 for a
// contract the harness cannot run. A failed leg is one such failure; so are a must-match key in no golden,
// a participant's golden that carries no must-match key, a missing golden, a participant without an
// exercises entry, a difference between CLIs and a missing or empty skip sentinel, so a fixture can
// return 1 after every leg printed [OK].
export function runFixture(
  fixtureName: string,
  bins: Record<CLI, string>,
  dirs: { fixtures: string; actual: string } = { fixtures: FIXTURES_DIR, actual: ACTUAL_DIR },
  readGolden: GoldenReader = readGoldenFile,
): number {
  const fixtureDir = join(dirs.fixtures, fixtureName);
  const inputDir = join(fixtureDir, "input");
  const contractPath = join(fixtureDir, "contract.yaml");
  const expectedDir = join(fixtureDir, "expected");

  if (!existsSync(contractPath)) {
    console.error(`[${fixtureName}] missing contract.yaml`);
    return 2;
  }
  // An empty contract.yaml parses to null, and one holding a list or a bare value has no field to read.
  const parsedContract: unknown = parseYaml(readFileSync(contractPath, "utf8"));
  if (parsedContract === null || typeof parsedContract !== "object" || Array.isArray(parsedContract)) {
    console.error(`[${fixtureName}] contract.yaml is not a mapping of contract fields (README.md "Contract model")`);
    return 2;
  }
  const contract = parsedContract as FixtureContract;
  const kind: FixtureKind = contract.kind ?? "directory";

  if (kind === "directory" && !existsSync(inputDir)) {
    console.error(`[${fixtureName}] missing input/ directory (kind=directory)`);
    return 2;
  }
  if (kind === "package-name" && !contract.package) {
    console.error(`[${fixtureName}] kind=package-name requires 'package:' field`);
    return 2;
  }
  const contractProblems = [
    ...exercisesProblems(contract),
    ...participantsProblems(contract),
    ...mustMatchProblems(contract),
    ...mayDifferProblems(contract),
    ...normalizeProblems(contract),
  ];
  if (contractProblems.length > 0) {
    for (const problem of contractProblems) console.error(`[${fixtureName}] contract.yaml ${problem}`);
    return 2;
  }

  mkdirSync(join(dirs.actual, fixtureName), { recursive: true });

  const results: Record<string, ProbeResult> = {};
  let failures = 0;

  // Each participant's golden, read once: the probe, the shape check and the comparison all use it. A
  // RangeError reading one (a size limit) fails that participant's leg below instead of the harness.
  const goldens = new Map<CLI, unknown>();
  const unreadGoldens = new Map<CLI, RangeError>();
  for (const cli of contract.participants) {
    const goldenPath = join(expectedDir, `${cli}.json`);
    if (!existsSync(goldenPath)) continue;
    try {
      goldens.set(cli, readGolden(goldenPath));
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      unreadGoldens.set(cli, err);
    }
  }

  // The legs still run, so each capture is written, and compare only the keys a golden carries. A
  // golden that could not be read may carry a key, so its fixture is not checked for them.
  const unresolved = unreadGoldens.size > 0 ? [] : unresolvedMustMatchKeys(contract.must_match, [...goldens.values()]);
  if (unresolved.length > 0) {
    console.error(`\n${unresolvedKeysReport(fixtureName, unresolved)}`);
    failures += unresolved.length;
  }
  const mustMatch = contract.must_match.filter((key) => !unresolved.includes(key));

  // A participant whose golden carries none of the keys fails the fixture here. Its leg still runs,
  // so its capture is written and an output that carries a key the golden omits is still reported.
  // Where every key is in no golden, the report above already covers each participant.
  const keyless =
    mustMatch.length > 0 ? goldensWithoutMustMatchKey(contract.must_match, [...goldens].map(([cli, golden]) => ({ cli, golden }))) : [];
  for (const cli of keyless) {
    console.error(`\n${keylessGoldenReport(fixtureName, cli, contract.must_match)}`);
    failures++;
  }

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
    try {
      // The golden decides which error payloads are expected and which absences are shape failures;
      // a missing golden is reported below.
      const unreadGolden = unreadGoldens.get(cli);
      if (unreadGolden) throw unreadGolden;
      const shapeGolden = goldens.get(cli);
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

      const absent = absentMustMatchKeys(parsedVal, mustMatch, shapeGolden);
      if (absent.length > 0) {
        const errorField = isTransientProbeFailure(parsedVal, shapeGolden) ? (parsedVal as { error?: unknown }).error : undefined;
        console.error(`\n${shapeFailureReport(`${fixtureName} × ${cli}`, exitCode, absent, mustMatch.length, errorField)}`);
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
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      console.error(`\n${comparisonFailureReport(`${fixtureName} × ${cli}`, err)}`);
      failures++;
    }
  }

  const legs: { cli: CLI; golden: unknown; actual?: unknown }[] = [];
  for (const cli of contract.participants) {
    const goldenPath = join(expectedDir, `${cli}.json`);
    if (!existsSync(goldenPath)) {
      console.error(`[${fixtureName}] ${cli} missing golden at ${goldenPath}`);
      failures++;
      continue;
    }
    if (unreadGoldens.has(cli)) continue; // its leg has already failed on it
    const golden = goldens.get(cli);
    const actual = results[cli]?.parsed;
    if (actual === undefined) {
      legs.push({ cli, golden });
      continue;
    }

    const diffs: string[] = [];
    try {
      for (const key of mustMatch) {
        const d = diffKey(actual, golden, key);
        if (d) diffs.push(d);
      }
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      console.error(`\n${comparisonFailureReport(`${fixtureName} × ${cli}`, err)}`);
      failures++;
      continue;
    }
    legs.push({ cli, golden, actual });
    if (diffs.length > 0) {
      console.error(`\n[FAIL] ${fixtureName} × ${cli}: ${diffs.length} must-match field(s) drifted`);
      for (const d of diffs) console.error(d);
      console.error(`  (actual captured at ${join("actual", fixtureName, `${cli}.json`)})`);
      console.error(`  Intended output change? Re-baseline golden-first: README.md "Re-baselining goldens".`);
      failures += diffs.length;
    } else {
      const keylessGolden = keyless.includes(cli);
      const notCompared = keylessGolden
        ? `; not compared: ${contract.must_match.join(", ")} (not in its golden)`
        : unresolved.length > 0 ? `; not compared: ${unresolved.join(", ")} (in no golden)` : "";
      // A leg that compared no field has nothing to call equal, so it does not print [OK].
      if (mustMatch.length === 0 || keylessGolden) {
        console.log(`[NONE] ${fixtureName} × ${cli}: no must-match field compared${notCompared}`);
      } else {
        console.log(`[OK]   ${fixtureName} × ${cli}: ${mustMatch.length} must-match fields equal apart from object key order${notCompared}`);
      }
    }
  }

  // Every leg above compared a CLI with its own golden; this compares the CLIs with each other. The
  // line that says they agree is printed only when every leg passed, so it never covers an output
  // that was not compared.
  try {
    const crossDiffs = crossCliDiffs(contract.must_match, legs);
    if (crossDiffs.length > 0) {
      console.error(`\n[FAIL] ${fixtureName}: ${crossDiffs.length} must-match field(s) differ between CLIs`);
      for (const d of crossDiffs) console.error(d);
      console.error(`  A must-match field holds one value in every CLI whose golden carries it. Fix the CLI or the golden that is`);
      console.error(`  wrong; if the CLIs differ on purpose, move the key from must_match to may_differ, with the reason (README.md "Contract model").`);
      failures += crossDiffs.length;
    } else if (failures === 0 && legs.length > 1) {
      console.log(`[OK]   ${fixtureName}: ${legs.map((leg) => leg.cli).join(", ")} agree on every must-match field their goldens carry`);
    }
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    console.error(`\n${comparisonFailureReport(`${fixtureName} across CLIs`, err)}`);
    failures++;
  }

  // A CLI that is not a participant needs a sentinel saying why it does not exercise the fixture.
  // Without one, a fixture that leaves a CLI out by mistake would pass looking complete. An empty
  // sentinel says no more than a missing one, so it fails too, as a may_differ entry without its reason does.
  const allCLIs: CLI[] = ["hma", "opena2a", "ai-trust"];
  for (const cli of allCLIs) {
    if (contract.participants.includes(cli)) continue;
    const skipPath = join(expectedDir, `${cli}.skip`);
    const skipReason = existsSync(skipPath) ? readFileSync(skipPath, "utf8").trim() : null;
    if (skipReason) {
      console.log(`[SKIP] ${fixtureName} × ${cli}: ${skipReason}`);
    } else if (skipReason === "") {
      console.error(`\n[FAIL] ${fixtureName} × ${cli}: the skip sentinel at ${skipPath} is empty`);
      console.error(`  Write in expected/${cli}.skip why ${cli} does not exercise this fixture (README.md "Contract model").`);
      failures++;
    } else {
      console.error(`\n[FAIL] ${fixtureName} × ${cli}: not a participant and has no skip sentinel at ${skipPath}`);
      console.error(`  List ${cli} under participants with a golden, or add expected/${cli}.skip saying why it does not exercise this fixture (README.md "Contract model").`);
      failures++;
    }
  }

  return failures > 0 ? 1 : 0;
}

// Runs each fixture and returns how many failed. runFixture returns 2, not 1, for a contract it cannot
// run, so its results are counted, not summed: the summary line counts fixtures.
export function runFixtures(
  fixtureNames: string[],
  bins: Record<CLI, string>,
  dirs: { fixtures: string; actual: string } = { fixtures: FIXTURES_DIR, actual: ACTUAL_DIR },
): number {
  let failed = 0;
  for (const name of fixtureNames) {
    if (runFixture(name, bins, dirs) !== 0) failed++;
  }
  return failed;
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

  const failedFixtures = runFixtures(fixtures, bins);

  console.log(`\n${fixtures.length} fixture(s) run, ${failedFixtures} fixture failure(s)`);
  process.exit(failedFixtures === 0 ? 0 : 1);
}

// Run the gate only when executed directly (e.g. `npm run parity`). Importing
// this module (the retry helpers are unit-tested) must not trigger a full run.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
