defmodule Shuttle.InterruptWatcherTest do
  use ExUnit.Case, async: true
  alias Shuttle.{EventStream, InterruptWatcher, WaitingTracker}

  @t0 1_792_305_384_206

  defp iso(ms), do: ms |> DateTime.from_unix!(:millisecond) |> DateTime.to_iso8601()
  defp line(map), do: Jason.encode!(map) <> "\n"

  defp claude_interrupt(ms, uuid \\ "a6bd7329") do
    line(%{
      "type" => "user",
      "isSidechain" => false,
      "uuid" => uuid,
      "timestamp" => iso(ms),
      "message" => %{
        "role" => "user",
        "content" => [%{"type" => "text", "text" => "[Request interrupted by user]"}]
      }
    })
  end

  describe "interrupt/2" do
    test "a Claude transcript ending in an interrupt, under trailing metadata" do
      bytes =
        line(%{"type" => "assistant", "uuid" => "x", "timestamp" => iso(@t0)}) <>
          claude_interrupt(@t0 + 11_386) <>
          line(%{"type" => "permission-mode", "permissionMode" => "auto"}) <>
          line(%{"type" => "attachment", "uuid" => "y", "timestamp" => iso(@t0)}) <>
          line(%{
            "type" => "user",
            "isSidechain" => true,
            "uuid" => "z",
            "message" => %{"content" => "side"}
          })

      assert InterruptWatcher.interrupt(bytes, "claude-code") == {"a6bd7329", @t0 + 11_386}
    end

    test "a Claude interrupt followed by a new turn is not the last word" do
      bytes =
        claude_interrupt(@t0) <>
          line(%{
            "type" => "user",
            "uuid" => "p",
            "timestamp" => iso(@t0 + 5),
            "message" => %{"content" => "go on"}
          })

      assert InterruptWatcher.interrupt(bytes, "claude-code") == nil

      assert InterruptWatcher.interrupt(
               "partial-line-from-a-tail\n" <> claude_interrupt(@t0),
               "claude-code"
             ) ==
               {"a6bd7329", @t0}
    end

    test "Claude's tool-use interrupt wording counts" do
      bytes =
        line(%{
          "type" => "user",
          "uuid" => "u",
          "timestamp" => iso(@t0),
          "message" => %{"content" => "[Request interrupted by user for tool use]"}
        })

      assert InterruptWatcher.interrupt(bytes, "claude-code") == {"u", @t0}
    end

    test "a Codex rollout ending in turn_aborted" do
      aborted =
        line(%{
          "timestamp" => iso(@t0),
          "type" => "event_msg",
          "payload" => %{"type" => "turn_aborted", "turn_id" => "t3", "reason" => "interrupted"}
        })

      context = line(%{"timestamp" => iso(@t0), "type" => "turn_context", "payload" => %{}})

      assert {"t3@" <> _, @t0} =
               InterruptWatcher.interrupt(context <> aborted <> context, "codex")

      complete =
        line(%{
          "timestamp" => iso(@t0 + 1),
          "type" => "event_msg",
          "payload" => %{"type" => "task_complete"}
        })

      assert InterruptWatcher.interrupt(aborted <> complete, "codex") == nil
    end
  end

  describe "the tracker" do
    defp fold(events), do: Enum.reduce(events, %{}, &WaitingTracker.apply_event(&2, &1, @t0))

    defp ev(type, at, extra \\ %{}),
      do:
        Map.merge(
          %{"type" => type, "sessionId" => "s", "timestamp" => at, "harness" => "claude-code"},
          extra
        )

    test "an interrupt closes an open turn as the human's" do
      sessions =
        fold([
          ev("user_prompt_submit", @t0),
          ev("post_tool_use", @t0 + 1),
          ev("interrupted", @t0 + 2)
        ])

      assert %{"s" => %{phase: "waiting", last_event_at: at}} =
               WaitingTracker.phases(sessions, @t0)

      assert at == @t0 + 2
    end

    test "an interrupt older than later activity is stale" do
      sessions =
        fold([
          ev("user_prompt_submit", @t0),
          ev("user_prompt_submit", @t0 + 5),
          ev("interrupted", @t0 + 2)
        ])

      assert %{"s" => %{phase: "working"}} = WaitingTracker.phases(sessions, @t0)
    end
  end

  @tag :tmp_dir
  test "a silent open turn whose transcript ends in an interrupt is recorded once", %{
    tmp_dir: dir
  } do
    events = Path.join(dir, "events.jsonl")
    transcript = Path.join(dir, "s.jsonl")
    now = @t0 + 60_000

    File.write!(
      events,
      line(%{
        "id" => "1",
        "type" => "session_start",
        "sessionId" => "s",
        "timestamp" => @t0 - 10,
        "harness" => "claude-code"
      }) <>
        line(%{
          "id" => "2",
          "type" => "post_tool_use",
          "sessionId" => "s",
          "timestamp" => @t0,
          "harness" => "claude-code"
        })
    )

    File.write!(transcript, claude_interrupt(@t0 + 11_386))

    stream = :"stream_#{System.unique_integer([:positive])}"

    start_supervised!(
      {EventStream,
       name: stream, events_file: events, poll_interval_ms: 3_600_000, clock: fn -> now end}
    )

    assert %{"s" => %{phase: "working"}} = EventStream.session_activity(stream)

    test_pid = self()

    emit = fn session, harness, {record, at} ->
      send(test_pid, {:emitted, session, harness, record, at})

      File.write!(
        events,
        line(%{
          "id" => "#{session}-interrupted-#{record}",
          "type" => "interrupted",
          "sessionId" => session,
          "timestamp" => at,
          "harness" => harness
        }),
        [:append]
      )
    end

    state = %{
      stream: stream,
      path: fn "s" -> transcript end,
      emit: emit,
      clock: fn -> now end,
      interval_ms: 3_600_000,
      quiet_ms: 3_000,
      seen: %{}
    }

    state = InterruptWatcher.scan(state)
    assert_received {:emitted, "s", "claude-code", "a6bd7329", at} when at == @t0 + 11_386

    # The stream has not folded the line yet; an unchanged transcript is not reread.
    InterruptWatcher.scan(state)
    refute_received {:emitted, _, _, _, _}

    # Reading the stream folds the interrupt.
    {:ok, _} = EventStream.slice(stream, events, 0, now)
    assert %{"s" => %{phase: "waiting"}} = EventStream.session_activity(stream)
    assert EventStream.open_turns(stream) == %{}
  end
end
