defmodule Shuttle.PollerDocumentsTest do
  # The Poller: the document cache, discovery listings and the owner feed.
  use Shuttle.Test.PollerCase, async: true

  test "document fiber index gives ids and uids precedence and resolves slugs lexically" do
    small_cache = %{
      "z-fiber" => %{
        entry: %{fiber: %{"id" => "z-fiber", "uid" => "uid-z", "slug" => "shared"}}
      },
      "a-fiber" => %{
        entry: %{fiber: %{"id" => "a-fiber", "uid" => "uid-a", "slug" => "shared"}}
      },
      "slug-shadow" => %{
        entry: %{fiber: %{"id" => "slug-shadow", "uid" => "uid-shadow", "slug" => "identity"}}
      },
      "slug-shadow-z" => %{
        entry: %{fiber: %{"id" => "slug-shadow-z", "uid" => "uid-shadow-z", "slug" => "identity"}}
      },
      "identity" => %{
        entry: %{fiber: %{"id" => "identity", "uid" => "uid-identity", "slug" => "other"}}
      },
      "duplicate-z" => %{
        entry: %{
          fiber: %{"id" => "duplicate", "uid" => "same-uid", "slug" => "dup-z", "name" => "z"}
        }
      },
      "duplicate-a" => %{
        entry: %{
          fiber: %{"id" => "duplicate", "uid" => "same-uid", "slug" => "dup-a", "name" => "a"}
        }
      },
      "uid-z" => %{
        entry: %{fiber: %{"id" => "uid-winner-z", "uid" => "shared-uid", "slug" => "uid-z"}}
      },
      "uid-a" => %{
        entry: %{fiber: %{"id" => "uid-winner-a", "uid" => "shared-uid", "slug" => "uid-a"}}
      },
      "empty-id" => %{
        entry: %{fiber: %{"id" => "", "slug" => "empty-slug"}}
      },
      "nil-fields" => %{
        entry: %{fiber: %{"slug" => nil}}
      }
    }

    {small_index, small_collisions} =
      Shuttle.Poller.DocumentCache.index_with_collisions(small_cache)

    assert small_index["shared"] == small_cache["a-fiber"].entry.fiber
    assert small_index["identity"] == small_cache["identity"].entry.fiber
    assert small_index["shared-uid"] == small_cache["uid-a"].entry.fiber
    assert small_index["uid-z"] == small_cache["z-fiber"].entry.fiber
    assert small_index["duplicate"] == small_cache["duplicate-a"].entry.fiber
    assert small_index[""] == small_cache["empty-id"].entry.fiber

    assert small_index ==
             Shuttle.Poller.DocumentCache.index(Map.new(Enum.reverse(Enum.to_list(small_cache))))

    refute Map.has_key?(small_index, nil)
    assert Poller.cached_fiber(%{document_fiber_index: small_index}, nil) == nil

    assert small_collisions["shared"] == [
             {"a-fiber", "uid-a", "a-fiber"},
             {"z-fiber", "uid-z", "z-fiber"}
           ]

    assert small_collisions["identity"] == [
             {"slug-shadow", "uid-shadow", "slug-shadow"},
             {"slug-shadow-z", "uid-shadow-z", "slug-shadow-z"}
           ]

    {seen, first_warnings} =
      Shuttle.Poller.DocumentCache.collision_transition(MapSet.new(), small_collisions)

    assert first_warnings == Enum.sort(Map.to_list(small_collisions))

    assert {^seen, []} =
             Shuttle.Poller.DocumentCache.collision_transition(seen, small_collisions)

    {empty_seen, []} = Shuttle.Poller.DocumentCache.collision_transition(seen, %{})

    assert {_reappeared, ^first_warnings} =
             Shuttle.Poller.DocumentCache.collision_transition(empty_seen, small_collisions)

    warning_log =
      ExUnit.CaptureLog.capture_log(fn ->
        first_install = Poller.install_document_cache(%Shuttle.Poller.State{}, small_cache)
        _same_install = Poller.install_document_cache(first_install, small_cache)

        # Poll-task index construction is pure and does not emit install warnings.
        _task_index = Shuttle.Poller.DocumentCache.index(small_cache)

        cleared = Poller.install_document_cache(first_install, %{})
        _reinstalled = Poller.install_document_cache(cleared, small_cache)
      end)

    assert length(String.split(warning_log, "document slug collision")) - 1 == 4
    assert warning_log =~ "resolves to fiber id \"identity\""

    wide_cache =
      Map.merge(
        small_cache,
        Map.new(1..40, fn number ->
          id = "wide-#{String.pad_leading(Integer.to_string(number), 2, "0")}"
          {id, %{entry: %{fiber: %{"id" => id, "uid" => "uid-#{id}", "slug" => "wide-shared"}}}}
        end)
      )

    {wide_index, wide_collisions} = Shuttle.Poller.DocumentCache.index_with_collisions(wide_cache)
    reversed_cache = Map.new(Enum.reverse(Enum.to_list(wide_cache)))

    assert wide_index == Shuttle.Poller.DocumentCache.index(reversed_cache)
    assert wide_index["wide-shared"]["id"] == "wide-01"
    assert wide_collisions["wide-shared"] |> hd() == {"wide-01", "uid-wide-01", "wide-01"}
  end

  test "force start refuses a failed standing reopen before terminal launch" do
    id = "tests/refused-arm"
    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    MockRunner.set_shuttle(
      id,
      "kind: standing\nhost: test-host\nagent: claude-sonnet\nproject_dir: #{MockRunner.felt_root()}\n",
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        runner: RefusedArmRunner,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true,
        poll_interval_ms: 600_000
      )

    await_boot_cycle!(poller)

    assert {:error, {:arm_refused, %{message: message}}} =
             Poller.dispatch_fiber(poller, id, force: true)

    assert message =~ "simulated arm failure"

    refute Enum.any?(MockRunner.commands(), fn {command, args} ->
             command == "tmux" and "new-session" in args
           end)

    assert MockRunner.fiber(id)["status"] == "closed"
  end

  test "published state starts cold, reports age while suspended, and fences daemon incarnations" do
    poller_opts = [
      runner: MockRunner,
      own_host_id: "test-host",
      felt_stores: [],
      poll_interval_ms: 600_000
    ]

    {:ok, first_poller} = start_poller!(poller_opts)
    {:ok, first} = Poller.published_state_response(first_poller)
    assert first.generation == 1
    assert first.etag =~ "W/\""
    assert Poller.snapshot(first_poller).document_cache["state"] == "cold"

    :sys.suspend(first_poller)

    assert wait_until(fn ->
             {:ok, response} = Poller.published_state_response(first_poller)
             response.age_ms > first.age_ms
           end)

    {:ok, stale} = Poller.published_state_response(first_poller)
    assert stale.age_ms >= first.age_ms
    :sys.resume(first_poller)

    :ok = GenServer.stop(first_poller, :normal, @state_timeout)
    {:ok, second_poller} = start_poller!(poller_opts)
    {:ok, second} = Poller.published_state_response(second_poller, first.etag)
    assert second.etag != first.etag
    assert second.generation == 1
  end

  test "CPU memory diagnostics measure bounded task inputs without changing Poller state" do
    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        own_host_id: "test-host",
        felt_stores: [MockRunner.felt_root()],
        poll_interval_ms: 600_000
      )

    await_boot_cycle!(poller)
    await_publication!(poller)
    before = :sys.get_state(poller, @state_timeout)

    baseline = Poller.cpu_memory_measurements(poller)

    assert %{
             available: true,
             measurement_microseconds: measurement_microseconds,
             word_size_bytes: word_size_bytes,
             semantics: semantics,
             state: %{words: state_words, bytes: state_bytes},
             poll_plan_task_environment: %{
               input_keys: plan_input_keys,
               input_fields: plan_input_fields,
               words: plan_words,
               bytes: plan_bytes
             },
             poll_read_task_environment: %{
               input_keys: read_input_keys,
               input_fields: read_input_fields,
               words: read_words,
               bytes: read_bytes
             }
           } = baseline

    assert plan_input_keys == [
             :auto_discover_felt_stores,
             :discovery,
             :felt_stores,
             :full_scan_budget_ms
           ]

    assert read_input_keys == [
             :announced_ids,
             :discovery,
             :document_cache,
             :felt_stores,
             :full_scan_budget_ms,
             :full_scan_min_interval_ms,
             :full_scan_timeout_ms,
             :last_full_listings,
             :last_known_listings,
             :runner,
             :running,
             :task_reads
           ]

    assert plan_input_fields |> Map.keys() |> Enum.sort() == plan_input_keys
    assert read_input_fields |> Map.keys() |> Enum.sort() == read_input_keys

    Enum.each(plan_input_fields, fn {field, measurement} ->
      words = :erts_debug.flat_size(Map.fetch!(before, field))
      assert measurement == %{words: words, bytes: words * baseline.word_size_bytes}
    end)

    Enum.each(read_input_fields, fn {field, measurement} ->
      words = :erts_debug.flat_size(Map.fetch!(before, field))
      assert measurement == %{words: words, bytes: words * baseline.word_size_bytes}
    end)

    assert word_size_bytes > 0
    assert is_integer(measurement_microseconds)
    assert measurement_microseconds >= 0

    assert semantics ==
             "flat_size estimates flattened message and spawn term copy size; input_fields measure each input-map value separately and exclude map/environment overhead and other captured terms; ref-counted off-heap binary payloads stay shared and are excluded, this is not RSS"

    assert state_words == :erts_debug.flat_size(before)
    assert state_bytes == state_words * word_size_bytes
    assert plan_bytes == plan_words * word_size_bytes
    assert read_bytes == read_words * word_size_bytes
    assert :sys.get_state(poller, @state_timeout) == before

    large_orphans =
      for n <- 1..5_000, do: %{fiber_id: "orphan-#{n}", reason: "missing_tmux_session"}

    :sys.replace_state(poller, &%{&1 | orphans: large_orphans})
    with_large_excluded_field = Poller.cpu_memory_measurements(poller)

    assert with_large_excluded_field.state.words > state_words

    assert with_large_excluded_field.poll_plan_task_environment.words ==
             baseline.poll_plan_task_environment.words

    assert with_large_excluded_field.poll_read_task_environment.words ==
             baseline.poll_read_task_environment.words

    large_document_cache =
      Map.new(1..2_000, fn n ->
        id = "cache-#{n}"

        entry = %{
          felt_store: MockRunner.felt_root(),
          path: "/cache/#{id}.md",
          report_path: nil,
          fiber: make_fiber(id)
        }

        {id, %{entry: entry, modified_at: nil}}
      end)

    :sys.replace_state(poller, fn state ->
      %{state | document_cache: large_document_cache, document_fiber_index: %{}}
    end)

    with_large_cache = Poller.cpu_memory_measurements(poller)

    assert with_large_cache.state.words > with_large_excluded_field.state.words

    assert with_large_cache.poll_plan_task_environment.words ==
             with_large_excluded_field.poll_plan_task_environment.words

    assert with_large_cache.poll_plan_task_environment.input_fields ==
             with_large_excluded_field.poll_plan_task_environment.input_fields

    assert with_large_cache.poll_read_task_environment.words >
             with_large_excluded_field.poll_read_task_environment.words

    assert with_large_cache.poll_read_task_environment.input_fields.document_cache.words >
             with_large_excluded_field.poll_read_task_environment.input_fields.document_cache.words

    refute :document_cache in with_large_cache.poll_plan_task_environment.input_keys

    assert Map.delete(with_large_cache.poll_read_task_environment.input_fields, :document_cache) ==
             Map.delete(
               with_large_excluded_field.poll_read_task_environment.input_fields,
               :document_cache
             )

    assert :sys.get_state(poller, @state_timeout).document_cache == large_document_cache
  end

  test "Desk orchestrators use nearest constitution across plain levels before owner filtering" do
    root = MockRunner.felt_root()

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        own_host_id: "test-host",
        felt_stores: [root],
        poll_interval_ms: 600_000
      )

    await_boot_cycle!(poller)

    make_entry = fn id, slug, store, block ->
      %{
        felt_store: store,
        path: store <> "/.felt/" <> slug <> ".md",
        report_path: "report.html",
        fiber: %{
          "id" => id,
          "uid" => id,
          "slug" => slug,
          "name" => slug,
          "outcome" => "Preserved",
          "status" => "open",
          "shuttle" => block
        }
      }
    end

    own = %{"kind" => "oneshot", "host" => "test-host"}
    remote = %{"kind" => "oneshot", "host" => "remote-host"}

    entries = [
      make_entry.("hub-uid", "hub", root, remote),
      make_entry.("plain-uid", "hub/notes", root, nil),
      make_entry.("thread-uid", "hub/notes/thread", root, own),
      make_entry.("deep-uid", "hub/notes/thread/deep", root, own),
      make_entry.("solo-uid", "solo", root, own),
      make_entry.("prefix-uid", "hub-shadow", root, own),
      make_entry.("other-uid", "hub/thread", "other-store", own)
    ]

    cache = Map.new(entries, &{&1.fiber["id"], %{entry: &1, modified_at: nil}})

    :sys.replace_state(poller, fn state ->
      %{
        state
        | document_cache: cache,
          document_fiber_index: Shuttle.Poller.DocumentCache.index(cache),
          document_cache_ready: true
      }
    end)

    # Synthetic state replacement bypasses the callback publication wrapper.
    send(poller, :publish_state)
    :sys.get_state(poller, @state_timeout)
    assert {:ok, %{fibers: feed}} = Poller.cached_fiber_documents(poller)

    assert Map.new(feed, &{&1.fiber["id"], &1.orchestrator}) == %{
             "thread-uid" => "hub-uid",
             "deep-uid" => "thread-uid",
             "solo-uid" => nil,
             "prefix-uid" => nil,
             "other-uid" => nil
           }

    # Every constitution is served where it stands; the rest of the row is the cache's.
    for row <- feed do
      assert %{column: "drafts", turn: "none"} = row

      assert Map.drop(row, [:orchestrator, :column, :turn]) ==
               Enum.find(entries, &(&1.fiber["id"] == row.fiber["id"]))
    end
  end

  # ── Tests ──

  test "felt reads omit resolved facets and Shuttle reads include them" do
    id = "tests/resolved-surface"
    MockRunner.set_shuttle(id, "agent: claude-opus")

    assert {felt_listing, 0} = MockRunner.cmd("felt", ["ls", "--json"], [])
    assert [%{"id" => ^id, "shuttle" => felt_list_block}] = Jason.decode!(felt_listing)
    refute Map.has_key?(felt_list_block, "resolved")

    assert {shuttle_listing, 0} = MockRunner.cmd("shuttle", ["ls", "--json"], [])
    assert [%{"id" => ^id, "shuttle" => shuttle_list_block}] = Jason.decode!(shuttle_listing)
    assert get_in(shuttle_list_block, ["resolved", "agent", "id"]) == "claude-opus"

    assert {felt_show, 0} = MockRunner.cmd("felt", ["show", id, "--json"], [])
    assert %{"shuttle" => felt_show_block} = Jason.decode!(felt_show)
    refute Map.has_key?(felt_show_block, "resolved")

    assert {shuttle_show, 0} = MockRunner.cmd("shuttle", ["show", id, "--json"], [])
    assert %{"shuttle" => shuttle_show_block} = Jason.decode!(shuttle_show)
    assert get_in(shuttle_show_block, ["resolved", "agent", "id"]) == "claude-opus"
  end

  test "poller discovers and dispatches eligible fibers" do
    # Use a fiber ID unique to this test to avoid collisions with sessions left
    # alive by other tests' long-lived Pollers/Watchers.
    fiber = make_fiber("tests/haiku-dispatch")
    MockRunner.set_fiber("tests/haiku-dispatch", fiber)
    MockRunner.set_shuttle("tests/haiku-dispatch", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_1,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Trigger a poll cycle manually
    send(poller, {:tick, Poller.snapshot(poller) |> Map.get(:tick_token)})

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
           end)

    # Check snapshot shows running worker
    assert wait_until(fn ->
             length(Poller.snapshot(poller).eligible) == 1
           end)

    snap = Poller.snapshot(poller)
    assert length(snap.eligible) == 1
    assert hd(snap.eligible).fiber_id == "tests/haiku-dispatch"
  end

  test "poller skips fibers targeted at a different shuttle host" do
    fiber = make_fiber("tests/host-mismatch")
    MockRunner.set_fiber("tests/host-mismatch", fiber)
    MockRunner.set_shuttle("tests/host-mismatch", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_host_mismatch,
        runner: MockRunner,
        own_host_id: "local",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    snap = Poller.snapshot(poller)
    assert snap.eligible == []
    assert snap.claimed_count == 0
  end

  test "poller dispatches fibers targeted at its own shuttle host" do
    fiber = make_fiber("tests/host-match")
    MockRunner.set_fiber("tests/host-match", fiber)
    MockRunner.set_shuttle("tests/host-match", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_host_match,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
           end)

    assert wait_until(fn ->
             snap = Poller.snapshot(poller)
             length(snap.eligible) == 1 and hd(snap.eligible).fiber_id == "tests/host-match"
           end)
  end

  # The Poller's default `own_host_id` is SHUTTLE_HOST when set, else Shuttle's
  # answer from `shuttle host --json`. Explicit `own_host_id:` opts always win.
  describe "own_host_id resolution" do
    test "SHUTTLE_HOST, trimmed, wins without asking Shuttle" do
      Env.put_env("SHUTTLE_HOST", "  candide \n")
      MockRunner.set_host_json(~s({"id": "from-shuttle"}))

      {:ok, poller} = start_identity_poller(:test_poller_env_host)

      assert Poller.snapshot(poller).host == "candide"
      refute asked_shuttle_for_host?()
    end

    test "with SHUTTLE_HOST unset the id is Shuttle's, frozen for the Poller's life" do
      Env.delete_env("SHUTTLE_HOST")
      MockRunner.set_host_json(~s({"id": "candide", "class": "single-user"}))

      {:ok, poller} = start_identity_poller(:test_poller_shuttle_host)

      assert Poller.snapshot(poller).host == "candide"
      assert Poller.own_host_id(:test_poller_shuttle_host) == "candide"
      assert asked_shuttle_for_host?()

      # A later change in Shuttle's answer does not reach a booted Poller.
      MockRunner.set_host_json(~s({"id": "renamed"}))
      assert Poller.own_host_id(:test_poller_shuttle_host) == "candide"
    end

    test "a Poller whose shuttle cannot name the host retries and recovers" do
      Env.delete_env("SHUTTLE_HOST")
      MockRunner.set_host_json("parsing host.json: not a JSON object", 1)

      ExUnit.CaptureLog.capture_log(fn ->
        assert {:ok, poller} =
                 start_supervised(%{
                   id: make_ref(),
                   start:
                     {Poller, :start_link,
                      [
                        [
                          name: :test_poller_no_host,
                          runner: MockRunner,
                          poll_interval_ms: 60_000,
                          felt_stores: [MockRunner.felt_root()],
                          daemon_heartbeat_file: test_heartbeat_file()
                        ]
                      ]},
                   restart: :temporary
                 })

        assert wait_until(fn ->
                 match?(
                   %{boot: %{stage: "configuration", reason: "retrying"}},
                   Shuttle.Readiness.status()
                 )
               end)

        assert %{boot_hold: nil, boot: %{error: error, retry_in_ms: retry_in}} =
                 Shuttle.Readiness.status()

        assert error =~ "shuttle host --json"
        assert retry_in <= 1_000
        MockRunner.set_host_json(~s({"id": "recovered-host"}))
        assert %{boot_hold: nil, own_host_id: "recovered-host"} = :sys.get_state(poller, 30_000)
        assert Process.alive?(poller)
      end)
    end
  end

  test "poller uses shuttle listing for discovery" do
    fiber = make_fiber("tests/projected-discovery")
    MockRunner.set_fiber("tests/projected-discovery", fiber)
    MockRunner.set_shuttle("tests/projected-discovery", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_projected_listing,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # The poller uses shuttle's widened kanban projection (the full field set
    # the document cache builds entries from).
    projection = Enum.join(Shuttle.FiberDocuments.kanban_fields(), ",")

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "shuttle" and
                 args == [
                   "-C",
                   MockRunner.felt_root(),
                   "ls",
                   "--status",
                   "all",
                   "--json",
                   "--any",
                   "field:shuttle",
                   "--any",
                   "field:due",
                   "--any",
                   "tag:cycle",
                   "--json-field",
                   projection
                 ]
             end)
           end)

    assert {:ok, fiber} =
             Poller.fetch_fiber_full(
               "tests/projected-discovery",
               :sys.get_state(poller, @state_timeout)
             )

    assert get_in(fiber, ["shuttle", "resolved", "agent", "id"]) == "claude-sonnet"

    assert {"shuttle",
            ["-C", MockRunner.felt_root(), "show", "tests/projected-discovery", "--json"]} in MockRunner.commands()
  end

  test "poller builds document cache entries from candidate rows, no shuttle show" do
    uid = "01JZ00000000000000000000CA"

    fiber =
      make_fiber("tests/cached-document", %{
        "uid" => uid,
        "modified_at" => "2026-06-06T01:00:00Z",
        "outcome" => "first"
      })

    MockRunner.set_fiber("tests/cached-document", fiber)
    MockRunner.set_shuttle("tests/cached-document", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_document_cache,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn ->
             get_in(Poller.snapshot(poller), [:document_cache, "entries"]) == 1
           end)

    first_stats = Poller.snapshot(poller)[:document_cache]

    assert %{"hits" => 0, "misses" => 1, "entries" => 1} = first_stats
    # The cache builds each entry directly from its candidate row — the widened
    # `shuttle ls` projection carries every field — so NO `shuttle show` fires.
    assert shuttle_show_count() == 0

    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             stats = Poller.snapshot(poller)[:document_cache]
             stats["hits"] == 1 and stats["misses"] == 0
           end)

    assert shuttle_show_count() == 0

    cached_state = :sys.get_state(poller, @state_timeout)
    assert Poller.cached_fiber(cached_state, uid)["uid"] == uid
    assert Poller.cached_fiber(cached_state, "tests/cached-document")["uid"] == uid

    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    assert [%{fiber: %{"id" => ^uid, "slug" => "tests/cached-document"}}] = body.fibers

    changed_fiber =
      make_fiber("tests/cached-document", %{
        "uid" => uid,
        "modified_at" => "2026-06-06T01:05:00Z",
        "name" => "changed document",
        "shuttle" => %{"enabled" => true, "kind" => "oneshot", "host" => "test-host"}
      })

    MockRunner.set_fiber("tests/cached-document", changed_fiber)
    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             stats = Poller.snapshot(poller)[:document_cache]
             stats["hits"] == 0 and stats["misses"] == 1
           end)

    assert shuttle_show_count() == 0
    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    assert [%{fiber: %{"id" => ^uid, "name" => "changed document"}}] = body.fibers
    cached_state = :sys.get_state(poller, @state_timeout)
    assert Poller.cached_fiber(cached_state, uid)["name"] == "changed document"

    assert Poller.cached_fiber(cached_state, "tests/cached-document")["name"] ==
             "changed document"

    MockRunner.delete_fiber("tests/cached-document")
    assert :ok = Poller.refresh_document(poller, "tests/cached-document")
    refreshed_state = :sys.get_state(poller, @state_timeout)
    assert Poller.cached_fiber(refreshed_state, uid) == nil
    assert Poller.cached_fiber(refreshed_state, "tests/cached-document") == nil

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      state = :sys.get_state(poller, @state_timeout)
      assert Poller.cached_fiber(state, uid) == nil
      assert Poller.cached_fiber(state, "tests/cached-document") == nil
    end)
  end

  test "post-mutation document refresh keeps Shuttle's resolved agent" do
    id = "tests/refreshed-agent"
    uid = "01JZ00000000000000000000CC"
    MockRunner.set_fiber(id, make_fiber(id, %{"uid" => uid}))
    MockRunner.set_shuttle(id, "kind: oneshot\nagent: claude-opus")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_refresh_resolved_agent,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn ->
             get_in(Poller.snapshot(poller), [:document_cache, "entries"]) == 1
           end)

    assert {:ok, before} = Poller.cached_fiber_documents(poller)
    assert [%{fiber: %{"id" => ^uid} = fiber}] = before.fibers
    assert get_in(fiber, ["shuttle", "resolved", "agent", "id"]) == "claude-opus"

    assert :ok = Poller.refresh_document(poller, id)

    assert {:ok, refreshed} = Poller.cached_fiber_documents(poller)
    assert [%{fiber: %{"id" => ^uid} = refreshed_fiber}] = refreshed.fibers
    refreshed_state = :sys.get_state(poller, @state_timeout)
    assert Poller.cached_fiber(refreshed_state, uid) == refreshed_fiber
    assert Poller.cached_fiber(refreshed_state, id) == refreshed_fiber
    assert get_in(refreshed_fiber, ["shuttle", "resolved", "agent", "id"]) == "claude-opus"

    MockRunner.set_shuttle(id, """
    kind: oneshot
    agent: claude-opus
    ask:
      text: Which cut?
      at: "2026-06-01T12:00:00Z"
    """)

    assert :ok = Poller.refresh_document(poller, id)
    assert {:ok, asked} = Poller.cached_fiber_documents(poller)
    assert [%{fiber: asked_fiber}] = asked.fibers
    assert get_in(asked_fiber, ["shuttle", "ask", "text"]) == "Which cut?"

    assert {:ok, _} = Poller.lifecycle_transition(poller, :clear_ask, id)
    assert {:ok, cleared} = Poller.cached_fiber_documents(poller)
    assert [%{fiber: cleared_fiber}] = cleared.fibers
    refute get_in(cleared_fiber, ["shuttle", "ask"])
    assert get_in(cleared_fiber, ["shuttle", "resolved", "agent", "id"]) == "claude-opus"
  end

  # The incident this guards: on an overloaded login node one failed `shuttle ls`
  # used to blank every fiber on the host for the tick — mass document-cache
  # eviction, cards flapping in and out. A failed listing is "world unknown", not
  # "fibers gone": the poller carries last-known candidates without re-shelling.
  test "a failed Shuttle listing carries last-known candidates instead of blanking the store" do
    uid = "01JZ00000000000000000000CB"

    fiber =
      make_fiber("tests/retained-document", %{
        "uid" => uid,
        "modified_at" => "2026-06-06T02:00:00Z"
      })

    MockRunner.set_fiber("tests/retained-document", fiber)
    MockRunner.set_shuttle("tests/retained-document", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_retained_document,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn ->
             get_in(Poller.snapshot(poller), [:document_cache, "entries"]) == 1
           end)

    show_count = shuttle_show_count()

    # Shuttle's primary listing times out. The tick retains the last-known
    # candidate, keeps the card served, and reuses its mtime-keyed cache entry.
    # Capture the last all-fresh refreshed_at before the failure, so we can prove
    # the partial tick does NOT advance it.
    fresh_refreshed_at = Poller.snapshot(poller)[:document_cache]["refreshed_at"]
    assert is_binary(fresh_refreshed_at)

    MockRunner.set_listing_timeout(true)
    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             stats = Poller.snapshot(poller)[:document_cache]
             stats["hits"] == 1 and stats["misses"] == 0 and stats["entries"] == 1
           end)

    assert shuttle_show_count() == show_count
    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    assert [%{fiber: %{"id" => ^uid, "slug" => "tests/retained-document"}}] = body.fibers

    # A store's listing FAILED, so this tick is "partial": the cache state says
    # so and refreshed_at is frozen at the last all-fresh tick (staleness honest).
    partial_stats = Poller.snapshot(poller)[:document_cache]
    assert partial_stats["state"] == "partial"
    assert partial_stats["refreshed_at"] == fresh_refreshed_at
    assert body.cache.state == "partial"
    assert body.cache.refreshed_at == fresh_refreshed_at

    # Shuttle recovers: the live listing resumes, the entry is served, and the tick
    # is "fresh" again with an ADVANCED refreshed_at.
    MockRunner.set_listing_timeout(false)
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert {:ok, body} = Poller.cached_fiber_documents(poller)
      assert [%{fiber: %{"id" => ^uid, "slug" => "tests/retained-document"}}] = body.fibers
      assert body.cache.state == "fresh"
    end)
  end

  test "seam patch survives a poll built from a pre-mutation snapshot (prefer-newer merge)" do
    uid = "01JZ0000000000000000000SEA"

    fiber =
      make_fiber("tests/seam", %{
        "uid" => uid,
        "modified_at" => "2026-06-06T01:00:00Z",
        "name" => "disk-old"
      })

    MockRunner.set_fiber("tests/seam", fiber)
    MockRunner.set_shuttle("tests/seam", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_seam_merge,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn ->
             get_in(Poller.snapshot(poller), [:document_cache, "entries"]) == 1
           end)

    # Simulate a mid-poll `refresh_document` patch landing on the LIVE cache: a
    # NEWER mtime and a fresh body. The on-disk candidate still reads the OLD
    # mtime, so the next poll's cache rebuild produces the stale "disk-old" entry.
    patched_entry = %{
      felt_store: MockRunner.felt_root(),
      path: "tests/seam/seam.md",
      fiber: %{
        "id" => uid,
        "slug" => "tests/seam",
        "uid" => uid,
        "name" => "patched-newer",
        "status" => "active",
        "shuttle" => %{"kind" => "oneshot", "host" => "test-host"}
      }
    }

    :sys.replace_state(poller, fn state ->
      %{
        state
        | document_cache: %{uid => %{modified_at: "2026-06-06T02:00:00Z", entry: patched_entry}},
          document_fiber_index:
            Shuttle.Poller.DocumentCache.index(%{
              uid => %{modified_at: "2026-06-06T02:00:00Z", entry: patched_entry}
            })
      }
    end)

    sync_poll_cycle!(poller)

    # The Task-built cache carries "disk-old" (mtime m1); the merge prefers the
    # live "patched-newer" entry (mtime m2 > m1) instead of clobbering it.
    assert_eventually(fn ->
      assert {:ok, body} = Poller.cached_fiber_documents(poller)
      assert [%{fiber: %{"name" => "patched-newer"}}] = body.fibers
    end)
  end

  test "mtime-reuse hit reconciles the companion path when tapestry.html is added/removed" do
    uid = "01JZ0000000000000000000RPT"

    fiber =
      make_fiber("tests/report-toggle", %{
        "uid" => uid,
        "modified_at" => "2026-06-06T03:00:00Z"
      })

    MockRunner.set_fiber("tests/report-toggle", fiber)
    MockRunner.set_shuttle("tests/report-toggle", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_report_toggle,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn ->
             get_in(Poller.snapshot(poller), [:document_cache, "entries"]) == 1
           end)

    # No companion yet.
    {:ok, body} = Poller.cached_fiber_documents(poller)
    assert [entry] = body.fibers
    refute Map.has_key?(entry, :report_path)

    # An tapestry.html appears — but adding it does NOT bump the fiber's mtime, so
    # the next poll is a mtime-REUSE hit. The reconcile must still surface it from
    # the candidate row's native report_path field.
    current = MockRunner.fiber("tests/report-toggle")

    MockRunner.set_fiber(
      "tests/report-toggle",
      Map.put(
        current,
        "report_path",
        "#{MockRunner.felt_dir()}/tests/report-toggle/tapestry.html"
      )
    )

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert {:ok, body} = Poller.cached_fiber_documents(poller)
      assert [entry] = body.fibers
      assert Map.has_key?(entry, :report_path)
      assert String.ends_with?(entry.report_path, "tapestry.html")
    end)

    # The artifact is removed (field drops) — again without an mtime bump. The
    # reconcile drops the stale report_path on the reuse hit.
    MockRunner.set_fiber("tests/report-toggle", Map.delete(current, "report_path"))
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert {:ok, body} = Poller.cached_fiber_documents(poller)
      assert [entry] = body.fibers
      refute Map.has_key?(entry, :report_path)
    end)
  end

  test "cold-cache serve logs once per cold period, not per request" do
    {:ok, poller} =
      start_poller!(
        name: :test_poller_cold_log,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    # Let the boot poll warm the cache, then force it cold and re-arm the guard.
    assert wait_until(fn -> :sys.get_state(poller, @state_timeout).document_cache_ready end)

    :sys.replace_state(poller, fn state ->
      %{
        state
        | document_cache_ready: false,
          document_cache: %{},
          document_fiber_index: %{}
      }
    end)

    # Commit the test fixture through an actual Poller transition before using
    # the mailbox-free reader.
    GenServer.call(poller, :sync)

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        {:ok, _} = Poller.cached_fiber_documents(poller)
        {:ok, _} = Poller.cached_fiber_documents(poller)
        {:ok, _} = Poller.cached_fiber_documents(poller)
      end)

    occurrences =
      log
      |> String.split("owner feed served from COLD document cache")
      |> length()
      |> Kernel.-(1)

    assert occurrences == 1
  end

  test "owner feed stamps serve-time runtime onto an owned fiber with a live worker" do
    uid = "01JZ00000000000000000000RT"

    fiber =
      make_fiber("tests/aloft", %{
        "uid" => uid,
        "modified_at" => "2026-06-08T01:00:00Z"
      })

    MockRunner.set_fiber("tests/aloft", fiber)
    MockRunner.set_shuttle("tests/aloft", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_stamp,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # The fiber dispatches (lands in state.running) AND its document caches.
    assert wait_until(fn ->
             snap = Poller.snapshot(poller)

             length(snap.eligible) == 1 and
               get_in(snap, [:document_cache, "entries"]) >= 1
           end)

    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    assert [%{runtime: runtime} = entry] = body.fibers
    # Liveness joins by uid (rename-safe): the served row's fiber uid matches
    # the runtime_key under which state.running tracks the live worker.
    assert get_in(entry, [:fiber, "uid"]) == uid
    assert %{tmux_session: session, state: _state, started_at: started} = runtime
    assert is_binary(session)
    assert is_integer(started)
    # No activity source by default → no phase, but last_activity_at still
    # present (falls back to meta/started_at) so the field is never missing.
    refute Map.has_key?(runtime, :phase)
    assert is_integer(runtime.last_activity_at)
  end

  test "owner feed stamps the REAL last_activity_at, distinct from started_at" do
    uid = "01JZ00000000000000000000RA"

    fiber =
      make_fiber("tests/realactivity", %{
        "uid" => uid,
        "modified_at" => "2026-06-08T01:00:00Z"
      })

    MockRunner.set_fiber("tests/realactivity", fiber)
    MockRunner.set_shuttle("tests/realactivity", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_real_activity,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             snap = Poller.snapshot(poller)
             length(snap.eligible) == 1 and get_in(snap, [:document_cache, "entries"]) >= 1
           end)

    # Discover the running worker's session and its started_at, then inject an
    # activity record whose last_event_at is deliberately 90s BEFORE started_at.
    assert {:ok, %{fibers: [%{runtime: %{started_at: started}}]}} =
             Poller.cached_fiber_documents(poller)

    assert {:ok, %{fibers: [%{runtime: %{session_uuid: session}}]}} =
             Poller.cached_fiber_documents(poller)

    assert is_binary(session)
    last_event_at = started - 90_000

    Env.put_app_env(:waiting_phases_source, fn ->
      %{session => %{last_event_at: last_event_at, phase: "waiting"}}
    end)

    assert {:ok, %{fibers: [%{runtime: runtime}]}} = Poller.cached_fiber_documents(poller)
    # The served last_activity_at is the tracker's real timestamp — NOT started_at.
    assert runtime.last_activity_at == last_event_at
    assert runtime.last_activity_at != runtime.started_at
    assert runtime.phase == "waiting"
  end

  test "owner feed stamps phase: waiting when the live worker's session is waiting for input" do
    uid = "01JZ00000000000000000000RW"

    fiber =
      make_fiber("tests/waiting", %{
        "uid" => uid,
        "modified_at" => "2026-06-08T01:00:00Z"
      })

    MockRunner.set_fiber("tests/waiting", fiber)
    MockRunner.set_shuttle("tests/waiting", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_waiting,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             snap = Poller.snapshot(poller)

             length(snap.eligible) == 1 and
               get_in(snap, [:document_cache, "entries"]) >= 1
           end)

    # Join activity by the cached harness UUID, never by the terminal handle.

    assert {:ok, %{fibers: [%{runtime: %{session_uuid: session}}]}} =
             Poller.cached_fiber_documents(poller)

    Env.put_app_env(:waiting_phases_source, fn ->
      %{session => %{last_event_at: 1_700_000_000_000, phase: "waiting"}}
    end)

    assert {:ok, %{fibers: [%{runtime: runtime}]}} = Poller.cached_fiber_documents(poller)
    assert runtime.phase == "waiting"
    assert runtime.last_activity_at == 1_700_000_000_000

    # The escalation phase stamps straight through the same path.
    Env.put_app_env(:waiting_phases_source, fn ->
      %{session => %{last_event_at: 1_700_000_000_000, phase: "attention"}}
    end)

    assert {:ok, %{fibers: [%{runtime: escalated}]}} = Poller.cached_fiber_documents(poller)
    assert escalated.phase == "attention"

    # Clearing the activity map drops the phase but keeps last_activity_at (the
    # meta/started_at fallback) — self-healing on the serve path.
    Env.put_app_env(:waiting_phases_source, fn -> %{} end)
    assert {:ok, %{fibers: [%{runtime: cleared}]}} = Poller.cached_fiber_documents(poller)
    refute Map.has_key?(cleared, :phase)
    assert is_integer(cleared.last_activity_at)
  end
end
