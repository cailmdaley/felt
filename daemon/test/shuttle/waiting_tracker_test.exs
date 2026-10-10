defmodule Shuttle.WaitingTrackerTest do
  use ExUnit.Case, async: true

  alias Shuttle.EventStream

  @hour_ms 60 * 60 * 1_000
  # Ingestion clock. Events carry their OWN timestamp now (last-event-wins
  # records the event's real `timestamp`, not the poll wall-clock), so the
  # injected clock only matters for boot-seed pruning and the missing-timestamp
  # fallback. `@base` is the "now" the tracker sees on boot and per poll.
  @base 1_000_000_000_000

  setup do
    base = Path.join(System.tmp_dir!(), "waiting_tracker_#{System.unique_integer([:positive])}")
    events = base <> ".jsonl"
    File.write!(events, "")
    on_exit(fn -> File.rm(events) end)

    {:ok, events: events}
  end

  defp start(events) do
    name = :"waiting_tracker_#{System.unique_integer([:positive])}"

    start_supervised!(
      {EventStream, events_file: events, poll_interval_ms: 10, clock: fn -> @base end, name: name}
    )

    name
  end

  # Append an event carrying its own real timestamp (defaults to @base).
  defp append(events, type, session, ts \\ @base) do
    extra =
      if String.starts_with?(session, "cx-"),
        do: %{harness: "codex", sessionId: "parent"},
        else: %{}

    append_ev(events, type, session, Map.put(extra, :timestamp, ts))
  end

  # Write a line directly to disk BEFORE boot, to seed from a pre-existing file.
  defp prewrite(events, type, session, ts) do
    line = Jason.encode!(%{type: type, tmuxSession: session, timestamp: ts})
    File.write!(events, line <> "\n", [:append])
  end

  defp activity(name, session), do: Map.get(EventStream.session_activity(name), session)
  defp phase(name, session), do: (activity(name, session) || %{})[:phase]
  defp last_event_at(name, session), do: (activity(name, session) || %{})[:last_event_at]
  defp ingested?(name, session), do: not is_nil(activity(name, session))

  # Lines are ingested in file order, so once a line appended after the ones
  # under test has landed, those have been ingested too: a negative assertion
  # after this speaks for lines the tracker has read.
  defp barrier(events, name) do
    session = "barrier-01J00000000000000000000000-shuttle"
    append(events, "pre_tool_use", session)
    assert wait_until(fn -> ingested?(name, session) end)
  end

  # A ceiling of ~30 s, reached only when the condition never holds: a passing
  # test returns as soon as it does, however loaded the machine.
  defp wait_until(fun, tries \\ 3_000) do
    cond do
      fun.() ->
        true

      tries <= 0 ->
        false

      true ->
        Process.sleep(10)
        wait_until(fun, tries - 1)
    end
  end

  # ── Category derivation per last event type ──

  test "file delivery preserves waiting state and timestamp", %{events: events} do
    prewrite(events, "stop", "foo-01J00000000000000000000000-shuttle", @base - 1000)
    prewrite(events, "file_sent", "foo-01J00000000000000000000000-shuttle", @base)
    name = start(events)
    assert phase(name, "foo-01J00000000000000000000000-shuttle") == "waiting"
    assert last_event_at(name, "foo-01J00000000000000000000000-shuttle") == @base - 1000
  end

  test "another session ending in the pane leaves the worker's stop alone", %{events: events} do
    s = "foo-01J00000000000000000000000-shuttle"
    line = fn type, id, ts -> Jason.encode!(%{type: type, tmuxSession: s, sessionId: id, timestamp: ts}) <> "\n" end
    File.write!(events, line.("stop", "worker", @base - 1000) <> line.("session_end", "probe", @base), [:append])
    name = start(events)
    assert phase(name, s) == "waiting"
    assert last_event_at(name, s) == @base - 1000
  end

  test "a stop event yields phase \"waiting\"", %{events: events} do
    name = start(events)
    append(events, "stop", "foo-01J00000000000000000000000-shuttle")

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "waiting"
           end)
  end

  test "a notification event yields phase \"attention\"", %{events: events} do
    name = start(events)
    append(events, "notification", "foo-01J00000000000000000000000-shuttle")

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "attention"
           end)
  end

  test "a lone subagent_stop is not the session's activity", %{events: events} do
    name = start(events)
    append(events, "subagent_stop", "foo-01J00000000000000000000000-shuttle")
    append(events, "stop", "bar-01J00000000000000000000000-shuttle")

    assert wait_until(fn -> ingested?(name, "bar-01J00000000000000000000000-shuttle") end)
    refute ingested?(name, "foo-01J00000000000000000000000-shuttle")
  end

  for working_type <- ["pre_tool_use", "post_tool_use", "user_prompt_submit", "session_start"] do
    test "a #{working_type} event yields phase \"working\" (long-tool guard)",
         %{events: events} do
      name = start(events)
      append(events, unquote(working_type), "foo-01J00000000000000000000000-shuttle")

      assert wait_until(fn ->
               phase(name, "foo-01J00000000000000000000000-shuttle") == "working"
             end)
    end
  end

  # ── Last-event-wins (no sticky state machine) ──

  test "last event wins: stop then pre_tool_use reads as \"working\"", %{events: events} do
    name = start(events)
    append(events, "stop", "foo-01J00000000000000000000000-shuttle")

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "waiting"
           end)

    # A following tool call wins — the worker resumed, no stickiness keeps it idle.
    append(events, "pre_tool_use", "foo-01J00000000000000000000000-shuttle")

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "working"
           end)
  end

  test "untyped notification after stop reads as \"attention\"",
       %{events: events} do
    name = start(events)
    append(events, "stop", "foo-01J00000000000000000000000-shuttle")

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "waiting"
           end)

    # Untyped notifications retain the attention signal for harnesses that
    # do not report why they are notifying.
    append(events, "notification", "foo-01J00000000000000000000000-shuttle")

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "attention"
           end)
  end

  # ── Waiting on itself, not on you ────────────────────────────────────────

  # Extra fields the harness volunteers on a line (`backgroundTasks` on a stop,
  # `notificationKind` on a notification).
  defp append_ev(events, type, session, extra) do
    line =
      Jason.encode!(Map.merge(%{type: type, tmuxSession: session, timestamp: @base}, extra))

    File.write!(events, line <> "\n", [:append])
  end

  test "a stop that leaves detached shells running reads as \"working\"",
       %{events: events} do
    name = start(events)
    append_ev(events, "stop", "foo-01J00000000000000000000000-shuttle", %{backgroundTasks: 2})

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "working"
           end)
  end

  test "the idle timer over outstanding background work does not raise a hand",
       %{events: events} do
    name = start(events)
    append_ev(events, "stop", "foo-01J00000000000000000000000-shuttle", %{backgroundTasks: 1})

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "working"
           end)

    # The count is carried onto the notification, which knows nothing about the
    # shells on its own.
    append_ev(events, "notification", "foo-01J00000000000000000000000-shuttle", %{
      notificationKind: "idle_prompt"
    })

    barrier(events, name)
    assert phase(name, "foo-01J00000000000000000000000-shuttle") == "working"
  end

  test "an idle reminder remains waiting rather than demanding attention", %{events: events} do
    name = start(events)
    append(events, "stop", "foo-01J00000000000000000000000-shuttle")

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "waiting"
           end)

    append_ev(events, "notification", "foo-01J00000000000000000000000-shuttle", %{
      notificationKind: "idle_prompt",
      timestamp: @base + 1
    })

    assert wait_until(fn ->
             activity(name, "foo-01J00000000000000000000000-shuttle")[:last_event_at] == @base + 1
           end)

    assert phase(name, "foo-01J00000000000000000000000-shuttle") == "waiting"
  end

  test "a permission prompt is attention even over running background work",
       %{events: events} do
    name = start(events)
    append_ev(events, "stop", "foo-01J00000000000000000000000-shuttle", %{backgroundTasks: 2})

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "working"
           end)

    append_ev(events, "notification", "foo-01J00000000000000000000000-shuttle", %{
      notificationKind: "permission_prompt"
    })

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "attention"
           end)
  end

  test "resuming the session clears the outstanding count", %{events: events} do
    name = start(events)
    append_ev(events, "stop", "foo-01J00000000000000000000000-shuttle", %{backgroundTasks: 1})

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "working"
           end)

    # A prompt arrived (the shell reporting back, or a human). Whatever is still
    # running, the NEXT stop says so; until then nothing is outstanding.
    append(events, "user_prompt_submit", "foo-01J00000000000000000000000-shuttle")
    append(events, "stop", "foo-01J00000000000000000000000-shuttle")

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "waiting"
           end)
  end

  # ── A subagent's stop is not the session's ──

  test "a subagent finishing while the parent works keeps it working", %{events: events} do
    prewrite(events, "post_tool_use", "foo-01J00000000000000000000000-shuttle", @base - 2_000)
    prewrite(events, "subagent_stop", "foo-01J00000000000000000000000-shuttle", @base - 1_000)
    name = start(events)

    assert phase(name, "foo-01J00000000000000000000000-shuttle") == "working"
    assert last_event_at(name, "foo-01J00000000000000000000000-shuttle") == @base - 2_000
  end

  test "a background subagent returning does not read as waiting while the parent digests it",
       %{events: events} do
    name = start(events)
    append_ev(events, "stop", "foo-01J00000000000000000000000-shuttle", %{backgroundTasks: 1})

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "working"
           end)

    # The subagent's stop names no background work; the parent is still busy
    # with its result until its own next stop says otherwise.
    append(events, "subagent_stop", "foo-01J00000000000000000000000-shuttle", @base + 1_000)
    append(events, "pre_tool_use", "bar-01J00000000000000000000000-shuttle", @base + 2_000)

    assert wait_until(fn -> ingested?(name, "bar-01J00000000000000000000000-shuttle") end)
    assert phase(name, "foo-01J00000000000000000000000-shuttle") == "working"
    assert last_event_at(name, "foo-01J00000000000000000000000-shuttle") == @base
  end

  test "a subagent_stop during idleness keeps the idle phase and its age",
       %{events: events} do
    # The pattern Claude Code emits while a worker sits idle: stop, the idle
    # reminder a minute later, then a subagent_stop from its away summary.
    prewrite(events, "stop", "foo-01J00000000000000000000000-shuttle", @base - 180_000)

    line =
      Jason.encode!(%{
        type: "notification",
        notificationKind: "idle_prompt",
        tmuxSession: "foo-01J00000000000000000000000-shuttle",
        timestamp: @base - 120_000
      })

    File.write!(events, line <> "\n", [:append])
    prewrite(events, "subagent_stop", "foo-01J00000000000000000000000-shuttle", @base)
    name = start(events)

    assert phase(name, "foo-01J00000000000000000000000-shuttle") == "waiting"
    assert last_event_at(name, "foo-01J00000000000000000000000-shuttle") == @base - 120_000
  end

  # ── Codex: live spawned agents hold the turn ──

  @codex "cx-01J00000000000000000000000-shuttle"

  defp tool(events, type, tool, ts) do
    append_ev(events, type, @codex, %{
      tool: tool,
      timestamp: ts,
      harness: "codex",
      sessionId: "parent"
    })
  end

  test "a Codex stop over a live spawned agent stays working until the agent returns",
       %{events: events} do
    name = start(events)
    tool(events, "pre_tool_use", "collaborationspawn_agent", @base)
    tool(events, "post_tool_use", "collaborationspawn_agent", @base + 100)
    append(events, "stop", @codex, @base + 1_000)
    assert wait_until(fn -> last_event_at(name, @codex) == @base + 1_000 end)
    assert phase(name, @codex) == "working"

    # The child's own tool calls land on the parent's session; they refresh the
    # time without turning the parent's ended turn back into a running one.
    tool(events, "pre_tool_use", "Bash", @base + 2_000)
    tool(events, "post_tool_use", "Bash", @base + 3_000)
    assert wait_until(fn -> last_event_at(name, @codex) == @base + 3_000 end)
    assert phase(name, @codex) == "working"

    append(events, "subagent_stop", @codex, @base + 4_000)
    assert wait_until(fn -> phase(name, @codex) == "waiting" end)
    assert last_event_at(name, @codex) == @base + 4_000
  end

  test "a Codex parent that waits on its child in-turn reads working throughout",
       %{events: events} do
    name = start(events)
    tool(events, "post_tool_use", "collaborationspawn_agent", @base)
    tool(events, "pre_tool_use", "collaborationwait_agent", @base + 100)
    append(events, "subagent_stop", @codex, @base + 1_000)
    tool(events, "post_tool_use", "collaborationwait_agent", @base + 1_100)
    assert wait_until(fn -> last_event_at(name, @codex) == @base + 1_100 end)
    assert phase(name, @codex) == "working"

    append(events, "stop", @codex, @base + 2_000)
    assert wait_until(fn -> phase(name, @codex) == "waiting" end)
  end

  test "a prompt does not forget a Codex child still running", %{events: events} do
    name = start(events)
    tool(events, "post_tool_use", "collaborationspawn_agent", @base)
    append(events, "stop", @codex, @base + 100)
    append(events, "user_prompt_submit", @codex, @base + 200)
    append(events, "stop", @codex, @base + 300)
    assert wait_until(fn -> last_event_at(name, @codex) == @base + 300 end)
    assert phase(name, @codex) == "working"
  end

  test "a Codex child that never reports back cannot hold the turn past the bound",
       %{events: events} do
    tool(events, "post_tool_use", "collaborationspawn_agent", @base - 2 * @hour_ms)
    append(events, "stop", @codex, @base - 2 * @hour_ms + 100)
    name = start(events)
    assert phase(name, @codex) == "waiting"
  end

  test "idle reminders hold through child tools and the last of two children passes the turn" do
    alias Shuttle.WaitingTracker, as: Tracker

    spawn = %{
      "type" => "post_tool_use",
      "tool" => "collaborationspawn_agent",
      "harness" => "codex",
      "sessionId" => "parent",
      "tmuxSession" => @codex,
      "timestamp" => @base
    }

    sessions = %{} |> Tracker.apply_event(spawn, @base) |> Tracker.apply_event(spawn, @base)
    sessions = Tracker.apply_event(sessions, Map.put(spawn, "type", "stop"), @base)
    idle = spawn |> Map.put("type", "notification") |> Map.put("notificationKind", "idle_prompt")
    sessions = Tracker.apply_event(sessions, idle, @base)
    sessions = Tracker.apply_event(sessions, Map.put(spawn, "tool", "Bash"), @base)
    assert %{phase: "working"} = Tracker.phases(sessions, @base)[@codex]
    done = Map.put(spawn, "type", "subagent_stop")
    sessions = Tracker.apply_event(sessions, done, @base)
    assert %{phase: "working"} = Tracker.phases(sessions, @base)[@codex]
    sessions = Tracker.apply_event(sessions, done, @base)
    assert %{phase: "waiting"} = Tracker.phases(sessions, @base)[@codex]
  end

  test "real Codex hooks hold an idle parent through child tools and release on child stop" do
    events =
      Path.expand("../fixtures/whose_move/codex-hooks.jsonl", __DIR__)
      |> File.read!()
      |> String.split("\n", trim: true)
      |> Enum.map(&Jason.decode!/1)

    Enum.reduce(events, %{}, fn ev, sessions ->
      sessions = Shuttle.WaitingTracker.apply_event(sessions, ev, ev["timestamp"])
      phase = Shuttle.WaitingTracker.phases(sessions, ev["timestamp"])[ev["tmuxSession"]].phase
      assert phase == if(ev["type"] == "subagent_stop", do: "waiting", else: "working")
      sessions
    end)
  end

  test "a real Claude stop includes live background agents" do
    ev =
      Path.expand("../fixtures/whose_move/claude-stop.json", __DIR__)
      |> File.read!()
      |> Jason.decode!()

    sessions = Shuttle.WaitingTracker.apply_event(%{}, ev, ev["timestamp"])

    assert %{phase: "working"} =
             Shuttle.WaitingTracker.phases(sessions, ev["timestamp"])[ev["tmuxSession"]]
  end

  test "another harness or Codex session cannot inherit or retire live children" do
    alias Shuttle.WaitingTracker, as: Tracker

    spawn = %{
      "type" => "post_tool_use",
      "tool" => "collaborationspawn_agent",
      "harness" => "codex",
      "sessionId" => "parent",
      "tmuxSession" => @codex,
      "timestamp" => @base
    }

    stop = Map.put(spawn, "type", "stop")
    sessions = %{} |> Tracker.apply_event(spawn, @base) |> Tracker.apply_event(stop, @base)
    foreign_stop = stop |> Map.put("type", "subagent_stop") |> Map.put("sessionId", "nested")

    assert %{phase: "working"} =
             sessions
             |> Tracker.apply_event(foreign_stop, @base)
             |> Tracker.phases(@base)
             |> Map.fetch!(@codex)

    foreign_spawn = Map.put(spawn, "sessionId", "nested")
    replaced = Tracker.apply_event(sessions, foreign_spawn, @base)
    assert %{type: "post_tool_use", session_id: "nested", kids: 1} = replaced[@codex]
    # A stop from the old parent cannot retire the replacement's child.
    assert %{phase: "working"} =
             replaced
             |> Tracker.apply_event(Map.put(spawn, "type", "subagent_stop"), @base)
             |> Tracker.phases(@base)
             |> Map.fetch!(@codex)

    for ev <- [
          Map.put(stop, "sessionId", "other"),
          Map.put(stop, "harness", "claude-code"),
          Map.put(stop, "harness", "pi")
        ] do
      assert %{phase: "waiting"} =
               sessions
               |> Tracker.apply_event(ev, @base)
               |> Tracker.phases(@base)
               |> Map.fetch!(@codex)
    end
  end

  test "Codex permission prompts override live children and completion stays mid-turn" do
    alias Shuttle.WaitingTracker, as: Tracker

    spawn = %{
      "type" => "post_tool_use",
      "tool" => "collaborationspawn_agent",
      "harness" => "codex",
      "sessionId" => "parent",
      "tmuxSession" => @codex,
      "timestamp" => @base
    }

    sessions = Tracker.apply_event(%{}, spawn, @base)

    prompt =
      spawn |> Map.put("type", "notification") |> Map.put("notificationKind", "permission_prompt")

    sessions = Tracker.apply_event(sessions, prompt, @base)
    sessions = Tracker.apply_event(sessions, Map.put(spawn, "tool", "Bash"), @base)
    assert %{phase: "attention"} = Tracker.phases(sessions, @base)[@codex]
    sessions = Tracker.apply_event(sessions, Map.put(spawn, "type", "subagent_stop"), @base)
    assert %{phase: "attention"} = Tracker.phases(sessions, @base)[@codex]
    sessions = Tracker.apply_event(sessions, Map.put(spawn, "type", "user_prompt_submit"), @base)
    assert %{phase: "working"} = Tracker.phases(sessions, @base)[@codex]
  end

  test "the suppression expires: an endless task cannot silence a worker forever",
       %{events: events} do
    name = start(events)

    # A shell that never returns — a dev server, a tail. An hour later the
    # session has been quiet with nothing to show, and the board says so rather
    # than keeping the worker invisible.
    append_ev(events, "stop", "foo-01J00000000000000000000000-shuttle", %{
      backgroundTasks: 1,
      timestamp: @base - 61 * 60 * 1_000
    })

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "waiting"
           end)
  end

  test "a long build inside the bound stays quiet", %{events: events} do
    name = start(events)

    append_ev(events, "stop", "foo-01J00000000000000000000000-shuttle", %{
      backgroundTasks: 1,
      timestamp: @base - 30 * 60 * 1_000
    })

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "working"
           end)
  end

  test "a harness that names neither field behaves exactly as before",
       %{events: events} do
    name = start(events)
    append(events, "stop", "foo-01J00000000000000000000000-shuttle")

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "waiting"
           end)

    append(events, "notification", "foo-01J00000000000000000000000-shuttle")

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "attention"
           end)
  end

  # ── Real last_event_at, not poll wall-clock (pins the fake-timestamp fix) ──

  test "last_event_at is the event's own timestamp, not the ingest clock",
       %{events: events} do
    name = start(events)
    one_hour_ago = @base - @hour_ms
    append(events, "stop", "foo-01J00000000000000000000000-shuttle", one_hour_ago)

    assert wait_until(fn -> ingested?(name, "foo-01J00000000000000000000000-shuttle") end)
    assert last_event_at(name, "foo-01J00000000000000000000000-shuttle") == one_hour_ago
  end

  test "a line missing a timestamp falls back to the ingest clock", %{events: events} do
    name = start(events)
    line = Jason.encode!(%{type: "stop", tmuxSession: "foo-01J00000000000000000000000-shuttle"})
    File.write!(events, line <> "\n", [:append])

    assert wait_until(fn -> ingested?(name, "foo-01J00000000000000000000000-shuttle") end)
    assert last_event_at(name, "foo-01J00000000000000000000000-shuttle") == @base
  end

  # ── Boot seeding from a pre-written file (pins the stopped-before-boot fix) ──

  test "a session stopped before boot is known immediately, with its real time",
       %{events: events} do
    stopped_24h_ago = @base - 24 * @hour_ms
    prewrite(events, "stop", "stale-01J00000000000000000000000-shuttle", stopped_24h_ago)

    name = start(events)

    # No new append — it must already be there from the boot seed.
    act = activity(name, "stale-01J00000000000000000000000-shuttle")
    assert act != nil
    assert act.phase == "waiting"
    assert act.last_event_at == stopped_24h_ago
  end

  test "boot seed prunes a session older than 48h, keeps one just inside",
       %{events: events} do
    prewrite(events, "stop", "ancient-01J00000000000000000000000-shuttle", @base - 49 * @hour_ms)
    prewrite(events, "stop", "recent-01J00000000000000000000000-shuttle", @base - 47 * @hour_ms)

    name = start(events)

    refute ingested?(name, "ancient-01J00000000000000000000000-shuttle")
    assert ingested?(name, "recent-01J00000000000000000000000-shuttle")
  end

  test "boot seed honors last-event-wins across the whole file", %{events: events} do
    # stop, then notification, then pre_tool_use — the last one wins on seed.
    prewrite(events, "stop", "seed-01J00000000000000000000000-shuttle", @base - 3_000)
    prewrite(events, "notification", "seed-01J00000000000000000000000-shuttle", @base - 2_000)
    prewrite(events, "pre_tool_use", "seed-01J00000000000000000000000-shuttle", @base - 1_000)

    name = start(events)

    assert phase(name, "seed-01J00000000000000000000000-shuttle") == "working"
    assert last_event_at(name, "seed-01J00000000000000000000000-shuttle") == @base - 1_000
  end

  # ── Filtering / robustness (carried forward) ──

  test "non-shuttle sessions are ignored", %{events: events} do
    name = start(events)
    append(events, "notification", "my-interactive-session")
    barrier(events, name)
    refute ingested?(name, "my-interactive-session")
  end

  test "a partial line (no trailing newline yet) is not consumed until complete",
       %{events: events} do
    name = start(events)

    line =
      Jason.encode!(%{
        type: "notification",
        tmuxSession: "foo-01J00000000000000000000000-shuttle",
        timestamp: @base
      })

    File.write!(events, line, [:append])
    Process.sleep(40)
    refute ingested?(name, "foo-01J00000000000000000000000-shuttle")

    File.write!(events, "\n", [:append])

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "attention"
           end)
  end

  test "file truncation resets the tail offset without crashing", %{events: events} do
    name = start(events)
    append(events, "notification", "foo-01J00000000000000000000000-shuttle")

    assert wait_until(fn ->
             phase(name, "foo-01J00000000000000000000000-shuttle") == "attention"
           end)

    File.write!(events, "")
    # The tail must see the shrink before the next append: `bar`'s line is as
    # long as `foo`'s, so a truncate-and-rewrite it missed is invisible to it.
    assert wait_until(fn -> :sys.get_state(name).offset == 0 end)
    append(events, "notification", "bar-01J00000000000000000000000-shuttle")

    assert wait_until(fn ->
             phase(name, "bar-01J00000000000000000000000-shuttle") == "attention"
           end)

    # A truncated file cannot make a remembered session wrong, only unrefreshed.
    assert phase(name, "foo-01J00000000000000000000000-shuttle") == "attention"
  end
end
