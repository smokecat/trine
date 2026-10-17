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
- There is no forward-secrecy guarantee for long-term device key compromise.
- Agent permission settings and project/user Claude configuration affect execution.
  Enabling bypass permissions increases the authority of every paired controller.

## First registration and additional machines

An empty device database accepts the first device registration, including when
`TRINE_OPEN_REGISTRATION=0`. Do not expose that endpoint publicly until your agent
has registered. Follow the [SSH-tunnel initialization procedure](apps/server/deploy/README.md#3-register-the-first-agent-before-opening-the-public-endpoint).
Keep the relay listener on loopback and registration closed afterward.

Adding another agent currently requires a controlled registration window. Block
public access, enable registration temporarily, enroll through SSH, then disable
registration and restore access. Clients use the normal pairing flow.

A future hardening option is a one-time initialization credential scoped to agent
registration, disabled atomically after enrollment, with rate limits and safe
secret delivery. **That mechanism is not implemented in this release.**

## Lost devices and recovery

Stop the agent and restrict relay access if a paired device is compromised. There
is no complete end-user revocation/recovery workflow yet. Do not assume clearing
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
