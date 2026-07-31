defmodule Shuttle.EventsParityTest do
  @moduledoc """
  Cross-language guard on the event stream.

  `felt hook event` (Go) writes the stream; `Shuttle.WaitingTracker` and
  `Shuttle.SentFiles` (Elixir) read it. Nothing in the type system connects the
  two, so the contract is a checked-in fixture: `cmd/testdata/events_golden.jsonl`
  is produced byte-for-byte by `TestEventGoldenParity` in cmd/hook_event_test.go
  and parsed here.

  A writer change that drops a field, renames a type, or reshapes `toolInput`
  fails on one side or the other — instead of quietly emptying the board.

  Regenerate the fixture with: `go test ./cmd -run Golden -update-golden`.
  """
  use ExUnit.Case, async: true

  alias Shuttle.SentFiles
  alias Shuttle.WaitingTracker

  # The fixture records: worker A (Claude) sending two files, writing a large
  # file, then stopping; worker B (Codex) ending blocked on a human; and a
  # subagent stopping outside any tmux session.
  @golden Path.expand("../../cmd/testdata/events_golden.jsonl", __DIR__)
  @worker_a "depersonalize-01KVC1N5XMAAMYXDAGR4V6QA9G-shuttle"
  @worker_b "codex-01KVC1N5XMAAMYXDAGR4V6QAAA-shuttle"
  @uid_a "01KVC1N5XMAAMYXDAGR4V6QA9G"
  # Just after the last event in the fixture, so nothing prunes as stale.
  @now 1_753_900_010_000

  setup do
    assert File.regular?(@golden),
           "missing #{@golden} — regenerate with `go test ./cmd -run Golden -update-golden`"

    :ok
  end

  describe "WaitingTracker over the Go-written stream" do
    test "derives a phase and a real last-event time per worker session" do
      name = :"parity_tracker_#{System.unique_integer([:positive])}"

      {:ok, pid} =
        WaitingTracker.start_link(
          events_file: @golden,
          poll_interval_ms: 60_000,
          clock: fn -> @now end,
          name: name
        )

      on_exit(fn -> if Process.alive?(pid), do: GenServer.stop(pid) end)

      activity = WaitingTracker.session_activity(name)

      # Worker A's last event is `stop` — the turn finished.
      assert %{phase: "waiting", last_event_at: 1_753_900_005_000} = activity[@worker_a]

      # Worker B's last event is `notification` — blocked on a human, and it
      # outranks A in the feed.
      assert %{phase: "attention", last_event_at: 1_753_900_008_000} = activity[@worker_b]

      # The subagent line carries no tmux session, so it tracks nothing. Only
      # `*-shuttle` sessions are worker sessions.
      assert Map.keys(activity) |> Enum.sort() == Enum.sort([@worker_a, @worker_b])
    end
  end

  describe "SentFiles over the Go-written stream" do
    test "reads the trail for the fiber whose ULID is embedded in the tmux name" do
      files = SentFiles.for_uid(@uid_a, events_file: @golden)

      # Both entries of one SendUserFile call, with the relative path resolved
      # against the event's cwd (/repo/felt) and the absolute one untouched.
      assert Enum.map(files, & &1.fullPath) |> Enum.sort() ==
               ["/repo/felt/results/frame.png", "/tmp/report.html"]

      assert Enum.find(files, &(&1.basename == "frame.png")).sessionId == "sess-a"
      assert Enum.find(files, &(&1.basename == "frame.png")).timestamp == 1_753_900_002_000
    end

    test "ignores every non-SendUserFile event, including the truncated Write" do
      # The oversized Write is trimmed to `file_path` + `truncated` by the
      # writer. It must not surface as a sent file.
      files = SentFiles.for_uid(@uid_a, events_file: @golden)
      refute Enum.any?(files, &(&1.basename == "big.md"))
    end

    test "returns nothing for a fiber with no sends" do
      assert SentFiles.for_uid("01KVC1N5XMAAMYXDAGR4V6QAAA", events_file: @golden) == []
    end
  end

  describe "line shape" do
    test "every line carries the fields both readers and operators depend on" do
      lines =
        @golden
        |> File.read!()
        |> String.split("\n", trim: true)
        |> Enum.map(&Jason.decode!/1)

      assert length(lines) == 10

      for line <- lines do
        assert is_binary(line["id"])
        assert is_integer(line["timestamp"])
        assert is_binary(line["type"])
        assert is_binary(line["sessionId"])
        assert is_binary(line["cwd"])
        assert is_binary(line["tmuxSession"])
        assert line["harness"] in ["claude-code", "codex"]
        assert is_binary(line["originName"])
      end

      # The harness discriminator is the transcript path, and the fixture
      # exercises both sides of it.
      assert Enum.any?(lines, &(&1["harness"] == "claude-code"))
      assert Enum.any?(lines, &(&1["harness"] == "codex"))

      # An oversized tool input is trimmed to what a reader consumes.
      big = Enum.find(lines, &(get_in(&1, ["toolInput", "truncated"]) == true))
      assert big["toolInput"]["file_path"] == "/repo/felt/big.md"
      refute Map.has_key?(big["toolInput"], "content")
    end
  end
end
