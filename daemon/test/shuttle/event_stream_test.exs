defmodule Shuttle.EventStreamTest do
  @moduledoc """
  `Shuttle.EventStream`: seeds its projections from `events.jsonl.1` and
  `events.jsonl`, follows appends, answers only for its own path, rebuilds on
  a shrink in place, and continues across a real rename-rotation — including a
  waiting spell and a tool call that straddle it. Most assertions read the
  activity fold, the projection with the most state to carry; the last tests
  read all three projections off the same pass.

  The poll interval is set far out, so every catch-up here is the one a read
  performs; nothing depends on timing.
  """
  use ExUnit.Case, async: true

  alias Shuttle.{Activity, EventStream, SentFiles}

  @t0 1_770_000_000_000
  @m 60_000
  @tmux "alpha-01KTS261GJMMRDRHS2QDMEFV3K-shuttle"
  @cwd "/repo/a"

  setup do
    dir = Path.join(System.tmp_dir!(), "event_stream_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    {:ok, path: Path.join(dir, "events.jsonl")}
  end

  defp ev(type, minute, extra \\ %{}) do
    %{
      "type" => type,
      "timestamp" => @t0 + minute * @m,
      "tmuxSession" => @tmux,
      "cwd" => @cwd,
      "sessionId" => "s1"
    }
    |> Map.merge(extra)
    |> Jason.encode!()
  end

  defp append(path, lines), do: File.write!(path, Enum.map(lines, &(&1 <> "\n")), [:append])

  defp start(path) do
    name = :"event_stream_#{System.unique_integer([:positive])}"
    start_supervised!({EventStream, events_file: path, poll_interval_ms: 3_600_000, name: name})
    name
  end

  defp all(name, path) do
    {:ok, buckets} = EventStream.slice(name, path, @t0 - 1_000 * @m, @t0 + 1_000 * @m)
    buckets
  end

  defp fresh(path),
    do: Activity.slice(Activity.fold_stream(path), @t0 - 1_000 * @m, @t0 + 1_000 * @m)

  defp kinds(buckets), do: Enum.map(buckets, &{div(&1.m - @t0, @m), &1.k, &1.n})

  test "seeds from the rotated file then the live one, and matches a fresh fold", %{path: path} do
    append(path <> ".1", [ev("notification", 0), ev("pre_tool_use", 1)])
    append(path, [ev("notification", 2), ev("post_tool_use", 5)])
    name = start(path)

    assert all(name, path) == fresh(path)

    assert kinds(all(name, path)) == [
             {0, "notify", 1},
             {1, "agent", 1},
             {2, "agent", 1},
             {2, "notify", 1},
             {3, "agent", 1},
             {4, "agent", 1},
             {5, "agent", 1}
           ]
  end

  test "a read catches up on appended lines, and leaves a partial line for later", %{path: path} do
    append(path, [ev("stop", 0)])
    name = start(path)
    assert kinds(all(name, path)) == [{0, "agent", 1}, {0, "reply", 1}]

    append(path, [ev("user_prompt_submit", 1)])
    File.write!(path, String.slice(ev("user_prompt_submit", 2), 0, 20), [:append])
    assert kinds(all(name, path)) == [{0, "agent", 1}, {0, "reply", 1}, {1, "attention", 1}]

    File.write!(path, String.slice(ev("user_prompt_submit", 2), 20..-1//1) <> "\n", [:append])
    assert {2, "attention", 1} in kinds(all(name, path))
    assert all(name, path) == fresh(path)
  end

  test "any other path is a miss, and window/3 then folds that path itself", %{path: path} do
    other = path <> ".other"
    append(other, [ev("stop", 0)])
    on_exit(fn -> File.rm(other) end)
    name = start(path)

    assert EventStream.slice(name, other, @t0, @t0 + @m) == :miss
    assert EventStream.events_file(name) == path

    assert {:ok, [%{k: "agent"}, %{k: "reply"}]} =
             Activity.window(@t0, @t0 + @m, events_file: other, stream: name)
  end

  test "a stream that is not running is a miss" do
    assert EventStream.slice(:no_such_stream, "/x", @t0, @t0 + @m) == :miss
    assert EventStream.sent_events(:no_such_stream, "/x") == :miss
    assert EventStream.session_activity(:no_such_stream) == %{}
  end

  test "a shrink in place rebuilds from the files", %{path: path} do
    append(path, [ev("stop", 0), ev("stop", 1)])
    name = start(path)
    assert length(all(name, path)) == 4

    File.write!(path, ev("user_prompt_submit", 7) <> "\n")
    assert kinds(all(name, path)) == [{7, "attention", 1}]
  end

  test "rotation continues the fold: a spell and a tool call straddle the rename",
       %{path: path} do
    gamma = %{"tmuxSession" => "gamma", "sessionId" => "g1"}
    append(path, [ev("notification", 0), ev("pre_tool_use", 1, gamma)])
    name = start(path)
    assert kinds(all(name, path)) == [{0, "notify", 1}, {1, "agent", 1}]

    # Written after the follower last read, then rotated away before it reads
    # again: the drain of the rotated file's tail must pick it up.
    append(path, [ev("notification", 2, %{"tmuxSession" => "beta"})])
    File.rename!(path, path <> ".1")

    # The new live file repeats alpha's ask (the same spell, so no mark) and
    # returns gamma's tool call, opened before the rotation.
    append(path, [ev("notification", 3), ev("post_tool_use", 6, gamma)])

    buckets = all(name, path)
    assert buckets == fresh(path)

    assert Enum.map(buckets, &{div(&1.m - @t0, @m), &1.s, &1.k}) == [
             {0, @tmux, "notify"},
             {1, "gamma", "agent"},
             {2, "beta", "notify"},
             {2, "gamma", "agent"},
             {3, "gamma", "agent"},
             {4, "gamma", "agent"},
             {5, "gamma", "agent"},
             {6, "gamma", "agent"}
           ]
  end

  test "a second rotation drops what the overwritten file held, and keeps the spell",
       %{path: path} do
    append(path, [ev("notification", 0), ev("stop", 1, %{"tmuxSession" => "beta"})])
    name = start(path)

    File.rename!(path, path <> ".1")
    append(path, [ev("stop", 10, %{"tmuxSession" => "beta"})])
    assert length(all(name, path)) == 5

    File.rename!(path, path <> ".1")
    append(path, [ev("notification", 20), ev("stop", 21, %{"tmuxSession" => "beta"})])

    # Minutes 0 and 1 lived only in the overwritten file. Alpha's spell from
    # minute 0 is still open, so minute 20 is a repeat, not an onset.
    assert Enum.map(all(name, path), &{div(&1.m - @t0, @m), &1.k}) == [
             {10, "agent"},
             {10, "reply"},
             {21, "agent"},
             {21, "reply"}
           ]
  end

  test "a rotation racing the seed is not counted twice", %{path: path} do
    append(path <> ".1", [ev("stop", 0, %{"tmuxSession" => "a"})])
    append(path, Enum.map(1..5, &ev("stop", &1, %{"tmuxSession" => "b"})))

    # Rotate once, between the seed's read of the live file and its fold of
    # `.1`, and give the new live file lines of its own.
    once = :counters.new(1, [])

    hook = fn ->
      if :counters.get(once, 1) == 0 do
        :counters.add(once, 1, 1)
        File.rename!(path, path <> ".1")
        append(path, Enum.map(6..7, &ev("stop", &1, %{"tmuxSession" => "c"})))
      end
    end

    name = :"event_stream_#{System.unique_integer([:positive])}"

    start_supervised!(
      {EventStream, events_file: path, poll_interval_ms: 3_600_000, name: name, seed_hook: hook}
    )

    assert all(name, path) == fresh(path)
    assert :counters.get(once, 1) == 1
    assert Enum.all?(all(name, path), &(&1.n == 1))
  end

  test "a replacement it cannot account for rebuilds from the files", %{path: path} do
    append(path, [ev("stop", 0)])
    name = start(path)
    assert length(all(name, path)) == 2

    # A new live file whose predecessor did not become events.jsonl.1. It is
    # written beside the old one first, so the two cannot share an inode.
    append(path <> ".new", [ev("user_prompt_submit", 4)])
    File.rename!(path <> ".new", path)
    assert kinds(all(name, path)) == [{4, "attention", 1}]
  end

  # ── Every projection off the same pass ──

  defp waiting(name) do
    name
    |> EventStream.session_activity()
    |> Map.new(fn {session, %{phase: phase}} -> {session, phase} end)
  end

  # The activity buckets of the ten minutes before `now`, after catching up.
  defp recent(name, path, now) do
    {:ok, buckets} = EventStream.slice(name, path, now - 10 * @m, now)
    buckets
  end

  defp sent(name, path) do
    {:ok, events} = EventStream.sent_events(name, path)
    Enum.flat_map(events, & &1.paths)
  end

  test "one pass seeds all three projections from both files", %{path: path} do
    now = System.system_time(:millisecond)
    shuttle = "w-01KTS261GJMMRDRHS2QDMEFV3K-shuttle"
    at = fn minute -> %{"timestamp" => now + minute * @m, "tmuxSession" => shuttle} end

    append(path <> ".1", [
      ev("stop", -3, at.(-3)),
      ev("file_sent", -3, Map.put(at.(-3), "files", ["/tmp/a.html"]))
    ])

    append(path, [
      ev(
        "notification",
        -2,
        at.(-2)
        |> Map.put("tmuxSession", "other-01KTHDNZS287ZSSG8X8V59XKW9-shuttle")
        |> Map.put("sessionId", "other-session")
      )
    ])

    name = start(path)

    # The session's last event lives only in the rotated file.
    assert waiting(name) == %{"s1" => "waiting", "other-session" => "attention"}

    assert sent(name, path) == ["/tmp/a.html"]

    assert Enum.map(recent(name, path, now), & &1.k) == ["agent", "reply", "notify"]
  end

  test "a rotation carries the waiting map and the sent trail; a second one drops the trail",
       %{path: path} do
    now = System.system_time(:millisecond)
    shuttle = "w-01KTS261GJMMRDRHS2QDMEFV3K-shuttle"
    at = fn minute -> %{"timestamp" => now + minute * @m, "tmuxSession" => shuttle} end

    sent_line = fn minute, file ->
      ev("file_sent", minute, Map.put(at.(minute), "files", [file]))
    end

    append(path, [ev("stop", -5, at.(-5)), sent_line.(-5, "/tmp/one.html")])
    name = start(path)

    # Written after the last read and rotated away before the next.
    append(path, [ev("pre_tool_use", -4, at.(-4))])
    File.rename!(path, path <> ".1")
    append(path, [sent_line.(-3, "/tmp/two.html")])

    # `sent/2` catches up; `session_activity/1` reads what is held.
    assert sent(name, path) == ["/tmp/one.html", "/tmp/two.html"]
    assert waiting(name) == %{"s1" => "working"}
    assert {:ok, events} = EventStream.sent_events(name, path)

    assert events ==
             EventStream.fold_files(path, [], &Enum.reverse(SentFiles.project(&1), &2))
             |> Enum.reverse()

    File.rename!(path, path <> ".1")
    append(path, [ev("stop", -1, at.(-1))])

    assert sent(name, path) == ["/tmp/two.html"]
    assert waiting(name) == %{"s1" => "waiting"}
  end

  test "session_activity answers at once while the stream is busy", %{path: path} do
    now = System.system_time(:millisecond)
    shuttle = "w-01KTS261GJMMRDRHS2QDMEFV3K-shuttle"
    append(path, [ev("stop", -1, %{"timestamp" => now - @m, "tmuxSession" => shuttle})])
    name = start(path)
    assert waiting(name) == %{"s1" => "waiting"}

    # A suspended stream stands in for one mid-reseed: its mailbox is not
    # served, yet the owner feed's read neither blocks nor loses the phase.
    :sys.suspend(name)

    try do
      {micros, activity} = :timer.tc(fn -> EventStream.session_activity(name) end)
      assert %{"s1" => %{phase: "waiting"}} = activity
      assert micros < 1_000_000
    after
      :sys.resume(name)
    end
  end

  test "replacement reseed retains child work when the replacement repeats only stop", %{
    path: path
  } do
    now = System.system_time(:millisecond)
    codex = %{"harness" => "codex", "sessionId" => "parent"}

    append(path, [
      ev(
        "post_tool_use",
        0,
        Map.merge(codex, %{
          "tool" => "collaborationspawn_agent",
          "id" => "spawn-1",
          "timestamp" => now
        })
      ),
      ev("stop", 1, Map.put(codex, "timestamp", now + 1))
    ])

    name = start(path)
    assert waiting(name) == %{"parent" => "working"}

    # The replacement omits the known spawn but repeats the stop at the same
    # timestamp: it is a retained-prefix rebuild, not newer evidence.
    replacement = path <> ".replacement"
    append(replacement, [ev("stop", 1, Map.put(codex, "timestamp", now + 1))])
    File.rename!(replacement, path)
    _ = all(name, path)

    assert waiting(name) == %{"parent" => "working"}
  end

  test "a rebuild keeps a waiting session the new files no longer mention", %{path: path} do
    now = System.system_time(:millisecond)
    a = "session-a"
    b = "session-b"

    append(path, [
      ev("notification", -3, %{
        "timestamp" => now - 3 * @m,
        "sessionId" => a,
        "tmuxSession" => "a-pane-shuttle"
      }),
      ev("notification", -3, %{
        "timestamp" => now - 3 * @m,
        "sessionId" => a,
        "tmuxSession" => "a-pane-shuttle"
      })
    ])

    name = start(path)
    assert waiting(name) == %{a => "attention"}

    # Shrunk in place: the rebuild sees only b, and still remembers a.
    File.write!(
      path,
      ev("stop", -1, %{
        "timestamp" => now - @m,
        "sessionId" => b,
        "tmuxSession" => "b-pane-shuttle"
      }) <> "\n"
    )

    assert Enum.map(recent(name, path, now), & &1.k) == ["agent", "reply"]
    assert waiting(name) == %{a => "attention", b => "waiting"}
  end
end
