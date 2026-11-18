defmodule ShuttleWeb.BoardControllerTest do
  use ExUnit.Case, async: true
  import Phoenix.ConnTest
  import Plug.Conn
  import Shuttle.Test.ApiConn

  @endpoint ShuttleWeb.Endpoint

  defmodule FakePoller do
    use GenServer
    def start_link(entries), do: GenServer.start_link(__MODULE__, entries)

    # Readers find the Poller's state in its published ETS table.
    def init(entries) do
      table = :ets.new(__MODULE__, [:set, :public, read_concurrency: true])

      :ets.insert(
        table,
        {:thread_inputs,
         %{entries: entries, local_live: MapSet.new(), own_host_id: "host", fleet: nil}}
      )

      :persistent_term.put({:shuttle_poller_published_state, self()}, table)
      {:ok, entries}
    end

    def terminate(_reason, _entries) do
      :persistent_term.erase({:shuttle_poller_published_state, self()})
      :ok
    end
  end

  defmodule RemoteClient do
    def get(_url, _headers, _timeout) do
      now = System.system_time(:millisecond)

      records = [
        %{
          "id" => "duplicate",
          "timestamp" => now,
          "type" => "board",
          "kind" => "post",
          "fiber" => "child",
          "text" => "remote duplicate"
        },
        %{
          "id" => "remote",
          "timestamp" => now,
          "type" => "board",
          "kind" => "asked",
          "fiber" => "child"
        }
      ]

      {:ok, 200, [], Jason.encode!(%{records: records})}
    end
  end

  defmodule LateRemoteClient do
    def get(_url, _headers, _timeout) do
      record = %{
        "id" => "late",
        "timestamp" => System.system_time(:millisecond) - 15 * 60_000,
        "type" => "board",
        "kind" => "post",
        "fiber" => "child",
        "text" => "arrived late"
      }

      {:ok, 200, [], Jason.encode!(%{records: [record]})}
    end
  end

  test "marks endpoint joins this host's ledgers into per-thread marks over the board's reach" do
    import Shuttle.Test.Ledgers
    sessions = ledger_setup!("SHUTTLE_SESSIONS_FILE", "board_marks_sessions")
    commits = ledger_setup!("SHUTTLE_COMMITS_FILE", "board_marks_commits")
    Shuttle.Test.Env.put_env("SHUTTLE_HOST", "host")
    host = Shuttle.Poller.own_host_id()
    now = System.system_time(:millisecond)
    old = now - Shuttle.Board.retention_ms() - 120_000

    write_jsonl!(sessions, [
      %{"uid" => "U1", "session" => "s1", "host" => host, "at" => old, "kind" => "dispatch"},
      %{"uid" => "U1", "session" => "s2", "host" => host, "at" => now - 1000, "kind" => "resume"}
    ])

    write_jsonl!(commits, [
      commit_record(%{"at" => old, "session" => "s1", "sha" => "a"}),
      commit_record(%{"at" => now - 500, "session" => "s2", "sha" => "b"}),
      commit_record(%{"at" => now - 400, "session" => "elsewhere", "sha" => "c"})
    ])

    body = api_conn() |> get("/api/v1/board/marks") |> json_response(200)
    assert body["reach_ms"] == Shuttle.Board.retention_ms()
    assert body["marks"] == %{"U1" => %{"launches" => [now - 1000], "commits" => [now - 500]}}
    assert Map.has_key?(body["origins"], host)
  end

  test "holdings appends each report as one line stamped with the host's local time" do
    dir = Path.join(System.tmp_dir!(), "board-holdings-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(dir) end)
    Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", dir)

    report = %{
      "page" => 1,
      "frames" => 3,
      "reader" => [%{"key" => "local:/a.html", "chars" => 9}]
    }

    for _ <- 1..2 do
      assert %{"ok" => true} =
               api_conn()
               |> post("/api/v1/board/holdings", Jason.encode!(report))
               |> json_response(200)
    end

    lines =
      dir
      |> Path.join("tmp/board-holdings.jsonl")
      |> File.read!()
      |> String.split("\n", trim: true)

    assert [first, _] = Enum.map(lines, &Jason.decode!/1)
    assert Map.delete(first, "time") == report
    assert first["time"] =~ ~r/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/
  end

  test "family endpoint composes and deduplicates a remote feed" do
    path = Path.join(System.tmp_dir!(), "board-family-api-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm(path) end)
    now = System.system_time(:millisecond)

    record = %{
      "type" => "board",
      "id" => "duplicate",
      "timestamp" => now,
      "kind" => "post",
      "fiber" => "child",
      "text" => "local"
    }

    File.write!(path, Jason.encode!(record) <> "\n")
    Shuttle.Test.EventFiles.scope!(path)
    Shuttle.Test.Env.put_env("SHUTTLE_HOST", "host")

    entries =
      for {id, uid} <- [{"hub", "root"}, {"hub/child", "child"}],
          do: %{
            felt_store: "/store",
            fiber: %{
              "id" => id,
              "slug" => id,
              "uid" => uid,
              "name" => uid,
              "shuttle" => %{"host" => "host"}
            }
          }

    poller = start_supervised!({FakePoller, entries})
    Shuttle.Test.Env.put_server(Shuttle.Poller, poller)
    dir = Path.join(System.tmp_dir!(), "board-cache-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(dir) end)

    registry =
      start_supervised!(
        {Shuttle.RemoteTemporalRegistry,
         name: nil,
         remotes: [%Shuttle.Remote{name: "remote", url: "http://remote"}],
         client: RemoteClient,
         store_dir: dir}
      )

    Shuttle.Test.Env.put_server(Shuttle.RemoteTemporalRegistry, registry)

    assert %{"family" => nil, "viewer" => nil, "records" => []} =
             api_conn() |> get("/api/v1/board/family?session=pi:unknown") |> json_response(200)

    assert :sys.get_state(registry).entries["remote"].feeds.board.last_attempt_at == nil
    assert %{items: [_ | _]} = Shuttle.RemoteTemporalRegistry.entries(registry, :board)["remote"]
    result = api_conn() |> get("/api/v1/board/family?fiber=root&since_ms=0") |> json_response(200)
    assert result["family"]["root_uid"] == "root"
    assert result["reach_ms"] == Shuttle.Board.retention_ms()

    assert [%{"id" => "duplicate", "text" => "local"}, %{"id" => "remote", "delivered" => true}] =
             result["records"]

    assert %{"family" => nil, "viewer" => nil, "records" => []} =
             api_conn() |> get("/api/v1/board/family?session=pi:unknown") |> json_response(200)

    assert 400 == get(api_conn(), "/api/v1/board/family").status
  end

  defmodule QuietRemoteClient do
    def get(_url, _headers, _timeout), do: {:ok, 200, [], Jason.encode!(%{records: []})}
  end

  # A reader catching up from a cursor still learns what waits from before it.
  test "family endpoint names what waits on the human over the board's whole reach" do
    path = Path.join(System.tmp_dir!(), "board-waiting-api-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm(path) end)
    now = System.system_time(:millisecond)

    record = %{
      "type" => "board",
      "id" => "to-cail",
      "timestamp" => now - 60_000,
      "kind" => "post",
      "fiber" => "child",
      "to" => %{"label" => "Cail"},
      "text" => "the fit converged"
    }

    File.write!(path, Jason.encode!(record) <> "\n")
    Shuttle.Test.EventFiles.scope!(path)
    Shuttle.Test.Env.put_env("SHUTTLE_HOST", "host")

    entries =
      for {id, uid} <- [{"hub", "root"}, {"hub/child", "child"}],
          do: %{
            felt_store: "/store",
            fiber: %{
              "id" => id,
              "slug" => id,
              "uid" => uid,
              "name" => uid,
              "shuttle" => %{"host" => "host"}
            }
          }

    poller = start_supervised!({FakePoller, entries})
    Shuttle.Test.Env.put_server(Shuttle.Poller, poller)
    dir = Path.join(System.tmp_dir!(), "board-cache-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(dir) end)

    registry =
      start_supervised!(
        {Shuttle.RemoteTemporalRegistry,
         name: nil,
         remotes: [%Shuttle.Remote{name: "remote", url: "http://remote"}],
         client: QuietRemoteClient,
         store_dir: dir}
      )

    Shuttle.Test.Env.put_server(Shuttle.RemoteTemporalRegistry, registry)

    result =
      api_conn()
      |> get("/api/v1/board/family?fiber=root&since_ms=#{now - 1000}")
      |> json_response(200)

    assert result["records"] == []
    assert result["waiting"] == %{"child" => %{"id" => "to-cail", "at" => now - 60_000}}
  end

  test "a late remote record is selected by local receive time" do
    Shuttle.Test.Env.put_env("SHUTTLE_HOST", "host")

    entries =
      for {id, uid} <- [{"hub", "root"}, {"hub/child", "child"}],
          do: %{
            felt_store: "/store",
            fiber: %{
              "id" => id,
              "slug" => id,
              "uid" => uid,
              "name" => uid,
              "shuttle" => %{"host" => "host"}
            }
          }

    poller = start_supervised!({FakePoller, entries})
    Shuttle.Test.Env.put_server(Shuttle.Poller, poller)
    dir = Path.join(System.tmp_dir!(), "board-cache-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(dir) end)
    Shuttle.Test.EventFiles.scope!(Path.join(dir, "events.jsonl"))

    registry =
      start_supervised!(
        {Shuttle.RemoteTemporalRegistry,
         name: nil,
         remotes: [%Shuttle.Remote{name: "remote", url: "http://remote"}],
         client: LateRemoteClient,
         store_dir: dir}
      )

    Shuttle.Test.Env.put_server(Shuttle.RemoteTemporalRegistry, registry)
    now = System.system_time(:millisecond)
    since = now - 5 * 60_000

    api_conn() |> get("/api/v1/board/family?fiber=root&since_ms=0") |> json_response(200)
    assert %{items: [_]} = Shuttle.RemoteTemporalRegistry.entries(registry, :board)["remote"]

    result =
      api_conn()
      |> get("/api/v1/board/family?fiber=root&since_ms=#{since}")
      |> json_response(200)

    assert [%{"id" => "late", "timestamp" => timestamp, "received_at" => received_at}] =
             result["records"]

    assert timestamp < since
    assert received_at >= since
  end

  test "local feed filters and supports conditional requests" do
    path = Path.join(System.tmp_dir!(), "board-api-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm(path) end)
    now = System.system_time(:millisecond)
    record = %{"type" => "board", "id" => "brd-test", "timestamp" => now, "kind" => "post"}
    File.write!(path, Jason.encode!(record) <> "\n")
    Shuttle.Test.EventFiles.scope!(path)
    first = get(api_conn(), "/api/v1/board?since_ms=#{now}")
    assert %{"records" => [^record]} = json_response(first, 200)
    [etag] = get_resp_header(first, "etag")

    assert (api_conn()
            |> put_req_header("if-none-match", etag)
            |> get("/api/v1/board?since_ms=#{now}")).status == 304

    assert %{"records" => []} =
             api_conn() |> get("/api/v1/board?since_ms=#{now + 1}") |> json_response(200)
  end

  test "open asks every board on the stream to show a page of a fiber" do
    {:ok, _} = Registry.register(Shuttle.Voice.Streams, :board_open, nil)

    body = %{fiber_id: "01FIBER", origin: "fir", page: "tapestry"}
    assert %{"ok" => true} = api_conn() |> post("/api/v1/board/open", body) |> json_response(200)
    assert_receive {:board_open, %{fiber_id: "01FIBER", origin: "fir", page: "tapestry"}}

    assert 400 == post(api_conn(), "/api/v1/board/open", %{fiber_id: "01FIBER", page: "x"}).status
    assert 400 == post(api_conn(), "/api/v1/board/open", %{page: "files"}).status
    refute_receive {:board_open, _}, 30
  end

  defmodule OpenForwardClient do
    def post(url, body, _type, _timeout) do
      send(:persistent_term.get({__MODULE__, :test}), {:forwarded, url, Jason.decode!(body)})
      {:ok, 200, ~s({"ok":true})}
    end
  end

  test "open passes the request once to every other daemon in the fleet" do
    :persistent_term.put({OpenForwardClient, :test}, self())
    Shuttle.Test.Env.put_app_env(:write_forward_client, OpenForwardClient)

    Shuttle.Test.Env.put_app_env(:remotes, [
      %{name: "fir", url: "http://127.0.0.1:4101"},
      %{name: Shuttle.Poller.own_host_id(), url: "http://127.0.0.1:4102"}
    ])

    body = %{fiber_id: "01FIBER", page: "files"}
    assert %{"ok" => true} = api_conn() |> post("/api/v1/board/open", body) |> json_response(200)
    own = Shuttle.Poller.own_host_id()

    assert_receive {:forwarded, "http://127.0.0.1:4101/api/v1/board/open",
                    %{
                      "fiber_id" => "01FIBER",
                      "origin" => ^own,
                      "page" => "files",
                      "forwarded" => true
                    }}

    refute_receive {:forwarded, _, _}, 50

    forwarded = Map.put(body, :forwarded, true)

    assert %{"ok" => true} =
             api_conn() |> post("/api/v1/board/open", forwarded) |> json_response(200)

    refute_receive {:forwarded, _, _}, 50
  end
end
