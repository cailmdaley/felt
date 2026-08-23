defmodule Shuttle.TokenSpend do
  @moduledoc """
  What a session cost, read out of its harness transcript.

  Claude Code stamps every assistant message with a `usage` block — the four
  counters the API bills on (`input_tokens`, `output_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`) — and pi does the
  same under its own names (`input`, `output`, `cacheRead`, `cacheWrite`). The
  Codex rollout instead emits cumulative `event_msg/token_count` snapshots;
  those are read as snapshots, never summed. The transcript therefore already
  holds the answer to "what did this session spend"; nothing has to be
  inferred, modelled, or priced. This module folds one session's transcript
  into one bounded observation, and
  `Shuttle.SessionLedger` supplies the fiber the session belonged to, so the
  same fold rolls up per fiber. The Claude and pi shapes meet (and are
  translated) in `usage_of/1`; the Codex snapshot is folded separately because
  its cumulative semantics are different, and the rest of the fold never
  needs to know which harness wrote the file.

  ## Collection never depends on inference

  Trails-shaped, like the ledger: what is written is what was observed. A
  missing transcript is reported as `found: false` with zeroed counters, never
  as an estimate and never as an error. A session the ledger does not know
  about is simply not in the rollup — this module answers about the sessions it
  is asked about, and the endpoint asks about ledgered ones.

  ## The double-count trap

  An assistant turn is written as **one record per content block**, and every
  one of those records repeats the same `message.usage`. A busy session shows
  ~700 usage-bearing lines for ~330 real messages. Folding line by line would
  overcount by more than 2×, so records are deduplicated on `message.id`; the
  first record carrying an id wins and later repeats are skipped. A record with
  a usage block and no id is counted once on its own (nothing else can be
  confused with it).

  Sidechain records (`isSidechain: true`, the subagent turns Claude Code writes
  into the parent session's file) ARE counted: a subagent's tokens are spent by
  the session that launched it, and that is the number the owner asked for.

  ## Caching

  Transcripts are append-only and reach several MB; the endpoint resolves many
  sessions per request and is polled. Each fold is cached in an ETS table keyed
  by session uuid and validated on `{mtime, size}` of the transcript, so an
  unchanged file is answered from memory and a grown one is re-read whole. A
  full re-read on change is deliberate — an incremental fold would have to
  reason about partial lines at the previous end-of-file, and a whole re-read
  of a file that just changed is the cheap half of the polling loop anyway.

  The table is owned by this module's GenServer; when it is not running, folds
  still happen, just uncached. Nothing here raises.
  """

  use GenServer
  require Logger

  alias Shuttle.Moment

  @table :shuttle_token_spend

  @typedoc "One session's spend, as folded and as served."
  @type spend :: %{
          session: String.t(),
          found: boolean(),
          input: non_neg_integer(),
          output: non_neg_integer(),
          cache_read: non_neg_integer(),
          cache_write: non_neg_integer(),
          messages: non_neg_integer(),
          first_at_ms: integer() | nil,
          last_at_ms: integer() | nil,
          models: %{String.t() => map()}
        }

  # ── Client ──

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  The spend for `session`, from cache when the transcript has not changed.

  Returns a zeroed observation with `found: false` for an unknown session, a
  non-UUID string, a harness transcript with no usage records, or a file that
  vanished mid-read. Never raises.

  Opts (for tests): `:root`, `:pi_root`, `:codex_root` (transcript roots),
  `:cache` (false to bypass).
  """
  @spec for_session(String.t() | nil, keyword()) :: spend()
  def for_session(session, opts \\ [])

  def for_session(session, opts) when is_binary(session) do
    case Moment.transcript_path(session, opts) do
      nil ->
        empty(session)

      path ->
        token = file_token(path)

        case cached(session, path, token, opts) do
          {:ok, spend} -> spend
          :miss -> fold_and_cache(session, path, token, opts)
        end
    end
  end

  def for_session(_session, _opts), do: empty(nil)

  @doc """
  Sum a list of spends into one — the per-fiber rollup's arithmetic, and the
  only place the counters are added, so the endpoint cannot drift from a fold.

  `found` is not summed: absence is per-session and the rollup reports counts.
  """
  @spec total([spend()]) :: map()
  def total(spends) when is_list(spends) do
    Enum.reduce(spends, blank_total(), fn spend, acc ->
      %{
        sessions: acc.sessions + 1,
        input: acc.input + spend.input,
        output: acc.output + spend.output,
        cache_read: acc.cache_read + spend.cache_read,
        cache_write: acc.cache_write + spend.cache_write,
        messages: acc.messages + spend.messages,
        first_at_ms: min_ms(acc.first_at_ms, spend.first_at_ms),
        last_at_ms: max_ms(acc.last_at_ms, spend.last_at_ms)
      }
    end)
  end

  @doc "A zeroed observation for `session` — what an unreadable transcript costs."
  @spec empty(String.t() | nil) :: spend()
  def empty(session) do
    %{
      session: session,
      found: false,
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      messages: 0,
      first_at_ms: nil,
      last_at_ms: nil,
      models: %{}
    }
  end

  # ── Server (cache owner only) ──

  @impl true
  def init(_opts) do
    table =
      :ets.new(@table, [
        :named_table,
        :public,
        :set,
        read_concurrency: true,
        write_concurrency: true
      ])

    {:ok, %{table: table}}
  end

  # ── Cache ──

  defp cached(session, path, token, opts) do
    if Keyword.get(opts, :cache, true) do
      lookup(session, path, token)
    else
      :miss
    end
  end

  defp lookup(session, path, token) do
    case :ets.lookup(@table, session) do
      [{^session, ^path, ^token, spend}] when not is_nil(token) -> {:ok, spend}
      _ -> :miss
    end
  rescue
    ArgumentError -> :miss
  end

  defp fold_and_cache(session, path, token, opts) do
    spend = fold(session, path)

    if Keyword.get(opts, :cache, true) and not is_nil(token) do
      :ets.insert(@table, {session, path, token, spend})
    end

    spend
  rescue
    ArgumentError -> fold(session, path)
  end

  defp file_token(path) do
    case File.stat(path, time: :posix) do
      {:ok, %File.Stat{type: :regular, mtime: mtime, size: size}} -> {mtime, size}
      _ -> nil
    end
  end

  # ── The fold ──

  defp fold(session, path) do
    {spend, _seen, codex} =
      path
      |> File.stream!()
      |> Enum.reduce(
        {%{empty(session) | found: true}, MapSet.new(), codex_state()},
        &absorb/2
      )

    spend
    |> add_codex(codex)
  rescue
    # Vanished, unreadable, or rewritten mid-read. An unreadable transcript is
    # an absence, not a failure: the endpoint reports it and stays 200.
    error ->
      Logger.debug("token spend: skipped #{path} — #{Exception.message(error)}")
      empty(session)
  end

  defp absorb(line, {acc, seen, codex} = unchanged) do
    case Jason.decode(line) do
      {:ok, record} ->
        codex = absorb_codex(codex, record)

        case usage_of(record) do
          {:ok, input, output, cache_r, cache_w, id, model, at_ms} ->
            if counted?(id, seen) do
              {acc, seen, codex}
            else
              {add(acc, input, output, cache_r, cache_w, model, at_ms), remember(seen, id), codex}
            end

          :skip ->
            {acc, seen, codex}
        end

      _ ->
        unchanged
    end
  end

  # The one place the Claude and pi shapes meet. Claude stamps every assistant
  # record with `message.usage` in API counter names and dedups on
  # `message.id` (one record per content block — see the double-count trap).
  # Pi nests the turn under `"message"` with its own counter names
  # (`cacheRead`, `cacheWrite`), one record per turn with `responseId` as the
  # identity. Both normalize here into `{usage-in-claude-keys, id, model,
  # at_ms}`, so the fold below never heard of a harness.
  defp usage_of(%{"type" => "message", "message" => %{"role" => "assistant"} = msg} = record) do
    usage = msg["usage"] || %{}

    {:ok, count(usage, "input"), count(usage, "output"), count(usage, "cacheRead"),
     count(usage, "cacheWrite"), msg["responseId"], msg["model"], at_ms(record)}
  end

  defp usage_of(%{"message" => %{"usage" => usage} = message} = record) when is_map(usage) do
    {:ok, count(usage, "input_tokens"), count(usage, "output_tokens"),
     count(usage, "cache_read_input_tokens"), count(usage, "cache_creation_input_tokens"),
     message["id"], message["model"], at_ms(record)}
  end

  defp usage_of(_), do: :skip

  # Codex emits a running total after each turn. Keep the latest total and
  # count assistant message items separately; summing every snapshot would turn
  # a session's spend into the sum of all its prefixes. Model breakdowns are
  # only reported when one model is named for the whole file: a cumulative
  # total cannot honestly be divided between models after a switch.
  defp codex_state do
    %{
      snapshot: nil,
      models: MapSet.new(),
      messages: 0,
      message_ids: MapSet.new(),
      first_at_ms: nil,
      last_at_ms: nil
    }
  end

  defp absorb_codex(state, %{"type" => "turn_context", "payload" => %{"model" => model}})
       when is_binary(model) do
    %{state | models: MapSet.put(state.models, model)}
  end

  defp absorb_codex(state, %{
         "type" => "response_item",
         "payload" => %{"type" => "message", "role" => "assistant", "id" => id}
       })
       when is_binary(id) do
    if MapSet.member?(state.message_ids, id) do
      state
    else
      %{state | messages: state.messages + 1, message_ids: MapSet.put(state.message_ids, id)}
    end
  end

  defp absorb_codex(state, %{
         "type" => "response_item",
         "payload" => %{"type" => "message", "role" => "assistant"}
       }) do
    %{state | messages: state.messages + 1}
  end

  defp absorb_codex(
         state,
         %{
           "type" => "event_msg",
           "payload" => %{
             "type" => "token_count",
             "info" => %{"total_token_usage" => usage}
           }
         } = record
       )
       when is_map(usage) do
    at_ms = at_ms(record)

    %{
      state
      | snapshot: usage,
        first_at_ms: min_ms(state.first_at_ms, at_ms),
        last_at_ms: max_ms(state.last_at_ms, at_ms)
    }
  end

  defp absorb_codex(state, _record), do: state

  defp add_codex(acc, %{snapshot: nil}), do: acc

  defp add_codex(acc, state) do
    counts = %{
      # Codex's `input_tokens` includes the cached prefix. Keep the same
      # orthogonal axes Claude exposes: uncached input, cache read, cache
      # write, and output. Reasoning output is already part of `output_tokens`;
      # adding it again would double-count the response.
      input:
        max(
          count(state.snapshot, "input_tokens") - count(state.snapshot, "cached_input_tokens"),
          0
        ),
      output: count(state.snapshot, "output_tokens"),
      cache_read: count(state.snapshot, "cached_input_tokens"),
      cache_write: count(state.snapshot, "cache_write_input_tokens")
    }

    models =
      case MapSet.to_list(state.models) do
        [model] -> merge_model(acc.models, model, counts, state.messages)
        _ -> acc.models
      end

    %{
      acc
      | input: acc.input + counts.input,
        output: acc.output + counts.output,
        cache_read: acc.cache_read + counts.cache_read,
        cache_write: acc.cache_write + counts.cache_write,
        messages: acc.messages + state.messages,
        first_at_ms: min_ms(acc.first_at_ms, state.first_at_ms),
        last_at_ms: max_ms(acc.last_at_ms, state.last_at_ms),
        models: models
    }
  end

  defp merge_model(models, model, counts, messages) when is_binary(model) do
    model_counts = Map.put(counts, :messages, messages)

    Map.update(models, model, model_counts, fn prior ->
      %{
        input: prior.input + model_counts.input,
        output: prior.output + model_counts.output,
        cache_read: prior.cache_read + model_counts.cache_read,
        cache_write: prior.cache_write + model_counts.cache_write,
        messages: prior.messages + model_counts.messages
      }
    end)
  end

  defp merge_model(models, _model, _counts, _messages), do: models

  defp counted?(id, seen) when is_binary(id), do: MapSet.member?(seen, id)
  defp counted?(_id, _seen), do: false

  defp remember(seen, id) when is_binary(id), do: MapSet.put(seen, id)
  defp remember(seen, _id), do: seen

  defp add(acc, input, output, cache_read, cache_write, model, at_ms) do
    counts = %{
      input: input,
      output: output,
      cache_read: cache_read,
      cache_write: cache_write
    }

    %{
      acc
      | input: acc.input + counts.input,
        output: acc.output + counts.output,
        cache_read: acc.cache_read + counts.cache_read,
        cache_write: acc.cache_write + counts.cache_write,
        messages: acc.messages + 1,
        first_at_ms: min_ms(acc.first_at_ms, at_ms),
        last_at_ms: max_ms(acc.last_at_ms, at_ms),
        models: bump_model(acc.models, model, counts)
    }
  end

  defp count(usage, key) do
    case Map.get(usage, key) do
      n when is_integer(n) and n > 0 -> n
      _ -> 0
    end
  end

  # Per-model breakdown, because a fable token and a haiku token are not the
  # same token and the difference is the whole reason to look. Bounded by the
  # number of distinct models one session used — a handful.
  defp bump_model(models, model, counts) when is_binary(model) do
    Map.update(
      models,
      model,
      Map.put(counts, :messages, 1),
      fn prior ->
        %{
          input: prior.input + counts.input,
          output: prior.output + counts.output,
          cache_read: prior.cache_read + counts.cache_read,
          cache_write: prior.cache_write + counts.cache_write,
          messages: prior.messages + 1
        }
      end
    )
  end

  defp bump_model(models, _model, _counts), do: models

  defp at_ms(%{"timestamp" => stamp}) when is_binary(stamp) do
    case DateTime.from_iso8601(stamp) do
      {:ok, dt, _offset} -> DateTime.to_unix(dt, :millisecond)
      _ -> nil
    end
  end

  defp at_ms(%{"timestamp" => stamp}) when is_integer(stamp), do: stamp
  defp at_ms(_), do: nil

  defp blank_total do
    %{
      sessions: 0,
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      messages: 0,
      first_at_ms: nil,
      last_at_ms: nil
    }
  end

  defp min_ms(nil, b), do: b
  defp min_ms(a, nil), do: a
  defp min_ms(a, b), do: min(a, b)

  defp max_ms(nil, b), do: b
  defp max_ms(a, nil), do: a
  defp max_ms(a, b), do: max(a, b)
end
