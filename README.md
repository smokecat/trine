# trine

[![CI](https://github.com/smokecat/trine/actions/workflows/ci.yml/badge.svg)](https://github.com/smokecat/trine/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A self-hosted remote interface for Claude Code. Continue sessions from your phone
or another browser, inspect tool activity, and respond to permission requests while
the agent runs on your own computer.

[简体中文](README.zh-CN.md) · [Deployment](apps/server/deploy/README.md) ·
[Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

## What it does

- Streams assistant messages, tool activity and subagent history.
- Lists, resumes, renames and archives sessions across paired machines.
- Relays tool approval requests and interactive questions to your browser.
- Pairs devices with a QR code or text payload and a manually verified short authentication code.
- Encrypts session payloads between the browser and agent; the relay stores ciphertext and routing metadata.
- Optionally sends generic activity notifications through Bark.

**Status:** an early, single-owner self-hosted project. The UI is currently in
Chinese. macOS agent development and a Linux relay are the primary targets;
Windows is not validated. This is not a multi-tenant service or an official
Anthropic product. There is no hosted service or prebuilt installer.

## Requirements

- [Bun](https://bun.sh/) **1.3.11** (the pinned test baseline).
- A working [Claude Code](https://code.claude.com/docs/en/overview) installation
  and your own authorized authentication. Model access and billing are supplied
  by Anthropic or your configured provider, not by trine.
- A current browser. Remote access requires HTTPS/WSS; local development uses loopback HTTP.

The agent uses Claude Agent SDK 0.3.251 and prefers `claude` on your PATH. The SDK
has separate terms and may install its own CLI fallback. Set `--claude-bin` to
select an executable. See [third-party notices](THIRD_PARTY_NOTICES.md).

## Run locally

```bash
git clone https://github.com/smokecat/trine.git
cd trine
bun install --frozen-lockfile
mkdir -p .dev
```

Run these commands in **three terminals**, each from the repository root:

```bash
# 1. Relay: listen on loopback and keep test state separate from your real agent.
TRINE_DB=.dev/relay.sqlite bun run dev:server
```

```bash
# 2. Web UI and same-origin API proxy.
bun run dev:web
```

```bash
# 3. Issue a short-lived invitation, then paste it at the agent's hidden prompt.
# Only the invite command prints the secret; keep this terminal private.
bun run agent:invite create --db .dev/relay.sqlite
# Choose a model your Claude account can access.
TRINE_DEFAULT_MODEL=sonnet bun run dev:agent --   --server http://localhost:5173 --home .dev/agent --enroll --pair
```

Open <http://localhost:5173>, paste the pairing payload, compare the codes on both
devices, and approve in the agent terminal **only if they match**. Keep that
terminal interactive. Use exactly the same hostname for the browser and agent;
`localhost` and `127.0.0.1` are different browser origins.

The development agent can still operate your real Claude workspaces. The separate
`.dev/agent` directory isolates trine identity/state, not Claude Code permissions
or history. Start with a disposable project and review permission requests.

For a phone or an Internet-facing relay, follow the [deployment guide](apps/server/deploy/README.md).
First and additional agents use the same one-time invitation flow; no registration
window or relay restart is needed. Keep the same `--home` and omit `--enroll` on
subsequent starts. Browser pairing still requires manual confirmation.
See [enrollment and recovery](apps/server/deploy/README.md#4-enroll-the-first-agent-and-pair-a-browser).

## Architecture

```text
Browser ── HTTPS / WebSocket ── Relay ── outbound WebSocket ── Agent ── Claude Code
   └──────────── encrypted application payloads ───────────────┘
```

| Package | Responsibility |
| --- | --- |
| `packages/core` | Types, Zod protocol schemas, crypto and authentication client |
| `apps/agent` | Claude SDK bridge, local session management, pairing and outbound connection |
| `apps/server` | Hono/Bun relay, device authentication, SQLite retention and optional Bark push |
| `apps/web` | React/Vite browser interface, device keys and encrypted communication |

See [architecture](docs/STRUCTURE.md), [design decisions](docs/DECISIONS.md) and
[protocol requirements](docs/PROTOCOL-REQUIREMENTS.md). Design notes and source
comments are primarily in Chinese.

## Configuration and data

The agent requires `--server` or `TRINE_SERVER`. Its default state directory is
`~/.trine`; `--home`/`TRINE_HOME` overrides it. `TRINE_DEFAULT_MODEL` selects the
fallback model (default `opus[1m]`). `TRINE_MAX_SESSIONS` and `TRINE_IDLE_TIMEOUT_MS` control active sessions.

Model fields accept Claude Code family aliases (`fable`, `opus`, `sonnet`, `haiku`, and
suffixed forms such as `opus[1m]`), which Claude Code resolves to the latest model in
that family, as well as full model IDs. The web app's preset model list contains only
aliases. New sessions preselect the model and permission mode from Settings → New
session defaults (initially `opus[1m]` and `bypassPermissions`); each session keeps its own
model and permission mode afterwards. Change the default permission mode if you do not
want new sessions to skip tool approval.

The relay reads environment variables. Copy the
[environment template](apps/server/deploy/trine-server.env.example) outside the
checkout and edit that copy. Keep the listener on loopback behind your TLS proxy.
`TRINE_OPEN_REGISTRATION` is deprecated and cannot enable registration.

| Location | Contents |
| --- | --- |
| Agent `~/.trine/` (or `--home`) | Private identity keys, paired recipients, session flags and counters |
| Claude Code's local configuration directory | Claude's own transcripts, settings and credentials |
| Browser localStorage / IndexedDB | Private keys, pairing data and cached plaintext history |
| Relay SQLite database | Device public keys, token hashes, ciphertext and routing metadata |

End-to-end encryption does not encrypt browser storage or protect against a
compromised browser, agent, or server that replaces the frontend JavaScript.
Read the [threat model and recovery guidance](SECURITY.md).

## Development

```bash
bun run typecheck
bun test
bun run build
# Or run all three:
bun run check
```

Tests use temporary state and fake/injected model calls; an Anthropic credential
is not needed. Production web output is `apps/web/dist/`. CI checks the locked
dependency installation, types, tests, build and secret patterns. See
[CONTRIBUTING.md](CONTRIBUTING.md) for test data and disclosure rules.

## License

trine's original code is [MIT licensed](LICENSE). Dependencies and copied/adapted
third-party portions retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Claude Code and Claude Agent SDK are separate products governed by their own terms.
