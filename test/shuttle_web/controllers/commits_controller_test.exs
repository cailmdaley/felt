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

  @endpoint ShuttleWeb.Endpoint

  setup do
    path =
      Path.join(
        System.tmp_dir!(),
        "shuttle_commits_ctrl_#{System.unique_integer([:positive])}.jsonl"
      )

    previous = System.get_env("SHUTTLE_COMMITS_FILE")
    previous_data_dir = System.get_env("SHUTTLE_DATA_DIR")
    System.delete_env("SHUTTLE_DATA_DIR")
    System.put_env("SHUTTLE_COMMITS_FILE", path)

    on_exit(fn ->
      File.rm(path)
      File.rm(path <> ".1")
      if previous, do: System.put_env("SHUTTLE_COMMITS_FILE", previous)
      if previous_data_dir, do: System.put_env("SHUTTLE_DATA_DIR", previous_data_dir)
    end)

    {:ok, path: path}
  end

  defp write!(path, records) do
    File.write!(path, Enum.map_join(records, "", &(Jason.encode!(&1) <> "\n")))
  end

  defp record(overrides) do
    Map.merge(
      %{
        "at" => 1_786_203_000_000,
        "kind" => "commit",
        "sha" => "79def80887a45cfdaea4e23a6e0444df808e908a",
        "subject" => "desk: cycle lens",
        "repo" => "/Users/me/dev/felt",
        "files" => 3,
        "insertions" => 42,
        "deletions" => 7,
        "session" => "0883ade1-08e0-4457-94c6-7ac12137eb0f",
        "tmux" => "edits-01KTS261GJMMRDRHS2QDMEFV3K-shuttle",
        "cwd" => "/Users/me/dev/felt"
      },
      overrides
    )
  end


  test "200 with the host stamp and every record, oldest first", %{path: path} do
    write!(path, [
      record(%{"sha" => "second", "at" => 200}),
      record(%{"sha" => "first", "at" => 100})
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
    write!(path, [
      record(%{"sha" => "old", "at" => 100}),
      record(%{"sha" => "lower", "at" => 200}),
      record(%{"sha" => "upper", "at" => 300}),
      record(%{"sha" => "new", "at" => 400})
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
      "{ not json\n\n" <> Jason.encode!(record(%{"sha" => "survivor", "at" => 10})) <> "\n"
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
      write!(path, [record(%{"sha" => "local", "at" => 100})])

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
      write!(path, [
        record(%{"sha" => "before", "at" => 100}),
        record(%{"sha" => "inside", "at" => 250})
      ])

      body = json_response(get(api_conn(), "/api/v1/commits/composite?since_ms=200"), 200)
      assert Enum.map(body["records"], & &1["sha"]) == ["inside"]
    end
  end
end
