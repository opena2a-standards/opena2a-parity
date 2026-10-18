# Scanning this repository

The fixture inputs are deliberately insecure test data, so a `hackmyagent secure` scan of
the repository root reports their findings. One of them is accepted for this repository:
GIT-002 lists files under `fixtures/secure-dirty-skill/input/` as committable sensitive files.
They must stay tracked for the fixture to mean anything, which is why the root `.gitignore`
ignores `.env`, `secrets.json`, `*.pem` and `*.key` and then re-includes paths under
`fixtures/`, so those four rules do not apply there. Any GIT-002 file outside `fixtures/` is a
real finding.
