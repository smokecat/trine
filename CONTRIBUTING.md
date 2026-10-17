# Contributing

Small, focused issues and pull requests are welcome. For a substantial change,
open an issue describing the problem and proposed behavior first. Communicate
respectfully and make criticism about the work, not the person.

## Development setup

Use Bun 1.3.11 and `bun install --frozen-lockfile`. Follow the local setup in
[README.md](README.md). There is no required paid account for running tests.
Changes to dependencies must update `bun.lock` using Bun.

Before submitting:

```bash
bun run typecheck
bun test
bun run build
```

Keep tests that exercise protocol behavior, permission boundaries, reconnects,
replay handling and rendering. Avoid assertions that merely mirror implementation
text. New fixtures must be synthetic: no real conversations, request IDs, user
paths, credentials, pairing payloads or production hostnames.

## Repository layout

See [docs/STRUCTURE.md](docs/STRUCTURE.md). Shared protocol changes belong in
`packages/core` and should include compatibility considerations for agent/server/web.
The relay is single-owner; adding multi-tenancy would require a separate design.

Tests write temporary data and inject model calls. Do not change the test suite
to use a developer's real Claude configuration or make paid model requests.
The subagent fixture includes intentionally synthetic linked identifiers and
attachment records to preserve a parsing regression case.

## Pull requests

Explain the user-visible problem, what changed, and how you verified it. Include
screenshots for meaningful UI changes with private content removed. Use a concise
commit title such as `fix(web): preserve history ordering after reconnect`.

Do not commit environment files, state directories, logs or generated builds.
Run Gitleaks 8.30.1 before release:

```bash
gitleaks git --log-opts=--all --redact=100
```

The repository configuration allows only specific libsodium API symbol false
positives in its patch. Do not broadly exclude source files from secret scanning.

## Security and licensing

Use the private reporting channel in [SECURITY.md](SECURITY.md) for vulnerabilities.
Never attach live credentials or unredacted transcripts to an issue.

By submitting a contribution, you agree to license your original contribution
under the project's MIT license. Retain upstream notices and record copied/adapted
code in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Do not include code or
assets that you do not have permission to distribute.
