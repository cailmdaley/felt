defmodule Shuttle.TranscriptUsage do
  @moduledoc """
  The latest usage facts of a native transcript, read from its tail.

  A read starts with the last 256 KiB and widens fourfold up to 16 MiB until
  the tail holds a usage record or a compaction, so a huge file costs what its
  last turns cost. Every fact is therefore a fact about the tail: `hit_share`
  covers the turns it holds, and an hour-long cache established before it reads
  as five minutes until the next hour-long write.

    * `context` — the prompt's tokens at the latest turn: Claude and Pi split
      input, cache reads and cache writes; Codex's cached input is already part
      of its input. A compaction replaces it with the count it records, or
      leaves it unknown, and a Codex reset carries no measured input.
    * `window` — the context window, which only Codex records.
    * `cached` — the tokens that turn read from the prompt cache.
    * `cache_warm_until` — epoch ms. Only Claude's native usage establishes a
      TTL: an hour after an hour-long write or a read of a live hour-long
      entry, otherwise five minutes. A compaction forgets it.
    * `hit_share` — the share of the tail's context tokens read from the cache.
    * `at` — epoch ms of the latest record.
  """

  alias Shuttle.FileTail

  @first_tail_bytes 262_144
  @max_tail_bytes 16_777_216
  @hour_ms 3_600_000
  @short_ms 300_000

  @empty %{
    context: nil,
    window: nil,
    cached: nil,
    at: nil,
    hour_until: nil,
    short_until: nil,
    warm_until: nil,
    read_tokens: 0,
    context_tokens: 0
  }

  @doc "The latest usage in the transcript at `path`, or `nil` when its tail holds none."
  @spec read(Path.t(), String.t() | nil) :: map() | nil
  def read(path, harness), do: read_tail(path, harness, @first_tail_bytes)

  defp read_tail(path, harness, bytes) do
    {lines, whole?} = FileTail.last_lines(path, bytes)

    case Enum.flat_map(lines, &line_entries(&1, harness)) do
      [] when not whole? and bytes < @max_tail_bytes -> read_tail(path, harness, bytes * 4)
      [] -> nil
      entries -> entries |> Enum.reduce(@empty, &apply_entry/2) |> summary()
    end
  end

  defp line_entries(line, harness) do
    case Jason.decode(line) do
      {:ok, record} -> entries(harness, record)
      {:error, _} -> []
    end
  end

  defp entries("claude-code", %{"isSidechain" => true}), do: []

  defp entries("claude-code", %{"type" => "system", "subtype" => "compact_boundary"} = record),
    do: [reset(record, count(record["compactMetadata"]["postTokens"]))]

  # A `<synthetic>` record is Claude Code's own stand-in reply; no model read a prompt for it.
  defp entries("claude-code", %{"type" => "assistant", "message" => %{"model" => "<synthetic>"}}),
    do: []

  defp entries("claude-code", %{"type" => "assistant", "message" => %{"usage" => %{} = u}} = r) do
    read = u["cache_read_input_tokens"]
    write = u["cache_creation_input_tokens"]

    [
      %{
        kind: :usage,
        at: time(r),
        context: sum([u["input_tokens"], read, write]),
        cached: count(read),
        cache: %{
          read: count(read) || 0,
          write: count(write) || 0,
          hour_write: count(u["cache_creation"]["ephemeral_1h_input_tokens"]) || 0
        }
      }
    ]
  end

  defp entries("pi", %{"type" => type} = record) when type in ["compaction", "context_edit"],
    do: [reset(record, nil)]

  defp entries("pi", %{"type" => "message", "message" => %{"role" => "assistant"} = message} = r) do
    case message do
      %{"stopReason" => reason} when reason in ["error", "aborted"] ->
        []

      %{"usage" => %{} = u} ->
        context = sum([u["input"], u["cacheRead"], u["cacheWrite"]])
        [%{kind: :usage, at: time(r), context: context, cached: count(u["cacheRead"])}]

      _ ->
        []
    end
  end

  defp entries("codex", %{"type" => "compacted"} = record), do: [reset(record, nil)]

  defp entries("codex", %{"type" => "event_msg", "payload" => %{"type" => type} = payload} = r) do
    case {type, payload} do
      {"context_compacted", _} ->
        [reset(r, nil)]

      {"token_count", %{"info" => %{"last_token_usage" => %{} = usage} = info}} ->
        [codex_usage(r, usage, info)]

      _ ->
        []
    end
  end

  defp entries(_harness, _record), do: []

  defp codex_usage(record, usage, info) do
    # A compaction reset reports a retained total with no measured input or output.
    reset_only? =
      usage["input_tokens"] == 0 and usage["output_tokens"] == 0 and
        (count(usage["total_tokens"]) || 0) > 0

    %{
      kind: :usage,
      at: time(record),
      context: if(!reset_only?, do: count(usage["input_tokens"])),
      window: count(info["model_context_window"]),
      cached: if(!reset_only?, do: count(usage["cached_input_tokens"]))
    }
  end

  defp reset(record, context), do: %{kind: :reset, at: time(record), context: context}

  defp apply_entry(%{kind: :reset} = entry, state) do
    %{
      state
      | context: entry.context,
        cached: nil,
        at: entry.at || state.at,
        hour_until: nil,
        short_until: nil,
        warm_until: nil
    }
  end

  defp apply_entry(%{kind: :usage} = entry, state) do
    %{
      state
      | context: entry.context,
        window: entry[:window],
        cached: entry.cached,
        at: entry.at || state.at
    }
    |> add_hit(entry)
    |> apply_cache(entry[:cache], entry.at)
  end

  defp add_hit(state, %{cached: cached, context: context})
       when is_number(cached) and is_number(context) and context > 0 do
    %{
      state
      | read_tokens: state.read_tokens + min(cached, context),
        context_tokens: state.context_tokens + context
    }
  end

  defp add_hit(state, _entry), do: state

  defp apply_cache(state, %{read: read, write: write, hour_write: hour_write}, at)
       when is_integer(at) and (read > 0 or write > 0) do
    hour_read? = read > 0 and state.hour_until != nil and state.hour_until > at
    hour? = hour_write > 0 or hour_read?
    short? = write > hour_write or (read > 0 and not hour_read?)
    hour_until = if hour?, do: at + @hour_ms, else: state.hour_until
    short_until = if short?, do: at + @short_ms, else: state.short_until

    %{
      state
      | hour_until: hour_until,
        short_until: short_until,
        warm_until: max(hour_until || 0, short_until || 0)
    }
  end

  defp apply_cache(state, _cache, _at), do: state

  defp summary(state) do
    %{
      context: state.context,
      window: state.window,
      cached: state.cached,
      cache_warm_until: state.warm_until,
      hit_share: hit_share(state),
      at: state.at
    }
    |> Map.reject(fn {_key, value} -> is_nil(value) end)
  end

  defp hit_share(%{context_tokens: 0}), do: nil
  defp hit_share(state), do: Float.round(state.read_tokens / state.context_tokens, 3)

  defp sum(values) do
    counts = Enum.map(values, &count/1)
    if Enum.all?(counts), do: Enum.sum(counts)
  end

  defp count(value) when is_number(value) and value >= 0, do: value
  defp count(_value), do: nil

  defp time(%{"timestamp" => stamp}) when is_binary(stamp) do
    case DateTime.from_iso8601(stamp) do
      {:ok, datetime, _offset} -> DateTime.to_unix(datetime, :millisecond)
      {:error, _} -> nil
    end
  end

  defp time(_record), do: nil
end
