defmodule ShuttleWeb.TemporalCompositeTest do
  @moduledoc """
  The cross-host temporal composites, plus the conditional-fetch support the
  hub and the board depend on.

  A live `Shuttle.RemoteTemporalRegistry`, registered as the test's instance,
  backs the composites; its cache is filled synchronously from a scripted HTTP stub, so
  each test states exactly what "candide" is remembered as having.
  """
  use ExUnit.Case, async: true
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

  # A registry the controllers find as this test's instance, primed with
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

    Shuttle.Test.Env.start_scoped!(
      {RemoteTemporalRegistry,
       [
         name: nil,
         remotes: [%Remote{name: "candide", url: "http://localhost:4001"}],
         client: MockClient,
         store_dir: dir
       ] ++ opts},
      RemoteTemporalRegistry
    )
  end

  # Point the readers at throwaway files, clearing SHUTTLE_DATA_DIR so nothing
  # can fall through to a dev machine's real ~/.shuttle.
  defp with_data_files(events_lines, session_lines) do
    keys = ~w(SHUTTLE_EVENTS_FILE SHUTTLE_SESSIONS_FILE SHUTTLE_COMMITS_FILE SHUTTLE_DATA_DIR)
    Enum.each(keys, &Shuttle.Test.Env.delete_env/1)

    dir = Path.join(System.tmp_dir!(), "shuttle-local-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    events = Path.join(dir, "events.jsonl")
    sessions = Path.join(dir, "sessions.jsonl")
    File.write!(events, Enum.map_join(events_lines, "", &(Jason.encode!(&1) <> "\n")))
    File.write!(sessions, Enum.map_join(session_lines, "", &(Jason.encode!(&1) <> "\n")))

    Shuttle.Test.EventFiles.scope!(events)
    Shuttle.Test.Env.put_env("SHUTTLE_SESSIONS_FILE", sessions)
    Shuttle.Test.Env.put_env("SHUTTLE_COMMITS_FILE", Path.join(dir, "commits.jsonl"))

    on_exit(fn -> File.rm_rf(dir) end)

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
      with_remote(%{"/api/v1/sessions" => %{"records" => [%{"fiber" => "remote/one", "session" => "s2", "host" => "candide", "at" => @t0}]}})

      # candide goes away entirely. Poll again: the fetch fails, the cache holds.
      Agent.update(MockClient, fn _ -> %{} end)
      :ok = RemoteTemporalRegistry.refresh_now()

      conn = get(api_conn(), "/api/v1/sessions/composite?since_ms=0")

      assert %{"records" => records, "origins" => origins} = json_response(conn, 200)
      assert Enum.any?(records, &(&1["host"] == "candide" and &1["fiber"] == "remote/one"))
      assert origins["candide"]["last_error"] == "not_set"
      # The last-seen time rides the block exactly while the origin reads stale.
      assert is_binary(origins["candide"]["last_polled_at"]) == origins["candide"]["stale"]
    end
  end

  describe "conditional fetch on the host-scoped feeds" do
    test "/sessions serves an ETag and 304s an unchanged ledger" do
      with_data_files([], [%{"fiber" => "a", "session" => "s", "at" => @t0}])
      assert_etag_round_trip("/api/v1/sessions?since_ms=0")
    end
  end

  describe "conditional fetch on the composites" do
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
