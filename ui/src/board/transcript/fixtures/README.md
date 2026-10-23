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

# Hook-delivered thread notices

`claude-hook-thread-notices.jsonl` keeps the envelope of a real Claude Code `attachment` record (`hook_additional_context`, from a `UserPromptSubmit` hook, Claude Code 2.1.287, `~/.claude/projects` on 2026-10-22): its fields, the `content` array of strings, and the `rendered` system-reminder.
Claude Code stores hook context this way, never as a `<system-reminder>` inside a `user` record.
The content is what `shuttle hook` writes today (the peer-context preamble, then `messaging.Labeled` per message); no thread delivery through a hook had been recorded yet, so the thread ids, fibers and outcomes are written for the fixture.
The second line is a peer message quoting a thread line, which must stay ordinary context.

# Captured image tool results

`tool-result-images.jsonl` holds one tool call and its image result per harness, in the shapes read from real local transcripts on 2026-10-23: Claude's `Read` result (`tool_result` content `{type: 'image', source: {type: 'base64', media_type, data}}`, mirrored in `toolUseResult.file`), Pi's `read` `toolResult` (`{type: 'image', data, mimeType}` beside a text block) and Codex's `view_image` `function_call_output` (`[{type: 'input_image', image_url: 'data:…'}]`).
Paths, identifiers and the images themselves are replaced: every payload is the same 1×1 PNG, and the Pi and Codex calls stand in for the records that preceded the captured results.

# Captured queued messages

`claude-queued-messages.jsonl` holds four `queued_command` attachments from a real Claude Code session on 2026-10-22, the records Claude Code writes when a message arrives while the agent works: a human prompt as a string, a human prompt as blocks with a pasted image, another session's Shuttle message (`origin.kind: 'peer'`, `isMeta`) and a background task's notification.
Texts are shortened, sockets, ids and the session are replaced, and the image is a 1×1 PNG.
A message the worker has not yet taken in has no record at all: the chat shows it from the composer until a prompt with its words appears.

# Captured thread spawn

`claude-shuttle-thread-command.jsonl` is a real Bash call from a chair's Claude Code session on 2026-10-22 that opened two threads with `shuttle thread … --slug …` and nested them with `felt nest`, with its real result. Only the tool-use id is replaced.
