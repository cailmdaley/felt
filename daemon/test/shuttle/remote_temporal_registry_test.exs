defmodule Shuttle.RemoteTemporalRegistryTest do
  @moduledoc """
  The cross-host temporal cache: four feeds per remote, fetched only when a
  composite asks, behind a freshness gate, with last-good data that survives
  both a failed fetch and a daemon restart.

  Driven against a scripted HTTP stub that records every URL it is asked for,
  so each test can say exactly which fetches a request caused.
  """
  use ExUnit.Case, async: true

  alias Shuttle.Remote
  alias Shuttle.RemoteTemporalRegistry

  # Scripted per-URL transport. Responses are keyed by the URL's PATH ONLY, so a
  # test scripts "the activity feed" once rather than re-deriving the window's
  # query string. Every request is logged; a path can be given a delay.
  defmodule MockClient do
    @behaviour Shuttle.RemoteRegistry.Client
    use Agent

    def start_link(_ \\ []),
      do: Agent.start_link(fn -> %{bodies: %{}, delays: %{}, log: []} end, name: __MODULE__)

    def reset, do: Agent.update(__MODULE__, &%{&1 | bodies: %{}})
    def set(path, response), do: Agent.update(__MODULE__, &put_in(&1, [:bodies, path], response))
    def delay(path, ms), do: Agent.update(__MODULE__, &put_in(&1, [:delays, path], ms))

    @doc """
    Hold every fetch of `path` until the test releases it: the fetching process
    sends `{:fetch_held, fetcher}` to the caller and waits for `:release`.
    """
    def hold(path), do: delay(path, {:hold, self()})

    @doc "The URLs requested so far, oldest first."
    def log, do: Agent.get(__MODULE__, &Enum.reverse(&1.log))

    def calls(path), do: Enum.count(log(), &(URI.parse(&1).path == path))

    @impl true
    def get(url, _timeout_ms), do: scripted(url)

    # Honors If-None-Match against an etag derived from the scripted body, so a
    # test can assert the real 200-then-304 round trip.
    @impl true
    def get(url, req_headers, _timeout_ms) do
      case scripted(url) do
        {:ok, body} ->
          etag = ~s("#{Integer.to_string(:erlang.phash2(body), 16)}")
          inm = Enum.find_value(req_headers, fn {k, v} -> if k == "if-none-match", do: v end)

          if inm == etag,
            do: {:ok, 304, [{"etag", etag}], ""},
            else: {:ok, 200, [{"etag", etag}], body}

        {:error, reason} ->
          {:error, reason}
      end
    end

    defp scripted(url) do
      path = URI.parse(url).path

      {response, delay} =
        Agent.get_and_update(__MODULE__, fn state ->
          {{Map.get(state.bodies, path, {:error, :not_set}), Map.get(state.delays, path, 0)},
           %{state | log: [url | state.log]}}
        end)

      case delay do
        {:hold, test} ->
          send(test, {:fetch_held, self()})
          receive do: (:release -> :ok)

        ms ->
          Process.sleep(ms)
      end

      response
    end
  end

  setup context do
    start_supervised!(MockClient)

    dir = Path.join(System.tmp_dir!(), "shuttle-temporal-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(dir) end)

    script(context[:script] || :full)
    {:ok, dir: dir}
  end

  @bucket %{"m" => 1_770_000_000_000, "s" => nil, "cwd" => "/repo", "k" => "agent", "n" => 3}
  @record %{"fiber" => "work/paper", "host" => "candide", "at" => 1_770_000_000_000}
  @ledgered_commit %{
    "at" => 1_770_000_000_000,
    "kind" => "commit",
    "sha" => "79def80887a45cfdaea4e23a6e0444df808e908a",
    "subject" => "paper: a section",
    "repo" => "/home/me/paper",
    "files" => 1,
    "insertions" => 4,
    "deletions" => 0,
    "session" => "s0"
  }
  @sent_file %{
    "fullPath" => "/repo/frame.png",
    "basename" => "frame.png",
    "timestamp" => 1_770_000_000_000,
    "sessionId" => "s0",
    "uid" => "01KTS261GJMMRDRHS2QDMEFV3K"
  }

  @paths ~w(/api/v1/activity /api/v1/sessions /api/v1/commits /api/v1/sent-files/all)

  defp script(:full) do
    MockClient.set("/api/v1/activity", {:ok, Jason.encode!(%{"buckets" => [@bucket]})})
    MockClient.set("/api/v1/sessions", {:ok, Jason.encode!(%{"records" => [@record]})})
    MockClient.set("/api/v1/commits", {:ok, Jason.encode!(%{"records" => [@ledgered_commit]})})
    MockClient.set("/api/v1/sent-files/all", {:ok, Jason.encode!(%{"files" => [@sent_file]})})
  end

  defp script(_), do: :ok

  defp candide, do: %Remote{name: "candide", url: "http://localhost:4001"}

  defp start_registry(dir, opts \\ []) do
    name = :"temporal_#{System.unique_integer([:positive])}"

    pid =
      start_supervised!(
        {RemoteTemporalRegistry,
         Keyword.merge(
           [name: name, remotes: [candide()], client: MockClient, store_dir: dir],
           opts
         )},
        id: name
      )

    {pid, name}
  end

  defp candide(name, feed), do: RemoteTemporalRegistry.entries(name, feed)["candide"]

  # A ceiling of ~30 s, reached only when the condition never holds: a passing
  # test returns as soon as it does, however loaded the machine.
  defp wait_until(fun, attempts \\ 3_000)
  defp wait_until(fun, 0), do: fun.()

  defp wait_until(fun, attempts) do
    if fun.() do
      true
    else
      Process.sleep(10)
      wait_until(fun, attempts - 1)
    end
  end

  # A clock the test owns: `clock` reads it, `advance.(ms)` moves it forward.
  # Staleness and the freshness gate are then decided by explicit time, not by
  # how long the scheduler took to run the test.
  defp fake_clock do
    agent = start_supervised!({Agent, fn -> DateTime.utc_now() end}, id: make_ref())
    clock = fn -> Agent.get(agent, & &1) end
    advance = fn ms -> Agent.update(agent, &DateTime.add(&1, ms, :millisecond)) end
    {clock, advance}
  end

  describe "demand-driven fetching" do
    test "nothing is fetched until a composite asks", %{dir: dir} do
      {pid, _name} = start_registry(dir)
      # A round trip through the mailbox: had init scheduled anything, it would
      # have had its chance.
      :sys.get_state(pid)
      Process.sleep(50)

      assert MockClient.log() == []
    end

    test "asking for a feed fetches that feed, from every remote, and nothing else",
         %{dir: dir} do
      other = %Remote{name: "other-host", url: "http://localhost:4002"}
      {_pid, name} = start_registry(dir, remotes: [candide(), other])

      entries = RemoteTemporalRegistry.entries(name, :sessions)

      assert entries["candide"].items == [@record]
      assert entries["other-host"].items == [@record]
      refute entries["candide"].stale
      assert entries["candide"].window == nil
      assert MockClient.calls("/api/v1/sessions") == 2
      for path <- @paths -- ["/api/v1/sessions"], do: assert(MockClient.calls(path) == 0)
    end

    test "each feed's list key is decoded into items", %{dir: dir} do
      {_pid, name} = start_registry(dir)

      assert candide(name, :activity).items == [@bucket]
      assert candide(name, :sessions).items == [@record]
      assert candide(name, :commits).items == [@ledgered_commit]
      assert candide(name, :sent_files).items == [@sent_file]
    end

    test "within the freshness gate a request is answered from memory", %{dir: dir} do
      {_pid, name} = start_registry(dir)

      assert candide(name, :commits).items == [@ledgered_commit]
      assert candide(name, :commits).items == [@ledgered_commit]
      assert MockClient.calls("/api/v1/commits") == 1
    end

    test "past the gate the feed is refetched conditionally, and a 304 keeps the data",
         %{dir: dir} do
      {_pid, name} = start_registry(dir, freshness_ms: 0)

      first = candide(name, :commits)
      Process.sleep(5)
      second = candide(name, :commits)

      assert MockClient.calls("/api/v1/commits") == 2
      assert second.items == [@ledgered_commit]
      assert second.etag == first.etag
      assert DateTime.compare(second.last_polled_at, first.last_polled_at) == :gt
    end

    test "concurrent requests for one feed share one in-flight fetch", %{dir: dir} do
      MockClient.delay("/api/v1/sessions", 200)
      {_pid, name} = start_registry(dir)

      views =
        1..4
        |> Enum.map(fn _ -> Task.async(fn -> candide(name, :sessions) end) end)
        |> Enum.map(&Task.await/1)

      assert Enum.all?(views, &(&1.items == [@record]))
      assert MockClient.calls("/api/v1/sessions") == 1
    end

    # The bounded wait is the subject. The fetch is held until the request has
    # returned, so the request can only have come back through its own wait;
    # the elapsed bound (under the 5 s default wait) is wall-clock, hence the
    # tag, with a margin no plausible load reaches.
    @tag :timing
    test "a request waits a bounded time, then serves what is held; the fetch lands later",
         %{dir: dir} do
      MockClient.hold("/api/v1/activity")
      {_pid, name} = start_registry(dir, wait_ms: 30)

      {elapsed_us, early} = :timer.tc(fn -> candide(name, :activity) end)

      assert elapsed_us < 2_500_000
      assert early.items == []
      assert early.stale

      assert_receive {:fetch_held, fetcher}
      send(fetcher, :release)

      # Still inside the gate, so no second fetch: the late result is served.
      assert wait_until(fn -> candide(name, :activity).items == [@bucket] end)
      refute candide(name, :activity).stale
      assert MockClient.calls("/api/v1/activity") == 1
    end
  end

  describe "the activity window" do
    test "ends on a five-minute boundary at or after now and spans fourteen days" do
      width = 14 * 24 * 60 * 60 * 1_000
      quantum = 5 * 60_000

      now = ~U[2026-09-28 10:07:31.250Z]
      {from_ms, to_ms} = RemoteTemporalRegistry.activity_window(now)
      assert to_ms == DateTime.to_unix(~U[2026-09-28 10:10:00Z], :millisecond)
      assert to_ms - from_ms == width
      assert rem(to_ms, quantum) == 0

      on_boundary = ~U[2026-09-28 10:05:00.000Z]
      assert {_, to_ms} = RemoteTemporalRegistry.activity_window(on_boundary)
      assert to_ms == DateTime.to_unix(on_boundary, :millisecond)

      # Every instant inside one quantum asks for the same window.
      assert RemoteTemporalRegistry.activity_window(~U[2026-09-28 10:05:00.001Z]) ==
               RemoteTemporalRegistry.activity_window(~U[2026-09-28 10:09:59.999Z])
    end

    test "is what the remote is asked for, and what the entry reports covering", %{dir: dir} do
      {_pid, name} = start_registry(dir)
      view = candide(name, :activity)

      [url] = Enum.filter(MockClient.log(), &(URI.parse(&1).path == "/api/v1/activity"))
      query = url |> URI.parse() |> Map.fetch!(:query) |> URI.decode_query()
      asked = {String.to_integer(query["from_ms"]), String.to_integer(query["to_ms"])}

      assert view.window == asked
      assert rem(elem(asked, 1), 5 * 60_000) == 0
      assert elem(asked, 1) >= System.system_time(:millisecond)
    end
  end

  describe "failure semantics" do
    test "a failing fetch keeps last-good data and records the error", %{dir: dir} do
      {clock, advance} = fake_clock()
      {_pid, name} = start_registry(dir, freshness_ms: 50, clock: clock)
      assert candide(name, :sessions).items == [@record]

      MockClient.reset()
      advance.(60)
      view = candide(name, :sessions)
      assert MockClient.calls("/api/v1/sessions") == 2

      assert view.items == [@record]
      assert view.last_error == :not_set
      # The last success is moments old: an error alone does not make it stale.
      refute view.stale
    end

    test "feeds fail independently", %{dir: dir} do
      MockClient.set("/api/v1/commits", {:error, :timeout})
      {_pid, name} = start_registry(dir)

      assert %{items: [@bucket], last_error: nil, stale: false} = candide(name, :activity)
      assert %{items: [], last_error: :timeout, stale: true} = candide(name, :commits)
    end

    test "a feed that has never succeeded is stale", %{dir: dir} do
      MockClient.reset()
      {_pid, name} = start_registry(dir)

      view = candide(name, :activity)
      assert view.last_polled_at == nil
      assert view.stale
    end

    test "stale means no success within ten freshness gates", %{dir: dir} do
      {clock, advance} = fake_clock()
      {_pid, name} = start_registry(dir, freshness_ms: 10, clock: clock)
      refute candide(name, :sessions).stale

      MockClient.reset()
      advance.(150)

      view = candide(name, :sessions)
      assert view.stale
      assert view.items == [@record]
      assert view.last_error == :not_set
    end

    test "an unreachable remote retries at most once per gate", %{dir: dir} do
      MockClient.reset()
      {_pid, name} = start_registry(dir)

      for _ <- 1..3, do: candide(name, :activity)
      assert MockClient.calls("/api/v1/activity") == 1
    end

    test "an envelope without the list key is zero items, not a failure", %{dir: dir} do
      MockClient.set("/api/v1/activity", {:ok, Jason.encode!(%{"error" => "nope"})})
      {_pid, name} = start_registry(dir)

      assert %{items: [], last_error: nil} = candide(name, :activity)
    end

    test "no remotes configured is an empty map, not a crash", %{dir: dir} do
      {_pid, name} = start_registry(dir, remotes: [])
      assert RemoteTemporalRegistry.entries(name, :activity) == %{}
      assert MockClient.log() == []
    end
  end

  describe "refresh_now/1" do
    test "fetches every feed inline, ignoring the gate", %{dir: dir} do
      {_pid, name} = start_registry(dir)
      :ok = RemoteTemporalRegistry.refresh_now(name)
      :ok = RemoteTemporalRegistry.refresh_now(name)

      for path <- @paths, do: assert(MockClient.calls(path) == 2)
      # And primes the gate: a request right after is served from memory.
      assert candide(name, :sessions).items == [@record]
      assert MockClient.calls("/api/v1/sessions") == 2
    end
  end

  describe "disk persistence" do
    test "a restarted registry serves the last-good cache for an unreachable remote",
         %{dir: dir} do
      {_pid, name} = start_registry(dir)
      :ok = RemoteTemporalRegistry.refresh_now(name)
      polled_at = candide(name, :activity).last_polled_at
      stop_supervised!(name)

      # The remote is gone entirely; the fresh registry has only the disk.
      MockClient.reset()
      {_pid, restarted} = start_registry(dir)

      view = candide(restarted, :activity)
      assert view.items == [@bucket]
      assert view.last_error == :not_set
      # Freshness is INHERITED, not reset: the entry reads "last seen at T",
      # where T is when the data was actually fetched.
      assert DateTime.compare(view.last_polled_at, polled_at) == :eq
      assert candide(restarted, :commits).items == [@ledgered_commit]
    end

    test "a cache last polled long ago restores as stale", %{dir: dir} do
      {_pid, name} = start_registry(dir)
      :ok = RemoteTemporalRegistry.refresh_now(name)
      stop_supervised!(name)

      path = Path.join([dir, "activity", "candide.json"])
      cached = path |> File.read!() |> Jason.decode!()
      long_ago = DateTime.utc_now() |> DateTime.add(-3_600, :second) |> DateTime.to_iso8601()
      File.write!(path, Jason.encode!(%{cached | "last_polled_at" => long_ago}))

      MockClient.reset()
      {_pid, restarted} = start_registry(dir)

      view = candide(restarted, :activity)
      assert view.items == [@bucket]
      assert view.stale
    end

    test "a restored etag makes the first fetch after boot a 304", %{dir: dir} do
      {_pid, name} = start_registry(dir)
      assert candide(name, :sessions).items == [@record]
      stop_supervised!(name)

      {_pid, restarted} = start_registry(dir)
      view = candide(restarted, :sessions)

      assert MockClient.calls("/api/v1/sessions") == 2
      assert view.items == [@record]
      refute view.stale
    end

    test "each feed is one JSON object per remote, under the feed's directory", %{dir: dir} do
      {_pid, name} = start_registry(dir)
      :ok = RemoteTemporalRegistry.refresh_now(name)

      decoded = Path.join([dir, "activity", "candide.json"]) |> File.read!() |> Jason.decode!()
      assert decoded["items"] == [@bucket]
      assert [_from, _to] = decoded["window"]
      assert is_binary(decoded["etag"])
      # Fleet config is authoritative at boot and is deliberately not persisted.
      refute Map.has_key?(decoded, "remote")

      for feed <- ~w(sessions commits sent_files),
          do: assert(File.exists?(Path.join([dir, feed, "candide.json"])))
    end

    test "a corrupt cache file degrades to an empty feed", %{dir: dir} do
      File.mkdir_p!(Path.join(dir, "activity"))
      File.write!(Path.join([dir, "activity", "candide.json"]), "{not json")

      MockClient.reset()
      {_pid, name} = start_registry(dir)

      view = candide(name, :activity)
      assert view.items == []
      assert view.stale
    end
  end
end
