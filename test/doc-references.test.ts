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
// Further hyphen or dot numbers belong to the same identifier, so CVE-2024-3094 and TLS-1.3 match whole.
const TICKET_ID = /\b[A-Z][A-Z0-9]*-\d+(?:[.-]\d+)*\b/g;
// A milestone code followed by a chip tier, "chip" or "score" is an Apple silicon chip (M4 Max) or the F1 score.
// The word may follow one hyphen or any run of spaces, start upper- or lower-case, and be plural.
const MILESTONE_CODE = /\b[MF]\d+\b(?!(?: +|-)(?:[Pp]ros?|[Mm]ax(?:es)?|[Uu]ltras?|[Cc]hips?|[Ss]cores?)\b)/g;

// Public identifiers a reader can look up by their number: CVE and CWE entries, ISO, RFC and IEEE standards.
const STANDARD_IDENTIFIER = /^(?:CVE-\d{4}-\d{4,}|CWE-\d+|ISO-\d+(?:-\d+)*|RFC-\d+|IEEE-\d+(?:\.\d+)*)$/;

// Public technical names that share a ticket key's shape: character encodings, hash, cipher and key
// sizes, elliptic curves, checksums, protocol versions, codecs and the certificate standard.
const WELL_KNOWN_TICKET_SHAPED = new Set([
  "UTF-7", "UTF-8", "UTF-16", "UTF-32",
  "SHA-1", "SHA-2", "SHA-3", "SHA-224", "SHA-256", "SHA-384", "SHA-512", "SHA3-224", "SHA3-256", "SHA3-384", "SHA3-512",
  "AES-128", "AES-192", "AES-256", "RSA-1024", "RSA-2048", "RSA-3072", "RSA-4096",
  "P-256", "P-384", "P-521", "CRC-32",
  "HTTP-2", "HTTP-3", "TLS-1.0", "TLS-1.1", "TLS-1.2", "TLS-1.3", "H-264", "H-265", "X-509",
]);

// An issue or pull request in another repository is cited as `<repo>#<number>`. A test cannot open
// GitHub, so each such citation must be one listed here, opened on GitHub and found to be the issue
// or pull request its sentence describes. A "(#123)" in a pull request title can be a number in
// another repository, so open the cited number itself before listing it.
export const CHECKED_ISSUE_REFERENCES = new Set(["ai-trust#61", "ai-trust#105", "hackmyagent#751", "hackmyagent#756"]);
// The repository name ends in a letter or digit, so "pre-#458" is not read as a repository called "pre-".
const ISSUE_REFERENCE = /(?<![\w.-])[A-Za-z](?:[\w.-]*[A-Za-z0-9])?#\d+\b/g;

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
    if (!checkIds.has(m[0]) && !WELL_KNOWN_TICKET_SHAPED.has(m[0]) && !STANDARD_IDENTIFIER.test(m[0])) found.push(`ticket-style identifier: ${m[0]}`);
  }
  for (const m of withoutLinks.matchAll(MILESTONE_CODE)) found.push(`milestone or finding code: ${m[0]}`);
  for (const m of withoutLinks.matchAll(ISSUE_REFERENCE)) {
    if (!CHECKED_ISSUE_REFERENCES.has(m[0])) found.push(`issue reference not in CHECKED_ISSUE_REFERENCES: ${m[0]}`);
  }
  return found;
}

