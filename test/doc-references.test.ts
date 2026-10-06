import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// README.md and the fixture contracts are read by people outside this repository, so everything they
// cite must be something that reader can open: a document inside this repository, a public link, or
// a check ID that a committed golden names. A planning note on a contributor's disk, a ticket key or
// a milestone code defined elsewhere is none of those, and two cleanups have removed them already.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const DOCUMENT_PATH = /[\w./~-]+\.(?:md|mdx|markdown|rst|adoc|txt|pdf|docx?)(?![\w])/g;
const TICKET_ID = /\b[A-Z][A-Z0-9]*-\d+\b/g;
// A milestone code followed by a chip tier, "chip" or "score" is an Apple silicon chip (M4 Max) or the F1 score.
const MILESTONE_CODE = /\b[MF]\d+\b(?![ -](?:Pro|Max|Ultra|chip|[Ss]core)\b)/g;

// Public technical names that share a ticket key's shape: character encodings, hash, cipher and key
// sizes, elliptic curves and checksums. ISO-8859-1 matches as ISO-8859.
const WELL_KNOWN_TICKET_SHAPED = new Set([
  "UTF-8", "UTF-16", "UTF-32", "ISO-8859",
  "SHA-1", "SHA-224", "SHA-256", "SHA-384", "SHA-512", "SHA3-224", "SHA3-256", "SHA3-384", "SHA3-512",
  "AES-128", "AES-192", "AES-256", "RSA-2048", "RSA-3072", "RSA-4096",
  "P-256", "P-384", "P-521", "CRC-32",
]);

// A document path resolves when it names a file inside the repository, relative to the repository
// root or to the citing file. A fixture contract describes its own input/, so that is tried too.
function resolvesInsideRepo(cited: string, citingFile: string): boolean {
  const base = dirname(citingFile);
  return [resolve(repoRoot, cited), resolve(base, cited), resolve(base, "input", cited)].some((candidate) => {
    const rel = relative(repoRoot, candidate);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && existsSync(candidate);
  });
}

// The check IDs the committed goldens name. A contract or the README citing one of these names a
// check the reader can see in the fixture's expected output.
export function goldenCheckIds(): Set<string> {
  const ids = new Set<string>();
  for (const fixture of readdirSync(join(repoRoot, "fixtures"))) {
    const expected = join(repoRoot, "fixtures", fixture, "expected");
    if (!existsSync(expected)) continue;
    for (const name of readdirSync(expected).filter((n) => n.endsWith(".json"))) {
      for (const m of readFileSync(join(expected, name), "utf8").matchAll(/"checkId"\s*:\s*"([^"]+)"/g)) ids.add(m[1]);
    }
  }
  return ids;
}

export function unreadableCitations(text: string, citingFile: string, checkIds: Set<string>): string[] {
  const found: string[] = [];
  const withoutLinks = text.replace(/\bhttps?:\/\/\S+/g, "");
  for (const m of withoutLinks.matchAll(DOCUMENT_PATH)) {
    if (!resolvesInsideRepo(m[0], citingFile)) found.push(`document path that does not resolve inside the repository: ${m[0]}`);
  }
  for (const m of withoutLinks.matchAll(TICKET_ID)) {
    if (!checkIds.has(m[0]) && !WELL_KNOWN_TICKET_SHAPED.has(m[0])) found.push(`ticket-style identifier: ${m[0]}`);
  }
  for (const m of withoutLinks.matchAll(MILESTONE_CODE)) found.push(`milestone or finding code: ${m[0]}`);
  return found;
}

function citingFiles(): string[] {
  const contracts = readdirSync(join(repoRoot, "fixtures"))
    .map((fixture) => join(repoRoot, "fixtures", fixture, "contract.yaml"))
    .filter((path) => existsSync(path));
  return [join(repoRoot, "README.md"), ...contracts];
}

test("README.md and every fixture contract cite only what a reader of this repository can open", () => {
  const checkIds = goldenCheckIds();
  const files = citingFiles();
  assert.ok(files.length > 1, "expected README.md and at least one fixtures/*/contract.yaml");
  const problems = files.flatMap((file) =>
    unreadableCitations(readFileSync(file, "utf8"), file, checkIds).map((p) => `${relative(repoRoot, file)}: ${p}`),
  );
  assert.deepEqual(
    problems,
    [],
    "Replace each with a sentence that stands on its own, a document inside this repository, or a link to a public issue.",
  );
});

test("a planning-note path, a ticket key and a milestone code are reported; repository paths and golden check IDs are not", () => {
  const readme = join(repoRoot, "README.md");
  const checkIds = new Set(["GIT-002"]);
  assert.deepEqual(unreadableCitations("See briefs/some-plan.md and [TEAM-012].", readme, checkIds), [
    "document path that does not resolve inside the repository: briefs/some-plan.md",
    "ticket-style identifier: TEAM-012",
  ]);
  assert.deepEqual(unreadableCitations("Tracked for M3/M4 (F1 fix).", readme, checkIds), [
    "milestone or finding code: M3",
    "milestone or finding code: M4",
    "milestone or finding code: F1",
  ]);
  assert.deepEqual(unreadableCitations("Notes in ~/notes/plan.md and /home/someone/plan.md.", readme, checkIds), [
    "document path that does not resolve inside the repository: ~/notes/plan.md",
    "document path that does not resolve inside the repository: /home/someone/plan.md",
  ]);
  assert.deepEqual(
    unreadableCitations("README.md, GIT-002 and https://github.com/opena2a-org/opena2a-parity/blob/main/PLAN.md are fine.", readme, checkIds),
    [],
  );
  // a fixture contract may name a file in its own input/ directory
  const contract = join(repoRoot, "fixtures", "scan-soul-hardened", "contract.yaml");
  assert.deepEqual(unreadableCitations("The hardened SOUL.md fixture.", contract, checkIds), []);
});

test("encodings, hash and cipher sizes, curves, chip names and the F1 score are not citations", () => {
  const readme = join(repoRoot, "README.md");
  assert.deepEqual(unreadableCitations("Encoded as UTF-8 with SHA-256 on an M4 Max.", readme, new Set()), []);
  assert.deepEqual(
    unreadableCitations(
      "UTF-16, ISO-8859-1, SHA-1, SHA3-512, AES-256, RSA-4096, P-384 and CRC-32 on an M1 Pro, an M2 Ultra or the M3 chip, with an F1 score and an F1-score.",
      readme,
      new Set(),
    ),
    [],
  );
  // the same shapes still report when nothing marks them as a technical name
  assert.deepEqual(unreadableCitations("Blocked on UTF-9 until M4 ships (F2).", readme, new Set()), [
    "ticket-style identifier: UTF-9",
    "milestone or finding code: M4",
    "milestone or finding code: F2",
  ]);
});
