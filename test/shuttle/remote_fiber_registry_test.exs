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

    # Every registry gets its own on-disk store: the default would be the real
    # `~/.shuttle/remote-fibers`, and a suite must not write there — nor read a
    # developer's live cache into a test's feeds.
    dir = Path.join(System.tmp_dir!(), "rfr-store-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(dir) end)

    {:ok, dir: dir}
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
    test "caches a successful feed and exposes its fibers, fresh", %{dir: dir} do
      MockClient.set(Remote.fibers_url(candide()), {:ok, feed_body([sample_fiber("foo")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_happy,
           remotes: [candide()],
           client: MockClient,
           auto_poll: false,
           store_dir: dir}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)
      feeds = RemoteFiberRegistry.feeds(pid)

      assert %{"candide" => entry} = feeds
      assert entry.stale == false
      assert entry.last_error == nil

      assert [%{"fiber" => %{"id" => "foo"}, "runtime" => %{"tmux_session" => "shuttle-foo"}}] =
               entry.fibers
    end

    test "refresh updates a single remote feed immediately", %{dir: dir} do
      url = Remote.fibers_url(candide())
      MockClient.set(url, {:ok, feed_body([sample_fiber("before")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_single_refresh,
           remotes: [candide()],
           client: MockClient,
           auto_poll: false,
           store_dir: dir}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)

      assert %{"candide" => %{fibers: [%{"fiber" => %{"id" => "before"}}]}} =
               RemoteFiberRegistry.feeds(pid)

      MockClient.set(url, {:ok, feed_body([sample_fiber("after")])})

      assert :ok = RemoteFiberRegistry.refresh(pid, "candide")

      assert %{"candide" => %{stale: false, fibers: [%{"fiber" => %{"id" => "after"}}]}} =
               RemoteFiberRegistry.feeds(pid)
    end

    test "a SINGLE failed poll after a success does not flip stale, keeps last-good fibers", %{
      dir: dir
    } do
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
           auto_poll: false,
           store_dir: dir}
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

    test "malformed JSON on a never-succeeded feed reads stale (nil last-success)", %{dir: dir} do
      url = Remote.fibers_url(candide())
      MockClient.set(url, {:ok, "{not json"})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_garbage,
           remotes: [candide()],
           client: MockClient,
           auto_poll: false,
           store_dir: dir}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)

      assert %{"candide" => %{stale: true, last_error: :malformed_json, fibers: []}} =
               RemoteFiberRegistry.feeds(pid)
    end

    test "a well-formed envelope without a fibers key yields zero fibers, fresh", %{dir: dir} do
      url = Remote.fibers_url(candide())
      MockClient.set(url, {:ok, Jason.encode!(%{"host" => "candide", "error" => "felt_busy"})})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_empty,
           remotes: [candide()],
           client: MockClient,
           auto_poll: false,
           store_dir: dir}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)

      assert %{"candide" => %{stale: false, fibers: []}} = RemoteFiberRegistry.feeds(pid)
    end
  end

  describe "conditional fetch (etag / 304)" do
    test "a 304 keeps last-good fibers and advances last_polled_at (clears staleness)", %{
      dir: dir
    } do
      # Generous poll_interval so freshness is stable across the assertions; the
      # point is that the 304 SUCCEEDS (keeps fibers, advances the success clock),
      # not the time-based staleness edge (covered elsewhere).
      remote = candide(poll_interval_ms: 60_000)
      url = Remote.fibers_url(remote)
      MockClient.set(url, {:ok, feed_body([sample_fiber("foo")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_304, remotes: [remote], client: MockClient, auto_poll: false, store_dir: dir}
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

    test "a changed body busts the etag and delivers the new feed (200)", %{dir: dir} do
      url = Remote.fibers_url(candide())
      MockClient.set(url, {:ok, feed_body([sample_fiber("before")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_etag_change,
           remotes: [candide()],
           client: MockClient,
           auto_poll: false,
           store_dir: dir}
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

    test "a 304 refreshes cache metadata from the x-shuttle-cache header (no freeze)", %{dir: dir} do
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
           name: :reg_304_cache,
           remotes: [remote],
           client: MockClient,
           auto_poll: false,
           store_dir: dir}
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

    test "a cold empty 200 keeps last-good fibers and does NOT advance last_polled_at", %{
      dir: dir
    } do
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
           name: :reg_cold_keep,
           remotes: [remote],
           client: MockClient,
           auto_poll: false,
           store_dir: dir}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)
      %{"candide" => first} = RemoteFiberRegistry.feeds(pid)
      assert [%{"fiber" => %{"id" => "foo"}}] = first.fibers
      t1 = first.last_polled_at

      Process.sleep(5)

      # The owner restarts: its next poll hasn't warmed yet, so it serves a COLD
      # empty feed. The viewer must NOT lose its last-good cards, and staleness
      # must stay honest (last_polled_at frozen at the last WARM success).
      cold =
        Jason.encode!(%{"host" => "candide", "fibers" => [], "cache" => %{"state" => "cold"}})

      MockClient.set(url, {:ok, cold})
      :ok = RemoteFiberRegistry.refresh_now(pid)

      %{"candide" => second} = RemoteFiberRegistry.feeds(pid)
      assert [%{"fiber" => %{"id" => "foo"}}] = second.fibers
      assert second.last_polled_at == t1
      assert second.last_error == nil
      assert second.cache["state"] == "cold"
    end

    test "carries the server's cache staleness metadata into the feed", %{dir: dir} do
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
           name: :reg_cache_meta,
           remotes: [candide()],
           client: MockClient,
           auto_poll: false,
           store_dir: dir}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)

      assert %{"candide" => %{cache: %{"state" => "fresh", "entries" => 1}}} =
               RemoteFiberRegistry.feeds(pid)
    end
  end

  describe "background tick (async Task path)" do
    test "auto-poll populates the feed via the supervised Task, not inline", %{dir: dir} do
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
           auto_poll: true,
           store_dir: dir}
        )

      entry = wait_for_feed(pid, "candide")
      assert entry.stale == false
      assert [%{"fiber" => %{"id" => "foo"}}] = entry.fibers
    end
  end

  describe "staleness over time" do
    test "a feed older than stale_multiplier × poll_interval reads stale", %{dir: dir} do
      remote = candide(poll_interval_ms: 1, stale_multiplier: 1)
      MockClient.set(Remote.fibers_url(remote), {:ok, feed_body([sample_fiber("foo")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_time_stale,
           remotes: [remote],
           client: MockClient,
           auto_poll: false,
           store_dir: dir}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)
      # Threshold is 1ms × 1; sleeping past it flips the time-based staleness.
      Process.sleep(10)

      assert %{"candide" => %{stale: true}} = RemoteFiberRegistry.feeds(pid)
    end

    test "sustained failure past the grace window DOES go stale, keeping last-good fibers", %{
      dir: dir
    } do
      # Tiny threshold (1ms × 1) so the grace elapses within the test. A success
      # stamps last_polled_at; a subsequent failure leaves it untouched; once
      # real time exceeds the threshold the feed reads stale — the slow alarm.
      remote = candide(poll_interval_ms: 1, stale_multiplier: 1)
      url = Remote.fibers_url(remote)
      MockClient.set(url, {:ok, feed_body([sample_fiber("foo")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_sustained_fail,
           remotes: [remote],
           client: MockClient,
           auto_poll: false,
           store_dir: dir}
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

    test "a fresh success clears staleness immediately (fast recovery)", %{dir: dir} do
      # 50ms, not 1ms. The freshness window here is
      # `poll_interval_ms × stale_multiplier`, and the assertion below must land
      # INSIDE it — with a 1ms window the `feeds/1` round trip after the
      # recovery poll routinely spent longer than the window it was checking, so
      # the entry aged back to stale before it could be read and the test failed
      # about five runs in six. 50ms is still far below any human-visible
      # staleness and comfortably above a GenServer call.
      remote = candide(poll_interval_ms: 50, stale_multiplier: 1)
      url = Remote.fibers_url(remote)
      MockClient.set(url, {:ok, feed_body([sample_fiber("foo")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_fast_recover,
           remotes: [remote],
           client: MockClient,
           auto_poll: false,
           store_dir: dir}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)
      # Age past the threshold so the feed reads stale.
      Process.sleep(80)
      assert %{"candide" => %{stale: true}} = RemoteFiberRegistry.feeds(pid)

      # A single fresh success flips stale → false instantly (no grace to re-earn).
      MockClient.set(url, {:ok, feed_body([sample_fiber("bar")])})
      :ok = RemoteFiberRegistry.refresh_now(pid)

      assert %{"candide" => %{stale: false, fibers: [%{"fiber" => %{"id" => "bar"}}]}} =
               RemoteFiberRegistry.feeds(pid)
    end

    test "a never-polled feed (nil last-success) is stale", %{dir: dir} do
      # No refresh_now, no auto_poll: last_polled_at stays nil, so the feed is
      # stale from birth via Remote.stale?/3's nil clause.
      MockClient.set(Remote.fibers_url(candide()), {:ok, feed_body([sample_fiber("foo")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :reg_never_polled,
           remotes: [candide()],
           client: MockClient,
           auto_poll: false,
           store_dir: dir}
        )

      assert %{"candide" => %{stale: true, fibers: []}} = RemoteFiberRegistry.feeds(pid)
    end
  end

  # ── Live fleet reload ──

  describe "fleet reload" do
    setup do
      dir = Path.join(System.tmp_dir!(), "rfr-fleet-#{System.unique_integer([:positive])}")
      File.mkdir_p!(dir)
      path = Path.join(dir, "remotes.json")

      prev_file = System.get_env("FELT_REMOTES_FILE")
      prev_remotes = Application.get_env(:shuttle, :remotes)
      System.put_env("FELT_REMOTES_FILE", path)
      Application.delete_env(:shuttle, :remotes)

      on_exit(fn ->
        File.rm_rf(dir)
        if prev_file, do: System.put_env("FELT_REMOTES_FILE", prev_file)
        if prev_file == nil, do: System.delete_env("FELT_REMOTES_FILE")

        if prev_remotes == nil,
          do: Application.delete_env(:shuttle, :remotes),
          else: Application.put_env(:shuttle, :remotes, prev_remotes)
      end)

      {:ok, path: path}
    end

    defp write_fleet(path, entries),
      do: File.write!(path, Jason.encode!(%{"version" => 1, "remotes" => entries}))

    test "an added remote joins the board and a removed one leaves it", %{dir: dir, path: path} do
      write_fleet(path, [%{"name" => "candide", "port" => 4001}])

      MockClient.set(
        "http://127.0.0.1:4001/api/v1/fibers?shuttle=true",
        {:ok, feed_body([sample_fiber("a")])}
      )

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :rfr_fleet, client: MockClient, auto_poll: false, store_dir: dir}
        )

      :ok = RemoteFiberRegistry.refresh_now(pid)
      assert Map.keys(RemoteFiberRegistry.feeds(pid)) == ["candide"]

      write_fleet(path, [
        %{"name" => "candide", "port" => 4001},
        %{"name" => "cineca", "port" => 4002}
      ])

      MockClient.set(
        "http://127.0.0.1:4002/api/v1/fibers?shuttle=true",
        {:ok, feed_body([sample_fiber("b")])}
      )

      :ok = RemoteFiberRegistry.refresh_now(pid)

      feeds = RemoteFiberRegistry.feeds(pid)
      assert Enum.sort(Map.keys(feeds)) == ["candide", "cineca"]

      # The pre-existing feed kept its cached rows — a reload must not force a
      # cold refetch of every origin.
      assert [%{"fiber" => %{"id" => "a"}}] = feeds["candide"].fibers

      write_fleet(path, [%{"name" => "cineca", "port" => 4002}])
      :ok = RemoteFiberRegistry.refresh_now(pid)
      assert Map.keys(RemoteFiberRegistry.feeds(pid)) == ["cineca"]
    end

    test "an explicit :remotes opt pins the list against the file", %{dir: dir, path: path} do
      write_fleet(path, [%{"name" => "from-file", "port" => 4001}])
      MockClient.set(Remote.fibers_url(candide()), {:ok, feed_body([sample_fiber("a")])})

      pid =
        start_supervised!(
          {RemoteFiberRegistry,
           name: :rfr_fleet_pinned,
           remotes: [candide()],
           client: MockClient,
           auto_poll: false,
           store_dir: dir}
        )

      write_fleet(path, [
        %{"name" => "from-file", "port" => 4001},
        %{"name" => "another", "port" => 4002}
      ])

      :ok = RemoteFiberRegistry.refresh_now(pid)
      assert Map.keys(RemoteFiberRegistry.feeds(pid)) == ["candide"]
    end
  end

  # ── Disk persistence ──
  #
  # A remote-owned fiber reaches this board through this cache and nowhere else,
  # so the cache has to outlive the process: without it, a daemon restart while
  # a host is unreachable makes that host's cards vanish instead of reading
  # "waiting on <host>".

  describe "disk persistence" do
    # A fresh GenServer over the same store_dir — the restart under test. Each
    # start needs its own supervisor child id as well as its own name.
    defp boot(dir, opts) do
      id = :"rfr_disk_#{System.unique_integer([:positive])}"

      start_supervised!(
        {RemoteFiberRegistry,
         Keyword.merge(
           [
             name: id,
             remotes: [candide(poll_interval_ms: 60_000)],
             client: MockClient,
             auto_poll: false,
             store_dir: dir
           ],
           opts
         )},
        id: id
      )

      id
    end

    defp store_path(dir, name \\ "candide"), do: Path.join(dir, "#{name}.json")

    test "a successful poll writes the remote's feed to disk", %{dir: dir} do
      MockClient.set(Remote.fibers_url(candide()), {:ok, feed_body([sample_fiber("foo")])})

      reg = boot(dir, [])
      :ok = RemoteFiberRegistry.refresh_now(reg)

      assert {:ok, raw} = File.read(store_path(dir))

      assert %{"fibers" => [%{"fiber" => %{"id" => "foo"}}], "last_polled_at" => at} =
               Jason.decode!(raw)

      assert {:ok, %DateTime{}, _} = DateTime.from_iso8601(at)
    end

    test "a restart serves the persisted rows, and they read STALE until a live poll", %{dir: dir} do
      MockClient.set(Remote.fibers_url(candide()), {:ok, feed_body([sample_fiber("foo")])})

      first = boot(dir, [])
      :ok = RemoteFiberRegistry.refresh_now(first)
      assert %{"candide" => %{stale: false}} = RemoteFiberRegistry.feeds(first)
      stop_supervised!(first)

      # The new daemon has never spoken to candide. Its rows are last-known-good,
      # so the board shows them — flagged stale, which is what renders
      # "⌛ waiting on candide" rather than implying a fresh observation. The
      # 60s poll_interval means the CLOCK would call this feed fresh; only the
      # restored flag keeps it honest.
      second = boot(dir, [])
      assert %{"candide" => restored} = RemoteFiberRegistry.feeds(second)
      assert [%{"fiber" => %{"id" => "foo"}}] = restored.fibers
      assert restored.stale == true
      assert restored.last_error == nil
      # `last_polled_at` is restored unfaked, so "last seen at T" is true.
      assert %DateTime{} = restored.last_polled_at

      # An unreachable owner leaves the restored rows exactly as they are.
      MockClient.set(Remote.fibers_url(candide()), {:error, :econnrefused})
      :ok = RemoteFiberRegistry.refresh_now(second)
      assert %{"candide" => still} = RemoteFiberRegistry.feeds(second)
      assert [%{"fiber" => %{"id" => "foo"}}] = still.fibers
      assert still.stale == true

      # The host comes back: one live success and the feed is fresh again.
      MockClient.set(Remote.fibers_url(candide()), {:ok, feed_body([sample_fiber("foo")])})
      :ok = RemoteFiberRegistry.refresh_now(second)
      assert %{"candide" => %{stale: false}} = RemoteFiberRegistry.feeds(second)
    end

    test "a live poll REPLACES restored rows — disk never resurrects a dropped fiber", %{dir: dir} do
      url = Remote.fibers_url(candide())
      MockClient.set(url, {:ok, feed_body([sample_fiber("kept"), sample_fiber("dropped")])})

      first = boot(dir, [])
      :ok = RemoteFiberRegistry.refresh_now(first)
      stop_supervised!(first)

      second = boot(dir, [])
      assert %{"candide" => %{fibers: [_, _]}} = RemoteFiberRegistry.feeds(second)

      # The owner has since closed "dropped". Its smaller feed wins outright.
      MockClient.set(url, {:ok, feed_body([sample_fiber("kept")])})
      :ok = RemoteFiberRegistry.refresh_now(second)

      assert %{"candide" => %{stale: false, fibers: [%{"fiber" => %{"id" => "kept"}}]}} =
               RemoteFiberRegistry.feeds(second)

      # And the file was rewritten, so the next restart cannot bring it back.
      stop_supervised!(second)
      third = boot(dir, [])

      assert %{"candide" => %{fibers: [%{"fiber" => %{"id" => "kept"}}]}} =
               RemoteFiberRegistry.feeds(third)
    end

    test "a 304 against a restored etag confirms the rows (fresh, no refetch)", %{dir: dir} do
      MockClient.set(Remote.fibers_url(candide()), {:ok, feed_body([sample_fiber("foo")])})

      first = boot(dir, [])
      :ok = RemoteFiberRegistry.refresh_now(first)
      stop_supervised!(first)

      # The etag rides to disk with the rows it describes, so the restarted
      # daemon's first conditional fetch 304s — and a 304 means the owner's feed
      # still equals what we restored, which settles it as observed.
      second = boot(dir, [])
      assert %{"candide" => %{stale: true}} = RemoteFiberRegistry.feeds(second)

      :ok = RemoteFiberRegistry.refresh_now(second)

      assert %{"candide" => %{stale: false, fibers: [%{"fiber" => %{"id" => "foo"}}]}} =
               RemoteFiberRegistry.feeds(second)
    end

    test "a cold empty 200 is not written, so a restart keeps the last WARM rows", %{dir: dir} do
      url = Remote.fibers_url(candide())
      MockClient.set(url, {:ok, feed_body([sample_fiber("foo")])})

      first = boot(dir, [])
      :ok = RemoteFiberRegistry.refresh_now(first)

      # The owner restarts and serves a cold empty feed. In memory the rows are
      # kept; on disk nothing moves — persisting the cold etag beside warm rows
      # would let the restart's first 304 declare remembered rows fresh.
      MockClient.set(
        url,
        {:ok,
         Jason.encode!(%{"host" => "candide", "fibers" => [], "cache" => %{"state" => "cold"}})}
      )

      :ok = RemoteFiberRegistry.refresh_now(first)
      stop_supervised!(first)

      second = boot(dir, [])
      assert %{"candide" => entry} = RemoteFiberRegistry.feeds(second)
      assert [%{"fiber" => %{"id" => "foo"}}] = entry.fibers
      assert entry.stale == true

      # And this is why the cold etag must stay off disk: the owner is STILL
      # cold, so the restarted daemon's first fetch must be a 200 of the cold
      # feed (rows kept, still remembered) — not a 304 against a cold etag, which
      # would have declared the remembered rows freshly observed.
      :ok = RemoteFiberRegistry.refresh_now(second)
      assert %{"candide" => after_cold} = RemoteFiberRegistry.feeds(second)
      assert [%{"fiber" => %{"id" => "foo"}}] = after_cold.fibers
      assert after_cold.stale == true

      # The owner warms up: the live rows land and the feed is fresh.
      MockClient.set(url, {:ok, feed_body([sample_fiber("foo")])})
      :ok = RemoteFiberRegistry.refresh_now(second)
      assert %{"candide" => %{stale: false}} = RemoteFiberRegistry.feeds(second)
    end

    test "a corrupt file is a warm-start miss, not a crash", %{dir: dir} do
      File.mkdir_p!(dir)
      File.write!(store_path(dir), "{not json")
      MockClient.set(Remote.fibers_url(candide()), {:ok, feed_body([sample_fiber("foo")])})

      reg = boot(dir, [])
      assert %{"candide" => %{fibers: [], stale: true}} = RemoteFiberRegistry.feeds(reg)

      # The registry is otherwise untouched: the next poll works and rewrites it.
      :ok = RemoteFiberRegistry.refresh_now(reg)
      assert %{"candide" => %{stale: false, fibers: [_]}} = RemoteFiberRegistry.feeds(reg)
      assert %{"fibers" => [_]} = Jason.decode!(File.read!(store_path(dir)))
    end

    test "a well-formed file without a fibers list restores nothing", %{dir: dir} do
      File.mkdir_p!(dir)

      File.write!(
        store_path(dir),
        Jason.encode!(%{"etag" => ~s("x"), "last_polled_at" => "nope"})
      )

      MockClient.set(Remote.fibers_url(candide()), {:ok, feed_body([sample_fiber("foo")])})

      reg = boot(dir, [])

      assert %{"candide" => %{fibers: [], stale: true, last_polled_at: nil}} =
               RemoteFiberRegistry.feeds(reg)
    end

    test "a missing store dir is a warm-start miss", %{dir: dir} do
      MockClient.set(Remote.fibers_url(candide()), {:ok, feed_body([sample_fiber("foo")])})

      reg = boot(Path.join(dir, "never-created"), [])
      assert %{"candide" => %{fibers: []}} = RemoteFiberRegistry.feeds(reg)
      :ok = RemoteFiberRegistry.refresh_now(reg)
      assert %{"candide" => %{stale: false, fibers: [_]}} = RemoteFiberRegistry.feeds(reg)
    end

    test "a failed write neither crashes the registry nor loses in-memory feeds", %{dir: dir} do
      # The store dir's parent is a regular FILE, so mkdir_p! cannot succeed and
      # every persist raises — which the registry must swallow.
      File.mkdir_p!(dir)
      blocker = Path.join(dir, "blocker")
      File.write!(blocker, "not a directory")

      MockClient.set(Remote.fibers_url(candide()), {:ok, feed_body([sample_fiber("foo")])})

      reg = boot(Path.join(blocker, "store"), [])
      :ok = RemoteFiberRegistry.refresh_now(reg)

      assert %{"candide" => entry} = RemoteFiberRegistry.feeds(reg)
      assert entry.stale == false
      assert [%{"fiber" => %{"id" => "foo"}}] = entry.fibers
      assert Process.alive?(Process.whereis(reg))
    end

    test "persistence is off when store_dir is nil", %{dir: dir} do
      MockClient.set(Remote.fibers_url(candide()), {:ok, feed_body([sample_fiber("foo")])})

      reg = boot(dir, store_dir: nil)
      :ok = RemoteFiberRegistry.refresh_now(reg)

      assert %{"candide" => %{fibers: [_]}} = RemoteFiberRegistry.feeds(reg)
      refute File.exists?(store_path(dir))
    end
  end
end