// README.md and the pages it moved its reference text to: CONTRIBUTING.md and docs/*.md.
function documentPages(): string[] {
  const docs = readdirSync(join(repoRoot, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(repoRoot, "docs", name));
  return [join(repoRoot, "README.md"), join(repoRoot, "CONTRIBUTING.md"), ...docs];
}

function citingFiles(): string[] {
  const contracts = readdirSync(join(repoRoot, "fixtures"))
    .map((fixture) => join(repoRoot, "fixtures", fixture, "contract.yaml"))
    .filter((path) => existsSync(path));
  return [...documentPages(), ...contracts];
}

test("README.md, the pages it links and every fixture contract cite only what a reader of this repository can open", () => {
  const checkIds = goldenCheckIds();
  const files = citingFiles();
  assert.ok(files.length > 1, "expected README.md and at least one fixtures/*/contract.yaml");
  const problems = files.flatMap((file) =>
    unreadableCitations(readFileSync(file, "utf8"), file, checkIds).map((p) => `${relative(repoRoot, file)}: ${p}`),
  );
  assert.deepEqual(
    problems,
    [],
    "Replace each with a sentence that stands on its own, a document inside this repository, or a link to a public issue. " +
      "An issue reference that is the issue or pull request its sentence describes on GitHub can instead be added to CHECKED_ISSUE_REFERENCES.",
  );
});

test("an issue reference in another repository is reported unless it is in CHECKED_ISSUE_REFERENCES", () => {
  const readme = join(repoRoot, "README.md");
  assert.deepEqual(unreadableCitations("Left out of that output (ai-trust#61, ai-trust#191).", readme, new Set()), [
    "issue reference not in CHECKED_ISSUE_REFERENCES: ai-trust#191",
  ]);
  assert.deepEqual(unreadableCitations("Since hackmyagent#756 (issue hackmyagent#751) and ai-trust#105.", readme, new Set()), []);
  // a hyphen before the number, a bare number and a link fragment are not references to another repository
  assert.deepEqual(
    unreadableCitations("The pre-#458 output, #756 and https://github.com/opena2a-org/ai-trust/issues/191#issue-1.", readme, new Set()),
    [],
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
      "UTF-16, ISO-8859-1, SHA-1, SHA3-512, AES-256, RSA-4096, P-384 and CRC-32 on an M1 Pro, an M2 Ultra or the M3 chip, with an F1 score, an F1 Score and an F1-score.",
      readme,
      new Set(),
    ),
    [],
  );
  // plurals, lower-case tier and score words, and more than one space before them
  assert.deepEqual(
    unreadableCitations("F1 scores, M1 pro, M3 ultra, M4  Max, M2 Pros, M1 Maxes, M3 chips and an M4-max.", readme, new Set()),
    [],
  );
  // the same shapes still report when nothing marks them as a technical name
  assert.deepEqual(unreadableCitations("Blocked on UTF-9 until M4 ships (F2).", readme, new Set()), [
    "ticket-style identifier: UTF-9",
    "milestone or finding code: M4",
    "milestone or finding code: F2",
  ]);
  // a chip tier counts only as a whole word, so M4 Maxwell is still a code
  assert.deepEqual(unreadableCitations("M4 Maxwell", readme, new Set()), ["milestone or finding code: M4"]);
});

test("CVE, CWE, ISO, RFC and IEEE identifiers and common protocol, codec and certificate names are not citations", () => {
  const readme = join(repoRoot, "README.md");
  for (const name of [
    "CVE-2024-3094", "CVE-2021-44228", "CWE-79", "ISO-8601", "ISO-27001", "ISO-8859-1", "RFC-8259", "IEEE-754", "IEEE-802.11",
    "UTF-7", "SHA-2", "SHA-3", "RSA-1024", "X-509", "HTTP-2", "HTTP-3",
    "TLS-1.0", "TLS-1.1", "TLS-1.2", "TLS-1.3", "H-264", "H-265",
  ]) {
    assert.deepEqual(unreadableCitations(`Defined in ${name}.`, readme, new Set()), [], name);
  }
  assert.deepEqual(
    unreadableCitations(
      "ISO-8601, ISO-27001, CVE-2024-3094, RFC-8259, IEEE-754, X-509, HTTP-2, SHA-3, UTF-7, RSA-1024, TLS-1.3, H-264",
      readme,
      new Set(),
    ),
    [],
  );
  // an identifier that only resembles a standard shape is still reported, and reported whole
  assert.deepEqual(unreadableCitations("Blocked on CVE-2024, TLS-1.4 and TEAM-2024-17.", readme, new Set()), [
    "ticket-style identifier: CVE-2024",
    "ticket-style identifier: TLS-1.4",
    "ticket-style identifier: TEAM-2024-17",
  ]);
});

// A red parity leg blocks a PR only in a CLI repository that lists `parity / parity` as a required
// status check on `main`; anywhere else the PR shows a failing check and can still be merged. So a
// README sentence that says the harness fails or blocks a PR must say where it blocks.
export function unconditionalBlockClaims(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=\.)\s+/)
    .filter((sentence) => /\b(?:fails?|block(?:s|ed|ing)?)\b.*\bPRs?\b|\bPRs?\b.*\bblock/.test(sentence))
    .filter((sentence) => !(sentence.includes("`parity / parity`") && /\brequire/.test(sentence)));
}

test("README.md and the pages it links say a parity failure blocks a PR only where `parity / parity` is a required check", () => {
  for (const page of documentPages()) {
    assert.deepEqual(
      unconditionalBlockClaims(readFileSync(page, "utf8")),
      [],
      `${relative(repoRoot, page)}: Say the PR gets a failing check, and that it is blocked only where \`parity / parity\` is required.`,
    );
  }
});

test("a sentence that fails or blocks a PR unconditionally is reported; one that names the required check is not", () => {
  assert.deepEqual(unconditionalBlockClaims("The harness fails the PR if output drifts. Open a PR; CI runs the harness."), [
    "The harness fails the PR if output drifts.",
  ]);
  assert.deepEqual(unconditionalBlockClaims("Drift blocks the CLI PR."), ["Drift blocks the CLI PR."]);
  assert.deepEqual(unconditionalBlockClaims("A PR is blocked on drift."), ["A PR is blocked on drift."]);
  assert.deepEqual(
    unconditionalBlockClaims(
      "A repo that requires `parity / parity` blocks its CLI PR on a red leg. Re-run the PR's failed job. " +
        "A unit test that fails on `main` turns the leg red.",
    ),
    [],
  );
});
