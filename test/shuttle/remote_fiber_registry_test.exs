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

    # Conditional-fetch transport. Derives a content etag from the scripted
    # response body and honors If-None-Match: a matching etag returns 304 (empty
    # body); otherwise a 200 with the body and an `etag` header. Errors pass
    # through unchanged. This lets tests exercise the real 200/304 round-trip.
    @impl true
    def get(url, req_headers, _timeout_ms) do
      case Agent.get(__MODULE__, &Map.get(&1, url, {:error, :not_set})) do
        {:ok, body} ->
          etag = etag_for(body)
          inm = header(req_headers, "if-none-match")
          # Mirror the server: the cache block rides `x-shuttle-cache` on both
          # 200 and 304 (a 304 has no body to carry it).
          resp_headers = [{"etag", etag} | cache_header(body)]

          if inm == etag,
            do: {:ok, 304, resp_headers, ""},
            else: {:ok, 200, resp_headers, body}

        {:error, reason} ->
          {:error, reason}
      end
    end

    # Mirror the server: the etag is over the FIBERS only, not the cache block —
    # so a cache-only change (e.g. refreshed_at advancing) still 304s and the new
    # cache rides the header.
    defp etag_for(body) do
      fibers =
        case Jason.decode(body) do
          {:ok, %{"fibers" => f}} -> f
          _ -> body
        end

      ~s("#{Integer.to_string(:erlang.phash2(fibers), 16)}")
    end

    defp cache_header(body) do
      case Jason.decode(body) do
        {:ok, %{"cache" => cache}} -> [{"x-shuttle-cache", Jason.encode!(cache)}]
        _ -> []
      end
    end

    defp header(headers, key) do
      Enum.find_value(headers, fn {k, v} -> if String.downcase(k) == key, do: v end)
    end
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
      entry[:fibers] not in [nil, []] ->
        entry

      attempts <= 0 ->
        flunk("feed for #{name} never populated")

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

    test "refresh updates a single remote feed immediately" do
      url = Remote.fibers_url(candide())
      MockClient.set(url, {:ok, feed_body([sample_fiber("before")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_single_refresh, remotes: [candide()], client: MockClient, auto_poll: false}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)

      assert %{"candide" => %{fibers: [%{"fiber" => %{"id" => "before"}}]}} =
               RemoteFiberRegistry.feeds(pid)

      MockClient.set(url, {:ok, feed_body([sample_fiber("after")])})

      assert :ok = RemoteFiberRegistry.refresh(pid, "candide")

      assert %{"candide" => %{stale: false, fibers: [%{"fiber" => %{"id" => "after"}}]}} =
               RemoteFiberRegistry.feeds(pid)
    end

    test "a SINGLE failed poll after a success does not flip stale, keeps last-good fibers" do
      url = Remote.fibers_url(candide())
      MockClient.set(url, {:ok, feed_body([sample_fiber("foo")])})

      # Generous poll_interval (60s) so the grace window (stale_multiplier ×
      # poll_interval = 2 × 60s here) comfortably outlasts the test: staleness is
      # now purely time-since-last-success, so a single blip within the window
      # must NOT flip the badge.
      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_blip,
           remotes: [candide(poll_interval_ms: 60_000)],
           client: MockClient,
           auto_poll: false}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)
      assert %{"candide" => %{stale: false, fibers: [_]}} = RemoteFiberRegistry.feeds(pid)

      # Next poll fails: the failure is recorded (last_error) but the feed stays
      # fresh — last-good cards persist and the badge does NOT light.
      MockClient.set(url, {:error, :econnrefused})
      :ok = RemoteFiberRegistry.refresh_now(pid)

      assert %{"candide" => entry} = RemoteFiberRegistry.feeds(pid)
      assert entry.stale == false
      assert entry.last_error == :econnrefused
      assert [%{"fiber" => %{"id" => "foo"}}] = entry.fibers
    end

    test "malformed JSON on a never-succeeded feed reads stale (nil last-success)" do
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

  describe "conditional fetch (etag / 304)" do
    test "a 304 keeps last-good fibers and advances last_polled_at (clears staleness)" do
      # Generous poll_interval so freshness is stable across the assertions; the
      # point is that the 304 SUCCEEDS (keeps fibers, advances the success clock),
      # not the time-based staleness edge (covered elsewhere).
      remote = candide(poll_interval_ms: 60_000)
      url = Remote.fibers_url(remote)
      MockClient.set(url, {:ok, feed_body([sample_fiber("foo")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_304, remotes: [remote], client: MockClient, auto_poll: false}
        )

      # First fetch: 200, stores the feed AND the etag.
      :ok = RemoteFiberRegistry.refresh_now(pid)
      %{"candide" => first} = RemoteFiberRegistry.feeds(pid)
      assert first.stale == false
      assert [%{"fiber" => %{"id" => "foo"}}] = first.fibers
      t1 = first.last_polled_at

      Process.sleep(5)

      # Body UNCHANGED → the conditional re-fetch sends the stored etag and the
      # stub replies 304. The feed keeps its fibers and, because the poll
      # SUCCEEDED, last_polled_at advances and staleness stays clear.
      :ok = RemoteFiberRegistry.refresh_now(pid)
      %{"candide" => second} = RemoteFiberRegistry.feeds(pid)

      assert second.stale == false
      assert second.last_error == nil
      assert [%{"fiber" => %{"id" => "foo"}}] = second.fibers
      assert DateTime.compare(second.last_polled_at, t1) == :gt
    end

    test "a changed body busts the etag and delivers the new feed (200)" do
      url = Remote.fibers_url(candide())
      MockClient.set(url, {:ok, feed_body([sample_fiber("before")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_etag_change, remotes: [candide()], client: MockClient, auto_poll: false}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)
      assert %{"candide" => %{fibers: [%{"fiber" => %{"id" => "before"}}]}} =
               RemoteFiberRegistry.feeds(pid)

      # Different body → different etag → the stored If-None-Match no longer
      # matches → a full 200 with the new fibers.
      MockClient.set(url, {:ok, feed_body([sample_fiber("after")])})
      :ok = RemoteFiberRegistry.refresh_now(pid)

      assert %{"candide" => %{fibers: [%{"fiber" => %{"id" => "after"}}]}} =
               RemoteFiberRegistry.feeds(pid)
    end

    test "a 304 refreshes cache metadata from the x-shuttle-cache header (no freeze)" do
      remote = candide(poll_interval_ms: 60_000)
      url = Remote.fibers_url(remote)

      body_at = fn t ->
        Jason.encode!(%{
          "host" => "candide",
          "fibers" => [sample_fiber("foo")],
          "cache" => %{"state" => "fresh", "refreshed_at" => t, "entries" => 1}
        })
      end

      MockClient.set(url, {:ok, body_at.("2026-07-20T10:00:00Z")})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_304_cache, remotes: [remote], client: MockClient, auto_poll: false}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)
      assert %{"candide" => %{cache: %{"refreshed_at" => "2026-07-20T10:00:00Z"}}} =
               RemoteFiberRegistry.feeds(pid)

      # The server's fibers are UNCHANGED but its cache advanced refreshed_at.
      # Since the etag is over fibers only, the conditional re-fetch 304s — and
      # the fresher cache block rides the x-shuttle-cache header, so the client's
      # refreshed_at tracks instead of freezing.
      MockClient.set(url, {:ok, body_at.("2026-07-20T10:05:00Z")})
      :ok = RemoteFiberRegistry.refresh_now(pid)

      assert %{"candide" => entry} = RemoteFiberRegistry.feeds(pid)
      assert entry.cache["refreshed_at"] == "2026-07-20T10:05:00Z"
      assert [%{"fiber" => %{"id" => "foo"}}] = entry.fibers
    end

    test "a cold empty 200 keeps last-good fibers and does NOT advance last_polled_at" do
      remote = candide(poll_interval_ms: 60_000)
      url = Remote.fibers_url(remote)

      warm =
        Jason.encode!(%{
          "host" => "candide",
          "fibers" => [sample_fiber("foo")],
          "cache" => %{"state" => "fresh", "entries" => 1}
        })

      MockClient.set(url, {:ok, warm})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_cold_keep, remotes: [remote], client: MockClient, auto_poll: false}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)
      %{"candide" => first} = RemoteFiberRegistry.feeds(pid)
      assert [%{"fiber" => %{"id" => "foo"}}] = first.fibers
      t1 = first.last_polled_at

      Process.sleep(5)

      # The owner restarts: its next poll hasn't warmed yet, so it serves a COLD
      # empty feed. The viewer must NOT lose its last-good cards, and staleness
      # must stay honest (last_polled_at frozen at the last WARM success).
      cold = Jason.encode!(%{"host" => "candide", "fibers" => [], "cache" => %{"state" => "cold"}})
      MockClient.set(url, {:ok, cold})
      :ok = RemoteFiberRegistry.refresh_now(pid)

      %{"candide" => second} = RemoteFiberRegistry.feeds(pid)
      assert [%{"fiber" => %{"id" => "foo"}}] = second.fibers
      assert second.last_polled_at == t1
      assert second.last_error == nil
      assert second.cache["state"] == "cold"
    end

    test "carries the server's cache staleness metadata into the feed" do
      url = Remote.fibers_url(candide())

      body =
        Jason.encode!(%{
          "host" => "candide",
          "fibers" => [sample_fiber("foo")],
          "cache" => %{"state" => "fresh", "entries" => 1, "last_refresh_ms" => 42}
        })

      MockClient.set(url, {:ok, body})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_cache_meta, remotes: [candide()], client: MockClient, auto_poll: false}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)

      assert %{"candide" => %{cache: %{"state" => "fresh", "entries" => 1}}} =
               RemoteFiberRegistry.feeds(pid)
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

    test "sustained failure past the grace window DOES go stale, keeping last-good fibers" do
      # Tiny threshold (1ms × 1) so the grace elapses within the test. A success
      # stamps last_polled_at; a subsequent failure leaves it untouched; once
      # real time exceeds the threshold the feed reads stale — the slow alarm.
      remote = candide(poll_interval_ms: 1, stale_multiplier: 1)
      url = Remote.fibers_url(remote)
      MockClient.set(url, {:ok, feed_body([sample_fiber("foo")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_sustained_fail, remotes: [remote], client: MockClient, auto_poll: false}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)

      # A failed poll records the error but does not stamp a fresh success.
      MockClient.set(url, {:error, :econnrefused})
      :ok = RemoteFiberRegistry.refresh_now(pid)
      Process.sleep(10)

      assert %{"candide" => entry} = RemoteFiberRegistry.feeds(pid)
      assert entry.stale == true
      assert entry.last_error == :econnrefused
      # Last-good cards are still served even while the badge is lit.
      assert [%{"fiber" => %{"id" => "foo"}}] = entry.fibers
    end

    test "a fresh success clears staleness immediately (fast recovery)" do
      remote = candide(poll_interval_ms: 1, stale_multiplier: 1)
      url = Remote.fibers_url(remote)
      MockClient.set(url, {:ok, feed_body([sample_fiber("foo")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_fast_recover, remotes: [remote], client: MockClient, auto_poll: false}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)
      # Age past the 1ms threshold so the feed reads stale.
      Process.sleep(10)
      assert %{"candide" => %{stale: true}} = RemoteFiberRegistry.feeds(pid)

      # A single fresh success flips stale → false instantly (no grace to re-earn).
      MockClient.set(url, {:ok, feed_body([sample_fiber("bar")])})
      :ok = RemoteFiberRegistry.refresh_now(pid)

      assert %{"candide" => %{stale: false, fibers: [%{"fiber" => %{"id" => "bar"}}]}} =
               RemoteFiberRegistry.feeds(pid)
    end

    test "a never-polled feed (nil last-success) is stale" do
      # No refresh_now, no auto_poll: last_polled_at stays nil, so the feed is
      # stale from birth via Remote.stale?/3's nil clause.
      MockClient.set(Remote.fibers_url(candide()), {:ok, feed_body([sample_fiber("foo")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_never_polled, remotes: [candide()], client: MockClient, auto_poll: false}
        )

      assert %{"candide" => %{stale: true, fibers: []}} = RemoteFiberRegistry.feeds(pid)
    end
  end
end
