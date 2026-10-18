#!/usr/bin/env -S node --experimental-strip-types
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, lstatSync, statSync, realpathSync, type Stats } from "node:fs";
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

// The command a CLI variable holds, without the white space around it, or undefined for a variable
// that is unset, empty or white space only. HMA_BIN=" " is as unusable as HMA_BIN="", but read as set
// it went to the probe path, where each leg failed its three attempts with exit 127 and the run ended 1.
export function binCommand(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// One line per CLI variable that is unset, empty or white space only. main() prints them and exits 2,
// as it does for "no fixtures found": a missing variable is a usage error, not a crash with a stack trace.
export function missingBinMessages(env: Record<string, string | undefined>): string[] {
  return Object.values(BIN_VARS)
    .filter((name) => binCommand(env[name]) === undefined)
    .map((name) => `env var ${name} is required — e.g. ${name}="node /path/to/dist/cli.js"`);
}

// INTENTIONAL_DRIFT is a switch: unset, empty or white space only, "0", "false", "no" and "off", in any
// letter case, leave drift mode off; any other value turns it on. Read as on only when it was exactly
// "1", INTENTIONAL_DRIFT=true printed "drift mode: off" and ran the normal gate.
export function driftModeOn(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return !["", "0", "false", "no", "off"].includes(normalized);
}

// What the command line asks for. The harness takes no positional argument: --help or -h prints the
// usage, --version prints the harness version, and any other argument is a usage error, so a misspelt
// option is reported instead of running the whole gate as if nothing had been given.
export type CliRequest = { kind: "run" } | { kind: "help" } | { kind: "version" } | { kind: "unknown"; argument: string };

export function cliRequest(args: string[]): CliRequest {
  if (args.some((arg) => arg === "--help" || arg === "-h")) return { kind: "help" };
  if (args.length === 0) return { kind: "run" };
  if (args.length === 1 && args[0] === "--version") return { kind: "version" };
  // The first argument that is not --version, or the repeat when --version was given more than once.
  return { kind: "unknown", argument: args.find((arg) => arg !== "--version") ?? args[1] };
}

// The usage --help prints: the three CLI variables, the two optional variables, the options and the
// exit codes, so a reader has the whole surface without opening README.md.
export const USAGE = `usage: npm run parity [-- --help | --version]
       node --experimental-strip-types src/run-parity.ts [--help | --version]

Runs each fixture under fixtures/ against the three CLIs and compares the keys its contract.yaml
lists under must_match: each CLI's output with that CLI's golden, then the CLIs with each other.
Captures are written under actual/<fixture>/<cli>.json.

environment variables:
  HMA_BIN        command that runs hackmyagent, e.g. "node /path/to/hackmyagent/dist/cli.js"
  OPENA2A_BIN    command that runs opena2a, e.g. "node /path/to/opena2a/packages/cli/dist/index.js"
  AI_TRUST_BIN   command that runs ai-trust, e.g. "node /path/to/ai-trust/dist/index.js"
                 Each is a shell command string; the fixture's command line is built around it.
  INTENTIONAL_DRIFT=1
                 Drift mode, which npm run parity:drift-demo sets: "+drift-demo" is appended to the
                 platform value of each opena2a capture that has one, so the gate is expected to fail.
                 Unset, empty or white space only, 0, false, no and off, in any letter case, leave
                 it off; any other value turns it on.
  PARITY_PROBE_BACKOFF_MS
                 Wait in milliseconds before the first retry of a transient probe failure (an
                 operational { error } payload the golden does not expect, or non-JSON output from
                 a command that did start), doubled before the second; such a probe is tried three
                 times, and a command that could not start is not retried. Default 1500.

options:
  --help, -h     print this usage and exit 0
  --version      print the harness version and exit 0

exit codes:
  0  every fixture passed, or the usage or the version was printed
  1  a fixture failed
  2  usage error: a CLI variable unset, empty or white space only, no fixture under fixtures/, or an
     argument other than the options above`;

// The version --version prints: the version field of this repository's package.json, read when asked
// so the two cannot drift apart.
export function harnessVersion(packageJsonPath: string = join(REPO_ROOT, "package.json")): string {
  const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof version !== "string") throw new Error(`${packageJsonPath} carries no version string`);
  return version;
}

