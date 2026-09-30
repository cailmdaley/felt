defmodule ShuttleWeb.APIControllerTest do
  @moduledoc """
  Tests for the daemon's API endpoints.
  """

  use ExUnit.Case
  alias Shuttle.Test.ForwardStub
  import Shuttle.Test.ApiConn
  import Shuttle.Test.EnvHelpers
  import Shuttle.Test.PollerHelpers
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  alias Shuttle.Poller
  alias Shuttle.Test.FiberUid
  alias Shuttle.Test.FeltStoreRunner, as: MockRunner

  alias Shuttle.Test.StubPostClient

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

  defp with_actions_host do
    previous = System.get_env("SHUTTLE_STORES")
    System.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    on_exit(fn ->
      case previous do
        nil -> System.delete_env("SHUTTLE_STORES")
        value -> System.put_env("SHUTTLE_STORES", value)
      end
    end)
  end

  test "GET /api/v1/agents degrades to []/200 when Shuttle output is unavailable" do
    # Shuttle owns the registry; the controller shells `shuttle agents --json`
    # through `Shuttle.CLI.run`. Route that shell-out at MockRunner (the
    # configured CLI-runner seam), whose fall-through returns `{"", 0}`. The
    # response is not a JSON array, so the controller must return an empty list
    # with 200 (the board's picker falls back to free text), never crash the
    # request. The mock keeps this result deterministic when a Shuttle binary is
    # available on PATH.
    previous_felt_runner = Application.get_env(:shuttle, :felt_runner)
    Application.put_env(:shuttle, :felt_runner, MockRunner)
    on_exit(fn -> restore_app_env(:felt_runner, previous_felt_runner) end)

    conn = get(api_conn(), "/api/v1/agents")
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == []
  end

  test "GET /api/v1/agents?origin= asks the host that owns the registry" do
    # The registry is a PER-HOST fact — the built-in layer travels with that
    # host's Shuttle binary and the user layer is a file in its home — so "which
    # agents can this host run" can only be answered by that host. A local
    # Shuttle CLI answering for a remote would be a confident wrong answer, so
    # this leg must forward; the stub fails the test if it instead shells locally.
    previous_felt_runner = Application.get_env(:shuttle, :felt_runner)
    Application.put_env(:shuttle, :felt_runner, MockRunner)
    on_exit(fn -> restore_app_env(:felt_runner, previous_felt_runner) end)

    remote_body = Jason.encode!([%{"id" => "claude-opus"}])

    ForwardStub.stub_forward(
      "candide",
      "http://candide.example:4000",
      {:ok, 200, "application/json", remote_body}
    )

    conn = get(api_conn(), "/api/v1/agents?origin=candide")

    assert conn.status == 200
    assert conn.resp_body == remote_body
    forwarded = Shuttle.Test.StubGetFileClient.last().url
    assert forwarded =~ "http://candide.example:4000/api/v1/agents"
    refute forwarded =~ "origin"
  end

  # ── POST /api/v1/dispatch ──

  test "dispatches a fiber via API" do
    fiber = make_fiber("tests/api-dispatch")
    MockRunner.set_fiber("tests/api-dispatch", fiber)
    MockRunner.set_shuttle("tests/api-dispatch", oneshot_shuttle())

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
    assert body["tmux_session"] == FiberUid.session("tests/api-dispatch")
  end

  test "dispatch returns 409 for already running fiber" do
    fiber = make_fiber("tests/api-dispatch-2")
    MockRunner.set_fiber("tests/api-dispatch-2", fiber)
    MockRunner.set_shuttle("tests/api-dispatch-2", oneshot_shuttle())
    MockRunner.add_tmux_session(FiberUid.session("tests/api-dispatch-2"))

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
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

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
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

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
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())
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
    assert body["tmux_session"] == FiberUid.session(fiber_id)
  end

  test "dispatch returns 400 without fiber_id" do
    conn = post(api_conn(), "/api/v1/dispatch", Jason.encode!(%{}))
    assert conn.status == 400
    body = Jason.decode!(conn.resp_body)
    assert body["error"] == "fiber_id is required"
  end

  test "HTTP ad-hoc dispatch re-arms and runs an awaiting standing role" do
    # Awaiting is represented by status:closed + untempered. The HTTP /dispatch
    # path folds ad_hoc into force (`force: force or ad_hoc`), so an explicit
    # dispatch is the human go-ahead: it bypasses the awaiting gate, re-arms the
    # document, and spawns without a separate `shuttle accept/resume`.
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

  # A forced start never puts a worker in the felt store. These post the board's
  # own launch body (force + ad_hoc + fresh) with whatever else a case needs.
  defp post_start(fiber_id, extra \\ %{}) do
    body =
      Map.merge(
        %{"fiber_id" => fiber_id, "force" => true, "ad_hoc" => true, "resume_mode" => "fresh"},
        extra
      )

    conn = post(api_conn(), "/api/v1/dispatch", Jason.encode!(body))
    {conn.status, Jason.decode!(conn.resp_body)}
  end

  # A closed oneshot whose block names no project_dir and no agent — the shape
  # a worker writes by hand.
  defp closed_bare_oneshot(fiber_id) do
    fiber =
      make_fiber(fiber_id, %{
        "status" => "closed",
        "closed-at" => "2026-09-29T10:00:00Z",
        "tempered" => false
      })

    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nproject_dir: \"\"\n", "closed")
  end

  defp shuttle_calls(verb),
    do:
      Enum.filter(MockRunner.commands(), fn
        {"shuttle", args} -> verb in args
        _ -> false
      end)

  defp spawned?, do: Enum.any?(MockRunner.commands(), &match?({"tmux", ["new-session" | _]}, &1))

  defp spawn_dir do
    {"tmux", args} = Enum.find(MockRunner.commands(), &match?({"tmux", ["new-session" | _]}, &1))
    args |> Enum.drop_while(&(&1 != "-c")) |> Enum.at(1)
  end

  test "a forced start of a block with no project_dir asks for one and writes nothing" do
    fiber_id = "tests/api-start-no-dir"
    closed_bare_oneshot(fiber_id)

    assert {422, body} = post_start(fiber_id)

    assert %{
             "dispatched" => false,
             "reason" => "arm_refused",
             "fiber_id" => ^fiber_id,
             "needs" => "project_dir",
             "message" => message
           } = body

    assert body["host"] == Poller.own_host_id()
    assert message =~ "no project_dir"
    assert shuttle_calls("reopen") == []
    refute spawned?()
  end

  test "a refused reopen answers in the CLI's own words" do
    fiber_id = "tests/api-reopen-refused"

    MockRunner.set_fiber(
      fiber_id,
      make_fiber(fiber_id, %{"status" => "closed", "closed-at" => "2026-09-29T10:00:00Z"})
    )

    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-retired\n", "closed")
    reason = "cannot arm: agent claude-retired is not in the registry"
    MockRunner.set_reopen_result(reason <> "\n", 1)

    assert {422, body} = post_start(fiber_id)

    assert body == %{
             "dispatched" => false,
             "reason" => "arm_refused",
             "fiber_id" => fiber_id,
             "host" => Poller.own_host_id(),
             "message" => reason
           }

    refute spawned?()
  end

  @tag :tmp_dir
  test "a confirmed project_dir is resolved, then saved with the arm in one write, and the worker starts there",
       %{tmp_dir: tmp_dir} do
    fiber_id = "tests/api-start-confirmed-dir"
    closed_bare_oneshot(fiber_id)
    checkout = Path.join(tmp_dir, "checkout")
    File.mkdir_p!(checkout)
    System.put_env("SHUTTLE_TEST_PROJECT", "checkout")
    on_exit(fn -> System.delete_env("SHUTTLE_TEST_PROJECT") end)
    raw = Path.join(tmp_dir, "$SHUTTLE_TEST_PROJECT")

    assert {200, %{"dispatched" => true}} = post_start(fiber_id, %{"project_dir" => raw})

    # The CLI resolves the raw input; the one arming write carries the path it
    # resolved, and the worker's cwd is read back from the block.
    assert [{"shuttle", ["resolve-dir", ^raw]}] = shuttle_calls("resolve-dir")
    assert [{"shuttle", reopen_args}] = shuttle_calls("reopen")

    assert Enum.drop_while(reopen_args, &(&1 != "reopen")) ==
             ["reopen", fiber_id, "--project-dir", checkout, "--local"]

    assert shuttle_calls("set-agent") == []
    assert spawn_dir() == checkout
  end

  test "a confirmed project_dir the host cannot use is asked for again, before any write" do
    fiber_id = "tests/api-start-bad-dir"
    closed_bare_oneshot(fiber_id)

    assert {422, body} = post_start(fiber_id, %{"project_dir" => "/nonexistent/checkout"})
    assert body["reason"] == "arm_refused"
    assert body["needs"] == "project_dir"
    assert body["message"] =~ "no such file or directory"
    assert shuttle_calls("reopen") == []
    refute spawned?()
  end

  @tag :tmp_dir
  test "an arm the CLI refuses for another reason shows its words and asks for nothing",
       %{tmp_dir: tmp_dir} do
    fiber_id = "tests/api-start-retired-agent"
    closed_bare_oneshot(fiber_id)
    reason = "cannot arm: unknown agent claude-retired (shuttle set-agent to pick a current one)"
    MockRunner.set_reopen_result(reason <> "\n", 1)

    assert {422, body} = post_start(fiber_id, %{"project_dir" => tmp_dir})
    assert body["reason"] == "arm_refused"
    assert body["message"] == reason
    refute Map.has_key?(body, "needs")
    refute spawned?()
  end

  test "a refused fresh start leaves a live session running and unmarked" do
    fiber_id = "tests/api-start-live-bad-dir"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())
    assert {:ok, session} = Poller.dispatch_fiber(fiber_id, [])
    before = length(MockRunner.commands())

    assert {422, %{"reason" => "arm_refused", "needs" => "project_dir"}} =
             post_start(fiber_id, %{"project_dir" => "/nonexistent/checkout"})

    after_refusal = Enum.drop(MockRunner.commands(), before)

    refute Enum.any?(after_refusal, fn
             {"tmux", ["kill-session" | _]} -> true
             {"shuttle", args} -> "mark-runtime" in args or "reopen" in args
             _ -> false
           end),
           "a refused start must not cut, mark or arm; got #{inspect(after_refusal)}"

    conn = post(api_conn(), "/api/v1/dispatch", Jason.encode!(%{"fiber_id" => fiber_id}))
    assert conn.status == 409
    assert Jason.decode!(conn.resp_body)["tmux_session"] == session
  end

  @tag :tmp_dir
  test "a standing role with a confirmed project_dir is armed by the one reopen write",
       %{tmp_dir: tmp_dir} do
    fiber_id = "tests/api-standing-confirmed-dir"

    MockRunner.set_fiber(
      fiber_id,
      make_fiber(fiber_id, %{"status" => "closed", "closed-at" => "2026-09-29T10:00:00Z"})
    )

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      project_dir: ""
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      """,
      "closed"
    )

    assert {200, %{"dispatched" => true}} = post_start(fiber_id, %{"project_dir" => tmp_dir})
    assert [{"shuttle", reopen_args}] = shuttle_calls("reopen")
    assert "--project-dir" in reopen_args
    assert spawn_dir() == tmp_dir
  end

  test "a blank project_dir confirms nothing" do
    fiber_id = "tests/api-start-blank-dir"
    closed_bare_oneshot(fiber_id)

    assert {422, %{"needs" => "project_dir"}} = post_start(fiber_id, %{"project_dir" => "   "})
    assert shuttle_calls("set-agent") == []
  end

  test "a forced start of a standing role with no project_dir is refused before its re-arm" do
    fiber_id = "tests/api-standing-no-dir"

    MockRunner.set_fiber(
      fiber_id,
      make_fiber(fiber_id, %{"status" => "closed", "closed-at" => "2026-09-29T10:00:00Z"})
    )

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      project_dir: ""
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      """,
      "closed"
    )

    assert {422, %{"reason" => "arm_refused", "needs" => "project_dir"}} = post_start(fiber_id)
    assert MockRunner.fiber(fiber_id)["status"] == "closed"
    assert File.read!(MockRunner.fiber(fiber_id)["path"]) =~ "status: closed"
    refute spawned?()
  end

  test "a forced start of a pinned role with no project_dir is refused" do
    fiber_id = "tests/api-pinned-no-dir"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "open"}))
    MockRunner.set_shuttle(fiber_id, "kind: pinned\nproject_dir: \"\"\n", "open")

    assert {422, %{"reason" => "arm_refused", "needs" => "project_dir"}} = post_start(fiber_id)
    assert File.read!(MockRunner.fiber(fiber_id)["path"]) =~ "status: open"
    refute spawned?()
  end

  test "a forced start whose declared project_dir is missing here asks for another" do
    fiber_id = "tests/api-start-missing-dir"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nproject_dir: /nonexistent/elsewhere\n")

    assert {422, body} = post_start(fiber_id)
    assert body["reason"] == "arm_refused"
    assert body["needs"] == "project_dir"
    assert body["message"] =~ "/nonexistent/elsewhere"
    refute spawned?()
  end

  # ── POST /api/v1/transition ──

  # The unified write-plane: one call resolves the kanban target to an action
  # AND invokes it (no separate resolve leg). A closed oneshot dragged to the
  # tempered column resolves to close-tempered and shells the offline writer —
  # threading `-C <store>` through the extracted Transition pipeline.
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

    # The transition pipeline shells felt to resolve the store/target and
    # shuttle for the write. Keep those process boundaries separate and capture
    # the complete Shuttle argv.
    File.write!(Path.join(stub_dir, "felt"), """
    #!/usr/bin/env bash
    exec "#{real_felt}" "$@"
    """)

    File.write!(Path.join(stub_dir, "shuttle"), """
    #!/usr/bin/env bash
    printf '%s\\n' "$@" >> "#{argv_log}"
    exit 0
    """)

    File.chmod!(Path.join(stub_dir, "felt"), 0o755)
    File.chmod!(Path.join(stub_dir, "shuttle"), 0o755)

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
    assert Enum.take(captured, 2) == ["-C", MockRunner.felt_root()]
    assert "close" in captured
    assert "--tempered=true" in captured
  end

  test "transition for an unknown target returns 400" do
    with_actions_host()
    MockRunner.set_shuttle("tests/transition-bad-target", oneshot_shuttle())

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
  # dispatch directive (user_message + resume_mode) directly to Shuttle,
  # carrying the `origin` the composite board stamped. A remote-owned card
  # forwards to the owning daemon's IDENTICAL endpoint over the tunnel (origin
  # stripped, so the owner runs its own local branch) and relays the response
  # verbatim — the same one-hop shape /transition uses, via the shared forwarder.

  defp stub_forward(remote_name, remote_url, response),
    do: ForwardStub.stub_forward(remote_name, remote_url, response, StubPostClient)

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

  test "dispatch owner-routes the user_message + resume_mode intact" do
    # The user's directive + continuation mode ride the dispatch call
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
    MockRunner.set_shuttle("tests/state", oneshot_shuttle())

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

    # What this daemon IS, alongside what it is doing. The build stamp rides the
    # snapshot so a hub's `/state/composite` answers "which host is on which
    # build" out of the one fetch it already makes, instead of a `/version`
    # round trip per host — so it is part of this body's shape, not an extra.
    assert body["build"] == Jason.decode!(Jason.encode!(Shuttle.BuildStamp.stamp()))

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

  # `GET /api/v1/agents` shells `shuttle agents --json` and returns its array
  # to the board. Shuttle owns registry contents; the controller tests cover
  # response shape and graceful degradation without requiring a live CLI.

  # ── GET /api/v1/version ──

  test "version returns the daemon build-info shape" do
    conn = get(api_conn(), "/api/v1/version")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert is_binary(body["git_sha"])
    assert is_binary(body["git_short_sha"])
    assert is_binary(body["built_at"])
    assert body["mix_vsn"] == Shuttle.version()
    assert is_boolean(body["tailnet_dial"]["configured"])
    assert is_list(body["tailnet_dial"]["bridges"])

    if body["git_sha"] != "unknown" do
      assert String.length(body["git_short_sha"]) == 7
      assert String.starts_with?(body["git_sha"], body["git_short_sha"])
    end
  end

  # Poll to a deadline instead of sleeping a guess. Returns false on timeout so
  # the caller's `assert` names the test that timed out.
  defp wait_until(fun, remaining_ms \\ 3_000) do
    cond do
      fun.() ->
        true

      remaining_ms <= 0 ->
        false

      true ->
        Process.sleep(20)
        wait_until(fun, remaining_ms - 20)
    end
  end
end
