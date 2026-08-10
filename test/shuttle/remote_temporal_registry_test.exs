defmodule Shuttle.RemoteTemporalRegistryTest do
  @moduledoc """
  The cross-host temporal cache: three feeds per remote, last-good data that
  survives both a failed poll and a daemon restart.

  Driven synchronously (`auto_poll: false` + `refresh_now/1`) against a scripted
  HTTP stub, the same way `Shuttle.RemoteFiberRegistryTest` drives the fiber
  feed.
  """
  use ExUnit.Case

  alias Shuttle.Remote
  alias Shuttle.RemoteTemporalRegistry

  # Scripted per-URL transport. Responses are keyed by the URL's PATH ONLY, so a
  # test scripts "the activity feed" once rather than re-deriving the trailing
  # window's query string it cannot predict.
  defmodule MockClient do
    @behaviour Shuttle.RemoteRegistry.Client
    use Agent

    def start_link(_ \\ []), do: Agent.start_link(fn -> %{} end, name: __MODULE__)
    def reset, do: Agent.update(__MODULE__, fn _ -> %{} end)
    def set(path, response), do: Agent.update(__MODULE__, &Map.put(&1, path, response))

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
      Agent.get(__MODULE__, &Map.get(&1, path, {:error, :not_set}))
    end
  end

  setup context do
    start_supervised!(MockClient)
    MockClient.reset()

    dir = Path.join(System.tmp_dir!(), "shuttle-temporal-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(dir) end)

    script(context[:script] || :full)
    {:ok, dir: dir}
  end

  @bucket %{"m" => 1_770_000_000_000, "s" => nil, "cwd" => "/repo", "k" => "agent", "n" => 3}
  @record %{"fiber" => "work/paper", "host" => "candide", "at" => 1_770_000_000_000}
  @commit %{"iso" => "2026-02-02T02:40:00Z", "subject" => "paper: a section"}
  @spend %{
    "fiber" => "work/paper",
    "session" => "s0",
    "at" => 1_770_000_000_000,
    "found" => true,
    "input" => 1,
    "output" => 2,
    "cache_read" => 3,
    "cache_write" => 4,
    "messages" => 1
  }

  defp script(:full) do
    MockClient.set("/api/v1/activity", {:ok, Jason.encode!(%{"buckets" => [@bucket]})})
    MockClient.set("/api/v1/sessions", {:ok, Jason.encode!(%{"records" => [@record]})})
    MockClient.set("/api/v1/narration", {:ok, Jason.encode!(%{"commits" => [@commit]})})
    MockClient.set("/api/v1/spend", {:ok, Jason.encode!(%{"sessions" => [@spend]})})
  end

  defp script(_), do: :ok

  defp candide do
    %Remote{name: "candide", url: "http://localhost:4001", poll_interval_ms: 50}
  end

  defp start_registry(dir, opts \\ []) do
    name = :"temporal_#{System.unique_integer([:positive])}"

    pid =
      start_supervised!(
        {RemoteTemporalRegistry,
         Keyword.merge(
           [
             name: name,
             remotes: [candide()],
             client: MockClient,
             store_dir: dir,
             auto_poll: false
           ],
           opts
         )},
        id: name
      )

    {pid, name}
  end

  describe "caching the four feeds" do
    test "a successful poll caches activity, sessions, narration, and spend", %{dir: dir} do
      {_pid, name} = start_registry(dir)
      :ok = RemoteTemporalRegistry.refresh_now(name)

      entry = RemoteTemporalRegistry.entries(name)["candide"]

      assert entry.activity_buckets == [@bucket]
      assert entry.sessions == [@record]
      assert entry.narration_commits == [@commit]
      assert entry.spend == [@spend]
      assert entry.last_error == nil
      refute entry.stale
      assert {from_ms, to_ms} = entry.activity_window
      assert to_ms - from_ms == 14 * 24 * 60 * 60 * 1_000
    end

    test "an envelope without the list key is zero items, not a failure", %{dir: dir} do
      MockClient.set("/api/v1/activity", {:ok, Jason.encode!(%{"error" => "nope"})})
      {_pid, name} = start_registry(dir)
      :ok = RemoteTemporalRegistry.refresh_now(name)

      entry = RemoteTemporalRegistry.entries(name)["candide"]
      assert entry.activity_buckets == []
      assert entry.last_error == nil
    end

    test "no remotes configured is an empty map, not a crash", %{dir: dir} do
      {_pid, name} = start_registry(dir, remotes: [])
      :ok = RemoteTemporalRegistry.refresh_now(name)
      assert RemoteTemporalRegistry.entries(name) == %{}
    end
  end

  describe "failure semantics" do
    test "a failing poll keeps last-good data and records the error", %{dir: dir} do
      {_pid, name} = start_registry(dir)
      :ok = RemoteTemporalRegistry.refresh_now(name)

      MockClient.reset()
      :ok = RemoteTemporalRegistry.refresh_now(name)

      entry = RemoteTemporalRegistry.entries(name)["candide"]
      assert entry.activity_buckets == [@bucket]
      assert entry.sessions == [@record]
      assert entry.narration_commits == [@commit]
      assert entry.spend == [@spend]
      assert entry.last_error == :not_set
    end

    test "a partial tick takes the feed that succeeded and keeps the one that did not",
         %{dir: dir} do
      {_pid, name} = start_registry(dir)
      :ok = RemoteTemporalRegistry.refresh_now(name)

      # Narration goes away; activity serves a new bucket.
      fresh = Map.put(@bucket, "n", 9)
      MockClient.set("/api/v1/activity", {:ok, Jason.encode!(%{"buckets" => [fresh]})})
      MockClient.set("/api/v1/narration", {:error, :timeout})
      :ok = RemoteTemporalRegistry.refresh_now(name)

      entry = RemoteTemporalRegistry.entries(name)["candide"]
      assert entry.activity_buckets == [fresh]
      assert entry.narration_commits == [@commit]
      assert entry.last_error == :timeout
      # At least one feed landed, so the origin is fresh AND carries the error.
      refute entry.stale
    end

    test "a total failure never advances freshness", %{dir: dir} do
      MockClient.reset()
      {_pid, name} = start_registry(dir)
      :ok = RemoteTemporalRegistry.refresh_now(name)

      entry = RemoteTemporalRegistry.entries(name)["candide"]
      assert entry.last_polled_at == nil
      assert entry.stale
    end
  end

  describe "conditional fetch" do
    test "a 304 keeps the data and still advances freshness", %{dir: dir} do
      {_pid, name} = start_registry(dir)
      :ok = RemoteTemporalRegistry.refresh_now(name)
      first = RemoteTemporalRegistry.entries(name)["candide"].last_polled_at

      # Same scripted bodies, so the stub's If-None-Match check 304s all three.
      Process.sleep(5)
      :ok = RemoteTemporalRegistry.refresh_now(name)

      entry = RemoteTemporalRegistry.entries(name)["candide"]
      assert entry.activity_buckets == [@bucket]
      assert entry.narration_commits == [@commit]
      assert DateTime.compare(entry.last_polled_at, first) == :gt
      refute entry.stale
    end
  end

  describe "disk persistence" do
    test "a restarted registry loads the last-good cache from disk", %{dir: dir} do
      {_pid, name} = start_registry(dir)
      :ok = RemoteTemporalRegistry.refresh_now(name)
      polled_at = RemoteTemporalRegistry.entries(name)["candide"].last_polled_at
      stop_supervised!(name)

      # The remote is gone entirely; the fresh registry has only the disk.
      MockClient.reset()
      {_pid, restarted} = start_registry(dir)

      entry = RemoteTemporalRegistry.entries(restarted)["candide"]
      assert entry.activity_buckets == [@bucket]
      assert entry.sessions == [@record]
      assert entry.narration_commits == [@commit]
      # Freshness is INHERITED, not reset: the entry reads "last seen at T",
      # where T is when the data was actually fetched, so it ages honestly from
      # there instead of a restart laundering stale data into fresh.
      assert DateTime.compare(entry.last_polled_at, polled_at) == :eq
    end

    test "a cache last polled long ago restores as stale", %{dir: dir} do
      {_pid, name} = start_registry(dir)
      :ok = RemoteTemporalRegistry.refresh_now(name)
      stop_supervised!(name)

      path = Path.join(dir, "candide.json")
      cached = path |> File.read!() |> Jason.decode!()
      long_ago = DateTime.utc_now() |> DateTime.add(-3_600, :second) |> DateTime.to_iso8601()
      File.write!(path, Jason.encode!(%{cached | "last_polled_at" => long_ago}))

      MockClient.reset()
      {_pid, restarted} = start_registry(dir)

      entry = RemoteTemporalRegistry.entries(restarted)["candide"]
      assert entry.activity_buckets == [@bucket]
      assert entry.stale
    end

    test "the cache file is one JSON object per remote", %{dir: dir} do
      {_pid, name} = start_registry(dir)
      :ok = RemoteTemporalRegistry.refresh_now(name)

      assert {:ok, raw} = File.read(Path.join(dir, "candide.json"))
      assert {:ok, decoded} = Jason.decode(raw)
      assert decoded["activity_buckets"] == [@bucket]
      assert [_from, _to] = decoded["activity_window"]
      # Fleet config is authoritative at boot and is deliberately not persisted.
      refute Map.has_key?(decoded, "remote")
    end

    test "a corrupt cache file degrades to an empty entry", %{dir: dir} do
      File.mkdir_p!(dir)
      File.write!(Path.join(dir, "candide.json"), "{not json")

      MockClient.reset()
      {_pid, name} = start_registry(dir)

      entry = RemoteTemporalRegistry.entries(name)["candide"]
      assert entry.activity_buckets == []
      assert entry.stale
    end
  end
end
