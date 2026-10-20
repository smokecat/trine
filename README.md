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
- Shows message times like a chat app: day separators, a time marker after gaps of 10+ minutes,
  the time under each of your messages, and start times for replies and tools on hover or expand.
- Rewinds a session to before one of your messages, restoring code, the conversation or both.
- Shows usage: each session's context window use, and per machine the 5-hour and weekly plan limits
  with their reset times (subscription accounts only). Limits refresh while sessions run, or on demand.
- Shows the output of local slash commands such as `/usage` and `/cost` as a card that keeps the
  terminal layout; `/usage` gets progress bars for each limit.
- Attaches images and files to messages: pick them, paste them or drop them onto the page.
  Attachments are encrypted in the browser and relayed as ciphertext; small images go to
  Claude inline, other files are saved on the agent's machine and handed over by path.
- Keeps reusable prompt snippets on the device: edit and copy them in Settings, and insert one at
  the cursor (or copy it) from the prompt button next to the paperclip. On phones, attachments and
  snippets live behind a `+` button so the input keeps its width.
- Lists, resumes, renames and archives sessions across paired machines; right-click or
  multi-select (Ctrl/Cmd/Shift-click) to archive in bulk, and copy a session's working directory.
- Pins sessions and workspaces (most recently pinned first). When grouped by workspace, groups
  keep a fixed order (newest workspace first) instead of jumping around as sessions change state.
- Hides temporary sessions by default (working directory under a system temp directory, or
  non-interactive runs such as `claude -p`); a list filter shows them again.
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
subsequent starts. Browser pairing still requires manual confirmation; to add a
browser to an agent that is already running (for example as a service), run
`bun run dev:agent -- pair --home <dir>` instead of starting a second agent.
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
fallback model (default `opus[1m]`). `TRINE_MAX_SESSIONS` (default 10) and `TRINE_IDLE_TIMEOUT_MS` (default 15 minutes) control
active sessions, i.e. sessions with a running Claude Code child process. When the limit is reached,
the agent first shuts down the child process of the least recently active idle session (its
transcript stays and it resumes on the next message); archiving a session also releases its idle child
process. The web list marks such sessions as 驻留 and shows `子进程 n/max` for the machine.

Attachments: the default limit is 10 files and 64 MB per message, adjustable in
Settings → Attachments up to the relay's per-file cap (`TRINE_BLOB_MAX_BYTES`, default
256 MB). Images are sent as-is unless you set a compression threshold there. The relay
keeps encrypted attachments for `TRINE_BLOB_TTL_MS` (default 7 days) in
`TRINE_BLOB_DIR` (default `blobs/` next to the database); afterwards, opening one asks
the agent to upload it again from its copy under `<home>/uploads`. Images up to about
3.75 MB and 2000 px are given to Claude inline; larger images and other files are listed
by path for Claude to read. Requires agent 0.11.0 or later.

Model fields accept Claude Code family aliases (`fable`, `opus`, `sonnet`, `haiku`, and
suffixed forms such as `opus[1m]`), which Claude Code resolves to the latest model in
that family, as well as full model IDs. The web app's preset model list contains only
aliases. New sessions preselect the model and permission mode from Settings → New
session defaults (initially `opus[1m]` and `bypassPermissions`); each session keeps its own
model and permission mode afterwards. Change the default permission mode if you do not
want new sessions to skip tool approval.

In the message box, the Return key on touch devices (phones, tablets) always inserts a
new line; tap the send button to send. With a physical keyboard, Settings → Send key
chooses between Enter to send (Shift+Enter for a new line, the default) and Cmd/Ctrl+Enter
to send (Enter for a new line). Cmd/Ctrl+Enter sends in both modes.

To rewind, hover over (or tap) one of your messages and choose **Rewind to here** (agent 0.9.0
or later, session idle). The dialog previews the change and offers the same three options as
Claude Code's `/rewind`: restore code and conversation, conversation only, or code only.
Rewinding the conversation removes that message and everything after it on every device and
puts the message back into the input box. Code is restored from Claude Code's file checkpoints,
which the agent now enables for every session (Claude Code stores them in its own configuration
directory). Only edits made through Claude's editing tools can be restored; changes made by
Bash commands or by hand cannot. Turns that ran before checkpoints were enabled can only rewind
the conversation, and the first message of a session can only restore code.

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
