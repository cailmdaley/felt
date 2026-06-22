defmodule ShuttleWeb.FiberDocumentsControllerTest do
  use ExUnit.Case
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

  # GET transport stub for the owner-routed `show` forward (forward_get →
  # get_file). Records the URL it was asked to fetch and replays a scripted
  # response, so the cross-host body read runs without a real tunnel.
  defmodule StubGetFileClient do
    use Agent

    def start_link(_ \\ []),
      do: Agent.start_link(fn -> %{response: nil, last: nil} end, name: __MODULE__)

    def set_response(response), do: Agent.update(__MODULE__, &Map.put(&1, :response, response))
    def last, do: Agent.get(__MODULE__, & &1.last)

    def get_file(url, _timeout_ms) do
      Agent.update(__MODULE__, &Map.put(&1, :last, %{url: url}))
      Agent.get(__MODULE__, & &1.response)
    end
  end

  setup do
    root =
      Path.join(
        System.tmp_dir!(),
        "shuttle-fiber-documents-controller-#{System.unique_integer([:positive])}"
      )

    store = Path.join(root, "loom")
    File.mkdir_p!(store)

    old_loom_homes = System.get_env("LOOM_HOMES")
    old_shuttle_host = System.get_env("SHUTTLE_HOST")

    System.put_env("LOOM_HOMES", store)
    System.put_env("SHUTTLE_HOST", "test-host")

    on_exit(fn ->
      restore_env("LOOM_HOMES", old_loom_homes)
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

    File.write!(Path.join([store, ".felt", "tests", "document", "report.html"]), "<p>report</p>\n")

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

    assert all_names == ["Managed", "Owned elsewhere", "Plain todo", "Unowned draft"]

    # shuttle=true: ONLY the row this daemon owns (shuttle block + host == own).
    only = get(api_conn(), "/api/v1/fibers?shuttle=true")
    assert only.status == 200
    assert [%{"fiber" => %{"name" => "Managed"}}] = Jason.decode!(only.resp_body)["fibers"]
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
      {RemoteFiberRegistry, remotes: [remote], client: StubFiberClient, auto_poll: false}
    )

    :ok = RemoteFiberRegistry.refresh_now()

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

  test "GET /api/v1/fibers/composite includes local human due-date cards the owner feed omits",
       %{store: store} do
    # Owner shuttle work — in both the owner feed and the composite.
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

    # A human-tracked todo: open + due, NO shuttle block. The owner feed
    # (`?shuttle=true`) drops it; the composite board must re-include it.
    write_fiber!(store, "tests/human-todo", """
    ---
    name: Human todo
    status: open
    due: 2026-12-01
    ---

    Body.
    """)

    # A shuttle fiber that ALSO carries a due: must appear exactly once (owner
    # feed), never double-counted into the human-due path.
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

    # A closed due card is off the board — status gates before due.
    write_fiber!(store, "tests/done-todo", """
    ---
    name: Done todo
    status: closed
    due: 2026-01-01
    ---

    Body.
    """)

    conn = get(api_conn(), "/api/v1/fibers/composite")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    names = body["fibers"] |> Enum.map(& &1["fiber"]["name"]) |> Enum.sort()
    assert names == ["Human todo", "Managed", "Owner with due"]

    # Every local row — owner and human-due alike — is stamped the local origin.
    assert Enum.all?(body["fibers"], &(&1["origin"] == "test-host"))

    # The shuttle+due fiber is present exactly once (no double-count).
    assert Enum.count(body["fibers"], &(&1["fiber"]["name"] == "Owner with due")) == 1

    # fiber_count reflects owner + human-due together.
    assert body["origins"]["test-host"]["fiber_count"] == 3

    # The owner feed itself stays strictly owner-only — the human todo never
    # leaks into `?shuttle=true`.
    only = get(api_conn(), "/api/v1/fibers?shuttle=true")
    owner_names = Jason.decode!(only.resp_body)["fibers"] |> Enum.map(& &1["fiber"]["name"]) |> Enum.sort()
    assert owner_names == ["Managed", "Owner with due"]
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

      # origin stripped; id re-encoded onto the owner's identical path; body=true preserved.
      assert StubGetFileClient.last().url ==
               "http://localhost:4002/api/v1/fibers/science/cmbx/explorations/analysis-advance?body=true"
    end

    test "relays the remote status verbatim and 502s on tunnel failure" do
      stub_forward("cineca", "http://localhost:4002", {:error, :econnrefused})

      conn =
        get(api_conn(), "/api/v1/fibers/science%2Fcmbx%2Fx?body=true&origin=cineca")

      assert conn.status == 502
      assert %{"error" => _} = json_response(conn, 502)
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

  defp restore_app_env(key, nil), do: Application.delete_env(:shuttle, key)
  defp restore_app_env(key, value), do: Application.put_env(:shuttle, key, value)

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

  defp restore_env(key, nil), do: System.delete_env(key)
  defp restore_env(key, value), do: System.put_env(key, value)
end
