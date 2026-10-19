# Security policy and threat model

trine is an early, single-owner remote-control tool. A paired browser can operate
Claude Code with the permissions of the agent's OS account. Use a dedicated,
least-privileged account and inspect permission prompts. Do not expose a shared
public instance or treat devices from different people as isolated tenants.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/smokecat/trine/security/advisories/new).
If that channel is unavailable, open an issue asking for a private reporting
channel without publishing exploit details, keys or transcripts. Only the latest
`main` is maintained; there is no promised response time or backport policy.

## What encryption protects

Session payloads are encrypted between the browser and agent using libsodium
crypto_box (X25519 + XSalsa20-Poly1305). Ed25519 challenge-response authenticates
devices to the relay. Pairing requires manual verification of a short code.
The relay sees routing metadata, device public keys, timing and ciphertext.
Optional Bark notifications reveal the event type and a machine identifier or
configured alias, not the session title or message body.

The relay must still enforce authentication, quotas and replay checks. Encryption
is not a substitute for those controls, backups or TLS.

## What encryption does not protect

- Browser private keys are stored in localStorage; cached conversations use IndexedDB.
  They are not separately encrypted at rest by trine.
- The agent stores private identity keys on disk and Claude stores its own history
  and credentials locally. Protect the OS account and backups.
- A compromised frontend host can replace JavaScript and steal browser keys or plaintext.
  Same-origin hosting trusts the relay host to serve the correct frontend.
- A compromised paired device or agent can read content and send authorized operations.
- The agent's local control socket (`<home>/control.sock`, same OS user only) can
  start pairings and remove paired devices. Anyone who can use it can already read
  the agent identity; pairing still requires a human to compare the short code.
- There is no forward-secrecy guarantee for long-term device key compromise.
- Agent permission settings and project/user Claude configuration affect execution.
  Enabling bypass permissions increases the authority of every paired controller.
  The web app preselects `bypassPermissions` for new sessions by default; change it in
  Settings → New session defaults if you want tool approval prompts.
- Any paired controller can rewind a session. Restoring code overwrites or deletes the
  files Claude edited since the chosen message, without a tool approval prompt. Sessions
  keep Claude Code file checkpoints (backups of edited files) in Claude's configuration
  directory.

## First registration and additional machines

New agents require a local administrator-issued invitation, including on an empty
database. `TRINE_OPEN_REGISTRATION` is deprecated and ignored. Browser clients
cannot enroll using an invitation: they still require an authenticated agent's
pairing endorsement after manual short-code verification.

The trust root is OS/SSH access to the relay database. The local `agent:invite`
command creates a 256-bit random bearer credential, valid for 10 minutes by default
(1–3600 seconds configurable), scoped only to one new agent. There is no network
API for issuing invitations and no new administrator password. Anyone possessing
an unused invitation can enroll an agent; verify the relay/SSH host and deliver
it only through a trusted private terminal or SSH pipe. This remains a single-owner
service, not tenant isolation.

Only the SHA-256 digest, a non-secret revocation ID and expiry are stored. The raw
credential is printed once by the explicit issuing command; keep terminal scrollback,
clipboard history and recording private. The agent reads hidden terminal input
(or one stdin line), sends it only in the registration POST body over HTTPS or
loopback HTTP, refuses redirects, and does not save it. Do not put it in argv,
environment files, URLs, logs, proxy body tracing or bug reports. Protect host
clocks, database permissions and backups.

SQLite IMMEDIATE transactions atomically delete the valid invitation and insert
the device, including across concurrent processes. Failed writes roll both back.
A retry for an existing identical device ID/key/role returns `created:false`
without consuming another invitation, even after expiry; this does not grant an
auth token. Ed25519 proof of private-key possession is still required to connect.
Key/role conflicts and revoked identities are rejected. Revoke an unused invitation
by ID; revoking it after enrollment does not revoke the device.

Registration bodies are limited to 4 KiB, attempts to 20 per source/minute and 200
globally/minute, and outstanding invitations to 100. Invalid bodies consume the
attempt budget (oversized bodies are rejected first). Untrusted forwarded headers
are ignored; without a trusted proxy all HTTP sources share a conservative bucket.
Limits can temporarily deny enrollment under abuse; they do not bypass validation.
Existing agents authenticate without using the registration budget.

Upgrade the relay first (additive schema v4), preserving existing device records,
tokens and pairing state. Previously enrolled older agents remain compatible;
unregistered older agents must upgrade to accept invitations. Old relay code
rejects the newer schema; rollback requires a matching backup and can lose newer
state. A pre-upgrade empty relay must remain isolated until the secure version is
running. Restored backups can resurrect still-valid invitations: revoke all listed
invitations after restoration before restoring public access. See the
[deployment and recovery guide](apps/server/deploy/README.md#4-enroll-the-first-agent-and-pair-a-browser)
and [中文说明](docs/AGENT-ENROLLMENT.zh-CN.md).

## Lost devices and recovery

Stop the agent and restrict relay access if a paired device is compromised.
`trine-agent devices revoke <device>` removes a browser from one agent's recipient
list (the agent stops encrypting for it and drops its messages), but does not
revoke its relay registration or tokens. There is no complete end-user
revocation/recovery workflow yet. Do not assume clearing
a browser's storage revokes its old keys or tokens on the other endpoints.
For a conservative reset: stop all components, back up state securely, replace
the relay database and all trine agent identity/recipient state, clear each
browser's trine site data, then enroll and pair again through the protected flow.
This loses trine pairing/cache state; preserve Claude's own transcript directory.
If an OS account or provider credential was compromised, rotate those separately.

## Deployment hygiene

Use HTTPS/WSS, verify both pairing codes, keep real environment files outside the
checkout, and restrict file permissions. Trust forwarded IP headers only behind
a trusted reverse proxy. Never serve the repository root, agent home or a database
as static web content. Backups include sensitive metadata and must remain private.
Do not publish logs, QR payloads or real transcripts in bug reports.

The tests and CI are useful checks, not an independent security audit or a claim
that this project is suitable for high-assurance environments.
