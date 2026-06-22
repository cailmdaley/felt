defmodule Shuttle.WaitingTrackerTest do
  use ExUnit.Case, async: false

  alias Shuttle.WaitingTracker

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

    {:ok, pid} =
      WaitingTracker.start_link(
        events_file: events,
        poll_interval_ms: 10,
        clock: fn -> @base end,
        name: name
      )

    on_exit(fn -> if Process.alive?(pid), do: GenServer.stop(pid) end)
    name
  end

  # Append an event carrying its own real timestamp (defaults to @base).
  defp append(events, type, session, ts \\ @base) do
    line = Jason.encode!(%{type: type, tmuxSession: session, timestamp: ts})
    File.write!(events, line <> "\n", [:append])
  end

  # Write a line directly to disk BEFORE boot, to seed from a pre-existing file.
  defp prewrite(events, type, session, ts) do
    line = Jason.encode!(%{type: type, tmuxSession: session, timestamp: ts})
    File.write!(events, line <> "\n", [:append])
  end

  defp activity(name, session), do: Map.get(WaitingTracker.session_activity(name), session)
  defp phase(name, session), do: (activity(name, session) || %{})[:phase]
  defp last_event_at(name, session), do: (activity(name, session) || %{})[:last_event_at]
  defp ingested?(name, session), do: not is_nil(activity(name, session))

  defp wait_until(fun, tries \\ 50) do
    cond do
      fun.() -> true
      tries <= 0 -> false
      true -> Process.sleep(10); wait_until(fun, tries - 1)
    end
  end

  # ── Category derivation per last event type ──

  test "a stop event yields phase \"waiting\"", %{events: events} do
    name = start(events)
    append(events, "stop", "foo-01J-shuttle")
    assert wait_until(fn -> phase(name, "foo-01J-shuttle") == "waiting" end)
  end

  test "a notification event yields phase \"attention\"", %{events: events} do
    name = start(events)
    append(events, "notification", "foo-01J-shuttle")
    assert wait_until(fn -> phase(name, "foo-01J-shuttle") == "attention" end)
  end

  test "subagent_stop yields phase \"waiting\" (folded into waiting, not cleared)",
       %{events: events} do
    name = start(events)
    append(events, "subagent_stop", "foo-01J-shuttle")
    assert wait_until(fn -> phase(name, "foo-01J-shuttle") == "waiting" end)
  end

  for working_type <- ["pre_tool_use", "post_tool_use", "user_prompt_submit", "session_start"] do
    test "a #{working_type} event yields phase \"working\" (long-tool guard)",
         %{events: events} do
      name = start(events)
      append(events, unquote(working_type), "foo-01J-shuttle")
      assert wait_until(fn -> phase(name, "foo-01J-shuttle") == "working" end)
    end
  end

  # ── Last-event-wins (no sticky state machine) ──

  test "last event wins: stop then pre_tool_use reads as \"working\"", %{events: events} do
    name = start(events)
    append(events, "stop", "foo-01J-shuttle")
    assert wait_until(fn -> phase(name, "foo-01J-shuttle") == "waiting" end)

    # A following tool call wins — the worker resumed, no stickiness keeps it idle.
    append(events, "pre_tool_use", "foo-01J-shuttle")
    assert wait_until(fn -> phase(name, "foo-01J-shuttle") == "working" end)
  end

  test "natural escalation: stop then notification reads as \"attention\"",
       %{events: events} do
    name = start(events)
    append(events, "stop", "foo-01J-shuttle")
    assert wait_until(fn -> phase(name, "foo-01J-shuttle") == "waiting" end)

    # CC fires the idle notification AFTER the stop — last-event-wins escalates
    # to attention with no hand-rolled stickiness.
    append(events, "notification", "foo-01J-shuttle")
    assert wait_until(fn -> phase(name, "foo-01J-shuttle") == "attention" end)
  end

  # ── Real last_event_at, not poll wall-clock (pins the fake-timestamp fix) ──

  test "last_event_at is the event's own timestamp, not the ingest clock",
       %{events: events} do
    name = start(events)
    one_hour_ago = @base - @hour_ms
    append(events, "stop", "foo-01J-shuttle", one_hour_ago)

    assert wait_until(fn -> ingested?(name, "foo-01J-shuttle") end)
    assert last_event_at(name, "foo-01J-shuttle") == one_hour_ago
  end

  test "a line missing a timestamp falls back to the ingest clock", %{events: events} do
    name = start(events)
    line = Jason.encode!(%{type: "stop", tmuxSession: "foo-01J-shuttle"})
    File.write!(events, line <> "\n", [:append])

    assert wait_until(fn -> ingested?(name, "foo-01J-shuttle") end)
    assert last_event_at(name, "foo-01J-shuttle") == @base
  end

  # ── Boot seeding from a pre-written file (pins the stopped-before-boot fix) ──

  test "a session stopped before boot is known immediately, with its real time",
       %{events: events} do
    stopped_24h_ago = @base - 24 * @hour_ms
    prewrite(events, "stop", "stale-01J-shuttle", stopped_24h_ago)

    name = start(events)

    # No new append — it must already be there from the boot seed.
    act = activity(name, "stale-01J-shuttle")
    assert act != nil
    assert act.phase == "waiting"
    assert act.last_event_at == stopped_24h_ago
  end

  test "boot seed prunes a session older than 48h, keeps one just inside",
       %{events: events} do
    prewrite(events, "stop", "ancient-01J-shuttle", @base - 49 * @hour_ms)
    prewrite(events, "stop", "recent-01J-shuttle", @base - 47 * @hour_ms)

    name = start(events)

    refute ingested?(name, "ancient-01J-shuttle")
    assert ingested?(name, "recent-01J-shuttle")
  end

  test "boot seed honors last-event-wins across the whole file", %{events: events} do
    # stop, then notification, then pre_tool_use — the last one wins on seed.
    prewrite(events, "stop", "seed-01J-shuttle", @base - 3_000)
    prewrite(events, "notification", "seed-01J-shuttle", @base - 2_000)
    prewrite(events, "pre_tool_use", "seed-01J-shuttle", @base - 1_000)

    name = start(events)

    assert phase(name, "seed-01J-shuttle") == "working"
    assert last_event_at(name, "seed-01J-shuttle") == @base - 1_000
  end

  # ── Filtering / robustness (carried forward) ──

  test "non-shuttle sessions are ignored", %{events: events} do
    name = start(events)
    append(events, "notification", "my-interactive-session")
    Process.sleep(40)
    refute ingested?(name, "my-interactive-session")
  end

  test "a partial line (no trailing newline yet) is not consumed until complete",
       %{events: events} do
    name = start(events)

    line = Jason.encode!(%{type: "notification", tmuxSession: "foo-01J-shuttle", timestamp: @base})
    File.write!(events, line, [:append])
    Process.sleep(40)
    refute ingested?(name, "foo-01J-shuttle")

    File.write!(events, "\n", [:append])
    assert wait_until(fn -> phase(name, "foo-01J-shuttle") == "attention" end)
  end

  test "file truncation resets the tail offset without crashing", %{events: events} do
    name = start(events)
    append(events, "notification", "foo-01J-shuttle")
    assert wait_until(fn -> phase(name, "foo-01J-shuttle") == "attention" end)

    File.write!(events, "")
    Process.sleep(40)
    append(events, "notification", "bar-01J-shuttle")
    assert wait_until(fn -> phase(name, "bar-01J-shuttle") == "attention" end)
  end
end
