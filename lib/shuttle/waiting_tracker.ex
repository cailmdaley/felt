defmodule Shuttle.WaitingTracker do
  @moduledoc """
  Tracks the *most recent hook event* per worker session by tailing this host's
  Claude Code hook-event stream (`~/.portolan/data/events.jsonl`), so the feed
  can rank in-flight workers by how long they've been idle.

  ## Why tail the local stream

  `~/loom/hooks/portolan-hook.sh` already appends every Claude Code hook event
  to a host-local `events.jsonl` on every machine a worker runs on. The owning
  daemon stamps runtime liveness for *its own* fibers (local daemon for local
  workers, the remote daemon for remote workers — the resolve/invoke split in
  the composite feed). So the simplest transport that respects that split is:
  **each daemon tails its own host's `events.jsonl`** and contributes the real
  last-activity timestamp + a `phase` category to the runtime block it already
  serves. No new cross-host channel — the signal rides the same per-host
  runtime stamping that `tmux_session` liveness already does.

  ## Last-event-wins (no state machine)

  Each tracked session holds exactly one record — `%{type: String.t(), at: ms}`
  — the **raw type and real timestamp of its most recent event**. Every event
  unconditionally overwrites it; there is no sticky/kind state machine.
  Escalation falls out of the natural event order: Claude Code fires the idle
  `notification` hook *after* the `stop`, so a long-idle worker becomes
  `attention` on its own.

  `at` is the event's **own** `timestamp` (epoch ms carried on every hook line),
  not the poll wall-clock — that's what makes idle-duration ranking real.

  ## Phase category, derived at READ time

  `session_activity/1` resolves each stored record to `%{last_event_at, phase}`,
  where `phase` is the category of the last event type:

    * `notification` → `"attention"` (the agent blocked on a human — idle
      prompt, permission, MCP elicitation).
    * `stop` / `subagent_stop` → `"waiting"` (a turn or subagent finished;
      the agent is idle, waiting on the next input).
    * anything else — `pre_tool_use`, `post_tool_use`, `user_prompt_submit`,
      `session_start`, … → `"working"`. This is the **long-tool guard**: a
      worker mid-tool (last event `pre_tool_use`, no following stop) is
      `"working"` no matter how long ago that event fired, so it sorts to the
      bottom of the in-flight column rather than masquerading as idle.

  Idle gating lives on the client, not here: the daemon reports the category
  and the real timestamp, and the client computes idle (`clientNow -
  last_event_at`) to decide whether to show a chip. Folding `subagent_stop`
  into `"waiting"` is
  deliberate under last-event-wins: a worker that just got a subagent result
  reads as `"waiting"` until its next `pre_tool_use`, which CC emits quickly.

  Self-healing: `Shuttle.Poller.stamp_runtime/2` only stamps for sessions still
  in `state.running`, so a dead worker's record is harmless. The age prune
  (`@max_age_ms`, 48h) is hygiene for the rare session that dies stale.

  ## Reading the past (boot seeding)

  On boot the tracker SEEDS from the existing `events.jsonl` in a single forward
  pass (last-event-wins, pruning sessions whose last event is older than
  `@max_age_ms`), THEN tails forward from the file's current end. So a worker
  that stopped before the daemon restarted — e.g. a review left idle 24h ago —
  is known on the very first serve, instead of being invisible until its next
  event (which, being idle, may never come).

  Only `*-shuttle` sessions are tracked; events from interactive (non-shuttle)
  sessions are ignored, mirroring the dispatch gate.
  """

  use GenServer
  require Logger

  @poll_interval_ms 1_000
  @max_age_ms 48 * 60 * 60 * 1_000
  @shuttle_session_suffix "-shuttle"

  defmodule State do
    @moduledoc false
    # `sessions` is `session => %{type: String.t(), at: ms}` — the raw type and
    # real timestamp of the session's most recent hook event (last-event-wins).
    # `clock` is a 0-arity fn returning the current epoch ms (injectable for tests).
    defstruct [:events_file, :poll_interval_ms, :clock, offset: 0, sessions: %{}]
  end

  # ── Client ──

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  A `session => %{last_event_at: ms, phase: phase}` map over every tracked
  `*-shuttle` session, where `last_event_at` is the real timestamp of the
  session's most recent hook event and `phase` is its category — `"attention"`,
  `"waiting"`, or `"working"` (see the moduledoc). The caller (poller) joins
  this against `state.running` in O(1) and computes idle from `last_event_at`;
  no gating happens here. Defaults to the singleton tracker; pass a pid/name
  for tests.
  """
  @spec session_activity(GenServer.server()) ::
          %{optional(String.t()) => %{last_event_at: integer(), phase: String.t()}}
  def session_activity(server \\ __MODULE__) do
    GenServer.call(server, :session_activity)
  catch
    :exit, _ -> %{}
  end

  @doc """
  Default host-local events stream path, honoring the same env the hook writes.

  Shuttle owns its own stream: `SHUTTLE_EVENTS_FILE`, else
  `$SHUTTLE_DATA_DIR/events.jsonl`, default `~/.shuttle/events.jsonl` — written by
  `~/loom/hooks/shuttle-hook.sh` (registered by `loom/setup.sh`).
  """
  def default_events_file do
    System.get_env("SHUTTLE_EVENTS_FILE") ||
      Path.join(
        System.get_env("SHUTTLE_DATA_DIR") ||
          Path.join(System.user_home!() || "/root", ".shuttle"),
        "events.jsonl"
      )
  end

  # ── Server ──

  @impl true
  def init(opts) do
    events_file = Keyword.get(opts, :events_file, default_events_file())
    poll_interval_ms = Keyword.get(opts, :poll_interval_ms, @poll_interval_ms)
    clock = Keyword.get(opts, :clock, &default_clock/0)

    # Seed last-event-per-session from the existing file, then tail forward from
    # its current end. A worker idle since before this boot is known immediately.
    {sessions, offset} = seed_from_file(events_file, clock.())

    schedule_poll(poll_interval_ms)

    {:ok,
     %State{
       events_file: events_file,
       poll_interval_ms: poll_interval_ms,
       clock: clock,
       offset: offset,
       sessions: sessions
     }}
  end

  # Single forward pass over the whole file building last-event-per-session
  # (last-event-wins, so the plain reduce naturally keeps the final event),
  # pruning sessions whose last event is older than @max_age_ms. Returns the
  # seeded sessions and the byte offset to resume tailing from (EOF). Reuses
  # `apply_event`, so blank/malformed lines are ignored the same way the tail
  # ignores them — one parse path.
  defp seed_from_file(path, now) do
    case File.read(path) do
      {:ok, contents} ->
        sessions =
          contents
          |> String.split("\n", trim: true)
          |> Enum.reduce(%{}, &apply_event(&1, &2, now))
          |> prune_old(now)

        {sessions, byte_size(contents)}

      _ ->
        {%{}, 0}
    end
  end

  @impl true
  def handle_call(:session_activity, _from, state) do
    result =
      Map.new(state.sessions, fn {session, %{type: type, at: at}} ->
        {session, %{last_event_at: at, phase: category(type)}}
      end)

    {:reply, result, state}
  end

  # The phase category of the most-recent event type. The catch-all is the
  # long-tool guard: anything that isn't an explicit idle/escalation signal
  # (pre_tool_use, post_tool_use, user_prompt_submit, session_start, …) is
  # "working", so a mid-tool worker sinks to the bottom regardless of wall-clock.
  defp category("notification"), do: "attention"
  defp category(type) when type in ["stop", "subagent_stop"], do: "waiting"
  defp category(_), do: "working"

  @impl true
  def handle_info(:poll, state) do
    state =
      state
      |> ingest_new_lines()
      |> update_in([Access.key(:sessions)], &prune_old(&1, now_ms(state)))

    schedule_poll(state.poll_interval_ms)
    {:noreply, state}
  end

  defp schedule_poll(ms), do: Process.send_after(self(), :poll, ms)

  # Read bytes appended since the last offset; reset to 0 if the file shrank
  # (truncation / rotation). A missing file leaves state untouched.
  defp ingest_new_lines(%State{events_file: path, offset: offset} = state) do
    case File.stat(path) do
      {:ok, %{size: size}} when size > offset ->
        case read_range(path, offset, size - offset) do
          {:ok, chunk} ->
            # Consume only up to the last newline; a trailing partial line (a
            # record still being written) is left unconsumed so the next poll
            # re-reads it whole. Advancing past it would silently drop the event.
            case :binary.matches(chunk, "\n") do
              [] ->
                state

              matches ->
                {last_nl, _} = List.last(matches)
                consumed = last_nl + 1
                complete = binary_part(chunk, 0, consumed)
                now = now_ms(state)

                sessions =
                  Enum.reduce(
                    String.split(complete, "\n", trim: true),
                    state.sessions,
                    &apply_event(&1, &2, now)
                  )

                %{state | offset: offset + consumed, sessions: sessions}
            end

          _ ->
            state
        end

      {:ok, %{size: size}} when size < offset ->
        %{state | offset: size}

      _ ->
        state
    end
  end

  defp read_range(path, offset, length) do
    with {:ok, file} <- File.open(path, [:read, :binary]) do
      try do
        :file.position(file, offset)
        case :file.read(file, length) do
          {:ok, data} -> {:ok, data}
          other -> other
        end
      after
        File.close(file)
      end
    end
  end

  # Last-event-wins: every event for a `*-shuttle` session unconditionally
  # overwrites its record with the event's own type and real timestamp. The
  # `"timestamp"` field is on every hook line; `now` is only a fallback for a
  # line missing it (shouldn't happen, but we never invent a worse-than-now age).
  defp apply_event(line, sessions, now) do
    case Jason.decode(line) do
      {:ok, %{"type" => type, "tmuxSession" => session} = ev}
      when is_binary(type) and is_binary(session) and session != "" ->
        if shuttle_session?(session) do
          at =
            case Map.get(ev, "timestamp") do
              ts when is_integer(ts) -> ts
              _ -> now
            end

          Map.put(sessions, session, %{type: type, at: at})
        else
          sessions
        end

      _ ->
        sessions
    end
  end

  defp prune_old(sessions, now) do
    cutoff = now - @max_age_ms
    Map.reject(sessions, fn {_s, %{at: at}} -> at < cutoff end)
  end

  defp shuttle_session?(session), do: String.ends_with?(session, @shuttle_session_suffix)

  defp now_ms(%State{clock: clock}) when is_function(clock, 0), do: clock.()
  defp now_ms(%State{}), do: default_clock()

  defp default_clock, do: System.system_time(:millisecond)
end
