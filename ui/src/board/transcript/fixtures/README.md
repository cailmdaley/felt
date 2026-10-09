# Captured usage records

These JSONL lines are field-selected captures from real local transcripts inspected on 2026-10-09, not synthetic provider responses.
Each line retains its original type, timestamp and selected numeric usage fields.
Lines come from independent sessions and are not a chronological conversation.
All message content, tool arguments/results, paths, session/message identifiers, retained histories and compaction summaries are omitted.

- Claude (`~/.claude/projects`): assistant `message.usage` splits input, cache reads and cache creation; `cache_creation.ephemeral_1h_input_tokens` identifies an hour-long write.
  The second assistant line is a read without a write.
  `compactMetadata.preTokens` is stale after compaction; `postTokens` is an explicit replacement count.
- Codex (`~/.codex/sessions`): `event_msg` / `token_count` exposes both `total_token_usage` and `last_token_usage`, plus the effective `model_context_window`.
  `cached_input_tokens` is already included in `input_tokens`.
  The captured `compacted` record in `codex-usage.jsonl` has `latest_token_usage_record: null`; no post-compaction count is available.
  `codex-compaction-reset.jsonl` captures a real compaction followed by a zero-input/output reset placeholder (`total_tokens: 25927`) and subsequent genuine usage (`input_tokens: 43002`).
  The reset's retained total is not measured input and is not displayed; cumulative totals are never a fallback.
  The compaction's `latest_token_usage_record.usage` is preserved as numeric evidence but is not treated as a post-compaction measurement.
- Pi (`~/.pi/agent/sessions`): assistant `message.usage` splits `input`, `cacheRead` and `cacheWrite`.
  `output`, `reasoning`, cost and `totalTokens` are not added to the displayed input count.
  The captured compaction only reports `tokensBefore`, not an after count.

The installed Pi provider catalog was inspected (`pi-ai`'s generated models and Pi's bundled provider records).
It describes provider capacity, not the effective window configured for a recorded session.
Claude and Pi lines contain no effective window, so their denominator is omitted.
Only Codex's recorded window is displayed.
Cache TTL is inferred only for native Claude records: hour writes establish an hour while active, otherwise five minutes; cache activity refreshes the active TTL.
Pi's generic usage does not record a TTL and Codex's token counters do not either, so neither gets a cache-temperature fact.
