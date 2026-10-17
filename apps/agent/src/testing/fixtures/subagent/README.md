# Synthetic subagent transcript

`agent-a000000000000001.jsonl` and its metadata file exercise traversal across
interleaved attachment records, tool calls and results. The parent/child links
are intentional. Paths, UUIDs, request/message/tool identifiers and dates are
synthetic; message bodies are limited to an echo/write/read test.

Keep the fixture and its assertions synchronized. Do not replace it with a live
Claude transcript. The test suite must not require a real model call.
