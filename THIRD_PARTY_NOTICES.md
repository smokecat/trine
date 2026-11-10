# Third-party notices

The root MIT license applies to trine's original work. It does not replace the
licenses of dependencies, adapted components, fonts or external services.

| Material | Location/use | License / notice |
| --- | --- | --- |
| libsodium-wrappers / libsodium.js | The import fix in `patches/libsodium-wrappers@0.7.16.patch` includes upstream generated code | [ISC, original copyright included](LICENSES/libsodium-wrappers-ISC.txt) |
| shadcn/ui | Adapted UI primitives in `apps/web/src/components/ui/` | [MIT](LICENSES/shadcn-MIT.txt) |
| IBM Plex Sans | Bundled through `@fontsource/ibm-plex-sans` | [SIL OFL 1.1](LICENSES/ibm-plex-sans-OFL.txt) |
| IBM Plex Mono | Bundled through `@fontsource/ibm-plex-mono` | [SIL OFL 1.1](LICENSES/ibm-plex-mono-OFL.txt) |
| Claude Agent SDK / Claude Code | Agent runtime dependency, installed separately by the package manager / user | Anthropic's separate terms, not this project's MIT license |
| Simple Icons (`claude` icon path, v16.37.0) | Claude engine mark in `apps/web/src/components/shell/EngineIcon.tsx` | CC0 1.0 (icon data); the mark itself is a trademark, see below |
| Lobe Icons (`codex` monochrome icon path, `@lobehub/icons-static-svg` v1.102.0) | Codex engine mark in `apps/web/src/components/shell/EngineIcon.tsx` | [MIT](LICENSES/lobe-icons-MIT.txt); the mark itself is a trademark, see below |

## Trademarks

Claude and the Claude logo are trademarks of Anthropic PBC. Codex, OpenAI and their
logos are trademarks of OpenAI. trine shows these marks only to identify which engine
a session or usage figure belongs to; it is not affiliated with or endorsed by either
company. Check each owner's brand guidelines before redistributing a build that
contains the marks.

## Claude products

The pinned `@anthropic-ai/claude-agent-sdk` package declares `SEE LICENSE IN README.md`.
Its license notice states: “© Anthropic PBC. All rights reserved. Use is subject to
the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.”

Review those terms and your authentication arrangement before use or redistribution.
This repository does not contain the SDK/CLI binary or grant rights to Anthropic
services, branding or accounts. trine is an independent project and is not endorsed
by Anthropic.

## Dependency and binary distributions

Other dependencies remain under their upstream licenses (including MIT, ISC and
Apache-2.0). See the manifests, `bun.lock` and installed packages for exact versions
and notices. This document identifies directly adapted/bundled material; it is not
a replacement for all transitive dependency notices.

The web build writes `dist/THIRD_PARTY_NOTICES.txt` with the adapted-source/font
notices and license files (or README fallback) from installed runtime dependencies.
Keep this file with a distributed frontend and review packages without a standalone
license file when changing dependencies. If distributing a packaged
agent or container, separately review the SDK/CLI and all bundled dependencies.
The initial project distribution is source code; no bundled agent binary is supplied.
