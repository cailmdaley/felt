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

    def handle_call(:thread_inputs, _from, entries),
      do: {:reply, {:ok, {entries, MapSet.new(), nil}}, entries}
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
    Shuttle.Test.Env.put_env("SHUTTLE_EVENTS_FILE", path)
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

    assert [%{"id" => "duplicate", "text" => "local"}, %{"id" => "remote", "delivered" => true}] =
             result["records"]

    assert %{"family" => nil, "viewer" => nil, "records" => []} =
             api_conn() |> get("/api/v1/board/family?session=pi:unknown") |> json_response(200)

    assert 400 == get(api_conn(), "/api/v1/board/family").status
  end

  test "local feed filters and supports conditional requests" do
    path = Path.join(System.tmp_dir!(), "board-api-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm(path) end)
    now = System.system_time(:millisecond)
    record = %{"type" => "board", "id" => "brd-test", "timestamp" => now, "kind" => "post"}
    File.write!(path, Jason.encode!(record) <> "\n")
    Shuttle.Test.Env.put_env("SHUTTLE_EVENTS_FILE", path)
    first = get(api_conn(), "/api/v1/board?since_ms=#{now}")
    assert %{"records" => [^record]} = json_response(first, 200)
    [etag] = get_resp_header(first, "etag")

    assert (api_conn()
            |> put_req_header("if-none-match", etag)
            |> get("/api/v1/board?since_ms=#{now}")).status == 304

    assert %{"records" => []} =
             api_conn() |> get("/api/v1/board?since_ms=#{now + 1}") |> json_response(200)
  end
end
