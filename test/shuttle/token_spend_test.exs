defmodule Shuttle.TokenSpendTest do
  @moduledoc """
  The fold from a transcript to a session's spend.

  Fixtures cover Claude Code's four `message.usage` counters, pi's equivalent
  envelope, Codex's cumulative token snapshots, one record per content block
  sharing a `message.id`, sidechain records for subagent turns, and the junk
  lines any file another program owns will eventually contain.
  """
  use ExUnit.Case, async: false

  alias Shuttle.TokenSpend

  @session "0883ade1-08e0-4457-94c6-7ac12137eb0f"

  setup do
    root = Path.join(System.tmp_dir!(), "spend-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(root, "-Users-someone-project"))
    on_exit(fn -> File.rm_rf(root) end)
    {:ok, root: root, path: Path.join([root, "-Users-someone-project", "#{@session}.jsonl"])}
  end

  defp usage(overrides \\ %{}) do
    Map.merge(
      %{
        "input_tokens" => 2,
        "output_tokens" => 100,
        "cache_read_input_tokens" => 1_000,
        "cache_creation_input_tokens" => 500
      },
      overrides
    )
  end

  defp assistant(id, at, extra \\ %{}) do
    Map.merge(
      %{
        "type" => "assistant",
        "timestamp" => at,
        "message" => %{
          "id" => id,
          "role" => "assistant",
          "model" => "claude-fable-5",
          "usage" => usage()
        }
      },
      extra
    )
  end

  defp write!(path, records) do
    File.write!(path, Enum.map_join(records, "", &(Jason.encode!(&1) <> "\n")))
  end

  defp spend(root), do: TokenSpend.for_session(@session, root: root, cache: false)

  test "folds the four counters and the message count", %{root: root, path: path} do
    write!(path, [
      assistant("msg_a", "2026-08-05T18:58:02.648Z"),
      assistant("msg_b", "2026-08-05T19:02:00.000Z")
    ])

    result = spend(root)

    assert result.found
    assert result.session == @session
    assert result.input == 4
    assert result.output == 200
    assert result.cache_read == 2_000
    assert result.cache_write == 1_000
    assert result.messages == 2
    assert result.first_at_ms == 1_785_956_282_648
    assert result.last_at_ms == 1_785_956_520_000
  end

  test "counts a multi-block assistant turn once, not once per block", %{root: root, path: path} do
    # The trap: Claude Code writes one record per content block, each repeating
    # the whole message's usage. Seven records, one turn, one turn's tokens.
    write!(path, for(_ <- 1..7, do: assistant("msg_a", "2026-08-05T18:58:02.648Z")))

    result = spend(root)

    assert result.messages == 1
    assert result.output == 100
  end

  test "counts sidechain (subagent) turns — the session paid for them", %{
    root: root,
    path: path
  } do
    write!(path, [
      assistant("msg_a", "2026-08-05T18:58:02.648Z"),
      assistant("msg_sub", "2026-08-05T18:59:00.000Z", %{"isSidechain" => true})
    ])

    assert spend(root).messages == 2
  end

  test "breaks the counters down per model", %{root: root, path: path} do
    write!(path, [
      assistant("msg_a", "2026-08-05T18:58:02.648Z"),
      %{
        "type" => "assistant",
        "timestamp" => "2026-08-05T18:59:00.000Z",
        "message" => %{
          "id" => "msg_b",
          "model" => "claude-sonnet-5",
          "usage" => usage(%{"output_tokens" => 7})
        }
      }
    ])

    result = spend(root)

    assert result.models["claude-fable-5"].output == 100
    assert result.models["claude-sonnet-5"].output == 7
    assert result.models["claude-sonnet-5"].messages == 1
  end

  test "ignores records with no usage block, and junk lines", %{root: root, path: path} do
    File.write!(
      path,
      "{ not json\n\n" <>
        Jason.encode!(%{"type" => "user", "timestamp" => "2026-08-05T18:00:00Z"}) <>
        "\n" <>
        Jason.encode!(assistant("msg_a", "2026-08-05T18:58:02.648Z")) <> "\n"
    )

    result = spend(root)
    assert result.messages == 1
    assert result.found
  end

  test "a missing transcript is an absence, not an error", %{root: root} do
    result = spend(root)

    assert result.found == false
    assert result.input == 0
    assert result.messages == 0
    assert result.first_at_ms == nil
  end

  test "a session id that is not UUID-shaped never reaches the filesystem", %{root: root} do
    assert TokenSpend.for_session("../../etc/passwd", root: root).found == false
    assert TokenSpend.for_session(nil).found == false
  end

  describe "the mtime cache" do
    test "serves an unchanged transcript from memory, re-reads a grown one", %{
      root: root,
      path: path
    } do
      write!(path, [assistant("msg_a", "2026-08-05T18:58:02.648Z")])

      first = TokenSpend.for_session(@session, root: root)
      assert first.messages == 1

      # Rewrite the file's CONTENT with the same size and mtime granularity the
      # cache keys on: the stale answer proves the cache is actually consulted.
      stat = File.stat!(path, time: :posix)
      write!(path, [assistant("msg_z", "2026-08-05T18:58:02.648Z")])
      File.touch!(path, stat.mtime)

      assert TokenSpend.for_session(@session, root: root).messages == 1

      # Growth changes the size, so the fold runs again.
      write!(path, [
        assistant("msg_a", "2026-08-05T18:58:02.648Z"),
        assistant("msg_b", "2026-08-05T19:00:00.000Z")
      ])

      assert TokenSpend.for_session(@session, root: root).messages == 2
    end
  end

  describe "total/1" do
    test "sums the counters and spans the widest interval" do
      a = %{
        TokenSpend.empty("a")
        | input: 1,
          output: 2,
          messages: 1,
          first_at_ms: 10,
          last_at_ms: 20
      }

      b = %{TokenSpend.empty("b") | cache_read: 5, messages: 3, first_at_ms: 5, last_at_ms: 15}

      total = TokenSpend.total([a, b])

      assert total.sessions == 2
      assert total.input == 1
      assert total.output == 2
      assert total.cache_read == 5
      assert total.messages == 4
      assert total.first_at_ms == 5
      assert total.last_at_ms == 20
    end

    test "an empty list totals to zero, not a crash" do
      assert TokenSpend.total([]).sessions == 0
    end
  end

  describe "pi transcripts (the second harness)" do
    setup do
      root = Path.join(System.tmp_dir!(), "spend-pi-#{System.unique_integer([:positive])}")
      File.mkdir_p!(Path.join(root, "--Users-someone-project--"))
      on_exit(fn -> File.rm_rf(root) end)

      path =
        Path.join([
          root,
          "--Users-someone-project--",
          "2026-08-21T18-19-21-052Z_#{@session}.jsonl"
        ])

      {:ok, root: root, path: path}
    end

    # Pi nests the turn under "message", names its counters its own way, and
    # writes one record per turn (identity: responseId).
    defp pi_assistant(response_id, at, overrides \\ %{}) do
      usage =
        Map.merge(
          %{"input" => 3, "output" => 50, "cacheRead" => 700, "cacheWrite" => 200},
          overrides
        )

      %{
        "type" => "message",
        "timestamp" => at,
        "message" => %{
          "role" => "assistant",
          "responseId" => response_id,
          "model" => "stealth/ox-alpha",
          "usage" => usage
        }
      }
    end

    defp pi_spend(root),
      do: TokenSpend.for_session(@session, root: root, pi_root: root, cache: false)

    test "folds pi's counters into the same observation", %{root: root, path: path} do
      write!(path, [
        pi_assistant("resp_a", "2026-08-21T18:20:00.000Z"),
        pi_assistant("resp_b", "2026-08-21T18:25:00.000Z")
      ])

      result = pi_spend(root)

      assert result.found
      assert result.input == 6
      assert result.output == 100
      assert result.cache_read == 1_400
      assert result.cache_write == 400
      assert result.messages == 2

      assert result.models == %{
               "stealth/ox-alpha" => %{
                 input: 6,
                 output: 100,
                 cache_read: 1_400,
                 cache_write: 400,
                 messages: 2
               }
             }
    end

    test "a responseId repeated across records counts once", %{root: root, path: path} do
      write!(path, for(_ <- 1..3, do: pi_assistant("resp_a", "2026-08-21T18:20:00.000Z")))

      assert pi_spend(root).messages == 1
    end

    test "a claude root miss with no pi file is found: false, not an error", %{root: root} do
      refute pi_spend(root).found
    end
  end

  describe "Codex rollouts (the third harness)" do
    setup do
      root = Path.join(System.tmp_dir!(), "spend-codex-#{System.unique_integer([:positive])}")
      date = Shuttle.HarnessPaths.local_today()

      dir =
        Path.join([
          root,
          "#{date.year}",
          String.pad_leading("#{date.month}", 2, "0"),
          String.pad_leading("#{date.day}", 2, "0")
        ])

      File.mkdir_p!(dir)
      path = Path.join(dir, "rollout-2026-08-23T18-19-21-052Z-#{@session}.jsonl")
      on_exit(fn -> File.rm_rf(root) end)
      {:ok, root: root, path: path}
    end

    defp codex_turn_context(model),
      do: %{"type" => "turn_context", "payload" => %{"model" => model}}

    defp codex_message(id, at),
      do: %{
        "type" => "response_item",
        "timestamp" => at,
        "payload" => %{"type" => "message", "role" => "assistant", "id" => id, "content" => []}
      }

    defp codex_token_count(at, overrides \\ %{}) do
      usage =
        Map.merge(
          %{
            "input_tokens" => 20,
            "cached_input_tokens" => 5,
            "cache_write_input_tokens" => 2,
            "output_tokens" => 3,
            "reasoning_output_tokens" => 1,
            "total_tokens" => 25
          },
          overrides
        )

      %{
        "type" => "event_msg",
        "timestamp" => at,
        "payload" => %{"type" => "token_count", "info" => %{"total_token_usage" => usage}}
      }
    end

    defp codex_spend(root),
      do:
        TokenSpend.for_session(@session,
          root: "/nope/not/here",
          pi_root: "/nope/not/here",
          codex_root: root,
          cache: false
        )

    test "uses the latest cumulative token snapshot once", %{root: root, path: path} do
      write!(path, [
        codex_turn_context("gpt-5.6-luna"),
        codex_token_count("2026-08-23T18:20:00.000Z"),
        codex_message("turn-1", "2026-08-23T18:20:01.000Z"),
        codex_token_count("2026-08-23T18:20:02.000Z", %{
          "input_tokens" => 42,
          "cached_input_tokens" => 12,
          "cache_write_input_tokens" => 4,
          "output_tokens" => 7,
          "reasoning_output_tokens" => 2,
          "total_tokens" => 49
        }),
        # A repeated final snapshot is normal when the harness flushes the
        # stream; it must not change the answer.
        codex_token_count("2026-08-23T18:20:03.000Z", %{
          "input_tokens" => 42,
          "cached_input_tokens" => 12,
          "cache_write_input_tokens" => 4,
          "output_tokens" => 7,
          "reasoning_output_tokens" => 2,
          "total_tokens" => 49
        })
      ])

      result = codex_spend(root)

      assert result.found
      assert result.input == 30
      assert result.output == 7
      assert result.cache_read == 12
      assert result.cache_write == 4
      assert result.messages == 1

      assert result.first_at_ms ==
               DateTime.from_iso8601("2026-08-23T18:20:00.000Z")
               |> elem(1)
               |> DateTime.to_unix(:millisecond)

      assert result.last_at_ms ==
               DateTime.from_iso8601("2026-08-23T18:20:03.000Z")
               |> elem(1)
               |> DateTime.to_unix(:millisecond)

      assert result.models == %{
               "gpt-5.6-luna" => %{
                 input: 30,
                 output: 7,
                 cache_read: 12,
                 cache_write: 4,
                 messages: 1
               }
             }
    end

    test "finds a historical Codex rollout outside the capture date fan-out", %{root: root} do
      date = Date.add(Shuttle.HarnessPaths.local_today(), -7)

      dir =
        Path.join([
          root,
          "#{date.year}",
          String.pad_leading("#{date.month}", 2, "0"),
          String.pad_leading("#{date.day}", 2, "0")
        ])

      File.mkdir_p!(dir)

      path = Path.join(dir, "rollout-old-#{@session}.jsonl")

      write!(path, [
        codex_turn_context("gpt-5.6-luna"),
        codex_token_count("2026-08-16T18:20:00.000Z")
      ])

      result = codex_spend(root)

      assert result.found
      assert result.input == 15
      assert result.output == 3
    end

    test "attributes cumulative deltas to the active model after a model switch", %{
      root: root,
      path: path
    } do
      write!(path, [
        codex_turn_context("gpt-5.6-luna"),
        codex_token_count("2026-08-23T18:20:00.000Z"),
        codex_message("turn-1", "2026-08-23T18:20:00.500Z"),
        codex_turn_context("gpt-5.6-luna-mini"),
        codex_message("turn-2", "2026-08-23T18:20:00.750Z"),
        codex_token_count("2026-08-23T18:20:01.000Z", %{
          "input_tokens" => 31,
          "output_tokens" => 7
        })
      ])

      assert codex_spend(root).models == %{
               "gpt-5.6-luna" => %{
                 input: 15,
                 output: 3,
                 cache_read: 5,
                 cache_write: 2,
                 messages: 1
               },
               "gpt-5.6-luna-mini" => %{
                 input: 11,
                 output: 4,
                 cache_read: 0,
                 cache_write: 0,
                 messages: 1
               }
             }
    end
  end
end
