defmodule Shuttle.SessionBindingTest do
  use ExUnit.Case, async: true
  alias Shuttle.{SessionBinding, EventStream, Poller.Snapshot}
  @now 1_800_000_000_000

  defp event(id, type, at, pid \\ 1, birth \\ "birth") do
    %{
      "sessionId" => id,
      "type" => type,
      "timestamp" => at,
      "receiverPid" => pid,
      "receiverBirth" => birth,
      "harness" => "claude-code",
      "tmuxSession" => "same-pane-shuttle"
    }
  end

  defp fold(events),
    do: Enum.reduce(events, SessionBinding.new(), &SessionBinding.apply_event(&2, &1, @now))

  test "known UUID anchors succession; panes and ordinary hooks do not" do
    state =
      fold([
        event("anchor", "pre_tool_use", @now),
        event("nested", "session_start", @now + 1, 2),
        event("rogue", "stop", @now + 2),
        event("next", "session_start", @now + 3),
        event("anchor", "session_end", @now + 4),
        event("rogue", "notification", @now + 5, 2)
      ])

    assert SessionBinding.current(state, "anchor") == "next"
    assert SessionBinding.current(state, "next") == "next"
    assert SessionBinding.current(state, "nested") == "nested"
    assert SessionBinding.current(state, "unseen") == "unseen"
    assert SessionBinding.current(state, "unknown") == nil
    assert SessionBinding.current(state, nil) == nil
  end

  test "resume transfers current UUID to a new lifetime and retires the predecessor" do
    state =
      fold([
        event("old", "session_start", @now),
        event("new", "session_start", @now + 1),
        event("new", "session_end", @now + 2),
        event("old", "session_start", @now + 3, 1, "new-birth"),
        event("newest", "session_start", @now + 4, 1, "new-birth"),
        event("stale", "session_start", @now + 5),
        event("new", "session_end", @now + 6)
      ])

    assert SessionBinding.current(state, "old") == "newest"
    assert SessionBinding.current(state, "new") == "newest"
    merged = SessionBinding.apply_event(state, event("old", "session_start", @now), @now)
    assert SessionBinding.current(merged, "old") == "newest"
  end

  test "loading an existing transcript unions receiver lineages across pruning" do
    state =
      fold([
        event("a", "session_start", @now),
        event("b", "session_start", @now + 1, 2),
        event("a", "session_start", @now + 2, 2)
      ])

    assert SessionBinding.current(state, "b") == "a"

    state =
      SessionBinding.prune(state, @now + 3)
      |> SessionBinding.apply_event(event("next", "session_start", @now + 4, 2), @now + 4)

    assert SessionBinding.current(state, "a") == "next"
    assert SessionBinding.current(state, "b") == "next"
  end

  test "old stream joins directly and first receiver hook seeds succession" do
    state = fold([Map.drop(event("old", "stop", @now), ["receiverPid", "receiverBirth"])])
    assert SessionBinding.current(state, "old") == "old"

    state =
      state
      |> SessionBinding.apply_event(event("old", "stop", @now + 1), @now)
      |> SessionBinding.apply_event(event("new", "session_start", @now + 2), @now)

    assert SessionBinding.current(state, "old") == "new"
    assert SessionBinding.prune(state, @now + 49 * 60 * 60 * 1000) == SessionBinding.new()
  end

  @tag :tmp_dir
  test "stream rotates and reseeds identity without rolling succession back", %{tmp_dir: dir} do
    path = Path.join(dir, "events.jsonl")
    File.write!(path, Jason.encode!(event("old", "stop", @now)) <> "\n")
    name = :binding_rotation_stream

    start_supervised!(
      {EventStream,
       name: name, events_file: path, clock: fn -> @now end, poll_interval_ms: 60_000}
    )

    File.rename!(path, path <> ".1")
    File.write!(path, Jason.encode!(event("new", "session_start", @now + 1)) <> "\n")
    EventStream.sent_events(name, path)
    assert SessionBinding.current(EventStream.session_bindings(name), "old") == "new"
    File.write!(path, "\n")
    EventStream.sent_events(name, path)
    assert SessionBinding.current(EventStream.session_bindings(name), "old") == "new"
  end

  @tag :tmp_dir
  test "partial reseed preserves equal-ms succession and accepts a new receiver", %{tmp_dir: dir} do
    path = Path.join(dir, "events.jsonl")
    old = Map.put(event("old", "session_start", @now), "id", "start-old")
    new = Map.put(event("new", "session_start", @now), "id", "start-new")
    File.write!(path, Jason.encode!(old) <> "\n" <> Jason.encode!(new) <> "\n")
    name = :binding_partial_stream

    start_supervised!(
      {EventStream,
       name: name, events_file: path, clock: fn -> @now + 10 end, poll_interval_ms: 60_000}
    )

    File.write!(path, Jason.encode!(old) <> "\n")
    EventStream.sent_events(name, path)
    assert SessionBinding.current(EventStream.session_bindings(name), "old") == "new"
    File.write!(path, Jason.encode!(event("old", "session_end", @now + 1)) <> "\n")
    EventStream.sent_events(name, path)
    assert SessionBinding.current(EventStream.session_bindings(name), "old") == "new"

    File.write!(
      path <> ".replacement",
      Jason.encode!(event("old", "session_start", @now + 2, 2)) <>
        "\n" <>
        Jason.encode!(event("newest", "session_start", @now + 3, 2)) <> "\n"
    )

    File.rename!(path <> ".replacement", path)
    EventStream.sent_events(name, path)
    assert SessionBinding.current(EventStream.session_bindings(name), "old") == "newest"
    assert SessionBinding.current(EventStream.session_bindings(name), "new") == "newest"
  end

  @tag :tmp_dir
  test "retired receiver's late end cannot end a resumed session", %{tmp_dir: dir} do
    path = Path.join(dir, "events.jsonl")

    events = [
      event("sid", "session_start", @now),
      event("sid", "session_start", @now + 1, 2),
      event("sid", "session_end", @now + 2),
      event("sid", "pre_tool_use", @now + 3, 2)
    ]

    File.write!(path, Enum.map_join(events, "", &(Jason.encode!(&1) <> "\n")))
    name = :binding_retired_stream

    start_supervised!(
      {EventStream,
       name: name, events_file: path, clock: fn -> @now + 3 end, poll_interval_ms: 60_000}
    )

    assert EventStream.session_activity(name)["sid"].phase == "working"
    File.rename!(path, path <> ".1")
    File.write!(path, Jason.encode!(event("sid", "session_end", @now + 4)) <> "\n")
    EventStream.sent_events(name, path)
    assert EventStream.session_activity(name)["sid"].phase == "working"
  end

  test "snapshot joins cache UUID, not tmux or missing worker metadata UUID" do
    now = DateTime.from_unix!(@now, :millisecond)

    meta = %{
      session: "same-pane-shuttle",
      agent_id: "test",
      started_at: now,
      last_activity_at: now
    }

    activity = %{
      "old" => %{last_event_at: @now, phase: "working"},
      "new" => %{last_event_at: @now + 3, phase: "waiting"},
      "same-pane-shuttle" => %{last_event_at: @now + 9, phase: "attention"}
    }

    binding = fold([event("old", "session_start", @now), event("new", "session_start", @now + 1)])
    index = Snapshot.runtime_index(%{"fiber" => meta}, activity)
    entry = %{fiber: %{"id" => "fiber", "shuttle" => %{"runtime" => %{"session_uuid" => "old"}}}}

    assert %{runtime: %{phase: "waiting", session_uuid: "new", last_activity_at: at}} =
             Snapshot.put_runtime(entry, index, activity, binding)

    assert at == @now + 3
    unknown = %{fiber: %{"id" => "fiber"}}
    refute Map.has_key?(Snapshot.put_runtime(unknown, index, activity, binding).runtime, :phase)
  end
end
