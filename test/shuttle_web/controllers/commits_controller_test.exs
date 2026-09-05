defmodule ShuttleWeb.CommitsControllerTest do
  @moduledoc """
  Wiring for `GET /api/v1/commits` — the commit ledger as narration's join
  rung 0.

  `Shuttle.CommitLedgerTest` covers the reader; this covers the envelope, both
  bounds, and the degradations.
  """
  use ExUnit.Case
  import Shuttle.Test.ApiConn
  import Plug.Conn
  import Phoenix.ConnTest
  import Shuttle.Test.Ledgers

  @endpoint ShuttleWeb.Endpoint

  setup do
    {:ok, path: ledger_setup!("SHUTTLE_COMMITS_FILE", "shuttle_commits_ctrl")}
  end

  test "200 with the host stamp and every record, oldest first", %{path: path} do
    write_jsonl!(path, [
      commit_record(%{"sha" => "second", "at" => 200}),
      commit_record(%{"sha" => "first", "at" => 100})
    ])

    conn = get(api_conn(), "/api/v1/commits")
    assert conn.status == 200

    body = json_response(conn, 200)
    assert body["host"] == Shuttle.Poller.own_host_id()
    assert Enum.map(body["records"], & &1["sha"]) == ["first", "second"]

    # The wire record is served verbatim — every key the hook wrote.
    assert %{
             "at" => 100,
             "kind" => "commit",
             "sha" => "first",
             "subject" => "desk: cycle lens",
             "repo" => "/Users/me/dev/felt",
             "files" => 3,
             "insertions" => 42,
             "deletions" => 7,
             "session" => "0883ade1-08e0-4457-94c6-7ac12137eb0f",
             "tmux" => "edits-01KTS261GJMMRDRHS2QDMEFV3K-shuttle",
             "cwd" => "/Users/me/dev/felt"
           } = hd(body["records"])
  end

  test "both bounds filter, inclusively", %{path: path} do
    write_jsonl!(path, [
      commit_record(%{"sha" => "old", "at" => 100}),
      commit_record(%{"sha" => "lower", "at" => 200}),
      commit_record(%{"sha" => "upper", "at" => 300}),
      commit_record(%{"sha" => "new", "at" => 400})
    ])

    conn = get(api_conn(), "/api/v1/commits?since_ms=200&until_ms=300")
    assert Enum.map(json_response(conn, 200)["records"], & &1["sha"]) == ["lower", "upper"]

    conn = get(api_conn(), "/api/v1/commits?since_ms=300")
    assert Enum.map(json_response(conn, 200)["records"], & &1["sha"]) == ["upper", "new"]
  end

  test "200 with an empty list when this host has no ledger yet" do
    conn = get(api_conn(), "/api/v1/commits?since_ms=0")
    assert json_response(conn, 200)["records"] == []
  end

  test "malformed lines are skipped rather than 500ing the endpoint", %{path: path} do
    File.write!(
      path,
      "{ not json\n\n" <> Jason.encode!(commit_record(%{"sha" => "survivor", "at" => 10})) <> "\n"
    )

    conn = get(api_conn(), "/api/v1/commits")
    assert conn.status == 200
    assert Enum.map(json_response(conn, 200)["records"], & &1["sha"]) == ["survivor"]
  end

  test "400 when a bound is present but not an integer" do
    for query <- ["?since_ms=abc", "?since_ms=1e9", "?since_ms=", "?until_ms=abc"] do
      conn = get(api_conn(), "/api/v1/commits" <> query)
      assert conn.status == 400, "expected 400 for #{inspect(query)}"
      assert %{"error" => error} = json_response(conn, 400)
      assert error =~ "ms"
    end
  end

  describe "composite" do
    test "stamps local records with this host and reports the local origin", %{path: path} do
      write_jsonl!(path, [commit_record(%{"sha" => "local", "at" => 100})])

      body = json_response(get(api_conn(), "/api/v1/commits/composite"), 200)
      own = Shuttle.Poller.own_host_id()

      assert body["host"] == own
      assert [%{"sha" => "local", "host" => ^own}] = body["records"]

      assert body["origins"][own] == %{
               "kind" => "local",
               "stale" => false,
               "last_polled_at" => nil,
               "last_error" => nil
             }
    end

    test "bounds apply to the merged stream", %{path: path} do
      write_jsonl!(path, [
        commit_record(%{"sha" => "before", "at" => 100}),
        commit_record(%{"sha" => "inside", "at" => 250})
      ])

      body = json_response(get(api_conn(), "/api/v1/commits/composite?since_ms=200"), 200)
      assert Enum.map(body["records"], & &1["sha"]) == ["inside"]
    end
  end
end
