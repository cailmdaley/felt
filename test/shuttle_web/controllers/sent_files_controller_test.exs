defmodule ShuttleWeb.SentFilesControllerTest do
  @moduledoc """
  Wiring + reading for `GET /api/v1/sent-files` — the owner-routed sent-files
  trail the standalone board reads for each card.

  The reader (`Shuttle.SentFiles`) is exercised against a FIXTURE `events.jsonl`
  covering matching (tmux-ULID *and* sessionId), dedup-keeping-newest,
  newest-first sort, ULID extraction, and the skipping of non-SendUserFile /
  malformed lines. The controller's local branch reads that fixture via
  `$PORTOLAN_EVENTS_FILE`; the remote branch reuses the shared
  `Shuttle.OriginRouter.forward_get/4` with a stubbed transport, mirroring the
  /file forward tests.
  """
  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  @match_ulid "01KTS261GJMMRDRHS2QDMEFV3K"
  @other_ulid "01KTCA2CY6X6P126ZMBK9686SH"
  @session_only_uid "0883ade1-08e0-4457-94c6-7ac12137eb0f"

  # GET transport stub for the cross-host /sent-files forward — records the last
  # url and replays a scripted `get_file/2`, so the forward leg runs without a
  # real tunnel. Mirrors the /file controller test's stub.
  defmodule StubGetFileClient do
    use Agent

    def start_link(_ \\ []),
      do: Agent.start_link(fn -> %{response: nil, last: nil} end, name: __MODULE__)

    def set_response(response), do: Agent.update(__MODULE__, &Map.put(&1, :response, response))
    def last, do: Agent.get(__MODULE__, & &1.last)

    def get_file(url, _timeout_ms) do
      Agent.update(__MODULE__, &Map.put(&1, :last, %{url: url}))
      Agent.get(__MODULE__, & &1.response)
    end
  end

  # A fixture events.jsonl line. Defaults mirror a real SendUserFile pre_tool_use
  # event; pass overrides to drop fields or change the tool/session.
  defp event(overrides) do
    base = %{
      "type" => "pre_tool_use",
      "sessionId" => "sess-#{System.unique_integer([:positive])}",
      "tmuxSession" => "morning-post-#{@match_ulid}-shuttle",
      "originName" => "dapmcw68",
      "tool" => "SendUserFile",
      "timestamp" => 1_000,
      "toolInput" => %{"files" => ["/tmp/a.html"]}
    }

    base |> Map.merge(overrides) |> Jason.encode!()
  end

  # Write a fixture stream and return its path; cleaned up on exit.
  defp write_fixture(lines) do
    path =
      Path.join(
        System.tmp_dir!(),
        "shuttle_sent_files_#{System.unique_integer([:positive])}.jsonl"
      )

    File.write!(path, Enum.join(lines, "\n") <> "\n")
    on_exit(fn -> File.rm(path) end)
    path
  end

  describe "Shuttle.SentFiles.for_uid/2 (the reader)" do
    test "matches by tmux-embedded ULID and flattens toolInput.files" do
      path =
        write_fixture([
          event(%{
            "tmuxSession" => "morning-post-#{@match_ulid}-shuttle",
            "timestamp" => 10,
            "toolInput" => %{"files" => ["/tmp/one.html", "/tmp/two.png"]}
          })
        ])

      files = Shuttle.SentFiles.for_uid(@match_ulid, events_file: path)

      assert Enum.map(files, & &1.fullPath) |> Enum.sort() == ["/tmp/one.html", "/tmp/two.png"]
      assert Enum.find(files, &(&1.fullPath == "/tmp/two.png")).basename == "two.png"
    end

    test "resolves a relative file path against the event's cwd to absolute" do
      # SendUserFile often records a path relative to the worker's cwd; /file
      # serves only absolute paths (a relative one 400s → broken-image icon on
      # the card). The reader absolutizes against the event's cwd. (Real case:
      # spt-talk-push sent `results/scratch/footprints/frames/frame3_act.png`.)
      # An already-absolute path in the same event passes through verbatim.
      path =
        write_fixture([
          event(%{
            "cwd" => "/leonardo_work/cmbx",
            "toolInput" => %{"files" => ["results/scratch/frame3_act.png", "/abs/already.png"]}
          })
        ])

      files = Shuttle.SentFiles.for_uid(@match_ulid, events_file: path)

      assert Enum.map(files, & &1.fullPath) |> Enum.sort() ==
               ["/abs/already.png", "/leonardo_work/cmbx/results/scratch/frame3_act.png"]

      assert Enum.find(files, &(&1.fullPath =~ "frame3_act")).basename == "frame3_act.png"
    end

    test "leaves a relative path as-is when the event carries no cwd" do
      # The default fixture event has no `cwd`; nothing to resolve against, so
      # the path is preserved (pre-cwd-capture behavior, not a crash).
      path = write_fixture([event(%{"toolInput" => %{"files" => ["rel/no-cwd.png"]}})])

      files = Shuttle.SentFiles.for_uid(@match_ulid, events_file: path)
      assert Enum.map(files, & &1.fullPath) == ["rel/no-cwd.png"]
    end

    test "matches by sessionId when the tmux name has no embedded ULID" do
      path =
        write_fixture([
          event(%{
            "tmuxSession" => "",
            "sessionId" => @session_only_uid,
            "toolInput" => %{"files" => ["/tmp/capture.html"]}
          })
        ])

      files = Shuttle.SentFiles.for_uid(@session_only_uid, events_file: path)
      assert Enum.map(files, & &1.fullPath) == ["/tmp/capture.html"]
    end

    test "skips non-SendUserFile, non-matching, and malformed lines" do
      path =
        write_fixture([
          event(%{"tool" => "Bash", "toolInput" => %{"command" => "ls"}}),
          event(%{"tmuxSession" => "x-#{@other_ulid}-shuttle"}),
          "{ this is not valid json",
          "",
          event(%{"timestamp" => 5, "toolInput" => %{"files" => ["/tmp/keep.html"]}})
        ])

      files = Shuttle.SentFiles.for_uid(@match_ulid, events_file: path)
      assert Enum.map(files, & &1.fullPath) == ["/tmp/keep.html"]
    end

    test "dedupes by fullPath keeping the newest send, sorted newest-first" do
      path =
        write_fixture([
          event(%{"timestamp" => 100, "toolInput" => %{"files" => ["/tmp/dup.html"]}}),
          event(%{"timestamp" => 50, "toolInput" => %{"files" => ["/tmp/old.html"]}}),
          event(%{"timestamp" => 300, "toolInput" => %{"files" => ["/tmp/dup.html"]}}),
          event(%{"timestamp" => 200, "toolInput" => %{"files" => ["/tmp/new.html"]}})
        ])

      files = Shuttle.SentFiles.for_uid(@match_ulid, events_file: path)

      # one /tmp/dup.html survivor, carrying the newest (300) timestamp
      assert Enum.count(files, &(&1.fullPath == "/tmp/dup.html")) == 1
      assert Enum.find(files, &(&1.fullPath == "/tmp/dup.html")).timestamp == 300

      # newest-first across distinct paths: dup(300) > new(200) > old(50)
      assert Enum.map(files, & &1.fullPath) == ["/tmp/dup.html", "/tmp/new.html", "/tmp/old.html"]
    end

    test "respects the cap" do
      lines =
        for i <- 1..10 do
          event(%{"timestamp" => i, "toolInput" => %{"files" => ["/tmp/f#{i}.html"]}})
        end

      path = write_fixture(lines)
      files = Shuttle.SentFiles.for_uid(@match_ulid, events_file: path, cap: 3)

      assert length(files) == 3
      # newest three: f10, f9, f8
      assert Enum.map(files, & &1.fullPath) == ["/tmp/f10.html", "/tmp/f9.html", "/tmp/f8.html"]
    end

    test "a missing events file yields an empty trail (no crash)" do
      assert Shuttle.SentFiles.for_uid(@match_ulid, events_file: "/no/such/events.jsonl") == []
    end
  end

  describe "local serve" do
    test "200 with the fiber's trail from the events stream" do
      path =
        write_fixture([
          event(%{"timestamp" => 10, "toolInput" => %{"files" => ["/tmp/local.html"]}}),
          event(%{"tmuxSession" => "x-#{@other_ulid}-shuttle"})
        ])

      with_events_file(path)

      conn = get(api_conn(), "/api/v1/sent-files?uid=#{@match_ulid}")

      assert conn.status == 200
      assert %{"files" => [%{"fullPath" => "/tmp/local.html", "basename" => "local.html"}]} =
               json_response(conn, 200)
    end

    test "200 with an empty list when the fiber has no sends" do
      path = write_fixture([event(%{})])
      with_events_file(path)

      conn = get(api_conn(), "/api/v1/sent-files?uid=#{@other_ulid}")
      assert %{"files" => []} = json_response(conn, 200)
    end

    test "400 when uid is missing" do
      conn = get(api_conn(), "/api/v1/sent-files")
      assert conn.status == 400
      assert %{"error" => "uid is required"} = json_response(conn, 400)
    end
  end

  describe "remote forward" do
    test "forwards a remote-owned fiber's trail to the owning daemon and relays JSON" do
      body = ~s({"files":[{"fullPath":"/abs/on/candide.html","basename":"candide.html"}]})
      stub_forward("candide", "http://localhost:4001", {:ok, 200, "application/json", body})

      conn = get(api_conn(), "/api/v1/sent-files?uid=#{@match_ulid}&origin=candide")

      assert conn.status == 200
      assert json_response(conn, 200) == Jason.decode!(body)

      # origin stripped; uid crosses as a query param to the owner's /sent-files.
      assert StubGetFileClient.last().url ==
               "http://localhost:4001/api/v1/sent-files?uid=#{@match_ulid}"
    end

    test "relays the remote's status verbatim" do
      stub_forward("candide", "http://localhost:4001", {:ok, 404, "application/json", ~s({"error":"x"})})

      conn = get(api_conn(), "/api/v1/sent-files?uid=#{@match_ulid}&origin=candide")
      assert conn.status == 404
    end

    test "502 when the tunnel forward fails" do
      stub_forward("candide", "http://localhost:4001", {:error, :econnrefused})

      conn = get(api_conn(), "/api/v1/sent-files?uid=#{@match_ulid}&origin=candide")
      assert conn.status == 502
      assert %{"error" => _} = json_response(conn, 502)
    end
  end

  # Point the reader's primary path (Shuttle owns the stream now) at a fixture for
  # the controller's local branch. Clear the legacy Portolan vars and
  # SHUTTLE_DATA_DIR so resolution is unambiguous and never leaks to the real
  # ~/.shuttle/events.jsonl on the dev machine. Restores prior env on exit.
  defp with_events_file(path) do
    keys = ~w(SHUTTLE_EVENTS_FILE SHUTTLE_DATA_DIR PORTOLAN_EVENTS_FILE PORTOLAN_DATA_DIR)
    previous = Map.new(keys, &{&1, System.get_env(&1)})

    Enum.each(keys, &System.delete_env/1)
    System.put_env("SHUTTLE_EVENTS_FILE", path)

    on_exit(fn ->
      Enum.each(previous, fn {k, v} ->
        if v, do: System.put_env(k, v), else: System.delete_env(k)
      end)
    end)
  end

  defp stub_forward(remote_name, remote_url, response) do
    start_supervised!(StubGetFileClient)
    StubGetFileClient.set_response(response)

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: remote_name, url: remote_url}])
    Application.put_env(:shuttle, :write_forward_client, StubGetFileClient)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)
  end

  defp restore_app_env(key, nil), do: Application.delete_env(:shuttle, key)
  defp restore_app_env(key, value), do: Application.put_env(:shuttle, key, value)

  defp api_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
  end
end
