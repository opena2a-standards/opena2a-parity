# HMA Test Fixtures

Intentionally vulnerable agent project for manual testing of all HackMyAgent
CLI commands. Every file here is designed to trigger specific detections.

## Quick Reference

```bash
CLI="node /Users/ecolibria/workspace/opena2a-org/hackmyagent/dist/cli.js"
DIR="/Users/ecolibria/workspace/opena2a-org/test/hma"

# --- Hardening Scanner (147+ checks) ---
$CLI secure $DIR
$CLI secure $DIR --verbose
$CLI secure $DIR --json
$CLI secure $DIR --format html --output /tmp/hma-report.html
$CLI secure $DIR --benchmark oasb-1
$CLI secure $DIR --benchmark oasb-1 --level L1
$CLI secure $DIR --deep

# --- Soul Governance Scanner (68 controls) ---
$CLI scan-soul $DIR
$CLI scan-soul $DIR --verbose
$CLI scan-soul $DIR --profile conversational
$CLI scan-soul $DIR --profile orchestrator --tier MULTI-AGENT
$CLI scan-soul $DIR --json
$CLI harden-soul $DIR --dry-run
$CLI harden-soul $DIR --dry-run --profile tool-agent

# --- OpenClaw Scanner ---
$CLI secure-openclaw $DIR
$CLI secure-openclaw $DIR --verbose

# --- Plugin Auto-Fix ---
$CLI fix-all $DIR --dry-run
$CLI fix-all $DIR --scan-only

# --- Attack Simulation ---
$CLI attack --local $DIR
$CLI attack --local $DIR --category prompt-injection
$CLI attack --local $DIR --category jailbreak
$CLI attack --local $DIR --category data-exfiltration
$CLI attack --local $DIR --intensity aggressive

# --- Skill Check ---
$CLI check @fake-publisher/deploy-helper
```

## What Each File Triggers

### Credentials (CRED-*)
| File | Check IDs |
|------|-----------|
| `.env` | CRED-001 (Anthropic, OpenAI, AWS, GitHub, Stripe keys) |
| `.env.local` | CRED-001 (Anthropic, Slack, Google, SendGrid keys) |
| `config.json` | CRED-001 (API keys in config) |
| `config.yaml` | CRED-001 (connection strings with passwords) |
| `fake-private.key` | CRED-002 (private key file) |
| `fake-cert.pem` | CRED-002 (certificate file) |
| `package.json` | CRED-003 (secrets in package.json -- none currently) |

### Claude Code (CLAUDE-*)
| File | Check IDs |
|------|-----------|
| `CLAUDE.md` | CLAUDE-001 (credential in CLAUDE.md), CLAUDE-006 (sensitive instructions) |
| `.claude/settings.json` | CLAUDE-002 (overly permissive), CLAUDE-003 (Bash(*)), CLAUDE-004 (no deny rules), CLAUDE-005 (memory with secrets) |

### MCP Configuration (MCP-*)
| File | Check IDs |
|------|-----------|
| `mcp.json` | MCP-001 (root fs), MCP-002 (shell server), MCP-003 (env secrets), MCP-005 (wildcard tools), MCP-008 (0.0.0.0), MCP-009 (execute/shell names) |
| `.cursor/mcp.json` | MCP-001 (home dir ~), MCP-003 (env secret) |
| `.vscode/mcp.json` | VSCODE-001 (credential), VSCODE-002 (root access /Users) |

### Prompt/Instruction Security (PROMPT-*)
| File | Check IDs |
|------|-----------|
| `CLAUDE.md` | PROMPT-001 (no boundaries), PROMPT-002 (no injection defense), PROMPT-003 (no output confidentiality), PROMPT-004 (no role definition) |
| `.cursorrules` | PROMPT-* (exfiltration pattern, no security terms) |
| `.clinerules` | PROMPT-* (exfiltration pattern) |
| `.windsurfrules` | PROMPT-* (permissive patterns) |
| `.github/copilot-instructions.md` | PROMPT-* (exfiltration, permissive) |
| `instructions.md` | PROMPT-* (no restrictions declared) |
| `constitution.md` | PROMPT-* (no safety boundaries) |

### Git (GIT-*)
| Missing | Check IDs |
|---------|-----------|
| No `.gitignore` | GIT-001, GIT-002, GIT-003 |

### Network (NET-*)
| File | Check IDs |
|------|-----------|
| `config.json` | NET-001 (0.0.0.0), NET-004 (/debug, /admin, /metrics) |
| `server.js` | NET-001 (0.0.0.0), NET-004 (debug/admin endpoints), NET-005 (WebSocket no auth) |

### Dependencies (DEP-*)
| File | Check IDs |
|------|-----------|
| `package.json` | DEP-001 (no lock file), DEP-003 (wildcard/latest versions), DEP-004 (dangerous scripts: curl|sh) |

### Process/Container (PROC-*)
| File | Check IDs |
|------|-----------|
| `Dockerfile` | PROC-001 (runs as root, no USER directive) |

### Skills (SKILL-*)
| File | Check IDs |
|------|-----------|
| `SKILL.md` | SKILL-001 (unsigned), SKILL-002 (curl|sh), SKILL-003 (heartbeat/cron), SKILL-004 (fs:~/), SKILL-005 (~/.ssh, ~/.aws, wallet.json), SKILL-006 (webhook.site, requestbin, ngrok), SKILL-008 (reverse shell) |
| `analytics.skill.md` | SKILL-001 (unsigned), SKILL-002 (wget|sh), SKILL-004 (fs:*), SKILL-006 (webhook.site) |
| `deploy.skill.md` | SKILL-001 (unsigned), SKILL-002 (wget|sh), SKILL-004 (fs:/), SKILL-005 (~/.kube), SKILL-006 (ngrok) |

### OpenClaw Config (CONFIG-*)
| File | Check IDs |
|------|-----------|
| `openclaw.json` | CONFIG-001 (secret exposure), CONFIG-* (auto approval, sandbox off) |
| `.openclaw/config.json` | CONFIG-001 (secrets), CONFIG-* (auto approval, sandbox off, unsigned skills) |

### Heartbeat (HEARTBEAT-*)
| File | Check IDs |
|------|-----------|
| `HEARTBEAT.md` | HEARTBEAT-001 (endpoint exposed), HEARTBEAT-002 (no auth), HEARTBEAT-* |

### Soul Governance (SOUL-*)
| File | Check IDs |
|------|-----------|
| `SOUL.md` | Minimal coverage -- only partial Trust Hierarchy and Injection Hardening. Missing 6 of 8 domains. |
| `system-prompt.md` | Triggers MULTI-AGENT tier detection (orchestrator, sub-agent, autonomous, loop) |
| `agent-config.yaml` | Multi-agent orchestration config with no safety limits |

### Server Vulnerabilities (IO-*, API-*, AUTH-*)
| File | Check IDs |
|------|-----------|
| `server.js` | IO-002 (SQL injection), IO-004 (path traversal), IO-001 (upload no validation), API-003 (key in query), AUTH-001 (no auth lib), NET-005 (WebSocket no auth) |

### Environment (ENV-*)
| File | Check IDs |
|------|-----------|
| `config.json` | ENV-001 (development mode), ENV-002 (debug: true), ENV-003 (verbose_errors) |
