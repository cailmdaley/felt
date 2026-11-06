defmodule Shuttle.TranscriptUsageTest do
  @moduledoc """
  Usage facts read from a transcript's tail. The fixtures are field-selected
  captures of real transcripts; their lines come from independent sessions, so
  each test seats the lines it needs.
  """
  use ExUnit.Case, async: true

  alias Shuttle.TranscriptUsage

  @fixtures Path.expand("../fixtures/transcript_usage", __DIR__)
  @minute 60_000
  @hour 3_600_000

  setup do
    path = Path.join(System.tmp_dir!(), "usage_#{System.unique_integer([:positive])}.jsonl")
    on_exit(fn -> File.rm(path) end)
    {:ok, path: path}
  end

  defp captured(name) do
    Path.join(@fixtures, name) |> File.read!() |> String.split("\n", trim: true)
  end

  defp read(path, lines, harness) do
    File.write!(path, Enum.map(lines, &(&1 <> "\n")))
    TranscriptUsage.read(path, harness)
  end

  defp ms(stamp) do
    {:ok, time, 0} = DateTime.from_iso8601(stamp)
    DateTime.to_unix(time, :millisecond)
  end

  defp stamp(at), do: at |> DateTime.from_unix!(:millisecond) |> DateTime.to_iso8601()

  defp claude(at, fields) do
    usage = %{
      input_tokens: 2,
      cache_read_input_tokens: fields[:read] || 0,
      cache_creation_input_tokens: fields[:write] || 0,
      cache_creation: %{ephemeral_1h_input_tokens: fields[:hour_write] || 0}
    }

    Jason.encode!(%{
      type: "assistant",
      timestamp: stamp(at),
      message: %{model: "claude-opus-5-5", usage: usage}
    })
  end

  describe "claude" do
    test "context sums input, cache reads and cache writes", %{path: path} do
      [hour_write, _read, _compaction] = captured("claude.jsonl")
      at = ms("2026-10-09T13:51:52.531Z")

      assert read(path, [hour_write], "claude-code") == %{
               context: 53_327,
               cached: 26_331,
               cache_warm_until: at + @hour,
               hit_share: 0.494,
               at: at
             }
    end

    test "a read with no live hour-long entry stays warm five minutes", %{path: path} do
      [_hour_write, read_only, _compaction] = captured("claude.jsonl")
      at = ms("2026-10-06T11:09:37.922Z")

      assert %{context: 80_844, cache_warm_until: warm} = read(path, [read_only], "claude-code")
      assert warm == at + 5 * @minute
    end

    test "a read of a live hour-long entry renews its hour, an expired one does not",
         %{path: path} do
      t0 = 1_800_000_000_000
      renewed = t0 + 50 * @minute
      late = renewed + 2 * @hour

      lines = [claude(t0, write: 900, hour_write: 900), claude(renewed, read: 900)]
      assert read(path, lines, "claude-code").cache_warm_until == renewed + @hour

      lines = lines ++ [claude(late, read: 900)]
      assert read(path, lines, "claude-code").cache_warm_until == late + 5 * @minute
    end

    test "a short write beside a live hour keeps the later estimate", %{path: path} do
      t0 = 1_800_000_000_000
      lines = [claude(t0, write: 900, hour_write: 900), claude(t0 + @minute, write: 10)]

      assert read(path, lines, "claude-code").cache_warm_until == t0 + @hour
    end

    test "a turn with no cache activity leaves the estimate alone", %{path: path} do
      t0 = 1_800_000_000_000
      lines = [claude(t0, write: 900, hour_write: 900), claude(t0 + @minute, [])]

      assert read(path, lines, "claude-code").cache_warm_until == t0 + @hour
    end

    test "a compaction replaces the context and forgets the cache", %{path: path} do
      [hour_write, _read, compaction] = captured("claude.jsonl")

      usage = read(path, [hour_write, compaction], "claude-code")

      assert usage.context == 24_705
      assert usage.at == ms("2026-06-07T21:15:54.185Z")
      refute Map.has_key?(usage, :cache_warm_until)
      refute Map.has_key?(usage, :cached)
    end

    test "sidechain and synthetic records say nothing about the session", %{path: path} do
      t0 = 1_800_000_000_000
      real = claude(t0, read: 900)

      sidechain =
        claude(t0 + @minute, read: 5) |> Jason.decode!() |> Map.put("isSidechain", true)

      synthetic =
        ~s({"type":"assistant","timestamp":"#{stamp(t0 + @hour)}","message":{"model":"<synthetic>",) <>
          ~s("usage":{"input_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}})

      usage = read(path, [real, Jason.encode!(sidechain), synthetic], "claude-code")

      assert usage.context == 902
      assert usage.at == t0
    end
  end

  describe "pi" do
    test "context sums input, cache reads and cache writes; no cache estimate", %{path: path} do
      [turn, _compaction] = captured("pi.jsonl")

      assert read(path, [turn], "pi") == %{
               context: 16_767,
               cached: 0,
               hit_share: 0.0,
               at: ms("2026-10-03T15:39:21.687Z")
             }
    end

    test "errored and aborted turns are not usage", %{path: path} do
      [turn, _compaction] = captured("pi.jsonl")
      failed = String.replace(turn, ~s("stopReason":"toolUse"), ~s("stopReason":"error"))
      aborted = String.replace(turn, ~s("stopReason":"toolUse"), ~s("stopReason":"aborted"))

      assert read(path, [failed, aborted], "pi") == nil
      assert read(path, [turn, failed], "pi").context == 16_767
    end

    test "a compaction leaves the context unknown", %{path: path} do
      [turn, compaction] = captured("pi.jsonl")

      assert read(path, [turn, compaction], "pi") |> Map.keys() |> Enum.sort() ==
               [:at, :hit_share]
    end
  end

  describe "codex" do
    test "cached input is part of the input, and the window is recorded", %{path: path} do
      [turn, _compacted] = captured("codex.jsonl")

      assert read(path, [turn], "codex") == %{
               context: 20_915,
               window: 258_400,
               cached: 12_032,
               hit_share: 0.575,
               at: ms("2026-10-09T15:19:10.075Z")
             }
    end

    test "a reset's retained total is not a measured context until the next turn",
         %{path: path} do
      [compacted, reset, turn] = captured("codex-compaction-reset.jsonl")

      assert read(path, [compacted, reset], "codex") == %{
               window: 258_400,
               at: ms("2026-10-05T10:02:02.476Z")
             }

      assert %{context: 43_002, cached: 23_296} = read(path, [compacted, reset, turn], "codex")
    end

    test "a compaction leaves the context unknown", %{path: path} do
      [turn, compacted] = captured("codex.jsonl")

      refute read(path, [turn, compacted], "codex") |> Map.has_key?(:context)
    end
  end

  describe "the tail" do
    test "widens past a large record to reach the last usage", %{path: path} do
      [turn, _compacted] = captured("codex.jsonl")
      bulk = ~s({"type":"response_item","payload":"#{String.duplicate("x", 2_000_000)}"})

      assert %{context: 20_915} = read(path, [turn, bulk], "codex")
    end

    test "stops at its bound", %{path: path} do
      [turn, _compacted] = captured("codex.jsonl")
      bulk = ~s({"type":"response_item","payload":"#{String.duplicate("x", 17_000_000)}"})

      assert read(path, [turn, bulk, bulk], "codex") == nil
    end

    test "ignores a partial trailing record and lines that are not JSON", %{path: path} do
      [turn, _compacted] = captured("codex.jsonl")
      File.write!(path, turn <> "\nnot json\n" <> String.slice(turn, 0, 40))

      assert %{context: 20_915} = TranscriptUsage.read(path, "codex")
    end

    test "a transcript with no usage has none", %{path: path} do
      assert read(path, [~s({"type":"user","message":{"content":"hi"}})], "claude-code") == nil
    end
  end
end
