defmodule ShuttleWeb.FiberDocumentsControllerTest do
  use ExUnit.Case
  alias Shuttle.Test.StubGetFileClient
  import Shuttle.Test.EnvHelpers
  import Phoenix.ConnTest
  import Plug.Conn

  @endpoint ShuttleWeb.Endpoint

  alias Shuttle.{Remote, RemoteFiberRegistry}

  # Deterministic HTTP stub for the cross-host composite test: scripts the
  # remote daemon's `/api/v1/fibers?shuttle=true` response so the local
  # RemoteFiberRegistry caches a known feed without a real tunnel.
  defmodule StubFiberClient do
    @behaviour Shuttle.RemoteRegistry.Client
    use Agent

    def start_link(_ \\ []), do: Agent.start_link(fn -> %{} end, name: __MODULE__)
    def set(url, response), do: Agent.update(__MODULE__, &Map.put(&1, url, response))

    @impl true
    def get(url, _timeout_ms), do: Agent.get(__MODULE__, &Map.get(&1, url, {:error, :not_set}))
  end

  setup do
    root =
      Path.join(
        System.tmp_dir!(),
        "shuttle-fiber-documents-controller-#{System.unique_integer([:positive])}"
      )

    store = Path.join(root, "loom")
    File.mkdir_p!(store)

    old_loom_homes = System.get_env("FELT_STORES")
    old_shuttle_host = System.get_env("SHUTTLE_HOST")

    System.put_env("FELT_STORES", store)
    System.put_env("SHUTTLE_HOST", "test-host")

    on_exit(fn ->
      restore_env("FELT_STORES", old_loom_homes)
      restore_env("SHUTTLE_HOST", old_shuttle_host)
      File.rm_rf(root)
    end)

    {:ok, store: store}
  end

  test "GET /api/v1/fibers returns daemon-local felt JSON with path metadata", %{store: store} do
    write_fiber!(store, "tests/document", """
    ---
    name: Document route
    status: active
    tags:
      - shuttle
    shuttle:
      enabled: true
      host: test-host
    ---

    Body.
    """)

    File.write!(
      Path.join([store, ".felt", "tests", "document", "report.html"]),
      "<p>report</p>\n"
    )

    # report_path is `dirname(felt.path)/report.html` — felt's carried path is
    # symlink-canonicalized (on macOS the tmp store's /var → /private/var), and
    # Portolan serves it as an absolute path, so assert against that realpath.
    # `dir` is that same canonicalized directory: the base the panel resolves a
    # relative `:::{embed}` / image against, emitted for every fiber.
    report = real_report_path(store, "tests/document")
    dir = real_fiber_dir(store, "tests/document")

    conn = get(api_conn(), "/api/v1/fibers")

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["host"] == "test-host"
    assert body["felt_stores"] == [store]

    assert [
             %{
               "felt_store" => ^store,
               "path" => "tests/document/document.md",
               "dir" => ^dir,
               "report_path" => ^report,
               "fiber" => %{
                 "id" => "tests/document",
                 "name" => "Document route",
                 "status" => "active",
                 "shuttle" => %{"enabled" => true, "host" => "test-host"}
               }
             }
           ] = body["fibers"]

    refute Map.has_key?(hd(body["fibers"])["fiber"], "body")
  end

  test "GET /api/v1/fibers?body=true includes felt bodies", %{store: store} do
    write_fiber!(store, "tests/body", """
    ---
    name: Body route
    status: open
    ---

    Body text.
    """)

    conn = get(api_conn(), "/api/v1/fibers?body=true")

    assert conn.status == 200
    assert [%{"fiber" => %{"body" => "Body text."}}] = Jason.decode!(conn.resp_body)["fibers"]
  end

  test "GET /api/v1/fibers?shuttle=true serves only this daemon's owned shuttle rows",
       %{store: store} do
    # Owned: shuttle block pinned to this daemon's host.
    write_fiber!(store, "tests/managed", """
    ---
    name: Managed
    status: active
    shuttle:
      kind: oneshot
      host: test-host
    ---

    Body.
    """)

    # Closed pinned constitutions still belong on the Shuttle board: their
    # lifecycle state is awaiting/reviewable, not "invisible".
    write_fiber!(store, "tests/closed-pinned", """
    ---
    name: Closed pinned
    status: closed
    shuttle:
      kind: pinned
      host: test-host
    ---

    Body.
    """)

    # Owned by ANOTHER host: physically rooted here (so it lands in the local
    # walk / document cache) but pinned to a peer. Slice 7: the owner-only feed
    # never serves a peer's fiber — it belongs to that host's feed, and a viewer
    # concatenates owners' answers rather than merging a mirror copy.
    write_fiber!(store, "tests/elsewhere", """
    ---
    name: Owned elsewhere
    status: active
    shuttle:
      kind: oneshot
      host: other-host
    ---

    Body.
    """)

    # Unowned: a shuttle block with no host:. Detected (it has a block) but not
    # considered — it names no daemon, so no daemon's feed claims it.
    write_fiber!(store, "tests/unowned", """
    ---
    name: Unowned draft
    status: open
    shuttle:
      kind: oneshot
    ---

    Body.
    """)

    write_fiber!(store, "tests/plain", """
    ---
    name: Plain todo
    status: open
    due: 2026-01-01
    ---

    Body.
    """)

    # Unfiltered: every fiber comes back (the content/search reader path).
    all = get(api_conn(), "/api/v1/fibers")
    assert all.status == 200

    all_names =
      Jason.decode!(all.resp_body)["fibers"]
      |> Enum.map(& &1["fiber"]["name"])
      |> Enum.sort()

    assert all_names == [
             "Closed pinned",
             "Managed",
             "Owned elsewhere",
             "Plain todo",
             "Unowned draft"
           ]

    # shuttle=true: the rows this daemon owns (shuttle block + host == own),
    # PLUS the host-less kinds the aux walks admit. "Plain todo" is a human
    # `due:` card with no shuttle block — it rides the `--has-field due` walk.
    # "Owned elsewhere" and "Unowned draft" name an owner (a peer, and nobody)
    # so they stay out. Served from the poller's warm document cache.
    warm_poller!(store)
    only = get(api_conn(), "/api/v1/fibers?shuttle=true")
    assert only.status == 200

    owner_names =
      only.resp_body
      |> Jason.decode!()
      |> Map.fetch!("fibers")
      |> Enum.map(& &1["fiber"]["name"])
      |> Enum.sort()

    assert owner_names == ["Closed pinned", "Managed", "Plain todo"]
  end

  test "GET /api/v1/fibers?shuttle=true stamps live runtime from the poller",
       %{store: store} do
    uid = "01KVRTNM000000000000000000"
    session = "live-#{uid}-shuttle"

    write_fiber!(store, "tests/live", """
    ---
    id: #{uid}
    name: Live worker
    status: active
    shuttle:
      kind: pinned
      host: test-host
    ---

    Body.
    """)

    # Warm the cache from disk, THEN layer the running worker on top (preserving
    # the warmed document_cache) so the owner feed stamps serve-time runtime.
    poller = warm_poller!(store)
    now = DateTime.utc_now()

    :sys.replace_state(poller, fn state ->
      %{
        state
        | running:
            Map.put(state.running, uid, %{
              fiber_id: "tests/live",
              uid: uid,
              session: session,
              agent_id: "codex",
              started_at: now,
              last_activity_at: now
            })
      }
    end)

    conn = get(api_conn(), "/api/v1/fibers?shuttle=true")
    assert conn.status == 200

    entry =
      conn.resp_body
      |> Jason.decode!()
      |> Map.fetch!("fibers")
      |> Enum.find(&(&1["fiber"]["slug"] == "tests/live"))

    assert entry["runtime"]["tmux_session"] == session
    assert entry["runtime"]["agent"] == "codex"
  end

  test "GET /api/v1/fibers?shuttle=true serves the warm poller cache with runtime AND held overlays",
       %{store: store} do
    # This fiber is NEVER written to disk: only the poller's in-memory document
    # cache can produce it. If the endpoint fell through to the live `felt ls`
    # path the row would be absent and this test would fail — its presence proves
    # the warm cache was served. The cache pre-stamps `runtime` (a running
    # worker); the controller layers `held` (a boot-quarantine-parked launch) on
    # top. Asserting BOTH overlays proves the controller applies `put_held` over
    # the cached, already-runtime-stamped rows without re-stamping runtime.
    uid = "01KVRTNM000000000000000001"
    session = "shuttle-tests-live"

    entry = %{
      felt_store: store,
      path: "tests/live/live.md",
      fiber: %{
        "id" => "tests/live",
        "slug" => "tests/live",
        "uid" => uid,
        "name" => "Live worker",
        "status" => "active",
        "shuttle" => %{"kind" => "pinned", "host" => "test-host"}
      }
    }

    now = DateTime.utc_now()
    {poller, original_state} = start_or_reuse_poller(store)

    # Let the Poller's boot poll (`schedule_tick(0)` in init/1) SETTLE before we
    # inject: that poll rebuilds `document_cache` from disk (where "tests/live"
    # does not exist) and would wipe the row below. Once it has settled the next
    # tick is 600s away, so the injected cache survives deterministically.
    wait_until(fn -> :sys.get_state(poller).document_cache_ready end)

    :sys.replace_state(poller, fn state ->
      %{
        state
        | own_host_id: "test-host",
          document_cache_ready: true,
          document_cache: %{uid => %{modified_at: "m1", entry: entry}},
          running:
            Map.put(state.running, uid, %{
              fiber_id: "tests/live",
              uid: uid,
              session: session,
              agent_id: "codex",
              started_at: now,
              last_activity_at: now
            }),
          parked_launches: %{uid => %{fiber_id: "tests/live", uid: uid, parked_at: now}}
      }
    end)

    restore_poller_on_exit(poller, original_state)

    conn = get(api_conn(), "/api/v1/fibers?shuttle=true")
    assert conn.status == 200

    row =
      conn.resp_body
      |> Jason.decode!()
      |> Map.fetch!("fibers")
      |> Enum.find(&(&1["fiber"]["slug"] == "tests/live"))

    assert row, "warm-cache row was not served — the endpoint fell through to the live path"

    # Runtime overlay: already stamped by the cache (not re-applied by the controller).
    assert row["runtime"]["tmux_session"] == session
    assert row["runtime"]["agent"] == "codex"

    # Held overlay: applied by the controller on top of the cached rows.
    assert row["held"] == true
    assert is_integer(row["held_since"])
  end

  test "GET /api/v1/fibers?shuttle=true serves an empty cold-cache feed, never the live path",
       %{store: store} do
    # The poller is up but its document cache is NOT ready (no poll has warmed
    # it). Serve-from-cache-ALWAYS: the endpoint returns a 200 with an empty
    # feed and `cache.state == "cold"` — it must NOT fall through to a live
    # `felt ls` (which would stall on a slow filesystem). The on-disk fiber is
    # therefore ABSENT until the poll warms the cache.
    write_fiber!(store, "tests/cold", """
    ---
    name: Cold fallback
    status: active
    shuttle:
      kind: oneshot
      host: test-host
    ---

    Body.
    """)

    {poller, original_state} = start_or_reuse_poller(store)

    # Wait out the boot poll, THEN force the cache cold — otherwise that poll
    # could settle after our injection and flip `document_cache_ready` back to
    # true. Post-settle, the next tick is 600s away, so cold sticks.
    wait_until(fn -> :sys.get_state(poller).document_cache_ready end)

    :sys.replace_state(poller, fn state ->
      %{state | own_host_id: "test-host", document_cache_ready: false, document_cache: %{}}
    end)

    restore_poller_on_exit(poller, original_state)

    conn = get(api_conn(), "/api/v1/fibers?shuttle=true")
    assert conn.status == 200

    body = Jason.decode!(conn.resp_body)
    assert body["fibers"] == []
    assert body["cache"]["state"] == "cold"
    refute "Cold fallback" in Enum.map(body["fibers"], & &1["fiber"]["name"])

    # A cold feed emits NO etag (cold and warm-empty stamp identical `[]`
    # entries; an etag would let a zero-fiber host 304 forever with state pinned
    # "cold"). The cache block still rides the x-shuttle-cache header.
    assert get_resp_header(conn, "etag") == []
    assert [cache_header] = get_resp_header(conn, "x-shuttle-cache")
    assert Jason.decode!(cache_header)["state"] == "cold"
  end

  test "GET /api/v1/fibers?shuttle=true sets an etag and answers If-None-Match with 304",
       %{store: store} do
    uid = "01KVRTNM000000000000000ET1"

    entry = %{
      felt_store: store,
      path: "tests/etag/etag.md",
      fiber: %{
        "id" => "tests/etag",
        "slug" => "tests/etag",
        "uid" => uid,
        "name" => "Etag fiber",
        "status" => "active",
        "shuttle" => %{"kind" => "oneshot", "host" => "test-host"}
      }
    }

    {poller, original_state} = start_or_reuse_poller(store)
    wait_until(fn -> :sys.get_state(poller).document_cache_ready end)

    :sys.replace_state(poller, fn state ->
      %{
        state
        | own_host_id: "test-host",
          document_cache_ready: true,
          document_cache: %{uid => %{modified_at: "m1", entry: entry}}
      }
    end)

    restore_poller_on_exit(poller, original_state)

    # First fetch: 200 with an etag header.
    conn = get(api_conn(), "/api/v1/fibers?shuttle=true")
    assert conn.status == 200
    assert [etag] = get_resp_header(conn, "etag")
    assert etag != ""

    # Conditional re-fetch with the SAME etag: 304, empty body, etag echoed.
    conn304 =
      api_conn()
      |> put_req_header("if-none-match", etag)
      |> get("/api/v1/fibers?shuttle=true")

    assert conn304.status == 304
    assert conn304.resp_body == ""
    # The 304 (no body) still carries the cache block so the client's
    # refreshed_at/state don't freeze across a run of 304s.
    assert [cache_header] = get_resp_header(conn304, "x-shuttle-cache")
    assert Jason.decode!(cache_header)["state"] == "fresh"

    # A stale etag still gets the full 200 feed.
    conn_stale =
      api_conn()
      |> put_req_header("if-none-match", ~s("deadbeef"))
      |> get("/api/v1/fibers?shuttle=true")

    assert conn_stale.status == 200

    assert [%{"fiber" => %{"slug" => "tests/etag"}}] =
             Jason.decode!(conn_stale.resp_body)["fibers"]
  end

  test "GET /api/v1/fibers?shuttle=true etag changes when the feed content changes",
       %{store: store} do
    uid = "01KVRTNM000000000000000ET2"

    base = %{
      felt_store: store,
      path: "tests/etag2/etag2.md",
      fiber: %{
        "id" => "tests/etag2",
        "slug" => "tests/etag2",
        "uid" => uid,
        "name" => "Before",
        "status" => "active",
        "shuttle" => %{"kind" => "oneshot", "host" => "test-host"}
      }
    }

    {poller, original_state} = start_or_reuse_poller(store)
    wait_until(fn -> :sys.get_state(poller).document_cache_ready end)

    :sys.replace_state(poller, fn state ->
      %{
        state
        | own_host_id: "test-host",
          document_cache_ready: true,
          document_cache: %{uid => %{modified_at: "m1", entry: base}}
      }
    end)

    restore_poller_on_exit(poller, original_state)

    conn1 = get(api_conn(), "/api/v1/fibers?shuttle=true")
    [etag1] = get_resp_header(conn1, "etag")

    changed = put_in(base.fiber["name"], "After")

    :sys.replace_state(poller, fn state ->
      %{state | document_cache: %{uid => %{modified_at: "m2", entry: changed}}}
    end)

    conn2 = get(api_conn(), "/api/v1/fibers?shuttle=true")
    [etag2] = get_resp_header(conn2, "etag")

    assert etag1 != etag2
  end

  test "entries_for_fiber reads report_path from the felt field without stat'ing",
       %{store: store} do
    # The owner-feed build path (:field): a candidate row carrying a non-empty
    # native `report_path` yields an entry with `:report_path` set, even though
    # NO report.html exists on disk — proving the list path trusts the field and
    # never stats. A row WITHOUT the field yields no report_path (again, no stat
    # discovers a non-existent file).
    dir = Path.join([store, ".felt", "tests", "reported"])
    File.mkdir_p!(dir)
    fiber_path = Path.join(dir, "reported.md")

    with_field = %{
      "id" => "tests/reported",
      "name" => "Reported",
      "path" => fiber_path,
      "report_path" => "tests/reported/report.html",
      "shuttle" => %{"host" => "test-host"}
    }

    assert [entry] = Shuttle.FiberDocuments.entries_for_fiber(store, with_field)
    assert entry.report_path == Path.join(dir, "report.html")
    refute File.exists?(entry.report_path)

    without_field = Map.delete(with_field, "report_path")
    assert [bare] = Shuttle.FiberDocuments.entries_for_fiber(store, without_field)
    refute Map.has_key?(bare, :report_path)
  end

  test "GET /api/v1/fibers canonicalizes ids through symlinked stores", %{store: store} do
    # Build the shapepipe shape: loom's `.felt/shapepipe` is a symlink into a
    # separate project store. `felt ls` walks loom and reports the traversal id
    # `shapepipe/review-ngmix`, but the realpath lands in the project store where
    # the slug is `review-ngmix` — which is also how /state keys the runtime.
    # The endpoint must emit the canonical (project-relative) id so the kanban
    # join matches, while keeping `path` store-relative for file access.
    root = Path.dirname(store)
    project = Path.join(root, "shapepipe")

    write_fiber!(project, "review-ngmix", """
    ---
    name: Ngmix review
    status: active
    shuttle:
      enabled: true
      host: test-host
    ---

    Body.
    """)

    File.mkdir_p!(Path.join(store, ".felt"))
    File.ln_s!(Path.join(project, ".felt"), Path.join([store, ".felt", "shapepipe"]))

    conn = get(api_conn(), "/api/v1/fibers")
    assert conn.status == 200

    entry =
      Jason.decode!(conn.resp_body)["fibers"]
      |> Enum.find(&(&1["fiber"]["name"] == "Ngmix review"))

    assert entry["fiber"]["id"] == "review-ngmix"
    assert entry["path"] == "shapepipe/review-ngmix/review-ngmix.md"
    assert entry["felt_store"] == store
  end

  test "GET /api/v1/fibers serves the flat symlinked-substore root (lightcone shape)",
       %{store: store} do
    # The case the old `entry_point`-guessing path-deriver got WRONG. loom's
    # `.felt/lightcone` symlinks into a project store whose ROOT fiber is FLAT —
    # `lightcone.md` directly in `.felt/`, not `lightcone/lightcone.md`. felt's
    # traversal id is `lightcone/lightcone` (served-store prefix), but the file
    # is flat. The old deriver produced `lightcone/lightcone/lightcone.md` (a
    # path that does not exist) and a `report.html` one directory too deep. The
    # leaf shape is now READ from felt's carried path, so both come out right.
    root = Path.dirname(store)
    project = Path.join(root, "lightcone")

    # Flat root fiber: the .md lives directly under the project's .felt/.
    File.mkdir_p!(Path.join(project, ".felt"))

    File.write!(Path.join([project, ".felt", "lightcone.md"]), """
    ---
    name: Lightcone root
    status: active
    shuttle:
      enabled: true
      host: test-host
    ---

    Body.
    """)

    File.write!(Path.join([project, ".felt", "report.html"]), "<p>flat report</p>\n")

    File.mkdir_p!(Path.join(store, ".felt"))
    File.ln_s!(Path.join(project, ".felt"), Path.join([store, ".felt", "lightcone"]))

    conn = get(api_conn(), "/api/v1/fibers")
    assert conn.status == 200

    entry =
      Jason.decode!(conn.resp_body)["fibers"]
      |> Enum.find(&(&1["fiber"]["name"] == "Lightcone root"))

    # Wire path stays served-store-relative and FLAT — the served file at
    # `<store>/.felt/lightcone/lightcone.md` (via the symlink) actually exists.
    assert entry["path"] == "lightcone/lightcone.md"
    assert File.exists?(Path.join([store, ".felt", entry["path"]]))

    # report.html is the sibling of the flat .md in the real project store, NOT
    # one directory deeper. Asserted via the realpath felt carries.
    {realdir, 0} = System.cmd("realpath", [Path.join(project, ".felt")])
    expected_report = Path.join(String.trim(realdir), "report.html")
    assert entry["report_path"] == expected_report
    assert File.exists?(entry["report_path"])
  end

  test "GET /api/v1/fibers survives stray non-fiber .md files in a store", %{store: store} do
    # A store with a SPEC.md (no frontmatter) makes `felt ls` print a stderr
    # warning while still emitting valid JSON on stdout. Folding stderr into
    # stdout used to corrupt the JSON and 500 the whole endpoint.
    write_fiber!(store, "tests/real", """
    ---
    name: Real fiber
    status: active
    ---

    Body.
    """)

    File.write!(Path.join([store, ".felt", "SPEC.md"]), "no frontmatter here\n")

    conn = get(api_conn(), "/api/v1/fibers")
    assert conn.status == 200
    fibers = Jason.decode!(conn.resp_body)["fibers"]
    assert Enum.any?(fibers, &(&1["fiber"]["name"] == "Real fiber"))
  end

  test "GET /api/v1/fibers/:id resolves a single fiber by canonical id (fast path)",
       %{store: store} do
    write_fiber!(store, "tests/single", """
    ---
    name: Single fiber
    status: active
    shuttle:
      enabled: true
      host: test-host
    ---

    Body text.
    """)

    File.write!(Path.join([store, ".felt", "tests", "single", "report.html"]), "<p>report</p>\n")
    report = real_report_path(store, "tests/single")

    conn = get(api_conn(), "/api/v1/fibers/tests/single")

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["host"] == "test-host"

    assert [
             %{
               "felt_store" => ^store,
               "path" => "tests/single/single.md",
               "report_path" => ^report,
               "fiber" => %{"id" => "tests/single", "name" => "Single fiber"}
             }
           ] = body["fibers"]

    # Default omits the body (metadata-only, like the locate path).
    refute Map.has_key?(hd(body["fibers"])["fiber"], "body")
  end

  test "GET /api/v1/fibers emits frontmatter ULID as the logical fiber id", %{store: store} do
    ulid = "01JZ0000000000000000000000"

    write_fiber!(store, "tests/ulid", """
    ---
    id: #{ulid}
    name: ULID fiber
    status: active
    shuttle:
      enabled: true
      host: test-host
    ---

    Body.
    """)

    conn = get(api_conn(), "/api/v1/fibers")
    assert conn.status == 200

    assert [
             %{
               "path" => "tests/ulid/ulid.md",
               "fiber" => %{
                 "id" => ^ulid,
                 "slug" => "tests/ulid",
                 "name" => "ULID fiber"
               }
             }
           ] = Jason.decode!(conn.resp_body)["fibers"]
  end

  test "GET /api/v1/fibers/:id resolves frontmatter ULIDs and migration-era slugs",
       %{store: store} do
    ulid = "01JZ0000000000000000000001"

    write_fiber!(store, "tests/ulid-show", """
    ---
    id: #{ulid}
    name: ULID show
    status: active
    shuttle:
      enabled: true
      host: test-host
    ---

    Body.
    """)

    by_ulid = get(api_conn(), "/api/v1/fibers/#{ulid}")
    assert by_ulid.status == 200

    assert [
             %{
               "path" => "tests/ulid-show/ulid-show.md",
               "fiber" => %{"id" => ^ulid, "slug" => "tests/ulid-show"}
             }
           ] = Jason.decode!(by_ulid.resp_body)["fibers"]

    by_slug = get(api_conn(), "/api/v1/fibers/tests/ulid-show")
    assert by_slug.status == 200

    assert [
             %{
               "path" => "tests/ulid-show/ulid-show.md",
               "fiber" => %{"id" => ^ulid, "slug" => "tests/ulid-show"}
             }
           ] = Jason.decode!(by_slug.resp_body)["fibers"]
  end

  test "GET /api/v1/fibers/:id?body=true includes the felt body alongside full metadata",
       %{store: store} do
    write_fiber!(store, "tests/single-body", """
    ---
    name: Single with body
    status: open
    ---

    The body content.
    """)

    conn = get(api_conn(), "/api/v1/fibers/tests/single-body?body=true")

    assert conn.status == 200

    # body=true returns the COMPLETE fiber — id + name + body — not a body-only
    # stub. `felt show -j` already carries the body, so the fast path resolves
    # the whole fiber and we keep the body rather than re-fetching it.
    assert [
             %{
               "fiber" => %{
                 "id" => "tests/single-body",
                 "name" => "Single with body",
                 "body" => "The body content."
               }
             }
           ] = Jason.decode!(conn.resp_body)["fibers"]
  end

  test "GET /api/v1/fibers/:id?body=true resolves via the show fast path, not the whole-store scan",
       %{store: store} do
    # Regression guard for the body-read stall: the daemon must NOT pass `--body`
    # to `felt show`. That selector returns `{body, body_start_line}` with no
    # `id`, so the fast path can't build an entry and `get/2` falls through to
    # `scan_lookup` — a `felt ls --body` over every store that cost the live
    # endpoint 6-10s while felt itself answered in ~10ms. This fake felt emulates
    # BOTH felt JSON shapes faithfully:
    #
    #   * `show -j` (no --body) → full fiber JSON (id + path + body)  [fast path]
    #   * `show -j --body`      → `{body, body_start_line}`, NO id     [the trap]
    #   * `ls …`                → `[]`                                 [scan = miss]
    #
    # If the `--body` flag is ever reintroduced, the fast path misses, the scan
    # returns nothing, and the endpoint answers an empty fiber list — failing the
    # assertion below. With the correct `felt show -j` call the fiber and its
    # body come back from the first store.
    install_body_read_fake_felt!(store)

    conn = get(api_conn(), "/api/v1/fibers/tests/single-body?body=true")

    assert conn.status == 200

    assert [
             %{
               "fiber" => %{
                 "id" => "tests/single-body",
                 "body" => "The body content."
               }
             }
           ] = Jason.decode!(conn.resp_body)["fibers"]
  end

  test "GET /api/v1/fibers/:id resolves a symlink-traversed fiber via the canonical id (scan fallback)",
       %{store: store} do
    # Mirror the list endpoint's shapepipe case: loom's `.felt/shapepipe` is a
    # symlink into a separate project store. felt's traversal id is
    # `shapepipe/review-ngmix`, but the canonical (project-relative) id is
    # `review-ngmix` — so `felt show review-ngmix` in the loom store misses and
    # the endpoint must fall back to scanning to match the canonical id.
    root = Path.dirname(store)
    project = Path.join(root, "shapepipe")

    write_fiber!(project, "review-ngmix", """
    ---
    name: Ngmix review
    status: active
    shuttle:
      enabled: true
      host: test-host
    ---

    Body.
    """)

    File.mkdir_p!(Path.join(store, ".felt"))
    File.ln_s!(Path.join(project, ".felt"), Path.join([store, ".felt", "shapepipe"]))

    conn = get(api_conn(), "/api/v1/fibers/review-ngmix")
    assert conn.status == 200

    assert [
             %{
               "felt_store" => ^store,
               "path" => "shapepipe/review-ngmix/review-ngmix.md",
               "fiber" => %{"id" => "review-ngmix", "name" => "Ngmix review"}
             }
           ] = Jason.decode!(conn.resp_body)["fibers"]
  end

  test "GET /api/v1/fibers/:id returns an empty fiber list for an unknown id", %{store: store} do
    write_fiber!(store, "tests/present", """
    ---
    name: Present
    status: active
    ---

    Body.
    """)

    conn = get(api_conn(), "/api/v1/fibers/tests/absent")
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["fibers"] == []
  end

  test "GET /api/v1/fibers/composite stamps origin and reports the local origin (no remotes)",
       %{store: store} do
    write_fiber!(store, "tests/managed", """
    ---
    name: Managed
    status: active
    shuttle:
      kind: oneshot
      host: test-host
    ---

    Body.
    """)

    warm_poller!(store)
    conn = get(api_conn(), "/api/v1/fibers/composite")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert body["host"] == "test-host"

    # Only this daemon's owned shuttle row, stamped with its origin.
    assert [%{"fiber" => %{"name" => "Managed"}, "origin" => "test-host"}] = body["fibers"]

    # The local origin is reported (kind: local); no remotes configured.
    assert body["origins"]["test-host"]["kind"] == "local"
    assert body["origins"]["test-host"]["stale"] == false
    assert body["origins"]["test-host"]["fiber_count"] == 1
    assert Map.keys(body["origins"]) == ["test-host"]
  end

  test "GET /api/v1/fibers/composite concatenates the local feed with a cached remote feed",
       %{store: store} do
    write_fiber!(store, "tests/managed", """
    ---
    name: Managed
    status: active
    shuttle:
      kind: oneshot
      host: test-host
    ---

    Body.
    """)

    remote = %Remote{name: "candide", url: "http://localhost:4001"}

    remote_body =
      Jason.encode!(%{
        "host" => "candide",
        "fibers" => [
          %{
            "felt_store" => "/loom",
            "path" => "tests/remote/remote.md",
            "fiber" => %{"id" => "tests/remote", "name" => "Remote work", "status" => "active"},
            "runtime" => %{"tmux_session" => "shuttle-remote"}
          }
        ]
      })

    start_supervised!(StubFiberClient)
    StubFiberClient.set(Remote.fibers_url(remote), {:ok, remote_body})

    # Start the registry under its DEFAULT name so the controller's feeds/0
    # call (which targets Shuttle.RemoteFiberRegistry) sees it.
    start_supervised!(
      # store_dir: nil — this stub feed must not reach the real
      # `~/.shuttle/remote-fibers` store and outlive the test.
      {RemoteFiberRegistry,
       remotes: [remote], client: StubFiberClient, auto_poll: false, store_dir: nil}
    )

    :ok = RemoteFiberRegistry.refresh_now()

    warm_poller!(store)
    conn = get(api_conn(), "/api/v1/fibers/composite")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    by_origin = Map.new(body["fibers"], &{&1["origin"], &1})

    assert by_origin["test-host"]["fiber"]["name"] == "Managed"
    assert by_origin["candide"]["fiber"]["name"] == "Remote work"
    # Remote liveness rides the owner-stamped runtime on the feed row.
    assert by_origin["candide"]["runtime"]["tmux_session"] == "shuttle-remote"

    assert body["origins"]["test-host"]["kind"] == "local"
    assert body["origins"]["candide"]["kind"] == "remote"
    assert body["origins"]["candide"]["stale"] == false
    assert body["origins"]["candide"]["fiber_count"] == 1
  end

  test "GET /api/v1/fibers/composite carries owned shuttle work plus human due cards, deduped",
       %{store: store} do
    write_fiber!(store, "tests/managed", """
    ---
    name: Managed
    status: active
    shuttle:
      kind: oneshot
      host: test-host
    ---

    Body.
    """)

    write_fiber!(store, "tests/human-todo", """
    ---
    name: Human todo
    status: open
    due: 2026-12-01
    ---

    Body.
    """)

    write_fiber!(store, "tests/owner-due", """
    ---
    name: Owner with due
    status: active
    due: 2026-11-01
    shuttle:
      kind: oneshot
      host: test-host
    ---

    Body.
    """)

    warm_poller!(store)
    conn = get(api_conn(), "/api/v1/fibers/composite")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    # "Human todo" carries a `due:` and NO shuttle block. It rides the
    # `--has-field due` walk — the one `shouldIncludeInKanban` always claimed
    # existed and, until this walk was built, did not. Without it the Week's ◴
    # marks and the drift machinery never saw a human's own deadlines.
    names = body["fibers"] |> Enum.map(& &1["fiber"]["name"]) |> Enum.sort()
    assert names == ["Human todo", "Managed", "Owner with due"]

    assert Enum.all?(body["fibers"], &(&1["origin"] == "test-host"))

    # "Owner with due" matches BOTH the shuttle walk and the due walk; the union
    # is deduped by fiber id, so it appears exactly once.
    assert Enum.count(body["fibers"], &(&1["fiber"]["name"] == "Owner with due")) == 1
    assert body["origins"]["test-host"]["fiber_count"] == 3

    only = get(api_conn(), "/api/v1/fibers?shuttle=true")

    owner_names =
      Jason.decode!(only.resp_body)["fibers"] |> Enum.map(& &1["fiber"]["name"]) |> Enum.sort()

    assert owner_names == ["Human todo", "Managed", "Owner with due"]
  end

  test "GET /api/v1/fibers?shuttle=true admits cycles with start, and dedupes a triple match",
       %{store: store} do
    # A cycle carries neither a shuttle block nor a host — it is a band on the
    # calendar, not dispatchable work — so it reaches the board only via the
    # `-t cycle` walk, and it renders only if `start` survives the kanban
    # projection.
    write_fiber!(store, "tests/cycle-autumn", """
    ---
    name: Autumn cycle
    status: open
    tags: [cycle]
    start: 2026-09-01
    due: 2026-11-30
    ---

    Body.
    """)

    # shuttle block + due + cycle tag: matched by all three walks, served once.
    write_fiber!(store, "tests/triple", """
    ---
    name: Triple match
    status: active
    tags: [cycle]
    start: 2026-09-01
    shuttle:
      kind: oneshot
      host: test-host
    ---

    Body.
    """)

    warm_poller!(store)
    conn = get(api_conn(), "/api/v1/fibers?shuttle=true")
    assert conn.status == 200

    fibers = Jason.decode!(conn.resp_body)["fibers"]
    cycle = Enum.find(fibers, &(&1["fiber"]["name"] == "Autumn cycle"))

    assert cycle, "cycle fiber was not admitted to the owner feed"
    assert "cycle" in cycle["fiber"]["tags"]

    # It carries a due AND the cycle tag, so BOTH aux walks return it. The union
    # dedupes across aux walks, not just against the shuttle walk.
    assert Enum.count(fibers, &(&1["fiber"]["name"] == "Autumn cycle")) == 1

    # felt normalizes a bare `YYYY-MM-DD` to a full instant on the way out —
    # `due` has always arrived this way, and `start` matches it. Pinned here so
    # the client knows which shape to parse.
    assert cycle["fiber"]["start"] == "2026-09-01T00:00:00Z"
    assert cycle["fiber"]["due"] == "2026-11-30T00:00:00Z"

    assert Enum.count(fibers, &(&1["fiber"]["name"] == "Triple match")) == 1
  end

  test "GET /api/v1/fibers?shuttle=true dedupes overlapping configured stores", %{store: store} do
    root = Path.dirname(store)
    project = Path.join(root, "felt-project")

    write_fiber!(project, "debug", """
    ---
    id: 01KVTXJ3VQYNZ6TYK342ZHV5CK
    name: felt debug
    status: open
    shuttle:
      kind: pinned
      host: test-host
    ---

    Body.
    """)

    File.mkdir_p!(Path.join(store, ".felt"))
    File.ln_s!(Path.join(project, ".felt"), Path.join([store, ".felt", "felt-project"]))
    System.put_env("FELT_STORES", Enum.join([store, project], ","))

    warm_poller!(store)
    conn = get(api_conn(), "/api/v1/fibers?shuttle=true")
    assert conn.status == 200

    assert [
             %{
               "fiber" => %{
                 "name" => "felt debug",
                 "uid" => "01KVTXJ3VQYNZ6TYK342ZHV5CK"
               }
             }
           ] = Jason.decode!(conn.resp_body)["fibers"]
  end

  # A fake `felt` on PATH that mimics the felt JSON shapes the body-read path can
  # hit. Faithful emulation is the point: `felt show -j` carries id + path + body;
  # `felt show -j --body` is the minimal, id-less editing selector; `felt ls` is
  # the (here empty) whole-store scan. Lets a controller test distinguish the
  # fast path from the scan fallback by RESULT alone, no timing. `$(pwd)` (not
  # `$PWD`, which `cd:` leaves stale) gives felt's per-call working store.
  defp install_body_read_fake_felt!(store) do
    bin_dir = Path.join(Path.dirname(store), "fake-bin")
    File.mkdir_p!(bin_dir)
    bin = Path.join(bin_dir, "felt")

    # Branch on the SUBCOMMAND ($1) first so `ls --body` (the scan) and
    # `show --body` (the trap) don't collide — both carry `--body`, only the
    # subcommand tells them apart, exactly as real felt distinguishes them.
    File.write!(bin, """
    #!/bin/sh
    case "$1" in
      ls)
        # The whole-store scan. Deliberately empty: if get/2 wrongly falls
        # through to scan_lookup, it finds nothing here and the test fails.
        printf '[]\\n'
        ;;
      show)
        case " $* " in
          *" --body "*)
            # felt's --body selector: body + start line ONLY, no id (the trap).
            printf '{"body":"The body content.","body_start_line":7}\\n'
            ;;
          *)
            # felt show -j: the full fiber JSON, body included.
            dir=$(pwd)
            printf '{"id":"tests/single-body","name":"Single with body","status":"open","path":"%s/.felt/tests/single-body/single-body.md","body":"The body content."}\\n' "$dir"
            ;;
        esac
        ;;
      *)
        printf '\\n'
        ;;
    esac
    """)

    File.chmod!(bin, 0o755)

    old_path = System.get_env("PATH")
    System.put_env("PATH", bin_dir <> ":" <> (old_path || ""))
    on_exit(fn -> restore_env("PATH", old_path) end)
  end

  describe "GET /api/v1/fibers/:id owner-routing" do
    test "a remote-owned fiber's body is fetched FROM the owning daemon, not locally" do
      # The fiber does NOT exist in this daemon's local store; only owner-routing
      # over the tunnel can produce its body. This is the analysis-advance bug:
      # without forwarding, the read came back empty and blamed "not in the local
      # mirror" — relying on git sync that must never be load-bearing.
      stub_forward(
        "cineca",
        "http://localhost:4002",
        {:ok, 200, "application/json; charset=utf-8",
         ~s({"fibers":[{"fiber":{"id":"science/cmbx/explorations/analysis-advance","body":"REMOTE BODY"}}]})}
      )

      conn =
        get(
          api_conn(),
          "/api/v1/fibers/science%2Fcmbx%2Fexplorations%2Fanalysis-advance?body=true&origin=cineca"
        )

      assert conn.status == 200
      assert %{"fibers" => [%{"fiber" => %{"body" => "REMOTE BODY"}}]} = json_response(conn, 200)

      # origin stripped; id re-encoded onto the owner's identical path; body=true
      # preserved; routed=1 added (every forward carries it now, whether it
      # started as an `origin=` request or a local self-route) so the owner's
      # own local read never bounces this back a second hop.
      last = StubGetFileClient.last()

      assert URI.parse(last.url).path ==
               "/api/v1/fibers/science/cmbx/explorations/analysis-advance"

      assert URI.parse(last.url).query |> URI.decode_query() == %{
               "body" => "true",
               "routed" => "1"
             }
    end

    test "relays the remote status verbatim and 502s on tunnel failure" do
      stub_forward("cineca", "http://localhost:4002", {:error, :econnrefused})

      conn =
        get(api_conn(), "/api/v1/fibers/science%2Fcmbx%2Fx?body=true&origin=cineca")

      assert conn.status == 502
      assert %{"error" => _} = json_response(conn, 502)
    end

    test "a local git mirror of a remote-owned fiber is not served — no origin param still forwards to the owner",
         %{store: store} do
      # A `[[wikilink]]` opens a fiber the board never carded, so the panel has
      # no composite row to read an origin off and the request arrives with no
      # `origin` at all. Serving this daemon's git copy here would repeat the
      # feed's `5669fc7` mistake, worse: the panel then routes its SAVES by the
      # origin this envelope reports. The local read must see `shuttle.host`
      # naming cineca and forward there instead of answering from what it has
      # on disk.
      write_fiber!(store, "science/cmbx/pinned", """
      ---
      name: Pinned to cineca
      status: active
      shuttle:
        host: cineca
      ---

      LOCAL MIRROR — must never be served.
      """)

      stub_forward(
        "cineca",
        "http://localhost:4002",
        {:ok, 200, "application/json; charset=utf-8",
         ~s({"fibers":[{"fiber":{"id":"science/cmbx/pinned","body":"REMOTE BODY"}}]})}
      )

      conn = get(api_conn(), "/api/v1/fibers/science%2Fcmbx%2Fpinned?body=true")

      assert conn.status == 200
      assert %{"fibers" => [%{"fiber" => %{"body" => "REMOTE BODY"}}]} = json_response(conn, 200)

      last = StubGetFileClient.last()
      assert last, "the local hit never forwarded to the owning remote"
      assert URI.parse(last.url).path == "/api/v1/fibers/science/cmbx/pinned"

      # order-insensitive: OriginRouter builds this query from a map.
      assert URI.parse(last.url).query |> URI.decode_query() == %{
               "body" => "true",
               "routed" => "1"
             }
    end

    test "routed=1 stops the forwarded request from bouncing back to the owner a second time",
         %{store: store} do
      # Two daemons whose git copies disagree about `host:` must not bounce a
      # request between them forever. The owner's own local read carries
      # `routed=1` on the way in (stamped by the forward above) and must answer
      # from ITS local copy without re-deriving an owner and forwarding again.
      write_fiber!(store, "science/cmbx/pinned-routed", """
      ---
      name: Pinned to cineca
      status: active
      shuttle:
        host: cineca
      ---

      LOCAL MIRROR.
      """)

      stub_forward(
        "cineca",
        "http://localhost:4002",
        {:ok, 200, "application/json; charset=utf-8", ~s({"fibers":[]})}
      )

      conn =
        get(api_conn(), "/api/v1/fibers/science%2Fcmbx%2Fpinned-routed?body=true&routed=1")

      assert conn.status == 200

      assert %{"fibers" => [%{"fiber" => %{"name" => "Pinned to cineca", "body" => body}}]} =
               json_response(conn, 200)

      assert body =~ "LOCAL MIRROR"
      assert StubGetFileClient.last() == nil, "routed=1 must not trigger a second hop"
    end

    test "a fiber this daemon owns is served from the local mirror, never forwarded to itself",
         %{store: store} do
      write_fiber!(store, "tests/self-owned", """
      ---
      name: Self owned
      status: active
      shuttle:
        host: test-host
      ---

      Body text.
      """)

      # A configured remote in play at all (cineca) must not matter: the
      # `shuttle.host` here IS this daemon's own id, so `entry_owner/1` must
      # bail out before ever consulting `OriginRouter.route/1`.
      stub_forward(
        "cineca",
        "http://localhost:4002",
        {:ok, 200, "application/json; charset=utf-8", ~s({"fibers":[]})}
      )

      conn = get(api_conn(), "/api/v1/fibers/tests/self-owned?body=true")

      assert conn.status == 200
      assert %{"fibers" => [%{"fiber" => %{"body" => "Body text."}}]} = json_response(conn, 200)
      assert StubGetFileClient.last() == nil
    end

    test "an ownerless fiber — no shuttle block, or a shuttle block with no host: — is served locally",
         %{store: store} do
      write_fiber!(store, "tests/no-shuttle", """
      ---
      name: No shuttle block
      status: active
      ---

      Body one.
      """)

      write_fiber!(store, "tests/host-less-shuttle", """
      ---
      name: Host-less shuttle block
      status: active
      shuttle:
        kind: oneshot
      ---

      Body two.
      """)

      stub_forward(
        "cineca",
        "http://localhost:4002",
        {:ok, 200, "application/json; charset=utf-8", ~s({"fibers":[]})}
      )

      no_block = get(api_conn(), "/api/v1/fibers/tests/no-shuttle?body=true")

      assert %{"fibers" => [%{"fiber" => %{"body" => "Body one."}}]} =
               json_response(no_block, 200)

      no_host = get(api_conn(), "/api/v1/fibers/tests/host-less-shuttle?body=true")
      assert %{"fibers" => [%{"fiber" => %{"body" => "Body two."}}]} = json_response(no_host, 200)

      assert StubGetFileClient.last() == nil
    end

    test "a shuttle.host naming no configured remote degrades to the local mirror rather than a dead end",
         %{store: store} do
      # `OriginRouter.route/1`'s documented degrade: an orphaned host (renamed
      # or dropped from `:remotes` since this fiber was pinned) is better
      # served by the mirror than by nothing, since no daemon in the fleet
      # claims it.
      write_fiber!(store, "tests/orphan-host", """
      ---
      name: Orphaned host pin
      status: active
      shuttle:
        host: c03
      ---

      Only copy anyone has.
      """)

      stub_forward(
        "cineca",
        "http://localhost:4002",
        {:ok, 200, "application/json; charset=utf-8", ~s({"fibers":[]})}
      )

      conn = get(api_conn(), "/api/v1/fibers/tests/orphan-host?body=true")

      assert conn.status == 200

      assert %{"fibers" => [%{"fiber" => %{"body" => "Only copy anyone has."}}]} =
               json_response(conn, 200)

      assert StubGetFileClient.last() == nil,
             "an unconfigured host: pin should never attempt a forward"
    end
  end

  defp stub_forward(remote_name, remote_url, response) do
    start_supervised!(StubGetFileClient)
    StubGetFileClient.set_response(response)

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: remote_name, url: remote_url}])
    Application.put_env(:shuttle, :write_forward_client, StubGetFileClient)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)
  end

  # Start a Poller under its default name (so the controller's calls reach it),
  # or reuse a running one — returning the original state to restore on exit.
  defp start_or_reuse_poller(store) do
    case Process.whereis(Shuttle.Poller) do
      nil ->
        {:ok, pid} =
          Shuttle.Poller.start_link(
            name: Shuttle.Poller,
            poll_interval_ms: 600_000,
            max_concurrent_workers: 0,
            felt_stores: [store]
          )

        {pid, nil}

      pid ->
        {pid, :sys.get_state(pid)}
    end
  end

  # Start (or reuse) the singleton Poller, force a real poll against this test's
  # configured stores, and block until its document cache is warm. The owner
  # feed (`?shuttle=true`) and the composite board are now served ALWAYS from
  # this cache — there is no live `felt ls` fallback — so a test that expects
  # on-disk shuttle fibers to appear must warm the cache first. Returns the pid.
  defp warm_poller!(store) do
    stores =
      case System.get_env("FELT_STORES") do
        nil -> [store]
        "" -> [store]
        value -> String.split(value, ",", trim: true)
      end

    {poller, original_state} = start_or_reuse_poller(store)

    :sys.replace_state(poller, fn state ->
      %{
        state
        | felt_stores: stores,
          own_host_id: "test-host",
          document_cache_ready: false,
          document_cache: %{}
      }
    end)

    send(poller, :run_poll_cycle)

    wait_until(fn ->
      state = :sys.get_state(poller)
      state.document_cache_ready and map_size(state.document_cache) > 0
    end)

    restore_poller_on_exit(poller, original_state)
    poller
  end

  # Block until `fun` returns truthy, polling briefly (default ≤2s). Used to let
  # a freshly started Poller's boot poll settle before injecting state.
  defp wait_until(fun, tries \\ 200) do
    cond do
      fun.() ->
        :ok

      tries <= 0 ->
        flunk("wait_until: condition never became true")

      true ->
        Process.sleep(10)
        wait_until(fun, tries - 1)
    end
  end

  defp restore_poller_on_exit(poller, original_state) do
    on_exit(fn ->
      if Process.alive?(poller) do
        if original_state do
          :sys.replace_state(poller, fn _ -> original_state end)
        else
          GenServer.stop(poller)
        end
      end
    end)
  end

  defp write_fiber!(store, fiber_id, content) do
    segments = String.split(fiber_id, "/")
    basename = List.last(segments)
    dir = Path.join([store, ".felt" | segments])
    File.mkdir_p!(dir)
    File.write!(Path.join(dir, "#{basename}.md"), content)
  end

  # The report_path the endpoint emits: `dirname(felt.path)/report.html`, where
  # felt's `path` is symlink-canonicalized. Mirror that by realpath'ing the
  # report file's directory so the assertion is robust to macOS's /var symlink.
  defp real_report_path(store, fiber_id) do
    Path.join(real_fiber_dir(store, fiber_id), "report.html")
  end

  # The `dir` the endpoint emits: `dirname(felt.path)`, symlink-canonicalized.
  # Mirror it by realpath'ing the fiber's directory so the assertion survives
  # macOS's /var → /private/var symlink.
  defp real_fiber_dir(store, fiber_id) do
    segments = String.split(fiber_id, "/")
    dir = Path.join([store, ".felt" | segments])
    {realdir, 0} = System.cmd("realpath", [dir])
    String.trim(realdir)
  end

  defp api_conn do
    build_conn()
    |> put_req_header("content-type", "application/json")
    |> put_req_header("accept", "application/json")
  end
end
