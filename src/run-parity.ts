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

type FixtureContract = {
  description: string;
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

function runCli(invocation: string, fixtureInputDir: string): { exitCode: number; stdout: string } {
  try {
    const stdout = execSync(`${invocation} "${fixtureInputDir}"`, {
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

  if (!existsSync(inputDir)) {
    console.error(`[${fixtureName}] missing input/ directory`);
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
    const cmd = invocation.replace("{BIN}", bin);
    const { exitCode, stdout } = runCli(cmd, inputDir);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      console.error(`[${fixtureName}] ${cli} produced non-JSON output (exit=${exitCode}). First 400 chars:\n${stdout.slice(0, 400)}`);
      failures++;
      continue;
    }
    parsed = normalize(parsed, contract.normalize ?? [], inputDir);
    parsed = applyIntentionalDrift(parsed, cli);

    const actualPath = join(ACTUAL_DIR, fixtureName, `${cli}.json`);
    writeFileSync(actualPath, stableStringify(parsed));

    results[cli] = { cli, exitCode, stdout, parsed };
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

main();
