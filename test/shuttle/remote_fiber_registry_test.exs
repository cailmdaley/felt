defmodule Shuttle.RemoteFiberRegistryTest do
  use ExUnit.Case

  alias Shuttle.Remote
  alias Shuttle.RemoteFiberRegistry

  # Deterministic HTTP stub: tests script per-URL responses so we can drive the
  # happy path, transient failure, and malformed-body paths without a real
  # endpoint. Mirrors the MockClient in remote_registry_test.exs and implements
  # the same Shuttle.RemoteRegistry.Client behaviour the registry consumes.
  defmodule MockClient do
    @behaviour Shuttle.RemoteRegistry.Client
    use Agent

    def start_link(_ \\ []), do: Agent.start_link(fn -> %{} end, name: __MODULE__)
    def reset, do: Agent.update(__MODULE__, fn _ -> %{} end)
    def set(url, response), do: Agent.update(__MODULE__, &Map.put(&1, url, response))

    @impl true
    def get(url, _timeout_ms), do: Agent.get(__MODULE__, &Map.get(&1, url, {:error, :not_set}))
  end

  setup do
    start_supervised!(MockClient)
    MockClient.reset()
    :ok
  end

  defp candide(opts \\ []) do
    %Remote{
      name: "candide",
      url: "http://localhost:4001",
      poll_interval_ms: Keyword.get(opts, :poll_interval_ms, 50),
      request_timeout_ms: Keyword.get(opts, :request_timeout_ms, 100),
      stale_multiplier: Keyword.get(opts, :stale_multiplier, 2)
    }
  end

  defp feed_body(fibers), do: Jason.encode!(%{"host" => "candide", "fibers" => fibers})

  # Poll feeds until the named origin has fibers (or give up). The stub returns
  # instantly, so a populated feed arrives within a few ticks; this just avoids
  # racing the async Task without a fixed sleep.
  defp wait_for_feed(pid, name, attempts \\ 100) do
    entry = Map.get(RemoteFiberRegistry.feeds(pid), name, %{fibers: []})

    cond do
      entry[:fibers] not in [nil, []] -> entry
      attempts <= 0 -> flunk("feed for #{name} never populated")
      true ->
        Process.sleep(5)
        wait_for_feed(pid, name, attempts - 1)
    end
  end

  defp sample_fiber(id) do
    %{
      "felt_store" => "/loom",
      "path" => "#{id}/#{id}.md",
      "fiber" => %{"id" => id, "name" => id, "status" => "active"},
      "runtime" => %{"tmux_session" => "shuttle-#{id}"}
    }
  end

  describe "Remote.fibers_url/1" do
    test "appends the owner-only fibers query" do
      assert Remote.fibers_url(candide()) == "http://localhost:4001/api/v1/fibers?shuttle=true"
    end

    test "trims a trailing slash on the base url" do
      remote = %Remote{name: "x", url: "http://localhost:4001/"}
      assert Remote.fibers_url(remote) == "http://localhost:4001/api/v1/fibers?shuttle=true"
    end
  end

  describe "feeds/0 with no registry running" do
    test "returns an empty map for graceful degradation" do
      assert RemoteFiberRegistry.feeds(:reg_absent_name) == %{}
    end
  end

  describe "fetch + cache" do
    test "caches a successful feed and exposes its fibers, fresh" do
      MockClient.set(Remote.fibers_url(candide()), {:ok, feed_body([sample_fiber("foo")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_happy, remotes: [candide()], client: MockClient, auto_poll: false}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)
      feeds = RemoteFiberRegistry.feeds(pid)

      assert %{"candide" => entry} = feeds
      assert entry.stale == false
      assert entry.last_error == nil
      assert [%{"fiber" => %{"id" => "foo"}, "runtime" => %{"tmux_session" => "shuttle-foo"}}] =
               entry.fibers
    end

    test "a non-200 / transport error keeps the last good feed but marks it stale" do
      url = Remote.fibers_url(candide())
      MockClient.set(url, {:ok, feed_body([sample_fiber("foo")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_blip,
           remotes: [candide(poll_interval_ms: 0)],
           client: MockClient,
           auto_poll: false}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)
      assert %{"candide" => %{stale: false, fibers: [_]}} = RemoteFiberRegistry.feeds(pid)

      # Next poll fails: cards persist (last-known-good) but the feed is stale.
      MockClient.set(url, {:error, :econnrefused})
      :ok = RemoteFiberRegistry.refresh_now(pid)

      assert %{"candide" => entry} = RemoteFiberRegistry.feeds(pid)
      assert entry.stale == true
      assert entry.last_error == :econnrefused
      assert [%{"fiber" => %{"id" => "foo"}}] = entry.fibers
    end

    test "malformed JSON marks the feed stale" do
      url = Remote.fibers_url(candide())
      MockClient.set(url, {:ok, "{not json"})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_garbage, remotes: [candide()], client: MockClient, auto_poll: false}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)

      assert %{"candide" => %{stale: true, last_error: :malformed_json, fibers: []}} =
               RemoteFiberRegistry.feeds(pid)
    end

    test "a well-formed envelope without a fibers key yields zero fibers, fresh" do
      url = Remote.fibers_url(candide())
      MockClient.set(url, {:ok, Jason.encode!(%{"host" => "candide", "error" => "felt_busy"})})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_empty, remotes: [candide()], client: MockClient, auto_poll: false}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)

      assert %{"candide" => %{stale: false, fibers: []}} = RemoteFiberRegistry.feeds(pid)
    end
  end

  describe "background tick (async Task path)" do
    test "auto-poll populates the feed via the supervised Task, not inline" do
      MockClient.set(Remote.fibers_url(candide()), {:ok, feed_body([sample_fiber("foo")])})

      # auto_poll: true exercises the real production path: the tick spawns a
      # Task.Supervisor.async_nolink fetch and folds the result in via
      # handle_info, rather than refresh_now's inline fetch.
      # tick_interval drives the auto-poll cadence (fast: fetch on the first
      # tick — `due?` is true with no prior attempt). poll_interval drives the
      # STALENESS threshold (stale_multiplier × poll_interval); keep it generous
      # so the freshly-fetched feed still reads `stale: false` by the time
      # wait_for_feed returns and we assert — at 5ms the threshold was ~5ms, so
      # any scheduling jitter flipped the feed stale before the assertion.
      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_async,
           remotes: [candide(poll_interval_ms: 60_000)],
           client: MockClient,
           tick_interval_ms: 5,
           auto_poll: true}
        )

      entry = wait_for_feed(pid, "candide")
      assert entry.stale == false
      assert [%{"fiber" => %{"id" => "foo"}}] = entry.fibers
    end
  end

  describe "staleness over time" do
    test "a feed older than stale_multiplier × poll_interval reads stale" do
      remote = candide(poll_interval_ms: 1, stale_multiplier: 1)
      MockClient.set(Remote.fibers_url(remote), {:ok, feed_body([sample_fiber("foo")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_time_stale, remotes: [remote], client: MockClient, auto_poll: false}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)
      # Threshold is 1ms × 1; sleeping past it flips the time-based staleness.
      Process.sleep(10)

      assert %{"candide" => %{stale: true}} = RemoteFiberRegistry.feeds(pid)
    end
  end
end
