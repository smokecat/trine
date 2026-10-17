# @trine/web

React, Vite and Tailwind browser client. The UI currently uses Chinese text and
supports desktop/mobile layouts. For installation and pairing see the
[root README](../../README.md); for hosting see the [deployment guide](../server/deploy/README.md).

## Commands

Run from this directory after installing dependencies at the repository root:

```bash
bun run dev
bun run typecheck
bun run build
bun run preview
```

The dev/preview proxy forwards `/auth`, `/ws`, `/healthz` and `/devices` to
`http://127.0.0.1:8787`. Override with `TRINE_DEV_PROXY`. The UI listens on port
5173; use the same origin in the browser and the agent's `--server` argument.
Production output is `dist/`; configure `TRINE_WEB_DIST` on the relay to serve it.

## Structure

- `app/`: routing, runtime, lifecycle and theme.
- `lib/`: crypto envelopes, transport, storage, pairing and history reducers.
- `store/`: Zustand state mirrored from the client runtime.
- `components/`: chat, composer, lists, pairing, machine controls and UI primitives.
- `views/`: routed pages.

Fonts, Markdown rendering dependencies and syntax highlighting are bundled locally.
Keep external scripts and remote content requests out of the application runtime.
libsodium and the syntax language bundles are split/lazy loaded; the larger build
chunks are expected. Recheck the browser's network requests after dependency changes.

Keys and cached messages are sensitive browser data. See [SECURITY.md](../../SECURITY.md)
for the frontend-host trust boundary and lost-device recovery limits.

The build also writes `dist/THIRD_PARTY_NOTICES.txt`; retain it with deployed assets.
