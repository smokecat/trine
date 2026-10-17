# Deploying trine

This guide targets a **single-owner Linux relay** behind Caddy, with agents making
outbound connections from their own machines. Use your own domain in place of
`trine.example.com` and your own SSH host in place of `relay-host`.
Read [SECURITY.md](../../../SECURITY.md) before exposing the service.

The examples use Bun 1.3.11, systemd and SQLite. Distribution-specific firewall,
Caddy and service-account setup may need adjustment. Do not reuse a public demo
instance for private work.

## 1. Install the runtime and prepare a release directory

Install Git, Caddy, SQLite's command-line tool and Bun using their official
installation instructions. Put the Bun 1.3.11 executable at `/usr/local/bin/bun`
for the systemd template, or edit the unit's `ExecStart` accordingly. Verify:

```bash
/usr/local/bin/bun --version
/usr/local/bin/bun -e 'import {Database} from "bun:sqlite"; const db = new Database(":memory:"); db.exec("SELECT 1"); db.close(); console.log("SQLite OK")'
```

Create a dedicated service account and writable state directory. This account is
for the relay, **not** for running the agent or Claude Code:

```bash
sudo useradd --system --home-dir /var/lib/trine --shell /usr/sbin/nologin trine
sudo install -d -m 750 -o trine -g trine /var/lib/trine /opt/trine-releases
sudo install -d -m 750 -o root -g trine /etc/trine
sudo -u trine git clone https://github.com/smokecat/trine.git /opt/trine-releases/initial
cd /opt/trine-releases/initial
sudo -u trine -H /usr/local/bin/bun install --frozen-lockfile
sudo -u trine -H /usr/local/bin/bun run build
sudo ln -s /opt/trine-releases/initial /opt/trine
```

The symlink command assumes `/opt/trine` does not already exist. For upgrades, use
the release-switch procedure below. Record the deployed commit with `git rev-parse HEAD`.

## 2. Configure and start the relay on loopback only

```bash
cd /opt/trine
sudo install -m 640 -o root -g trine apps/server/deploy/trine-server.env.example /etc/trine/server.env
sudoedit /etc/trine/server.env
```

Keep these values and enable the web build:

```dotenv
TRINE_HOST=127.0.0.1
TRINE_PORT=8787
TRINE_DB=/var/lib/trine/trine.sqlite
TRINE_OPEN_REGISTRATION=0
TRINE_TRUST_PROXY=1
TRINE_WEB_DIST=/opt/trine/apps/web/dist
```

All available variables are documented in [trine-server.env.example](trine-server.env.example).
Keep actual environment files outside the checkout and out of source archives.

```bash
sudo install -m 644 apps/server/deploy/trine-server.service /etc/systemd/system/trine-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now trine-server
sudo systemctl status trine-server
curl --fail http://127.0.0.1:8787/healthz
```

The listener must remain on loopback behind Caddy; do not expose port 8787. On this
version, even an empty database refuses registration without an invitation. When
upgrading an older empty relay, keep its public route disabled until the new
version is running. `TRINE_OPEN_REGISTRATION` no longer enables enrollment.

## 3. Enable HTTPS

Point your domain's DNS at the relay host. Adapt [Caddyfile](Caddyfile), replacing
`trine.example.com`; merge it into your existing configuration or install it as
the main Caddyfile on a dedicated host. Validate and reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --fail https://trine.example.com/healthz
```

Caddy terminates TLS and forwards to `127.0.0.1:8787`. Keep its forwarded-IP header
trust boundary intact; review source-IP handling if adding proxy hops.

## 4. Enroll the first agent and pair a browser

In a **private SSH terminal on the relay**, run the local administration command
against the exact database used by the running service, using the same release:

```bash
cd /opt/trine
sudo -u trine /usr/local/bin/bun run agent:invite create --db /var/lib/trine/trine.sqlite
```

It prints the credential once to stdout, and its non-secret ID and expiry to stderr.
Default validity is 10 minutes; `--ttl 300` selects five minutes (maximum one hour).
The CLI requires an existing database initialized by the matching relay. No
configuration change, public-access window or relay restart is needed.

On the new machine, from a checkout with dependencies installed and Claude Code
authenticated, start the agent in an interactive terminal:

```bash
TRINE_DEFAULT_MODEL=sonnet bun run dev:agent -- --server https://trine.example.com --home ~/.trine --enroll --pair
```

Paste only the invitation at the hidden prompt, then press Enter. Never put the
credential in a command argument, environment variable or URL. Keep terminal and
clipboard history private. `--enroll` can also read one line from a private stdin
pipe; such a run cannot manually confirm browser pairing, so restart interactively
with `--pair` afterward. The invitation is not saved by the agent.

Open `https://trine.example.com`, scan/paste the pairing payload, compare both
short authentication codes and approve in the agent terminal only if they match.
Pairing still requires this separate human confirmation. Its payload expires after
five minutes; never publish the QR or payload.

For later starts, preserve the same `--home` and omit `--enroll`; omit `--pair`
unless adding a browser. Even if `--enroll` remains, an existing identity does not
prompt for or consume an invitation. Do not run two agents with the same identity.
Background-service setup is OS-specific; preserve server URL, identity directory,
PATH and provider configuration. Do initial pairing in a TTY.

## 5. Add machines, revoke invitations and recover

For each new agent, repeat only the **issue invitation + start with `--enroll`**
steps above. Pair each browser with each agent it should control. Previously this
required blocking public access, enabling registration, restarting, enrolling,
disabling registration, restarting again and restoring access. These maintenance
steps and the first-agent tunnel/URL switch are no longer required.

Use local metadata-only administration commands on the relay:

