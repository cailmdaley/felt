defmodule ShuttleWeb.TemporalCompositeTest do
  @moduledoc """
  The three cross-host temporal composites, plus the conditional-fetch support
  the hub's polling depends on.

  A live `Shuttle.RemoteTemporalRegistry` under its default name backs the
  composites; its cache is filled synchronously from a scripted HTTP stub, so
  each test states exactly what "candide" is remembered as having.
  """
  use ExUnit.Case

  import Plug.Conn
  import Phoenix.ConnTest

  alias Shuttle.{Remote, RemoteTemporalRegistry}

  @endpoint ShuttleWeb.Endpoint

  @t0 1_770_000_000_000
  @minute 60_000
  @day 86_400_000

  # Scripted transport, keyed by path. Same shape as the registry test's.
  defmodule MockClient do
    @behaviour Shuttle.RemoteRegistry.Client
    use Agent

    def start_link(_ \\ []), do: Agent.start_link(fn -> %{} end, name: __MODULE__)
    def set(path, body), do: Agent.update(__MODULE__, &Map.put(&1, path, body))

    @impl true
    def get(url, _timeout_ms) do
      path = URI.parse(url).path

      case Agent.get(__MODULE__, &Map.get(&1, path)) do
        nil -> {:error, :not_set}
        body -> {:ok, body}
      end
    end
  end

  setup do
    start_supervised!(MockClient)
    :ok
  end

  # A registry under the DEFAULT name, so the controllers find it, primed with
  # whatever the caller scripted. Returns after one synchronous refresh.
  defp with_remote(feeds) do
    Enum.each(feeds, fn {path, body} -> MockClient.set(path, Jason.encode!(body)) end)

    dir = Path.join(System.tmp_dir!(), "shuttle-composite-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(dir) end)

    start_supervised!(
      {RemoteTemporalRegistry,
       name: RemoteTemporalRegistry,
       remotes: [%Remote{name: "candide", url: "http://localhost:4001"}],
       client: MockClient,
       store_dir: dir,
       auto_poll: false}
    )

    :ok = RemoteTemporalRegistry.refresh_now()
  end

  defp own_host, do: Shuttle.Poller.own_host_id()

  defp api_conn, do: build_conn() |> put_req_header("accept", "application/json")

  # Point the readers at throwaway files, clearing SHUTTLE_DATA_DIR so nothing
  # can fall through to a dev machine's real ~/.shuttle.
  defp with_data_files(events_lines, session_lines) do
    keys = ~w(SHUTTLE_EVENTS_FILE SHUTTLE_SESSIONS_FILE SHUTTLE_DATA_DIR)
    previous = Map.new(keys, &{&1, System.get_env(&1)})
    Enum.each(keys, &System.delete_env/1)

    dir = Path.join(System.tmp_dir!(), "shuttle-local-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    events = Path.join(dir, "events.jsonl")
    sessions = Path.join(dir, "sessions.jsonl")
    File.write!(events, Enum.map_join(events_lines, "", &(Jason.encode!(&1) <> "\n")))
    File.write!(sessions, Enum.map_join(session_lines, "", &(Jason.encode!(&1) <> "\n")))

    System.put_env("SHUTTLE_EVENTS_FILE", events)
    System.put_env("SHUTTLE_SESSIONS_FILE", sessions)

    on_exit(fn ->
      File.rm_rf(dir)

      Enum.each(previous, fn {k, v} ->
        if v, do: System.put_env(k, v), else: System.delete_env(k)
      end)
    end)

    %{dir: dir, events: events, sessions: sessions}
  end

  describe "GET /api/v1/activity/composite" do
    test "merges local and remote buckets, each stamped with its host" do
      with_data_files(
        [%{"timestamp" => @t0, "type" => "pre_tool_use", "cwd" => "/local"}],
        []
      )

      with_remote(%{
        "/api/v1/activity" => %{
          "buckets" => [%{"m" => @t0, "s" => nil, "cwd" => "/remote", "k" => "agent", "n" => 7}]
        }
      })

      conn = get(api_conn(), "/api/v1/activity/composite?from_ms=#{@t0}&to_ms=#{@t0 + @minute}")

      assert %{"buckets" => buckets, "origins" => origins, "host" => host} =
               json_response(conn, 200)

      assert host == own_host()
      assert %{"cwd" => "/local", "host" => ^host} = Enum.find(buckets, &(&1["cwd"] == "/local"))

      assert %{"cwd" => "/remote", "host" => "candide", "n" => 7} =
               Enum.find(buckets, &(&1["cwd"] == "/remote"))

      assert origins["candide"]["kind"] == "remote"
      assert origins["candide"]["stale"] == false
      assert origins[host]["kind"] == "local"
    end

    test "filters cached remote buckets to the requested sub-window" do
      with_data_files([], [])

      with_remote(%{
        "/api/v1/activity" => %{
          "buckets" => [
            %{"m" => @t0, "k" => "agent", "n" => 1},
            %{"m" => @t0 + @day, "k" => "agent", "n" => 2}
          ]
        }
      })

      conn = get(api_conn(), "/api/v1/activity/composite?from_ms=#{@t0}&to_ms=#{@t0 + @minute}")

      assert %{"buckets" => buckets} = json_response(conn, 200)
      assert Enum.map(buckets, & &1["n"]) == [1]
    end

    test "reports each origin's covered window, not the one that was asked for" do
      with_data_files([], [])
      with_remote(%{"/api/v1/activity" => %{"buckets" => []}})

      from_ms = @t0 - 60 * @day
      conn = get(api_conn(), "/api/v1/activity/composite?from_ms=#{from_ms}&to_ms=#{@t0}")

      assert %{"origins" => origins} = json_response(conn, 200)

      # The hub caches a trailing 14 days; asking for 60 gets what exists, and
      # the covered window says so rather than implying the gap was quiet.
      assert %{"from_ms" => cached_from, "to_ms" => cached_to} = origins["candide"]["window"]
      assert cached_to - cached_from == 14 * @day
      assert cached_from > from_ms

      assert origins[own_host()]["window"] == %{"from_ms" => from_ms, "to_ms" => @t0}
    end

    test "a local-only fleet returns local data and a local origin" do
      with_data_files([%{"timestamp" => @t0, "type" => "pre_tool_use"}], [])

      conn = get(api_conn(), "/api/v1/activity/composite?from_ms=#{@t0}&to_ms=#{@t0 + @minute}")

      assert %{"buckets" => [bucket], "origins" => origins} = json_response(conn, 200)
      assert bucket["host"] == own_host()
      assert Map.keys(origins) == [own_host()]
    end

    test "400 on a bad window, like the single-host endpoint" do
      conn = get(api_conn(), "/api/v1/activity/composite?from_ms=#{@t0}&to_ms=#{@t0 - 1}")
      assert %{"error" => _} = json_response(conn, 400)
    end
  end

  describe "GET /api/v1/sessions/composite" do
    test "merges ledgers on the host stamp the records already carry, sorted by at" do
      with_data_files([], [
        %{"fiber" => "local/one", "session" => "s1", "host" => "test-host", "at" => @t0 + 10}
      ])

      with_remote(%{
        "/api/v1/sessions" => %{
          "records" => [
            %{"fiber" => "remote/old", "session" => "s0", "host" => "candide", "at" => @t0},
            %{"fiber" => "remote/new", "session" => "s2", "host" => "candide", "at" => @t0 + 20}
          ]
        }
      })

      conn = get(api_conn(), "/api/v1/sessions/composite?since_ms=0")

      assert %{"records" => records, "origins" => origins} = json_response(conn, 200)
      assert Enum.map(records, & &1["fiber"]) == ["remote/old", "local/one", "remote/new"]
      assert origins["candide"]["kind"] == "remote"
    end

    test "since_ms bounds the cached remote ledger too" do
      with_data_files([], [])

      with_remote(%{
        "/api/v1/sessions" => %{
          "records" => [
            %{"fiber" => "remote/old", "at" => @t0},
            %{"fiber" => "remote/new", "at" => @t0 + 20}
          ]
        }
      })

      conn = get(api_conn(), "/api/v1/sessions/composite?since_ms=#{@t0 + 10}")

      assert %{"records" => records} = json_response(conn, 200)
      assert Enum.map(records, & &1["fiber"]) == ["remote/new"]
    end
  end

  describe "GET /api/v1/narration/composite" do
    test "stamps each commit with its origin and filters to the window" do
      with_remote(%{
        "/api/v1/narration" => %{
          "commits" => [
            %{"iso" => "2026-02-02T02:40:00Z", "subject" => "inside"},
            %{"iso" => "2020-01-01T00:00:00Z", "subject" => "outside"}
          ]
        }
      })

      conn = get(api_conn(), "/api/v1/narration/composite?from_ms=#{@t0}&to_ms=#{@t0 + @day}")

      assert %{"commits" => commits, "origins" => origins, "host" => host} =
               json_response(conn, 200)

      remote = Enum.filter(commits, &(&1["host"] == "candide"))
      assert Enum.map(remote, & &1["subject"]) == ["inside"]
      assert origins["candide"]["kind"] == "remote"
      assert origins[host]["kind"] == "local"
    end
  end

  describe "a disconnected remote" do
    test "keeps its history on screen, marked stale with its last-seen time" do
      with_data_files([], [])
      with_remote(%{"/api/v1/activity" => %{"buckets" => [%{"m" => @t0, "n" => 4}]}})

      # candide goes away entirely. Poll again: the fetch fails, the cache holds.
      Agent.update(MockClient, fn _ -> %{} end)
      :ok = RemoteTemporalRegistry.refresh_now()

      conn = get(api_conn(), "/api/v1/activity/composite?from_ms=#{@t0}&to_ms=#{@t0 + @minute}")

      assert %{"buckets" => buckets, "origins" => origins} = json_response(conn, 200)
      assert Enum.any?(buckets, &(&1["host"] == "candide" and &1["n"] == 4))
      assert origins["candide"]["last_error"] == "not_set"
      assert origins["candide"]["last_polled_at"] != nil
    end
  end

  describe "conditional fetch on the host-scoped feeds" do
    test "/activity serves an ETag and 304s an unchanged window" do
      with_data_files([%{"timestamp" => @t0, "type" => "pre_tool_use"}], [])
      assert_etag_round_trip("/api/v1/activity?from_ms=#{@t0}&to_ms=#{@t0 + @minute}")
    end

    test "/sessions serves an ETag and 304s an unchanged ledger" do
      with_data_files([], [%{"fiber" => "a", "session" => "s", "at" => @t0}])
      assert_etag_round_trip("/api/v1/sessions?since_ms=0")
    end

    test "/narration serves an ETag and 304s an unchanged store" do
      assert_etag_round_trip("/api/v1/narration?from_ms=#{@t0}&to_ms=#{@t0 + @day}")
    end

    test "/activity's ETag distinguishes windows" do
      with_data_files([%{"timestamp" => @t0, "type" => "pre_tool_use"}], [])

      first = get(api_conn(), "/api/v1/activity?from_ms=#{@t0}&to_ms=#{@t0 + @minute}")
      second = get(api_conn(), "/api/v1/activity?from_ms=#{@t0}&to_ms=#{@t0 + @day}")

      assert etag(first) != etag(second)
    end

    test "a changed events file breaks the /activity ETag" do
      %{events: events} = with_data_files([%{"timestamp" => @t0, "type" => "pre_tool_use"}], [])
      url = "/api/v1/activity?from_ms=#{@t0}&to_ms=#{@t0 + @minute}"

      before = etag(get(api_conn(), url))

      # A new line, and an mtime a second in the future so the token moves even
      # on a filesystem with whole-second mtime granularity.
      File.write!(events, Jason.encode!(%{"timestamp" => @t0, "type" => "stop"}) <> "\n", [
        :append
      ])

      future = System.os_time(:second) + 5
      File.touch!(events, future)

      assert etag(get(api_conn(), url)) != before
    end
  end

  defp assert_etag_round_trip(url) do
    first = get(api_conn(), url)
    assert first.status == 200
    assert (tag = etag(first)) != nil

    conditional = api_conn() |> put_req_header("if-none-match", tag) |> get(url)
    assert conditional.status == 304
    assert conditional.resp_body == ""
  end

  defp etag(conn) do
    case get_resp_header(conn, "etag") do
      [value | _] -> value
      [] -> nil
    end
  end
end