function runCli(invocation: string, positionalArg: string | null): { exitCode: number; stdout: string; stderr: string } {
  const cmd = positionalArg === null ? invocation : `${invocation} "${positionalArg}"`;
  try {
    const stdout = execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

// A command that could not start: sh's exit 126 (found but cannot be executed) or 127 (not found), or
// Node's module-resolution error, which Node prints before any of the CLI's own code runs. Either
// fails the same way on every run, so probeWithRetry reports it after the first attempt instead of
// retrying it. The reason is the line sh or Node printed for it: the first stderr line that names the
// failure, or else the first one that is not part of Node's source excerpt, stack or error object. A
// command that printed anything on stdout did start, whatever its exit code.
const START_FAILURE_LINE = /^Error:|command not found|cannot execute|is a directory|Permission denied|No such file or directory/;
const NODE_REPORT_LINE = /^(?:node:internal|throw|\^|at |\{|\})/;

export function startFailureReason(exitCode: number, stdout: string, stderr: string): string | null {
  if (stdout !== "") return null;
  if (exitCode !== 126 && exitCode !== 127 && !/Cannot find module|(?:ERR_)?MODULE_NOT_FOUND/.test(stderr)) return null;
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return (
    lines.find((line) => START_FAILURE_LINE.test(line)) ??
    lines.find((line) => !NODE_REPORT_LINE.test(line)) ??
    lines[0] ??
    `exit ${exitCode} with nothing on stdout or stderr`
  );
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
  "keyed on an operational { error } payload the golden does not expect, or non-JSON output from a command that did start; absent must-match keys are never retried, nor is a command that could not start";
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

type ProbeOutcome = { exitCode: number; stdout: string; stderr: string; parsed: unknown; parseOk: boolean; startFailure: string | null };

// Runs the CLI and parses its JSON, retrying only on a transient probe failure
// (an operational { error } payload the golden does not expect, or
// unparseable/empty output from a command that did start). A command that could
// not start is returned after its first attempt, with startFailureReason's
// reason as `startFailure`; on every other path `startFailure` is null.
// `prepare` (runFixture passes the fixture's normalization) runs on each parsed
// payload before that decision, and `parsed` is the prepared payload. Returns
// the last attempt's result regardless, so the caller's comparison still runs.
export function probeWithRetry(
  cmd: string,
  positionalArg: string | null,
  label: string,
  golden?: unknown,
  prepare: (parsed: unknown) => unknown = (parsed) => parsed,
): ProbeOutcome {
  let last: ProbeOutcome = {
    exitCode: 1,
    stdout: "",
    stderr: "",
    parsed: undefined,
    parseOk: false,
    startFailure: null,
  };
  for (let attempt = 1; attempt <= PROBE_RETRIES; attempt++) {
    const { exitCode, stdout, stderr } = runCli(cmd, positionalArg);
    if (attempt === 1) {
      // A retry would fail the same way after its backoff, and would hide the reason behind retry lines.
      const startFailure = startFailureReason(exitCode, stdout, stderr);
      if (startFailure !== null) return { exitCode, stdout, stderr, parsed: undefined, parseOk: false, startFailure };
    }
    let parsed: unknown;
    let parseOk = true;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parseOk = false;
    }
    if (parseOk) parsed = prepare(parsed);
    last = { exitCode, stdout, stderr, parsed, parseOk, startFailure: null };

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
  // Key strings only: mustMatchProblems names every other entry, and converting one to a string to
  // compare it here throws on a mapping with a toString key, which stopped the run with a TypeError.
  const mustMatch = new Set(
    (Array.isArray(contract.must_match) ? contract.must_match : []).filter((key: unknown) => typeof key === "string").map(canonicalPath),
  );
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
//
// kind decides whether the fixture has an input/ directory and what {FIXTURE_INPUT_DIR} stands for.
// Any value other than package-name was run as a directory fixture without the input/ check and with
// an empty string for the placeholder. In a kind: package-name fixture, a package that is not a string
// was converted to text when it was put in place of {PACKAGE}, so a fixture with `package: 2048` or
// `package: [ghost]` ran and could pass; one that cannot be converted, such as a mapping with a
// toString key, threw. A directory fixture does not read package, so its type is not checked there.
// A package left without a value is reported by runFixture.
export function kindProblems(contract: Pick<FixtureContract, "kind" | "package">): string[] {
  const kind: unknown = contract.kind ?? "directory";
  if (kind !== "directory" && kind !== "package-name") return [`kind is neither directory nor package-name: ${formatEntry(kind)}`];
  const packageName: unknown = contract.package;
  return kind === "directory" || packageName == null || typeof packageName === "string"
    ? []
    : [`package is not a package name string: ${formatEntry(packageName)}`];
}

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
  // A list that names no CLI runs and compares nothing, and the fixture passed on its skip sentinels alone.
  if (entries.length === 0) {
    return [`participants lists no CLI, so the fixture would run and compare nothing; list at least one of ${clis.join(", ")}`];
  }
  return entries.flatMap((cli: unknown, i) => {
    if (typeof cli !== "string" || !clis.includes(cli)) return [`participants entry ${i + 1} is not one of ${clis.join(", ")}: ${formatEntry(cli)}`];
    // A CLI listed twice was run twice and then reported as agreeing with itself.
    return entries.indexOf(cli) < i ? [`participants entry ${i + 1} repeats ${cli}; list each CLI once`] : [];
  });
}

// A rule field that is missing or not a string. An empty replacement is a string: it deletes what the pattern matches.
function ruleFieldProblems(name: string, field: string, value: unknown, emptyAllowed = false): string[] {
  if (value == null || (value === "" && !emptyAllowed)) return [`${name} has no ${field}`];
  return typeof value === "string" ? [] : [`${name} ${field} is not a string: ${formatEntry(value)}`];
}

// fixtureInputDir is what the fixture puts in place of {FIXTURE_INPUT_DIR}: its input directory, or an
// empty string for a kind: package-name fixture, which has none. So a rule there whose pattern holds the
// placeholder fails: with an empty string in its place, {FIXTURE_INPUT_DIR}* was *, which is not a
// regular expression, {FIXTURE_INPUT_DIR} alone matched at every position of every string, and
// {FIXTURE_INPUT_DIR}.* with an empty replacement deleted every string value, which can hide a
// must-match difference.
//
// Any other pattern is compiled with the input directory in place of the placeholder, as normalize
// compiles it, so one that is a regular expression only with another value there
// ([a-{FIXTURE_INPUT_DIR}] is one with an empty string) fails here instead of throwing when the first
// output is normalized, and it is run, since the engine throws for some only then. One that holds the
// placeholder and can match empty text, as canMatchEmpty finds, fails too: ({FIXTURE_INPUT_DIR})? turned
// "ab" into "<IN>a<IN>b<IN>", and \b|{FIXTURE_INPUT_DIR}, which matches empty text only next to a word,
// turned "ab cd" into "<IN>ab<IN> <IN>cd<IN>". A rule whose replacement is empty is not checked for
// this: where it matched no text it inserts nothing.
export function normalizeProblems(contract: Pick<FixtureContract, "normalize">, fixtureInputDir: string): string[] {
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
      const holdsPlaceholder = patternProblems.length === 0 && (pattern as string).includes(INPUT_DIR_PLACEHOLDER);
      if (holdsPlaceholder && fixtureInputDir === "") {
        patternProblems.push(
          `${name} (replace_regex) pattern holds ${INPUT_DIR_PLACEHOLDER}, but a kind: package-name fixture has no input directory for it to stand for`,
        );
      } else if (patternProblems.length === 0) {
        // Each line quotes the pattern as compiled, which says what the placeholder became.
        const standingFor = holdsPlaceholder ? ` with ${INPUT_DIR_PLACEHOLDER} standing for the input directory` : "";
        const source = ruleSource(pattern as string, fixtureInputDir);
        let compiled: RegExp | undefined;
        try {
          const candidate = new RegExp(source, "g");
          // The engine compiles a pattern the first time it runs it, once for text of one-byte characters
          // and once for text with a wider one, and only then throws for one too large to compile: 100,000
          // literal characters passed new RegExp and threw when the first output was normalized.
          candidate.exec("");
          candidate.exec(WIDE_CHARACTER);
          compiled = candidate;
        } catch (err) {
          patternProblems.push(`${name} (replace_regex) pattern is not a regular expression${standingFor}: ${compileErrorMessage(err as Error, source)}`);
        }
        // A pattern written without the placeholder is left as its author wrote it: ^$ replaces a value that is an empty string.
        if (compiled && holdsPlaceholder && replacement !== "" && canMatchEmpty(compiled.source)) {
          patternProblems.push(
            `${name} (replace_regex) pattern can match empty text${standingFor}: ${quotedPattern(compiled.source)} would insert the replacement where it matched no text`,
          );
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

const INPUT_DIR_PLACEHOLDER = "{FIXTURE_INPUT_DIR}";
// A character outside Latin-1, which makes the text that holds it one of two-byte characters.
const WIDE_CHARACTER = String.fromCharCode(0x100);

// A replace_regex pattern as normalize applies it: every {FIXTURE_INPUT_DIR} stands for the fixture's
// input directory, matched literally. The directory is put in by a function: given as a replacement
// string, a path holding $&, $` or $' is expanded by the replace call instead of inserted as it is.
// Exported for a unit test, since a path holding $` cannot be passed to a stub CLI through the shell.
export function rulePattern(pattern: string, fixtureInputDir: string): RegExp {
  return new RegExp(ruleSource(pattern, fixtureInputDir), "g");
}

// The text rulePattern compiles, which is also the text the engine repeats in its message for a pattern it will not compile.
function ruleSource(pattern: string, fixtureInputDir: string): string {
  const literalDir = fixtureInputDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return pattern.replaceAll(INPUT_DIR_PLACEHOLDER, () => literalDir);
}

// How many characters of a pattern a line that reports it quotes. The engine's message repeats the whole
// pattern, so a rule of 100,000 characters printed a line of as many.
const QUOTED_PATTERN_LENGTH = 200;

// A pattern as a line that reports it quotes it, with the g flag rulePattern gives it. One longer than
// QUOTED_PATTERN_LENGTH characters is cut there, without splitting a surrogate pair, and the line says how long it is.
function quotedPattern(source: string): string {
  if (source.length <= QUOTED_PATTERN_LENGTH) return `/${source}/g`;
  const end = /[\uD800-\uDBFF]/.test(source[QUOTED_PATTERN_LENGTH - 1]) ? QUOTED_PATTERN_LENGTH - 1 : QUOTED_PATTERN_LENGTH;
  return `/${source.slice(0, end)}…/g (the first ${end} of its ${source.length} characters)`;
}

// The engine's message for a pattern it will not compile, with the pattern it repeats quoted as quotedPattern quotes it.
function compileErrorMessage(err: Error, source: string): string {
  return err.message.replace(`/${source}/g`, () => quotedPattern(source));
}

// Whether a regular expression, given as the source of one compiled without the u or v flag (as
// rulePattern compiles it), can match empty text in some string: whether one of its alternatives holds
// no part that must match a character. An assertion (^, $, \b, \B or a lookaround) matches no character,
// so it counts as able to match empty text whatever it asserts, as \b does next to a word and (?=b)
// before a b; so does a backreference, which matches empty text where its group took no part. Each other
// part matches a character unless its quantifier allows it to repeat zero times.
//
// The groups are walked with a list of those open, not a call per group: the engine runs a pattern that
// nests 200,000 groups, and one that nested 3,000 overflowed the call stack here, which threw a RangeError
// out of the run before the remaining fixtures ran.
function canMatchEmpty(source: string): boolean {
  // Its last alternative matches the empty string, so this reports how many groups the source holds and
  // whether one is named, which decide what \1 and \k<name> are, without parsing the source for them.
  const groups = new RegExp(`(?:${source})|`).exec("") as RegExpExecArray;
  const groupCount = groups.length - 1;
  const named = groups.groups !== undefined;
  let i = 0;

  // For the innermost disjunction that is open, the whole source or a group's: whether an alternative that
  // has ended can match empty text, and whether the one being read still can. A group that opens keeps the
  // two for the disjunction around it, and whether it is a lookaround, until its ) is read.
  let ended = false;
  let current = true;
  const open: { lookaround: boolean; ended: boolean; current: boolean }[] = [];

  // Reads the quantifier after a part, if any, and records in current whether the part must match a
  // character: it must if it does whenever it matches, and its quantifier does not let it repeat zero
  // times. A { that does not open a quantifier is a character matched as itself.
  const quantified = (partEmpty: boolean): void => {
    const quantifier = /^(?:[*+?]|\{(\d+)(?:,\d*)?\})\??/.exec(source.slice(i));
    i += quantifier?.[0].length ?? 0;
    const least = quantifier === null || quantifier[0][0] === "+" ? 1 : quantifier[0][0] === "{" ? Number(quantifier[1]) : 0;
    if (least > 0 && !partEmpty) current = false;
  };

  // A part that is not a group: reads it and returns whether it can match empty text.
  const atom = (): boolean => {
    const c = source[i++];
    if (c === "^" || c === "$") return true;
    if (c === "\\") return escape();
    if (c === "[") {
      // A class matches one character. Without the v flag it holds no class, so it ends at the first ] not escaped.
      while (i < source.length && source[i] !== "]") i += source[i] === "\\" ? 2 : 1;
      i++;
      return false;
    }
    return false; // ., or a character matched as itself, such as a ] or } that closes nothing
  };

  // The part after a backslash: an assertion, a backreference or one character, whose escape may take
  // up to three octal digits, two hex digits after x, four after u and a letter after c.
  const escape = (): boolean => {
    const c = source[i++];
    if (c === "b" || c === "B") return true;
    if (/[1-9]/.test(c)) {
      // Without the u flag, \ and a number greater than the count of groups is an octal escape or the digit itself.
      const number = c + (/^\d*/.exec(source.slice(i)) as RegExpExecArray)[0];
      if (Number(number) <= groupCount) {
        i += number.length - 1;
        return true;
      }
    }
    if (c === "k" && named) {
      i = source.indexOf(">", i) + 1;
      return true;
    }
    if (c === "c" && !/[a-zA-Z]/.test(source[i] ?? "")) {
      i--; // a backslash matched as itself, followed by the c
      return false;
    }
    const tail = /[0-3]/.test(c) ? /^[0-7]{0,2}/ : /[4-7]/.test(c) ? /^[0-7]?/ : c === "x" ? /^(?:[\da-fA-F]{2})?/ : c === "u" ? /^(?:[\da-fA-F]{4})?/ : c === "c" ? /^./ : /^/;
    i += (tail.exec(source.slice(i)) as RegExpExecArray)[0].length;
    return false;
  };

  for (;;) {
    const c = source[i];
    if (c === undefined || c === ")") {
      // The innermost disjunction ends: the whole source's at its end, or a group's at its ).
      const empty = ended || current;
      const group = open.pop();
      if (group === undefined) return empty;
      i++;
      ({ ended, current } = group);
      quantified(group.lookaround || empty);
    } else if (c === "|") {
      i++;
      if (current) ended = true;
      current = true;
    } else if (c === "(") {
      i++;
      const head = /^\?(<?[=!]|<[^>]*>|[a-zA-Z]*(?:-[a-zA-Z]*)?:)/.exec(source.slice(i));
      i += head?.[0].length ?? 0;
      open.push({ lookaround: /^<?[=!]$/.test(head?.[1] ?? ""), ended, current });
      ended = false;
      current = true;
    } else {
      quantified(atom());
    }
  }
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

// A replace_regex pattern the engine would not compile when normalize ran it on an output. The load check
// compiles each pattern where the call stack is shallow. normalize builds the pattern again, and the
// engine can compile it again at the depth of the first string it reaches, once it has dropped the code
// it compiled before: a pattern near the engine's compile stack limit then throws "Stack overflow", a
// SyntaxError, which stopped the run before the remaining legs and fixtures ran.
class NormalizeRuleError extends Error {
  constructor(index: number, err: SyntaxError, source: string) {
    super(`normalize rule ${index + 1} (replace_regex) pattern could not be run on the output: ${compileErrorMessage(err, source)}`);
  }
}

function normalize(parsed: unknown, rules: FixtureContract["normalize"], fixtureInputDir: string): unknown {
  let out = structuredClone(parsed);
  for (const [i, rule] of rules.entries()) {
    if (rule.kind === "strip_key" && rule.path) {
      stripKey(out, rule.path);
    } else if (rule.kind === "replace_regex" && rule.pattern != null && rule.replacement != null) {
      const source = ruleSource(rule.pattern, fixtureInputDir);
      try {
        out = replaceInStrings(out, new RegExp(source, "g"), rule.replacement);
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        throw new NormalizeRuleError(i, err, source);
      }
    }
  }
  return out;
}

function applyIntentionalDrift(obj: unknown, cli: CLI): unknown {
  if (!driftModeOn(process.env.INTENTIONAL_DRIFT)) return obj;
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
// A key the participant's own golden also omits is absence on both sides, and #21 broke that: it
// read every absent must-match key as a wrong-shape document and turned hackmyagent main's required
// parity context red on ai-trust rows that had not changed. The check-registered-ai contract had
// recorded the case on 2026-06-10 as "absent == absent", when its ai-trust golden omitted
// `scanStatus`; that golden carries the key since #107.
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
// compared. One golden carrying the key is enough: a participant whose golden omits it is held to that
// omission by its own leg. With no golden yet there is nothing to resolve a key against, and each
// missing golden is reported on its own.
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
// recorded absence, and its own leg holds its output to it. A leg that failed before its own
// comparison has no `actual` and takes part with its golden.
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

// An error the operating system returned for a call, such as opening a file the harness may not read
// (EACCES) or looking up a symbolic link that dangles (ENOENT) or loops (ELOOP). Node names the call on
// each such error, so a TypeError from a mistake in the harness is not taken for one.
type SystemCallError = Error & { syscall: string; code?: string };
function isSystemCallError(err: unknown): err is SystemCallError {
  return err instanceof Error && typeof (err as { syscall?: unknown }).syscall === "string";
}

// The system's reason, as its code and the call that returned it: the message repeats the path, which
// the line that reports it has already named.
function systemCallReason(err: SystemCallError): string {
  return `${err.code ?? err.message} on ${err.syscall}`;
}

// A contract, golden, skip sentinel or capture that is a directory, a FIFO or a device, which the harness
// does not read or write.
class NotAFileError extends Error {
  constructor(stats: Stats) {
    super(stats.isDirectory() ? "a directory" : stats.isFIFO() ? "a FIFO" : "a device or socket");
  }
}

// The text of a contract, golden or skip sentinel, read only when it is a file: opening a FIFO waits for
// a program to write to it, so a golden that was one held the run, and reading a directory fails with
// EISDIR, which a contract and a skip sentinel threw out of the run. Its type is looked up first, which
// does not open it. Throws a NotAFileError for anything but a file, and the system's error for a path
// it cannot look up (a symbolic link that dangles or loops) or a file it cannot open or read.
function readTextFile(path: string): string {
  const stats = statSync(path);
  if (!stats.isFile()) throw new NotAFileError(stats);
  return readFileSync(path, "utf8");
}

// Writes a capture to a file, or to a path that names nothing yet. Opening a FIFO to write to it waits for
// a program to read from it, so a capture path that was one held the run before any later leg or fixture
// ran; its type is looked up first, as readTextFile does. Throws a NotAFileError for anything but a file,
// and the system's error for a path it cannot look up or a file it cannot open or write.
function writeTextFile(path: string, text: string): void {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats !== undefined && !stats.isFile()) throw new NotAFileError(stats);
  writeFileSync(path, text);
}

// Why a contract, golden or skip sentinel was not read: it is not a file, or the system would not open or read it.
type UnreadFileError = NotAFileError | SystemCallError;
function isUnreadFileError(err: unknown): err is UnreadFileError {
  return err instanceof NotAFileError || isSystemCallError(err);
}

// The end of the line that reports one, after the file's name and path.
function unreadFileReason(err: UnreadFileError): string {
  return err instanceof NotAFileError ? `is ${err.message}, not a file` : `could not be read (${systemCallReason(err)})`;
}

// Whether a path names an entry, a symbolic link that dangles or loops included: runFixture asks this of
// a golden. existsSync follows the link and reads such a golden as missing, so it was reported missing
// after its CLI had run instead of failing its leg as a golden that cannot be read does. A contract.yaml
// that was such a link was reported missing by runFixture, and its fixture was left out of the run.
function hasEntry(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// How runFixture reads a participant's golden. A unit test passes its own, since the RangeError a golden
// over the size limit throws cannot be produced with a committed fixture.
export type GoldenReader = (goldenPath: string) => unknown;
const readGoldenFile: GoldenReader = (goldenPath) => JSON.parse(readTextFile(goldenPath));

// Why a participant's golden could not be read: a size limit (a RangeError), JSON that does not parse
// (a SyntaxError), or a path that is not a file or that the operating system would not open or read.
type UnreadGoldenError = RangeError | SyntaxError | UnreadFileError;

// The line for a leg whose golden could not be read. A golden that is not valid JSON is named with its
// path and the parser's reason, one that is not a file with its path and what it is, and one the
// operating system would not open or read with its path and the system's reason; a RangeError is a
// size limit, reported as a comparison that hit one is.
function unreadGoldenReport(label: string, goldenPath: string, err: UnreadGoldenError): string {
  if (err instanceof SyntaxError) return `[FAIL] ${label}: the golden at ${goldenPath} is not valid JSON (SyntaxError: ${err.message})`;
  if (err instanceof RangeError) return comparisonFailureReport(label, err);
  return `[FAIL] ${label}: the golden at ${goldenPath} ${unreadFileReason(err)}`;
}

// A participant's command as its fixture runs it: every {BIN} stands for the command that runs the CLI
// and, in a kind: package-name fixture, every {PACKAGE} for the contract's package. A directory fixture
// has no package, and {PACKAGE} in its command stays as written. Both values are put in by a function,
// in one pass: given as replacement strings to one replace call each, they replaced only the first
// placeholder, a $&, $` or $' in a value was expanded instead of inserted as it is, and a {PACKAGE} in
// the CLI's own command was replaced too. Exported for a unit test, since the shell expands $` and $$
// before a stub CLI sees its arguments.
export function exerciseCommand(invocation: string, bin: string, packageName?: string): string {
  return invocation.replaceAll(/\{BIN\}|\{PACKAGE\}/g, (placeholder) => (placeholder === "{BIN}" ? bin : (packageName ?? placeholder)));
}

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

  // Every directory under fixtures/ is run, so one with no contract.yaml fails here by name. The entries
  // whose lower-cased name starts with "contract" (contract.yml, Contract.yaml) are named from a listing
  // of the directory, so the line says what it holds instead of guessing at a misspelling.
  if (!hasEntry(contractPath)) {
    let found: string[] = [];
    try {
      found = readdirSync(fixtureDir).filter((name) => name.toLowerCase().startsWith("contract"));
    } catch {
      // a directory that cannot be listed gets the line without them
    }
    const hint = found.length > 0 ? ` (found ${found.join(", ")}; the harness reads contract.yaml only)` : "";
    console.error(`[${fixtureName}] missing contract.yaml${hint}`);
    return 2;
  }
  // The parser throws on a syntax error, a second document, a repeated key and an alias to an anchor
  // that is not set. That fails this fixture, as a contract of the wrong type does, instead of
  // stopping the run before the remaining fixtures. The first line of the error names the place; the
  // lines after it quote the file. A contract.yaml that is not a file or cannot be opened (a symbolic
  // link that dangles or loops included) fails it too.
  let contractText: string;
  try {
    contractText = readTextFile(contractPath);
  } catch (err) {
    if (!isUnreadFileError(err)) throw err;
    console.error(`[${fixtureName}] contract.yaml ${unreadFileReason(err)}`);
    return 2;
  }
  let parsedContract: unknown;
  try {
    parsedContract = parseYaml(contractText);
  } catch (err) {
    const reason = (err as Error).message.split("\n")[0].replace(/:$/, "");
    console.error(`[${fixtureName}] contract.yaml is not one valid YAML document: ${reason}`);
    return 2;
  }
  // An empty contract.yaml parses to null, and one holding a list or a bare value has no field to read.
  if (parsedContract === null || typeof parsedContract !== "object" || Array.isArray(parsedContract)) {
    console.error(`[${fixtureName}] contract.yaml is not a mapping of contract fields (README.md "Contract model")`);
    return 2;
  }
  const contract = parsedContract as FixtureContract;
  // The checks after this one read kind, so a contract with a kind they cannot read stops here.
  const kindLines = kindProblems(contract);
  if (kindLines.length > 0) {
    for (const problem of kindLines) console.error(`[${fixtureName}] contract.yaml ${problem}`);
    return 2;
  }
  const kind: FixtureKind = contract.kind ?? "directory";

  if (kind === "directory" && !existsSync(inputDir)) {
    console.error(`[${fixtureName}] missing input/ directory (kind=directory)`);
    return 2;
  }
  if (kind === "package-name" && !contract.package) {
    console.error(`[${fixtureName}] kind=package-name requires 'package:' field`);
    return 2;
  }
  // What a replace_regex rule's {FIXTURE_INPUT_DIR} stands for: a kind: package-name fixture has no input directory.
  const fixtureInputDir = kind === "directory" ? inputDir : "";
  const contractProblems = [
    ...exercisesProblems(contract),
    ...participantsProblems(contract),
    ...mustMatchProblems(contract),
    ...mayDifferProblems(contract),
    ...normalizeProblems(contract, fixtureInputDir),
  ];
  if (contractProblems.length > 0) {
    for (const problem of contractProblems) console.error(`[${fixtureName}] contract.yaml ${problem}`);
    return 2;
  }

  const results: Record<string, ProbeResult> = {};
  let failures = 0;

  // Each participant's golden, read once: the probe, the shape check and the comparison all use it. A
  // golden that cannot be read fails that participant's leg below instead of the harness: one over a
  // size limit (a RangeError), one that is not valid JSON (a SyntaxError), one that is not a file (a
  // directory or a FIFO) and one the operating system would not open, such as a file without read
  // permission or a symbolic link that dangles or loops. Each of these but the link stopped the run
  // before the remaining legs and fixtures ran, or, for a FIFO, did not let it finish; the link was
  // reported as a missing golden after its CLI had run (see hasEntry).
  const goldens = new Map<CLI, unknown>();
  const unreadGoldens = new Map<CLI, UnreadGoldenError>();
  for (const cli of contract.participants) {
    const goldenPath = join(expectedDir, `${cli}.json`);
    if (!hasEntry(goldenPath)) continue;
    try {
      goldens.set(cli, readGolden(goldenPath));
    } catch (err) {
      if (!(err instanceof RangeError || err instanceof SyntaxError || isUnreadFileError(err))) throw err;
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
    // A golden that could not be read fails its leg here, without running the CLI.
    const unreadGolden = unreadGoldens.get(cli);
    if (unreadGolden) {
      console.error(`\n${unreadGoldenReport(`${fixtureName} × ${cli}`, join(expectedDir, `${cli}.json`), unreadGolden)}`);
      failures++;
      continue;
    }
    const cmd = exerciseCommand(invocation, bins[cli], kind === "package-name" ? contract.package : undefined);
    const positionalArg = kind === "package-name" ? null : inputDir;
    try {
      // The golden decides which error payloads are expected and which absences are shape failures;
      // a missing golden is reported below.
      const shapeGolden = goldens.get(cli);
      // Normalized inside the probe, so the expected-error decision sees what the golden was copied from.
      const fixtureNormalize = (doc: unknown) => normalize(doc, contract.normalize ?? [], fixtureInputDir);
      const { exitCode, stdout, stderr, parsed, parseOk, startFailure } = probeWithRetry(cmd, positionalArg, `${fixtureName} ${cli}`, shapeGolden, fixtureNormalize);
      // An output that is not JSON fails the leg. The report carries what the leg printed that says why:
      // for a command that could not start, the line sh or Node printed and the variable that holds the
      // command; otherwise stdout, or stderr where stdout is blank.
      if (!parseOk) {
        if (startFailure !== null) {
          console.error(`[${fixtureName}] ${cli} could not start (exit=${exitCode}): ${startFailure}`);
          console.error(`  ${BIN_VARS[cli]}="${bins[cli]}" is the command the harness ran through sh (README.md "Quickstart").`);
        } else if (stdout.trim() !== "") {
          console.error(`[${fixtureName}] ${cli} produced non-JSON output (exit=${exitCode}). First 400 chars:\n${stdout.slice(0, 400)}`);
        } else if (stderr.trim() !== "") {
          console.error(`[${fixtureName}] ${cli} produced no output on stdout (exit=${exitCode}). stderr (first 400 chars):\n${stderr.slice(0, 400)}`);
        } else {
          console.error(`[${fixtureName}] ${cli} produced no output on stdout or stderr (exit=${exitCode}).`);
        }
        failures++;
        continue;
      }
      const parsedVal = applyIntentionalDrift(parsed, cli);

      const actualPath = join(dirs.actual, fixtureName, `${cli}.json`);
      const capture = stableStringify(parsedVal);
      // A capture that cannot be written, such as one whose path is a directory or whose fixture's directory
      // under actual/ is a file, fails its leg instead of stopping the run, and so does one whose path is a
      // FIFO, which held the run, or a device, which took the capture; the catch below rethrows any error
      // but a RangeError and a NormalizeRuleError.
      try {
        mkdirSync(dirname(actualPath), { recursive: true });
        writeTextFile(actualPath, capture);
      } catch (err) {
        if (err instanceof NotAFileError) {
          console.error(`\n[FAIL] ${fixtureName} × ${cli}: the capture at ${actualPath} is ${err.message}, not a file`);
        } else if (isSystemCallError(err)) {
          console.error(`\n[FAIL] ${fixtureName} × ${cli}: the capture could not be written at ${actualPath} (${systemCallReason(err)})`);
        } else {
          throw err;
        }
        failures++;
        continue;
      }

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
      // A pattern normalize could not run on the output fails its leg, as a payload that cannot be compared does.
      if (err instanceof NormalizeRuleError) console.error(`\n[FAIL] ${fixtureName} × ${cli}: ${err.message}`);
      else if (err instanceof RangeError) console.error(`\n${comparisonFailureReport(`${fixtureName} × ${cli}`, err)}`);
      else throw err;
      failures++;
    }
  }

  const legs: { cli: CLI; golden: unknown; actual?: unknown }[] = [];
  for (const cli of contract.participants) {
    const goldenPath = join(expectedDir, `${cli}.json`);
    if (!hasEntry(goldenPath)) {
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
      // Where every golden was read, a key in no golden is named as such on every leg's line, the
      // keyless one's included, so the keys called "not in its golden" are only those another golden
      // carries. Where a golden could not be read, no key is called "in no golden", since that golden
      // may carry it: the keyless leg's line then calls every must-match key "not in its golden",
      // including one that no golden that was read carries.
      const keylessGolden = keyless.includes(cli);
      const uncompared = [
        ...(keylessGolden ? [`${mustMatch.join(", ")} (not in its golden)`] : []),
        ...(unresolved.length > 0 ? [`${unresolved.join(", ")} (in no golden)`] : []),
      ];
      const notCompared = uncompared.length > 0 ? `; not compared: ${uncompared.join("; ")}` : "";
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
    // A sentinel that is not a file or cannot be opened fails the fixture, as an empty one does, instead of stopping the run.
    let skipReason: string | null = null;
    try {
      if (existsSync(skipPath)) skipReason = readTextFile(skipPath).trim();
    } catch (err) {
      if (!isUnreadFileError(err)) throw err;
      console.error(`\n[FAIL] ${fixtureName} × ${cli}: the skip sentinel at ${skipPath} ${unreadFileReason(err)}`);
      console.error(`  Make expected/${cli}.skip a file that says why ${cli} does not exercise this fixture (README.md "Contract model").`);
      failures++;
      continue;
    }
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

// The fixtures `npm run parity` runs: every entry of fixturesDir that is a directory or a symbolic link
// that resolves to one, in the order readdirSync gives them, whether or not it holds a contract.yaml.
// runFixture fails one without a contract.yaml by name, and the summary counts it. Selecting on the
// contract left a fixture whose contract.yaml was deleted or renamed out of the run without a line, and
// the summary counted one fixture fewer. An entry that is not a directory (a plain file, a symbolic link
// that dangles or loops) is not a fixture.
export function fixtureNames(fixturesDir: string): string[] {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => {
      if (entry.isDirectory()) return true;
      if (!entry.isSymbolicLink()) return false;
      try {
        return statSync(join(fixturesDir, entry.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name);
}

function main() {
  // The header line comes first on every path, --help, --version and an unexpected argument included,
  // so no run exits 0 without it. The arguments are read before the variable check: --help answers with
  // the variables unset, and an unexpected argument is reported instead of being ignored while the whole
  // gate runs.
  console.log("opena2a-parity harness");
  const request = cliRequest(process.argv.slice(2));
  if (request.kind === "help") {
    console.log(USAGE);
    process.exit(0);
  }
  if (request.kind === "version") {
    console.log(harnessVersion());
    process.exit(0);
  }
  if (request.kind === "unknown") {
    console.error(`unexpected argument: ${request.argument}`);
    console.error("the harness takes no argument other than --help, -h and --version; --help prints the usage");
    process.exit(2);
  }

  console.log(`  fixtures dir: ${FIXTURES_DIR}`);
  console.log(`  drift mode:   ${driftModeOn(process.env.INTENTIONAL_DRIFT) ? "ON (expect fail)" : "off"}`);

  const missing = missingBinMessages(process.env);
  if (missing.length > 0) {
    for (const line of missing) console.error(line);
    process.exit(2);
  }
  const bins = Object.fromEntries(
    Object.entries(BIN_VARS).map(([cli, name]) => [cli, binCommand(process.env[name]) as string]),
  ) as Record<CLI, string>;

  const fixtures = fixtureNames(FIXTURES_DIR);

  if (fixtures.length === 0) {
    console.error("no fixtures found");
    process.exit(2);
  }

  const failedFixtures = runFixtures(fixtures, bins);

  console.log(`\n${fixtures.length} fixture(s) run, ${failedFixtures} fixture failure(s)`);
  process.exit(failedFixtures === 0 ? 0 : 1);
}

// Whether this module is the script node was started with: both paths resolved through symbolic
// links and the URL decoded before they are compared. node resolves the entry's links into
// import.meta.url and percent-encodes it, while process.argv[1] keeps the path as typed, so an
// unresolved comparison was false through a link or from a path holding a space, and the gate
// exited 0 having run nothing.
function isEntryModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntryModule()) main();
