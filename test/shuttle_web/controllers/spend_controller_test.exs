defmodule ShuttleWeb.SpendControllerTest do
  @moduledoc """
  `GET /api/v1/spend` — the ledger joined to the transcripts, rolled up per
  fiber. `Shuttle.TokenSpendTest` covers the fold; this covers the join, the
  envelope, and what happens when a transcript is not on this disk.
  """
  use ExUnit.Case, async: false
  import Shuttle.Test.ApiConn

  import Plug.Conn
  import Phoenix.ConnTest
  import Shuttle.Test.Ledgers

  @endpoint ShuttleWeb.Endpoint

  @s1 "0883ade1-08e0-4457-94c6-7ac12137eb0f"
  @s2 "11111111-2222-3333-4444-555555555555"
  @t0 1_786_203_000_000

  setup do
    keys = ~w(SHUTTLE_SESSIONS_FILE SHUTTLE_DATA_DIR SHUTTLE_CLAUDE_PROJECTS_DIR)
    previous = Map.new(keys, &{&1, System.get_env(&1)})
    Enum.each(keys, &System.delete_env/1)

    dir = Path.join(System.tmp_dir!(), "spend-ctrl-#{System.unique_integer([:positive])}")
    projects = Path.join(dir, "projects/-Users-someone-project")
    File.mkdir_p!(projects)
    ledger = Path.join(dir, "sessions.jsonl")

    System.put_env("SHUTTLE_SESSIONS_FILE", ledger)
    System.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", Path.join(dir, "projects"))

    on_exit(fn ->
      File.rm_rf(dir)

      Enum.each(previous, fn {k, v} ->
        if v, do: System.put_env(k, v), else: System.delete_env(k)
      end)
    end)

    {:ok, ledger: ledger, projects: projects}
  end

  defp record(session, fiber, at \\ @t0) do
    %{
      "fiber" => fiber,
      "uid" => "01KTS261GJMMRDRHS2QDMEFV3K",
      "session" => session,
      "harness" => "claude-code",
      "host" => "test-host",
      "at" => at,
      "kind" => "dispatch"
    }
  end

  defp transcript!(projects, session, turns) do
    lines =
      Enum.map(turns, fn {id, out} ->
        Jason.encode!(%{
          "type" => "assistant",
          "timestamp" => "2026-08-05T18:58:02.648Z",
          "message" => %{
            "id" => id,
            "model" => "claude-fable-5",
            "usage" => %{
              "input_tokens" => 1,
              "output_tokens" => out,
              "cache_read_input_tokens" => 10,
              "cache_creation_input_tokens" => 5
            }
          }
        }) <> "\n"
      end)

    File.write!(Path.join(projects, "#{session}.jsonl"), Enum.join(lines))
  end

  test "one row per ledgered session, with its fiber and its counters", ctx do
    write_jsonl!(ctx.ledger, [record(@s1, "work/paper")])
    transcript!(ctx.projects, @s1, [{"msg_a", 100}, {"msg_b", 50}])

    body = json_response(get(api_conn(), "/api/v1/spend"), 200)

    assert body["host"] == Shuttle.Poller.own_host_id()
    assert [row] = body["sessions"]
    assert row["fiber"] == "work/paper"
    assert row["session"] == @s1
    assert row["harness"] == "claude-code"
    assert row["found"] == true
    assert row["output"] == 150
    assert row["cache_read"] == 20
    assert row["messages"] == 2
  end

  test "the fiber rollup sums a fiber's sessions", ctx do
    write_jsonl!(ctx.ledger, [
      record(@s1, "work/paper", @t0),
      record(@s2, "work/paper", @t0 + 10)
    ])

    transcript!(ctx.projects, @s1, [{"msg_a", 100}])
    transcript!(ctx.projects, @s2, [{"msg_b", 7}])

    body = json_response(get(api_conn(), "/api/v1/spend"), 200)

    assert [fiber] = body["fibers"]
    assert fiber["fiber"] == "work/paper"
    assert fiber["sessions"] == 2
    assert fiber["measured"] == 2
    assert fiber["output"] == 107
    assert fiber["input"] == 2
    assert fiber["messages"] == 2
  end

  test "the fiber rollup counts a resumed session's lifetime spend once", ctx do
    write_jsonl!(ctx.ledger, [
      record(@s1, "work/paper", @t0),
      Map.put(record(@s1, "work/paper", @t0 + 10), "kind", "resume"),
      record(@s2, "work/paper", @t0 + 20)
    ])

    transcript!(ctx.projects, @s1, [{"msg_a", 100}])
    transcript!(ctx.projects, @s2, [{"msg_b", 7}])

    body = json_response(get(api_conn(), "/api/v1/spend"), 200)

    assert length(body["sessions"]) == 3
    assert [fiber] = body["fibers"]
    assert fiber["sessions"] == 2
    assert fiber["measured"] == 2
    assert fiber["output"] == 107
    assert fiber["messages"] == 2
  end

  test "a missing transcript is a zeroed row with found: false, still counted", ctx do
    write_jsonl!(ctx.ledger, [record(@s1, "work/paper"), record(@s2, "work/paper")])
    transcript!(ctx.projects, @s1, [{"msg_a", 100}])

    body = json_response(get(api_conn(), "/api/v1/spend"), 200)

    missing = Enum.find(body["sessions"], &(&1["session"] == @s2))
    assert missing["found"] == false
    assert missing["output"] == 0

    assert [fiber] = body["fibers"]
    assert fiber["sessions"] == 2
    assert fiber["measured"] == 1
    assert fiber["output"] == 100
  end

  test "since_ms bounds the ledger walk", ctx do
    write_jsonl!(ctx.ledger, [
      record(@s1, "old", @t0),
      record(@s2, "new", @t0 + 1_000)
    ])

    body = json_response(get(api_conn(), "/api/v1/spend?since_ms=#{@t0 + 500}"), 200)

    assert Enum.map(body["sessions"], & &1["fiber"]) == ["new"]
  end

  test "no ledger at all is an empty answer, not a 500" do
    body = json_response(get(api_conn(), "/api/v1/spend"), 200)
    assert body["sessions"] == []
    assert body["fibers"] == []
  end

  test "malformed ledger lines are skipped", ctx do
    File.write!(ctx.ledger, "{ nope\n" <> Jason.encode!(record(@s1, "survivor")) <> "\n")

    body = json_response(get(api_conn(), "/api/v1/spend"), 200)
    assert Enum.map(body["sessions"], & &1["fiber"]) == ["survivor"]
  end

  test "400 when since_ms is present but not an integer" do
    conn = get(api_conn(), "/api/v1/spend?since_ms=abc")
    assert conn.status == 400
    assert json_response(conn, 400)["error"] =~ "since_ms"
  end
end
