# Command Code local usage parser feasibility

Research date: 2026-10-01

## Finding

**A local parser looks feasible and is a good candidate, but should not be implemented from documentation alone.** Command Code documents durable per-session JSONL transcripts and explicitly says model replies include token usage and cost. That gives us a local source for token accounting and session timing without network access. The public docs do not specify the exact JSON keys, token semantics, branching/fork duplication behavior, or model identifiers. Verify those against a real current transcript before implementation, per this repository's new-parser gate.

## Documented storage

- Session transcript: `~/.commandcode/projects/<project-slug>/<session-id>.jsonl`.
- One JSON record per line; first record is a header with session id, creation time, and working directory. Later entries include user/model messages, token usage and cost, model/effort changes, compaction summaries, etc.
- Entries form a parent-linked tree; history is append-only. Rewind/fork creates branches rather than rewriting history.
- Sidecars include `<id>.meta.json` (title/model/lineage/trace ids/compaction stats), `<id>.share.json`, `<id>.checkpoints.jsonl`, and `<id>.prompts.jsonl`. The transcript is the relevant usage source; avoid reading prompt/history or checkpoint sidecars for accounting.
- Headless `cmd -p` sessions are persisted but hidden from the picker. `--no-session` sessions are in-memory and unavailable to a filesystem parser.
- Docs describe `~/.commandcode/` as configuration root. No alternate data-root environment variable was established from the sources reviewed.

## Parser fit

**Likely supportable:** traverse project directories, parse JSONL, extract assistant usage/model/time and user timing events, aggregate buckets and sessions using existing repository helpers. The documented header cwd can likely identify project, but confirm actual schema and fallback behavior.

**Risks to resolve with a real transcript:** exact record discriminators and nested paths; whether usage is cumulative or per-call; prompt/cache/reasoning field semantics; calls with repeated usage across streaming/content records; retry records; model alias/routing tier handling and pricing collisions; branch/fork copied-history dedup; compaction boundaries; partially written final lines; corrupt/unreadable project roots. Never upload transcript content, stored cost, credentials, or prompt/tool payloads.

Suggested narrow implementation after validation: source id `command-code`; scan only canonical `projects/**/*.jsonl` transcript files; extract allow-listed accounting/timing fields; deduplicate repeated API-call identities and copied branch history; return `skipped` with warnings on incomplete discovery/read failures so prior sync state is protected. Sidecars should not be required for token collection unless real samples prove otherwise.

## Sources

- Official Sessions & Checkpoints docs: https://commandcode.ai/docs/sessions — storage path, JSONL, header/entry description, branches, sidecars, headless and in-memory sessions.
- Official Security & Privacy docs: https://commandcode.ai/docs/resources/security — conversation history local under `~/.commandcode/projects/`; auth local under `~/.commandcode/auth.json`.
- Official Telemetry docs: https://commandcode.ai/docs/troubleshooting/telemetry — describes anonymous session metrics and explicitly distinguishes telemetry from local transcript accounting.
- Official CLI reference: https://commandcode.ai/docs/reference/cli — supports resuming by transcript path/ID, corroborating transcript-file handling.

Docs establish the broad format, not a stable machine-readable accounting schema. Before release, inspect a current local transcript and independently sum its usage records against parser output; then run pricing-map checks for every emitted model id. Backend source registration is also a release prerequisite under this repository's parser checklist.