```bash
sudo -u trine /usr/local/bin/bun run agent:invite list --db /var/lib/trine/trine.sqlite
sudo -u trine /usr/local/bin/bun run agent:invite revoke INVITATION_ID --db /var/lib/trine/trine.sqlite
```

`INVITATION_ID` is the non-secret ID printed when issuing/listing. An invitation
can register only one new agent, not a browser. Revoking an invitation cannot
revoke an already enrolled device. There is a maximum of 100 pending invitations;
revoke unused ones or let them expire.

| Failure | Recovery |
| --- | --- |
| `invalid_invitation` | Expired, revoked, used or issued for a different relay. Issue a fresh one and retry with the same `--home`. |
| Network failure during enrollment | Preserve `--home` and retry. If the device was committed before the response was lost, private-key authentication succeeds without another invitation. If not, reuse the unexpired invitation. |
| `registration_closed` / unregistered identity | Check `--server` and `--home`; for a genuinely new device upgrade both sides and use `--enroll`. |
| `rate_limited` | Wait at least a minute; check trusted proxy configuration/abuse if it persists. |
| Key or role conflict / `bad_signature` | Check the correct identity backup and relay. Do not overwrite identity keys to force enrollment. |
| `device_revoked` | An invitation does not restore a revoked device. Follow [lost-device guidance](../../../SECURITY.md#lost-devices-and-recovery). |
| Local invitation CLI fails | Check database path, ownership, matching source/schema version, TTL and pending invitation count. |

Upgrade the relay first. Schema v4 adds the invitation table and preserves existing
identities, tokens, encrypted state and pairings. Already registered older agents
continue to work (their idempotent register requests are still accepted); new
agents on older binaries must upgrade. The old public/empty-database enrollment
behavior is intentionally removed, including when the old switch is set to `1`.
Old relay binaries refuse schema v4; use a matching pre-upgrade backup for rollback,
accepting loss of newer state. After restoring any backup, revoke all listed
invitations before reopening public access, since a backup may resurrect a still
valid invitation. [中文注册、部署与迁移说明](../../../docs/AGENT-ENROLLMENT.zh-CN.md).

## 6. Optional Bark notifications

Configure both variables together in `/etc/trine/server.env`, or leave both empty:

```dotenv
TRINE_BARK_URL=https://api.day.app
TRINE_BARK_KEY=REPLACE_WITH_YOUR_DEVICE_KEY
```

Then restart the relay. Notifications contain a generic event type plus a short
machine ID or configured `TRINE_PUSH_ALIAS`. They do not contain messages or session
titles. The Bark provider can see notification metadata. Keep aliases non-sensitive.

Notifications are best-effort, deduplicated and suppressed while a client is online
by default. See the environment template for the relevant settings.

## 7. Backups

Use SQLite's backup mechanism, not a raw copy of a database with an active WAL:

```bash
sudo -u trine sqlite3 /var/lib/trine/trine.sqlite   ".backup '/var/lib/trine/backup.sqlite'"
sudo chmod 600 /var/lib/trine/backup.sqlite
```

Copy backups to private storage, check restoration in an isolated environment and
retain the matching release/configuration. Agent state and browser data require
separate handling. Do not put identity keys or database backups into this repository.
The relay backup contains ciphertext and sensitive metadata, not the plaintext
Claude history; it is still private data.

## 8. Upgrades and rollback

1. Choose and review a commit. Back up the database and config before upgrading.
2. Clone or extract **only tracked source** into a new directory under
   `/opt/trine-releases/`. Do not tar an entire developer working directory.
3. Install with `bun install --frozen-lockfile`, run the checks and build the web UI
   in that new directory. Keep the live release unchanged until they succeed.
4. Stop the service, save the old symlink target, then replace `/opt/trine` using a
   temporary symlink and atomic rename on the same filesystem. On Linux, after
   setting `release_dir` to the verified absolute release path:

   ```bash
   previous_release=$(readlink -f /opt/trine)
   sudo systemctl stop trine-server
   sudo ln -s "$release_dir" /opt/trine.next
   sudo mv -Tf /opt/trine.next /opt/trine
   sudo systemctl start trine-server
   curl --fail http://127.0.0.1:8787/healthz
   ```

5. Verify public HTTPS, asset content types, agent reconnection, pairing/session
   operations and logs. A healthy `/healthz` alone is not end-to-end acceptance.
6. If verification fails, stop the service and restore the previous symlink target.
   Restore a database backup only if the release changed the schema incompatibly;
   doing so discards newer relay state. Preserve failed-state evidence privately.

This project has no automatic database downgrade guarantee. Do not delete the old
release or backup before confirming the new deployment.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Service fails to start | Bun executable path, SQLite directory ownership, environment validation and `journalctl` |
| Database is read-only | `TRINE_DB` must be within the unit's writable `/var/lib/trine` directory |
| `registration_closed` for a new agent | Issue an invitation and start with `--enroll`; check identity/server URL |
| WS closes with 4001 | Device/token authentication; preserve the correct agent identity |
| WS closes with 4005 | Another process is using the same agent identity |
| Browser cannot connect | HTTPS certificate, reverse proxy, same origin, and WS Origin configuration |
| Camera unavailable | Secure context and browser permission; paste the pairing payload instead |
| Model unavailable | Select a model accessible to your provider with `TRINE_DEFAULT_MODEL` |
| No notifications | Both Bark values, online suppression and deduplication; never paste the key into an issue |

For separate frontend hosting, configure an explicit `TRINE_CORS_ORIGINS` allowlist;
wildcards are rejected. You are responsible for frontend security headers and the
trustworthiness of the frontend host in that arrangement.
