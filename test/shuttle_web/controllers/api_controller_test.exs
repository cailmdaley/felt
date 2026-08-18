defmodule ShuttleWeb.APIControllerTest do
  @moduledoc """
  Tests for the Stage 5 Agent-API REST endpoints.
  """

  use ExUnit.Case
  import Shuttle.Test.EnvHelpers
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  alias Shuttle.Poller
  alias Shuttle.Dispatcher
  alias Shuttle.Test.FeltStoreRunner, as: MockRunner

  # POST transport stub for the cross-host /transition forward test. Records the
  # last (url, body) it was asked to POST and replays a scripted response, so the
  # forward leg is exercised without a real tunnel. Implements `post/4` only —
  # the read `get/2` callback isn't needed here, so it doesn't declare the
  # behaviour (which would warn about the missing required `get/2`).
  defmodule StubPostClient do
    use Agent

    def start_link(_ \\ []),
      do:
        Agent.start_link(
          fn -> %{response: nil, get_response: {:error, :not_set}, last: nil, last_get: nil} end,
          name: __MODULE__
        )

    def set_response(response), do: Agent.update(__MODULE__, &Map.put(&1, :response, response))

    def set_get_response(response),
      do: Agent.update(__MODULE__, &Map.put(&1, :get_response, response))

    def last, do: Agent.get(__MODULE__, & &1.last)
    def last_get, do: Agent.get(__MODULE__, & &1.last_get)

    def get(url, _timeout_ms) do
      Agent.update(__MODULE__, &Map.put(&1, :last_get, %{url: url}))
      Agent.get(__MODULE__, & &1.get_response)
    end

    def post(url, body, _content_type, _timeout_ms) do
      Agent.update(__MODULE__, &Map.put(&1, :last, %{url: url, body: body}))
      Agent.get(__MODULE__, & &1.response)
    end
  end

  # ── Setup ──

  setup do
    previous_action_runner = Application.get_env(:shuttle, :action_query_runner)
    Application.put_env(:shuttle, :action_query_runner, MockRunner)

    on_exit(fn ->
      restore_app_env(:action_query_runner, previous_action_runner)
    end)

    start_supervised!(MockRunner)
    MockRunner.reset()
    mock_felt_root = MockRunner.felt_root()
    on_exit(fn -> File.rm_rf(mock_felt_root) end)

    start_supervised!(
      {Poller,
       runner: MockRunner, poll_interval_ms: 600_000, felt_stores: [MockRunner.felt_root()]}
    )

    Process.sleep(50)
    :ok
  end

  # Minimal shuttle: block YAML for a oneshot fiber ready for dispatch.
  @oneshot_shuttle "enabled: true\nkind: oneshot\n"

  defp api_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  defp make_fiber(id, attrs \\ %{}) do
    Map.merge(
      %{
        "id" => id,
        "name" => id,
        "status" => "active",
        "tags" => ["constitution"],
        "created_at" => "2026-04-28T00:00:00Z"
      },
      attrs
    )
  end

  defp with_actions_host do
    previous = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", MockRunner.felt_root())

    on_exit(fn ->
      case previous do
        nil -> System.delete_env("FELT_STORES")
        value -> System.put_env("FELT_STORES", value)
      end
    end)
  end

  test "GET /api/v1/agents degrades to []/200 when felt's agents verb is unavailable" do
    # The registry is felt-owned now: the controller shells `felt shuttle agents
    # --json` through Shuttle.Felt.run. Route that shell-out at MockRunner (the
    # `:felt_runner` seam), whose fall-through returns `{"", 0}` — felt emitted
    # nothing parseable as a JSON array, the "verb absent / old felt" shape. The
    # controller must degrade to an empty list with 200 (the board's picker falls
    # back to free-text), never crash the request. Without the seam this asserted
    # `== []` only on a box where felt happened to be absent — a real felt on PATH
    # returned the live registry and the test flapped.
    previous_felt_runner = Application.get_env(:shuttle, :felt_runner)
    Application.put_env(:shuttle, :felt_runner, MockRunner)
    on_exit(fn -> restore_app_env(:felt_runner, previous_felt_runner) end)

    conn = get(api_conn(), "/api/v1/agents")
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == []
  end

  # ── POST /api/v1/dispatch ──

  test "dispatches a fiber via API" do
    fiber = make_fiber("tests/api-dispatch")
    MockRunner.set_fiber("tests/api-dispatch", fiber)
    MockRunner.set_shuttle("tests/api-dispatch", @oneshot_shuttle)

    conn =
      post(
        api_conn(),
        "/api/v1/dispatch",
        Jason.encode!(%{"fiber_id" => "tests/api-dispatch"})
      )

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["dispatched"] == true
    assert body["fiber_id"] == "tests/api-dispatch"
    assert body["tmux_session"] == Dispatcher.session_name("tests/api-dispatch")
  end

  test "dispatch returns 409 for already running fiber" do
    fiber = make_fiber("tests/api-dispatch-2")
    MockRunner.set_fiber("tests/api-dispatch-2", fiber)
    MockRunner.add_tmux_session(Dispatcher.session_name("tests/api-dispatch-2"))

    conn =
      post(
        api_conn(),
        "/api/v1/dispatch",
        Jason.encode!(%{
          "fiber_id" => "tests/api-dispatch-2"
        })
      )

    assert conn.status == 409
    body = Jason.decode!(conn.resp_body)
    assert body["dispatched"] == false
    assert body["reason"] == "already_running"
  end

  test "dispatch 409 includes the live tmux session when the poller tracks it" do
    fiber_id = "tests/api-dispatch-live"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    assert {:ok, session} = Poller.dispatch_fiber(fiber_id, [])

    conn =
      post(
        api_conn(),
        "/api/v1/dispatch",
        Jason.encode!(%{
          "fiber_id" => fiber_id
        })
      )

    assert conn.status == 409
    body = Jason.decode!(conn.resp_body)
    assert body["dispatched"] == false
    assert body["reason"] == "already_running"
    assert body["tmux_session"] == session
  end

  test "dispatch clears stale in-memory running state when tmux session is gone" do
    fiber_id = "tests/api-stale-running"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    assert {:ok, session} = Poller.dispatch_fiber(fiber_id, [])
    MockRunner.remove_tmux_session(session)

    conn =
      post(
        api_conn(),
        "/api/v1/dispatch",
        Jason.encode!(%{
          "fiber_id" => fiber_id
        })
      )

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["dispatched"] == true
    assert body["fiber_id"] == fiber_id
    assert body["tmux_session"] == session
  end

  test "dispatch returns 200 for slow successful dispatches past the default call timeout" do
    fiber_id = "tests/api-slow-dispatch"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)
    MockRunner.set_new_session_delay(5_250)

    started_at_ms = System.monotonic_time(:millisecond)

    conn =
      post(
        api_conn(),
        "/api/v1/dispatch",
        Jason.encode!(%{
          "fiber_id" => fiber_id
        })
      )

    elapsed_ms = System.monotonic_time(:millisecond) - started_at_ms

    assert elapsed_ms >= 5_000
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["dispatched"] == true
    assert body["fiber_id"] == fiber_id
    assert body["tmux_session"] == Dispatcher.session_name(fiber_id)
  end

  test "dispatch returns 400 without fiber_id" do
    conn = post(api_conn(), "/api/v1/dispatch", Jason.encode!(%{}))
    assert conn.status == 400
    body = Jason.decode!(conn.resp_body)
    assert body["error"] == "fiber_id is required"
  end

  test "HTTP ad-hoc dispatch of an awaiting standing role re-arms and runs (no longer 422)" do
    # Awaiting is felt-native (slice 5): status:closed + untempered. The HTTP
    # /dispatch path folds ad_hoc into force (`force: force or ad_hoc`), so an
    # explicit dispatch IS the human verdict: it bypasses the awaiting gate,
    # re-arms the doc, and spawns — instead of the old 422 that told the user to
    # `felt shuttle accept/resume` first.
    fiber_id = "tests/api-awaiting-refuses-adhoc"

    fiber =
      make_fiber(fiber_id, %{
        "status" => "closed",
        "closed-at" => "2026-05-24T10:00:00Z",
        "tags" => ["constitution", "standing"]
      })

    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      """,
      "closed"
    )

    conn =
      post(
        api_conn(),
        "/api/v1/dispatch",
        Jason.encode!(%{
          "fiber_id" => fiber_id,
          "ad_hoc" => true
        })
      )

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["dispatched"] == true
    assert body["fiber_id"] == fiber_id
  end

  # ── POST /api/v1/transition ──

  # The unified write-plane: one call resolves the kanban target to an action
  # AND invokes it (no separate resolve leg). A closed oneshot dragged to the
  # tempered column resolves to close-tempered and shells the offline writer —
  # threading --felt-store through the extracted Transition pipeline.
  @tag :capture_log
  test "transition resolves the target and invokes in one call (local)" do
    with_actions_host()

    MockRunner.set_shuttle(
      "tests/transition-local",
      "enabled: true\nkind: oneshot\nreview:\n  state: awaiting\n",
      "closed"
    )

    stub_dir =
      Path.join(
        System.tmp_dir!(),
        "shuttle-transition-stub-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(stub_dir)
    argv_log = Path.join(stub_dir, "argv.log")
    real_felt = System.find_executable("felt") || "felt"

    # The transition pipeline shells the real felt to resolve the store/target,
    # THEN shells `felt shuttle <verb>` for the write. Capture only the `shuttle`
    # subcommand (logging its verb + flags, the `shuttle` prefix dropped) and
    # delegate everything else to the real felt — so resolution still works and
    # the log holds just the write's argv.
    File.write!(Path.join(stub_dir, "felt"), """
    #!/usr/bin/env bash
    if [ "$1" = shuttle ]; then
      printf '%s\\n' "${@:2}" >> "#{argv_log}"
      exit 0
    fi
    exec "#{real_felt}" "$@"
    """)

    File.chmod!(Path.join(stub_dir, "felt"), 0o755)

    previous_path = System.get_env("PATH")
    System.put_env("PATH", "#{stub_dir}:#{previous_path}")

    on_exit(fn ->
      if previous_path, do: System.put_env("PATH", previous_path), else: System.delete_env("PATH")
      File.rm_rf!(stub_dir)
    end)

    conn =
      post(
        api_conn(),
        "/api/v1/transition",
        Jason.encode!(%{fiber_id: "tests/transition-local", target: "tempered"})
      )

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["invoked"] == true
    assert body["action"] == "close-tempered"
    assert body["target"] == "tempered"

    captured = argv_log |> File.read!() |> String.split("\n", trim: true)
    assert Enum.take(captured, 2) == ["--felt-store", MockRunner.felt_root()]
    assert "close" in captured
    assert "--tempered=true" in captured
  end

  test "transition for an unknown target returns 400" do
    with_actions_host()
    MockRunner.set_shuttle("tests/transition-bad-target", @oneshot_shuttle)

    conn =
      post(
        api_conn(),
        "/api/v1/transition",
        Jason.encode!(%{fiber_id: "tests/transition-bad-target", target: "nowhere"})
      )

    assert conn.status == 400
    body = Jason.decode!(conn.resp_body)
    assert body["error"] == "unknown_target"
    assert body["invoked"] == false
  end

  test "transition for an unknown fiber returns 404" do
    with_actions_host()

    conn =
      post(
        api_conn(),
        "/api/v1/transition",
        Jason.encode!(%{fiber_id: "tests/transition-missing", target: "drafts"})
      )

    assert conn.status == 404
    body = Jason.decode!(conn.resp_body)
    assert body["error"] == "not_found"
    assert body["invoked"] == false
  end

  # A remote-owned fiber: the local daemon forwards to the OWNING remote's
  # /transition over the tunnel and relays its response verbatim, re-stamped with
  # the origin the caller routed to. The forwarded payload carries no origin (so
  # the remote runs its own local branch); only fiber_id + target cross the wire.
  test "transition forwards a remote-owned fiber to the owning daemon" do
    start_supervised!(StubPostClient)

    StubPostClient.set_response(
      {:ok, 200,
       Jason.encode!(%{
         "fiber_id" => "tests/remote-work",
         "target" => "drafts",
         "origin" => "local",
         "action" => "pause",
         "invoked" => true
       })}
    )

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: "candide", url: "http://localhost:4001"}])
    Application.put_env(:shuttle, :write_forward_client, StubPostClient)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)

    conn =
      post(
        api_conn(),
        "/api/v1/transition",
        Jason.encode!(%{
          fiber_id: "tests/remote-work",
          target: "drafts",
          origin: "candide"
        })
      )

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["invoked"] == true
    assert body["action"] == "pause"
    # Origin re-stamped to what the caller routed to, not the remote's "local".
    assert body["origin"] == "candide"

    # Forwarded to the owning remote's /transition, fiber_id + target only.
    last = StubPostClient.last()
    assert last.url == "http://localhost:4001/api/v1/transition"
    forwarded = Jason.decode!(last.body)
    assert forwarded == %{"fiber_id" => "tests/remote-work", "target" => "drafts"}
  end

  test "successful remote transition refreshes the cached remote fiber feed" do
    start_supervised!(StubPostClient)

    StubPostClient.set_response(
      {:ok, 200,
       Jason.encode!(%{
         "fiber_id" => "tests/remote-work",
         "target" => "tempered",
         "origin" => "local",
         "action" => "close-tempered",
         "invoked" => true
       })}
    )

    StubPostClient.set_get_response(
      {:ok,
       Jason.encode!(%{
         "host" => "cineca",
         "fibers" => [
           %{
             "path" => "tests/remote-work/remote-work.md",
             "fiber" => %{
               "id" => "tests/remote-work",
               "name" => "Remote work",
               "status" => "closed",
               "tempered" => true
             }
           }
         ]
       })}
    )

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: "cineca", url: "http://localhost:4002"}])
    Application.put_env(:shuttle, :write_forward_client, StubPostClient)

    start_supervised!({
      Shuttle.RemoteFiberRegistry,
      # No disk persistence: this stub feed must not reach the real
      # `~/.shuttle/remote-fibers` store and outlive the test.
      remotes: [%Shuttle.Remote{name: "cineca", url: "http://localhost:4002"}],
      client: StubPostClient,
      auto_poll: false,
      store_dir: nil
    })

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)

    conn =
      post(
        api_conn(),
        "/api/v1/transition",
        Jason.encode!(%{
          fiber_id: "tests/remote-work",
          target: "tempered",
          origin: "cineca"
        })
      )

    assert conn.status == 200
    assert StubPostClient.last_get().url == "http://localhost:4002/api/v1/fibers?shuttle=true"

    assert %{"cineca" => %{stale: false, fibers: [%{"fiber" => %{"tempered" => true}}]}} =
             Shuttle.RemoteFiberRegistry.feeds()
  end

  test "transition relays a remote owner's error status" do
    start_supervised!(StubPostClient)

    StubPostClient.set_response(
      {:ok, 409, Jason.encode!(%{"invoked" => false, "error" => "action_not_available"})}
    )

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: "cineca", url: "http://localhost:4002"}])
    Application.put_env(:shuttle, :write_forward_client, StubPostClient)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)

    conn =
      post(
        api_conn(),
        "/api/v1/transition",
        Jason.encode!(%{fiber_id: "tests/remote-err", target: "tempered", origin: "cineca"})
      )

    assert conn.status == 409
    body = Jason.decode!(conn.resp_body)
    assert body["invoked"] == false
    assert body["error"] == "action_not_available"
    assert body["origin"] == "cineca"
  end

  # ── Owner-routing for the non-drag write verbs (Shuttle.OriginRouter) ──
  #
  # The kanban posts tag/horizon edits, promote/requeue lifecycle, and the
  # dispatch directive (user_message + resume_mode, STORE 3) directly to Shuttle,
  # carrying the `origin` the composite board stamped. A remote-owned card
  # forwards to the owning daemon's IDENTICAL endpoint over the tunnel (origin
  # stripped, so the owner runs its own local branch) and relays the response
  # verbatim — the same one-hop shape /transition uses, via the shared forwarder.

  defp stub_forward(remote_name, remote_url, response) do
    start_supervised!(StubPostClient)
    StubPostClient.set_response(response)

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: remote_name, url: remote_url}])
    Application.put_env(:shuttle, :write_forward_client, StubPostClient)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)
  end

  test "felt-edit forwards a remote-owned card to the owning daemon" do
    stub_forward("candide", "http://localhost:4001", {:ok, 200, "edited"})

    conn =
      post(
        api_conn(),
        "/api/v1/felt-edit",
        Jason.encode!(%{fiber_id: "tests/remote-card", origin: "candide", add: ["idea"]})
      )

    assert conn.status == 200
    assert conn.resp_body == "edited"

    last = StubPostClient.last()
    assert last.url == "http://localhost:4001/api/v1/felt-edit"
    # origin stripped so the owner treats the fiber as local; the rest crosses.
    assert Jason.decode!(last.body) == %{"fiber_id" => "tests/remote-card", "add" => ["idea"]}
  end

  test "lifecycle forwards a remote-owned card to the owning daemon" do
    stub_forward("candide", "http://localhost:4001", {:ok, 200, "paused"})

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{action: "pause", fiber: "tests/remote-card", origin: "candide"})
      )

    assert conn.status == 200
    assert conn.resp_body == "paused"

    last = StubPostClient.last()
    assert last.url == "http://localhost:4001/api/v1/lifecycle"
    assert Jason.decode!(last.body) == %{"action" => "pause", "fiber" => "tests/remote-card"}
  end

  test "dispatch forwards a remote-owned card and relays its JSON" do
    stub_forward(
      "candide",
      "http://localhost:4001",
      {:ok, 200, Jason.encode!(%{"dispatched" => true, "fiber_id" => "tests/remote-card"})}
    )

    conn =
      post(
        api_conn(),
        "/api/v1/dispatch",
        Jason.encode!(%{fiber_id: "tests/remote-card", origin: "candide"})
      )

    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["dispatched"] == true

    last = StubPostClient.last()
    assert last.url == "http://localhost:4001/api/v1/dispatch"
    assert Jason.decode!(last.body) == %{"fiber_id" => "tests/remote-card"}
  end

  test "dispatch owner-routes the STORE-3 user_message + resume_mode intact" do
    # STORE 3: the user's directive + continuation mode ride the dispatch call
    # (replacing the old file-a-review-comment-then-dispatch two-step). For a
    # remote-owned card they must owner-route to the owning daemon's /dispatch
    # with origin stripped — the body otherwise verbatim.
    stub_forward(
      "cineca",
      "http://localhost:4002",
      {:ok, 200, Jason.encode!(%{"dispatched" => true, "fiber_id" => "tests/remote-card"})}
    )

    conn =
      post(
        api_conn(),
        "/api/v1/dispatch",
        Jason.encode!(%{
          fiber_id: "tests/remote-card",
          origin: "cineca",
          user_message: "talk to me first",
          resume_mode: "previous"
        })
      )

    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["dispatched"] == true

    last = StubPostClient.last()
    assert last.url == "http://localhost:4002/api/v1/dispatch"
    # origin stripped; user_message + resume_mode survive the hop.
    assert Jason.decode!(last.body) == %{
             "fiber_id" => "tests/remote-card",
             "user_message" => "talk to me first",
             "resume_mode" => "previous"
           }
  end

  test "felt-edit relays a tunnel failure as 502" do
    stub_forward("candide", "http://localhost:4001", {:error, :econnrefused})

    conn =
      post(
        api_conn(),
        "/api/v1/felt-edit",
        Jason.encode!(%{fiber_id: "tests/remote-card", origin: "candide", add: ["x"]})
      )

    assert conn.status == 502
    assert conn.resp_body =~ "forward to candide failed"
  end

  test "an unknown origin falls through to local — no forward, local arbitrates" do
    stub_forward("candide", "http://localhost:4001", {:ok, 200, "should-not-be-used"})

    # origin "ghost" matches no configured remote → :local. The fiber isn't in
    # the local store, so the local branch returns a clean not-found rather than
    # forwarding anywhere.
    conn =
      post(
        api_conn(),
        "/api/v1/felt-edit",
        Jason.encode!(%{fiber_id: "tests/nonexistent", origin: "ghost", add: ["x"]})
      )

    assert conn.status == 400
    assert conn.resp_body =~ "fiber not found"
    # The forwarder was never touched — no silent mis-route to the wrong host.
    assert StubPostClient.last() == nil
  end

  # ── GET /api/v1/state ──

  test "state returns full orchestrator state" do
    uid = "01KTCA2CWXBSNHETE66MXKPVE7"
    fiber = make_fiber("tests/state", %{"uid" => uid})
    MockRunner.set_fiber("tests/state", fiber)
    MockRunner.set_shuttle("tests/state", @oneshot_shuttle)

    send(Shuttle.Poller, :run_poll_cycle)

    # Poll for the outcome rather than sleeping a fixed 100ms for it. The cycle
    # has to discover the fiber, decide it is eligible, launch a worker and
    # register it running before this endpoint can show the row — comfortably
    # under 100ms on an idle machine, and not reliably so under a full-suite
    # load, where this test failed about one run in five.
    assert wait_until(fn ->
             match?(
               [%{fiber_id: "tests/state"} | _],
               Shuttle.Poller.snapshot(Shuttle.Poller)[:eligible]
             )
           end)

    conn = get(api_conn(), "/api/v1/state")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["host"] != nil
    assert is_list(body["eligible"])
    assert is_list(body["running_detail"])

    # Slice 7: no separate `:runtime` index. Liveness rides the `eligible` rows
    # — each carries the intrinsic uid, the live tmux session, and run state, so
    # a consumer reads running-ness off the row instead of joining against a
    # parallel runtime overlay (which the cutover deleted with the store).
    refute Map.has_key?(body, "runtime")

    expected_session = "state-#{uid}-shuttle"

    assert [
             %{
               "fiber_id" => "tests/state",
               "uid" => ^uid,
               "state" => "running",
               "tmux_session" => ^expected_session
             }
           ] = body["eligible"]

    assert is_list(body["waiters"])
  end

  test "state degrades to JSON when the poller is unavailable" do
    :sys.suspend(Shuttle.Poller)

    try do
      conn = get(api_conn(), "/api/v1/state")
      assert conn.status == 503
      body = Jason.decode!(conn.resp_body)
      assert body["error"] == "poller_unavailable"
      assert is_binary(body["host"])
      assert is_list(body["running_detail"])
    after
      :sys.resume(Shuttle.Poller)
    end
  end

  # ── GET /api/v1/state/composite ──

  test "composite returns local snapshot plus per-origin remote snapshots" do
    # Spin up a RemoteRegistry with a stub client so the composite
    # endpoint has remote data to merge in. The client returns a fake
    # candide snapshot that lists tests/work-on-candide as running.
    defmodule CompositeStubClient do
      @behaviour Shuttle.RemoteRegistry.Client

      @impl true
      def get("http://localhost:4001/api/v1/state", _timeout) do
        body =
          Jason.encode!(%{
            "host" => "candide",
            "eligible" => [%{"fiber_id" => "tests/work-on-candide"}],
            "blocked" => [],
            "retrying" => []
          })

        {:ok, body}
      end

      def get(_url, _timeout), do: {:error, :no_stub}
    end

    # Controller calls Shuttle.RemoteRegistry.snapshots/0, which routes
    # to the default-named GenServer. Start one under the default name
    # for this test (the test config disables auto-start so this name
    # is free until we claim it).
    start_supervised!({
      Shuttle.RemoteRegistry,
      remotes: [
        %Shuttle.Remote{name: "candide", url: "http://localhost:4001"}
      ],
      client: CompositeStubClient,
      tick_interval_ms: 60_000
    })

    :ok = Shuttle.RemoteRegistry.poll_now()

    conn = get(api_conn(), "/api/v1/state/composite")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert is_map(body["local"])
    assert is_list(body["local"]["eligible"])

    assert is_map(body["remotes"])
    candide = body["remotes"]["candide"]
    assert candide != nil
    assert candide["stale"] == false
    assert candide["last_polled_at"] != nil
    assert candide["last_error"] == nil
    assert is_map(candide["snapshot"])
    assert candide["snapshot"]["host"] == "candide"
    assert candide["recovery"]["state"] == "healthy"
    assert candide["recovery"]["attempt"] == 0
  end

  test "composite degrades remote snapshots when the remote registry is unavailable" do
    start_supervised!({
      Shuttle.RemoteRegistry,
      remotes: [
        %Shuttle.Remote{name: "candide", url: "http://localhost:4001"}
      ],
      tick_interval_ms: 60_000
    })

    :sys.suspend(Shuttle.RemoteRegistry)

    try do
      conn = get(api_conn(), "/api/v1/state/composite")
      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["remotes"]["_registry"]["stale"] == true
      assert body["remotes"]["_registry"]["last_error"] != nil
      assert body["remotes"]["_registry"]["recovery"]["state"] == "unavailable"
    after
      :sys.resume(Shuttle.RemoteRegistry)
    end
  end

  test "composite degrades gracefully when no RemoteRegistry is running" do
    # No RemoteRegistry started under the default name; controller
    # should still return a valid composite shape.
    conn = get(api_conn(), "/api/v1/state/composite")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert is_map(body["local"])
    assert body["remotes"] == %{}
  end

  test "composite degrades local snapshot when the poller is unavailable" do
    :sys.suspend(Shuttle.Poller)

    try do
      conn = get(api_conn(), "/api/v1/state/composite")
      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["local"]["error"] == "poller_unavailable"
      assert body["remotes"] == %{}
    after
      :sys.resume(Shuttle.Poller)
    end
  end

  # ── GET /api/v1/agents ──

  # NOTE (Stage 4a): the former "agents returns the registry as a JSON array"
  # test was deleted. `GET /api/v1/agents` now shells `felt shuttle agents
  # --json` (felt owns the registry); its CONTENTS — non-empty list, a flagged
  # default — are felt's responsibility, verified felt-side, and the verb is not
  # guaranteed live in `mix test`. The controller's only daemon-side contract is
  # "200 + bare array, degrading to [] when felt is unavailable" — and a test
  # asserting that would still depend on the live verb to distinguish the two,
  # so the route's content is left to felt's own suite.

  # ── GET /api/v1/version ──

  test "version returns the daemon build-info shape" do
    conn = get(api_conn(), "/api/v1/version")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert is_binary(body["git_sha"])
    assert is_binary(body["git_short_sha"])
    assert is_binary(body["built_at"])
    assert body["mix_vsn"] == Shuttle.version()

    if body["git_sha"] != "unknown" do
      assert String.length(body["git_short_sha"]) == 7
      assert String.starts_with?(body["git_sha"], body["git_short_sha"])
    end
  end
  # Poll to a deadline instead of sleeping a guess. Returns false on timeout so
  # the caller's `assert` names the test that timed out.
  defp wait_until(fun, remaining_ms \\ 3_000) do
    cond do
      fun.() -> true
      remaining_ms <= 0 -> false
      true -> (Process.sleep(20); wait_until(fun, remaining_ms - 20))
    end
  end

end
