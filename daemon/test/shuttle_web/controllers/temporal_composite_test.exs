defmodule ShuttleWeb.TemporalCompositeTest do
  @moduledoc """
  The cross-host temporal composites, plus the conditional-fetch support the
  hub and the board depend on.

  A live `Shuttle.RemoteTemporalRegistry` under its default name backs the
  composites; its cache is filled synchronously from a scripted HTTP stub, so
  each test states exactly what "candide" is remembered as having.
  """
  use ExUnit.Case
  import Shuttle.Test.ApiConn

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
    def calls, do: Agent.get(__MODULE__, &Map.get(&1, :calls, 0))

    @impl true
    def get(url, _timeout_ms) do
      path = URI.parse(url).path

      Agent.get_and_update(__MODULE__, fn state ->
        response =
          case Map.get(state, path) do
            nil -> {:error, :not_set}
            body -> {:ok, body}
          end

        {response, Map.update(state, :calls, 1, &(&1 + 1))}
      end)
    end
  end

  setup do
    start_supervised!(MockClient)
    :ok
  end

  # A registry under the DEFAULT name, so the controllers find it, primed with
  # whatever the caller scripted. Returns after one synchronous refresh, which
  # also starts every feed's freshness gate: the composites below read memory.
  defp with_remote(feeds, opts \\ []) do
    start_remote(feeds, opts)
    :ok = RemoteTemporalRegistry.refresh_now()
  end

  # The same registry, unprimed: its first composite request is what fetches.
  defp start_remote(feeds, opts \\ []) do
    Enum.each(feeds, fn {path, body} -> MockClient.set(path, Jason.encode!(body)) end)

    dir = Path.join(System.tmp_dir!(), "shuttle-composite-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(dir) end)

    start_supervised!(
      {RemoteTemporalRegistry,
       [
         name: RemoteTemporalRegistry,
         remotes: [%Remote{name: "candide", url: "http://localhost:4001"}],
         client: MockClient,
         store_dir: dir
       ] ++ opts}
    )
  end

  defp own_host, do: Shuttle.Poller.own_host_id()

  # Point the readers at throwaway files, clearing SHUTTLE_DATA_DIR so nothing
  # can fall through to a dev machine's real ~/.shuttle.
  defp with_data_files(events_lines, session_lines) do
    keys = ~w(SHUTTLE_EVENTS_FILE SHUTTLE_SESSIONS_FILE SHUTTLE_COMMITS_FILE SHUTTLE_DATA_DIR)
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
    System.put_env("SHUTTLE_COMMITS_FILE", Path.join(dir, "commits.jsonl"))

    on_exit(fn ->
      File.rm_rf(dir)

      Enum.each(previous, fn {k, v} ->
        if v, do: System.put_env(k, v), else: System.delete_env(k)
      end)
    end)

    %{dir: dir, events: events, sessions: sessions}
  end

  describe "in_window/4 — the window semantics every composite filters remotes by" do
    alias ShuttleWeb.TemporalComposite, as: Composite

    test "a nil upper bound is open-ended, matching CommitLedger's local half" do
      items = [%{at: @t0}, %{at: @t0 + @day}, %{at: @t0 - 1}]

      assert Composite.in_window(items, :at, @t0, nil) == [%{at: @t0}, %{at: @t0 + @day}]
    end

    test "both bounds are inclusive" do
      items = [%{at: @t0}, %{at: @t0 + @minute}, %{at: @t0 + 2 * @minute}]

      assert Composite.in_window(items, :at, @t0, @t0 + 2 * @minute) == items

      assert Composite.in_window(items, :at, @t0 + @minute, @t0 + @minute) ==
               [%{at: @t0 + @minute}]
    end

    test "an item with no readable timestamp is kept, not silently dropped" do
      items = [%{at: @t0 - @day}, %{other: "no stamp"}, %{at: nil}]

      assert Composite.in_window(items, :at, @t0, @t0 + @day) == [
               %{other: "no stamp"},
               %{at: nil}
             ]
    end

    test "string keys read the same as atom keys" do
      assert Composite.in_window([%{"at" => @t0 - @day}], :at, @t0, nil) == []
      assert Composite.in_window([%{"at" => @t0}], :at, @t0, nil) == [%{"at" => @t0}]
    end
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

      # The local origin covers the canonical window: whole minutes.
      assert origins[own_host()]["window"] == %{"from_ms" => from_ms, "to_ms" => @t0 + 59_999}
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

  describe "demand" do
    test "a composite request is what fetches the remote's feed" do
      with_data_files([], [])

      start_remote(%{
        "/api/v1/commits" => %{"records" => [%{"at" => @t0, "sha" => "abc", "kind" => "commit"}]}
      })

      assert MockClient.calls() == 0

      conn = get(api_conn(), "/api/v1/commits/composite?since_ms=0")

      assert %{"records" => [record], "origins" => origins} = json_response(conn, 200)
      assert record["host"] == "candide"
      assert origins["candide"]["stale"] == false
      # Only the commits feed was asked for.
      assert MockClient.calls() == 1
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

  describe "conditional fetch on /activity" do
    test "bounds that differ inside a minute share a validator, and the scan is skipped" do
      with_data_files([%{"timestamp" => @t0 + 5_000, "type" => "pre_tool_use"}], [])

      first = get(api_conn(), "/api/v1/activity?from_ms=#{@t0}&to_ms=#{@t0 + @minute}")
      assert first.status == 200
      tag = etag(first)

      # Same canonical window: from ceils to @t0, to floors to @t0 + @minute.
      nudged = "/api/v1/activity?from_ms=#{@t0 - 59_999}&to_ms=#{@t0 + @minute + 42_000}"
      assert etag(get(api_conn(), nudged)) == tag

      conditional = api_conn() |> put_req_header("if-none-match", tag) |> get(nudged)
      assert conditional.status == 304
      assert conditional.resp_body == ""
    end

    test "an append to the events file turns the same validator into a 200" do
      %{events: events} =
        with_data_files([%{"timestamp" => @t0 + 5_000, "type" => "pre_tool_use"}], [])

      url = "/api/v1/activity?from_ms=#{@t0}&to_ms=#{@t0 + @minute}"
      tag = etag(get(api_conn(), url))

      File.write!(
        events,
        Jason.encode!(%{"timestamp" => @t0 + 6_000, "type" => "stop"}) <> "\n",
        [
          :append
        ]
      )

      conn = api_conn() |> put_req_header("if-none-match", tag) |> get(url)

      assert conn.status == 200
      assert etag(conn) != tag
      assert Enum.any?(json_response(conn, 200)["buckets"], &(&1["k"] == "reply"))
    end
  end

  describe "conditional fetch on the composites" do
    test "an unchanged activity composite 304s; an append or a remote change does not" do
      %{events: events} =
        with_data_files([%{"timestamp" => @t0, "type" => "pre_tool_use", "cwd" => "/local"}], [])

      with_remote(
        %{"/api/v1/activity" => %{"buckets" => [%{"m" => @t0, "k" => "agent", "n" => 1}]}},
        freshness_ms: 60_000
      )

      url = "/api/v1/activity/composite?from_ms=#{@t0}&to_ms=#{@t0 + @minute}"
      first = get(api_conn(), url)
      assert first.status == 200
      tag = etag(first)

      assert (api_conn() |> put_req_header("if-none-match", tag) |> get(url)).status == 304

      # The local stream moves.
      File.write!(events, Jason.encode!(%{"timestamp" => @t0, "type" => "stop"}) <> "\n", [
        :append
      ])

      after_append = api_conn() |> put_req_header("if-none-match", tag) |> get(url)
      assert after_append.status == 200
      tag = etag(after_append)
      assert (api_conn() |> put_req_header("if-none-match", tag) |> get(url)).status == 304

      # The remote's data moves.
      MockClient.set(
        "/api/v1/activity",
        Jason.encode!(%{"buckets" => [%{"m" => @t0, "k" => "agent", "n" => 9}]})
      )

      :ok = RemoteTemporalRegistry.refresh_now()

      after_refresh = api_conn() |> put_req_header("if-none-match", tag) |> get(url)
      assert after_refresh.status == 200
      assert Enum.any?(json_response(after_refresh, 200)["buckets"], &(&1["n"] == 9))
    end

    test "the ledger composites 304 while nothing moved" do
      with_data_files([], [%{"fiber" => "a", "session" => "s", "at" => @t0}])

      with_remote(%{
        "/api/v1/sessions" => %{"records" => [%{"fiber" => "remote", "at" => @t0}]},
        "/api/v1/commits" => %{"records" => []},
        "/api/v1/sent-files/all" => %{"files" => []}
      })

      for url <- [
            "/api/v1/sessions/composite?since_ms=0",
            "/api/v1/sessions/composite?since_ms=0&uid=01KTS261GJMMRDRHS2QDMEFV3K",
            "/api/v1/commits/composite?since_ms=0",
            "/api/v1/sent-files/all/composite?since_ms=0"
          ] do
        assert_etag_round_trip(url)
      end

      sessions = etag(get(api_conn(), "/api/v1/sessions/composite?since_ms=0"))
      narrowed = etag(get(api_conn(), "/api/v1/sessions/composite?since_ms=0&uid=x"))
      assert sessions != narrowed
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
