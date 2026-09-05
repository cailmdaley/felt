defmodule ShuttleWeb.SessionsControllerTest do
  @moduledoc """
  Wiring for `GET /api/v1/sessions` — the session ledger as join rung 0.

  `Shuttle.SessionLedgerTest` covers the reader; this covers the envelope, the
  `since_ms` bound, and the degradations.
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
        "shuttle_sessions_ctrl_#{System.unique_integer([:positive])}.jsonl"
      )

    previous = System.get_env("SHUTTLE_SESSIONS_FILE")
    previous_data_dir = System.get_env("SHUTTLE_DATA_DIR")
    System.delete_env("SHUTTLE_DATA_DIR")
    System.put_env("SHUTTLE_SESSIONS_FILE", path)

    on_exit(fn ->
      File.rm(path)
      File.rm(path <> ".1")
      if previous, do: System.put_env("SHUTTLE_SESSIONS_FILE", previous)
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
        "fiber" => "work/paper/edits",
        "uid" => "01KTS261GJMMRDRHS2QDMEFV3K",
        "session" => "0883ade1-08e0-4457-94c6-7ac12137eb0f",
        "harness" => "claude-code",
        "host" => "dapmcw68",
        "tmux" => "edits-01KTS261GJMMRDRHS2QDMEFV3K-shuttle",
        "at" => 1_786_203_000_000,
        "kind" => "dispatch"
      },
      overrides
    )
  end


  test "200 with the host stamp and every record, oldest first", %{path: path} do
    write!(path, [
      record(%{"fiber" => "second", "at" => 200}),
      record(%{"fiber" => "first", "at" => 100, "kind" => "claim"})
    ])

    conn = get(api_conn(), "/api/v1/sessions")
    assert conn.status == 200

    body = json_response(conn, 200)
    assert body["host"] == Shuttle.Poller.own_host_id()
    assert Enum.map(body["records"], & &1["fiber"]) == ["first", "second"]

    # The wire record is served verbatim — every key the writer wrote.
    assert %{
             "fiber" => "first",
             "uid" => "01KTS261GJMMRDRHS2QDMEFV3K",
             "session" => "0883ade1-08e0-4457-94c6-7ac12137eb0f",
             "harness" => "claude-code",
             "host" => "dapmcw68",
             "tmux" => "edits-01KTS261GJMMRDRHS2QDMEFV3K-shuttle",
             "at" => 100,
             "kind" => "claim"
           } = hd(body["records"])
  end

  test "since_ms filters, inclusively", %{path: path} do
    write!(path, [
      record(%{"fiber" => "old", "at" => 100}),
      record(%{"fiber" => "edge", "at" => 200}),
      record(%{"fiber" => "new", "at" => 300})
    ])

    conn = get(api_conn(), "/api/v1/sessions?since_ms=200")

    assert Enum.map(json_response(conn, 200)["records"], & &1["fiber"]) == ["edge", "new"]
  end

  test "200 with an empty list when this host has no ledger yet" do
    conn = get(api_conn(), "/api/v1/sessions?since_ms=0")
    assert json_response(conn, 200)["records"] == []
  end

  test "malformed lines are skipped rather than 500ing the endpoint", %{path: path} do
    File.write!(
      path,
      "{ not json\n\n" <> Jason.encode!(record(%{"fiber" => "survivor", "at" => 10})) <> "\n"
    )

    conn = get(api_conn(), "/api/v1/sessions")
    assert conn.status == 200
    assert Enum.map(json_response(conn, 200)["records"], & &1["fiber"]) == ["survivor"]
  end

  test "400 when since_ms is present but not an integer" do
    for query <- ["?since_ms=abc", "?since_ms=1e9", "?since_ms=100x", "?since_ms="] do
      conn = get(api_conn(), "/api/v1/sessions" <> query)
      assert conn.status == 400, "expected 400 for #{inspect(query)}"
      assert %{"error" => error} = json_response(conn, 400)
      assert error =~ "since_ms"
    end
  end
end
