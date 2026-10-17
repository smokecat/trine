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

Do **not** enable the public Caddy site yet. If an existing proxy already forwards
to this port, disable that route first. Do not expose port 8787 in the firewall.

## 3. Register the first agent before opening the public endpoint

An empty relay database accepts the first registration even with
`TRINE_OPEN_REGISTRATION=0`. A public endpoint at this point would allow someone
else to claim that slot. Initialize over SSH while the public route is disabled.

On the machine that will run the agent, keep an SSH tunnel open:

```bash
ssh -N -L 127.0.0.1:18787:127.0.0.1:8787 relay-host
```

In another terminal, from a local trine checkout with dependencies installed and
Claude Code authenticated, start the agent **without** `--pair`:

```bash
TRINE_DEFAULT_MODEL=sonnet bun run dev:agent --   --server http://localhost:18787 --home ~/.trine
```

On the relay, check that exactly the expected agent was registered:

```bash
sudo -u trine sqlite3 /var/lib/trine/trine.sqlite   'SELECT device_id, role FROM devices;'
sudo journalctl -u trine-server -n 30
```

Compare the device ID with the local agent terminal; do not share the logs.
Stop the agent with Ctrl-C and close the tunnel. Preserve `~/.trine`: the same
identity will authenticate after switching to the public URL.

If registration is already closed but the expected agent is absent, stop and
investigate the database. Do not enable open registration to work around an
unexpected first device.

## 4. Enable HTTPS and pair the browser

Point your domain's DNS at the relay host. Adapt [Caddyfile](Caddyfile), replacing
`trine.example.com`; merge it into your existing configuration or install it as
the main Caddyfile on a dedicated host. Validate and reload using your Caddy
installation's documented paths:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --fail https://trine.example.com/healthz
```

Caddy terminates TLS and forwards to `127.0.0.1:8787`. The template overwrites
forwarded IP headers from the incoming client; keep that trust boundary intact.
If using multiple proxy hops, review source-IP handling rather than assuming the
single-proxy configuration applies.

Restart the **same local agent identity** in an interactive terminal:

```bash
TRINE_DEFAULT_MODEL=sonnet bun run dev:agent --   --server https://trine.example.com --home ~/.trine --pair
```

Open `https://trine.example.com` in your browser, scan or paste the pairing payload,
compare the short authentication codes, and confirm in the agent terminal only
if both match. The pairing payload expires after five minutes. For later starts,
omit `--pair` unless enrolling another browser. Never publish the payload or QR code.

Agent background-service setup is OS-specific. Preserve the same `--home`, server
URL, PATH and provider configuration in that service; do initial pairing in a TTY.
Do not run two agent processes with the same identity simultaneously.

## 5. Add another machine

A new browser pairs through an already registered agent. A new **agent machine**
currently requires direct registration: temporarily disable public access to the
relay, set `TRINE_OPEN_REGISTRATION=1`, restart it, enroll the new agent through
the same SSH procedure, then set the value back to `0` and restart **before**
restoring public access. Verify the registered device IDs. Pair each browser with
each agent it should control.

Do not leave an enrollment window open to the Internet. A future one-time
initialization credential is described in SECURITY.md; it is not implemented yet.

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
| `registration_closed` for a new agent | Use the protected enrollment procedure; do not enable public registration |
| WS closes with 4001 | Device/token authentication; preserve the correct agent identity |
| WS closes with 4005 | Another process is using the same agent identity |
| Browser cannot connect | HTTPS certificate, reverse proxy, same origin, and WS Origin configuration |
| Camera unavailable | Secure context and browser permission; paste the pairing payload instead |
| Model unavailable | Select a model accessible to your provider with `TRINE_DEFAULT_MODEL` |
| No notifications | Both Bark values, online suppression and deduplication; never paste the key into an issue |

For separate frontend hosting, configure an explicit `TRINE_CORS_ORIGINS` allowlist;
wildcards are rejected. You are responsible for frontend security headers and the
trustworthiness of the frontend host in that arrangement.
