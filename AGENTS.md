# Contributor and coding-agent guide

Read [README.md](README.md), [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md) before changing behavior.

- Use Bun and the committed lockfile; do not introduce another package manager.
- `packages/core` owns shared types, protocol validation and crypto. Keep it free of UI dependencies.
- Preserve client-to-agent encryption, pairing confirmation, permission checks and replay protection.
- Treat the relay as a single-owner service; do not assume tenant isolation.
- Never put credentials, live transcripts, local paths or deployment details into fixtures or reports.
  Use synthetic test data and keep associations between IDs consistent.
- Tests must use temporary directories and injected/fake model calls. Do not use live accounts.
- Run `bun run typecheck`, `bun test` and `bun run build` before proposing a release.
- Explain externally visible changes and update the relevant documentation.
- Keep changes focused. Do not modify a user's running deployment as part of a source change.
