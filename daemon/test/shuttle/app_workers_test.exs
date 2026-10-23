defmodule Shuttle.AppWorkersTest do
  use ExUnit.Case, async: true

  # The concurrent-claim races are bounded only against a hang: a passing race
  # never waits this long, and a loaded machine can take seconds per task.
  @race_timeout 60_000
  import Shuttle.Test.PollerHelpers
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  @endpoint ShuttleWeb.Endpoint
  alias Shuttle.{AppWorkers, Dispatcher, Poller, WorkerBackend}
  alias Shuttle.Test.FeltStoreRunner, as: Runner
  alias Shuttle.Test.{Env, FakeCli}

  defmodule Kitty do
    def open(_tmux, _host), do: :ok
  end

  defmodule App do
    use Agent

    def start_link(_),
      do:
        Agent.start_link(
          fn ->
            %{
              calls: [],
              result: {:ok, %{"id" => "turn-1", "status" => "inProgress"}},
              state: :idle
            }
          end,
          name: __MODULE__
        )

    def status(id) do
      state = state(id)

      phase =
        Agent.get(__MODULE__, &Map.get(&1, :phase, if(state == :idle, do: "waiting", else: nil)))

      %{state: state, phase: phase}
    end

    def calls, do: Agent.get(__MODULE__, & &1.calls)
    def set(key, value), do: Agent.update(__MODULE__, &Map.put(&1, key, value))

    defp record(call),
      do: Agent.update(__MODULE__, &Map.update!(&1, :calls, fn calls -> calls ++ [call] end))

    def start_thread(opts) do
      record({:start, opts})

      {:ok,
       %{
         "id" => "app-session-1",
         "sessionId" => Agent.get(__MODULE__, &Map.get(&1, :transcript_id, "app-session-1"))
       }}
    end

    def name_thread(id, name) do
      {:ok, %{"active" => true}} = AppWorkers.get(id)

      Agent.update(
        __MODULE__,
        &Map.update(&1, :names, [{id, name}], fn names -> names ++ [{id, name}] end)
      )

      {:error, :rename_unavailable}
    end

    def names, do: Agent.get(__MODULE__, &Map.get(&1, :names, []))

    def resume_thread(id, opts) do
      record({:resume, id, opts})

      Agent.get_and_update(__MODULE__, fn state ->
        case Map.fetch(state, :resume_result) do
          {:ok, result} ->
            {result, state}

          :error ->
            result =
              {:ok, %{"id" => Map.get(state, :resume_id, id), "status" => %{"type" => "active"}}}

            loaded = %{"id" => id, "status" => %{"type" => "active"}}
            {result, Map.merge(state, %{state: :idle, read_result: {:ok, loaded}})}
        end
      end)
    end

    def read_thread(id) do
      record({:read, id})

      Agent.get(
        __MODULE__,
        &Map.get(&1, :read_result, {:ok, %{"id" => id, "status" => %{"type" => "active"}}})
      )
    end

    def start_turn(id, prompt, opts) do
      {:ok, %{"active" => true}} = AppWorkers.get(id)
      record({:turn, id, prompt, opts})
      Agent.get(__MODULE__, & &1.result)
    end

    def interrupt(id) do
      record({:interrupt, id})
      Agent.get(__MODULE__, &Map.get(&1, :interrupt_result, :ok))
    end

    def state(_), do: Agent.get(__MODULE__, & &1.state)
  end

  defmodule MarkerFailureRunner do
    def cmd("shuttle", args, opts) do
      if mark_runtime?(args), do: {"write failed", 1}, else: Runner.cmd("shuttle", args, opts)
    end

    def cmd(cmd, args, opts), do: Runner.cmd(cmd, args, opts)

    defp mark_runtime?(["-C", _store, "mark-runtime" | _]), do: true
    defp mark_runtime?(["mark-runtime" | _]), do: true
    defp mark_runtime?(_), do: false
  end

  defmodule MarkerFailsOnceRunner do
    use Agent

    def start_link(_), do: Agent.start_link(fn -> true end, name: __MODULE__)

    def cmd("shuttle", args, opts) do
      if mark_runtime?(args) and Agent.get_and_update(__MODULE__, fn fail? -> {fail?, false} end),
        do: {"write failed", 1},
        else: Runner.cmd("shuttle", args, opts)
    end

    def cmd(cmd, args, opts), do: Runner.cmd(cmd, args, opts)

    defp mark_runtime?(["-C", _store, "mark-runtime" | _]), do: true
    defp mark_runtime?(["mark-runtime" | _]), do: true
    defp mark_runtime?(_), do: false
  end

  defmodule LegacyHeldRunner do
    def cmd("ps", _args, _opts),
      do:
        {"1234 1 codex resume 11111111-2222-3333-4444-555555555555\n5678 1 codex --remote unix:///control.sock resume app-session-1\n",
         0}

    def cmd(cmd, args, opts), do: Runner.cmd(cmd, args, opts)
  end

  defmodule MissingTmuxRunner do
    def cmd("tmux", _args, _opts), do: {"tmux unavailable", :timeout}
    def cmd(cmd, args, opts), do: Runner.cmd(cmd, args, opts)
  end

  setup do
    Runner.start!()
    start_supervised!(App)
    root = Path.join(System.tmp_dir!(), "app-workers-test-#{System.unique_integer([:positive])}")
    Env.put_app_env(:app_workers_dir, root)
    Env.put_app_env(:codex_app_client, App)

    on_exit(fn -> File.rm_rf!(root) end)

    :ok
  end

  defp fiber(id, status \\ "active") do
    Runner.set_fiber(
      id,
      make_fiber(id, %{"status" => status, "uid" => "01KTHDNZS287ZSSG8X8V59XKWB"})
    )

    Runner.set_shuttle(
      id,
      "kind: oneshot\nagent: codex\nsurface: app\nproject_dir: /tmp\n",
      status
    )
  end

  defp dispatch(id, opts \\ []) do
    Dispatcher.dispatch(
      id,
      Keyword.merge([runner: Runner, work_dir: "/tmp", felt_store: Runner.felt_root()], opts)
    )
  end

  defp terminal_fiber(id) do
    fiber(id)

    Runner.set_shuttle(
      id,
      "kind: oneshot\nagent: codex\nsurface: cli\nhost: #{Poller.own_host_id()}\nproject_dir: /tmp\n",
      "active"
    )
  end

  test "terminal dispatch owns the same backend and presents only the exact thread" do
    terminal_fiber("tests/terminal")
    assert {:ok, ref} = dispatch("tests/terminal")
    assert ref == "codex-app:app-session-1"
    assert {:ok, record} = AppWorkers.get("app-session-1")
    assert record["surface"] == "cli"
    assert record["terminal_tmux"] == "codex-terminal-app-session-1"
    assert record["backend_endpoint"] == Shuttle.CodexApp.Transport.default_socket()
    assert record["backend_host"] == Poller.own_host_id()

    assert [
             {:start, _},
             {:turn, "app-session-1", prompt, _},
             {:read, "app-session-1"},
             {:resume, "app-session-1", []}
           ] =
             App.calls()

    assert prompt =~ "Fiber: tests/terminal"
    assert prompt =~ "Backend: codex-app-server"
    assert prompt =~ "Activate the felt and shuttle skills"
    refute prompt =~ "Surface: app"

    assert %{
             surface: "cli",
             tmux_session: "codex-terminal-app-session-1",
             thread_id: "app-session-1"
           } = WorkerBackend.wire(ref)

    {"tmux", args} =
      Enum.find(Runner.commands(), fn {cmd, args} -> cmd == "tmux" and "new-session" in args end)

    script = File.read!(List.last(args))

    assert script =~
             "--remote 'unix://#{record["backend_endpoint"]}' -C '/tmp' resume 'app-session-1'"

    refute script =~ "||"
    refute script =~ "model_reasoning_effort"
  end

  test "closing a terminal leaves the conversation owned; attach recreates only its viewer" do
    terminal_fiber("tests/terminal")
    assert {:ok, ref} = dispatch("tests/terminal")
    tmux = WorkerBackend.tmux(ref)
    Runner.remove_tmux_session(tmux)
    assert :alive = WorkerBackend.session_status(Runner, ref)
    assert :idle = WorkerBackend.observe(ref)
    assert {:error, :already_running} = dispatch("tests/terminal")

    assert {:ok, %{tmux_session: ^tmux, created: true}} =
             Shuttle.CodexTerminal.prepare("app-session-1", runner: Runner)

    assert {:ok, %{tmux_session: ^tmux, created: false}} =
             Shuttle.CodexTerminal.prepare("app-session-1", runner: Runner)

    assert 1 == Enum.count(App.calls(), &match?({:start, _}, &1))
    assert 1 == Enum.count(App.calls(), &match?({:turn, _, _, _}, &1))
    App.set(:read_result, {:error, :disconnected})

    assert {:error, :disconnected} =
             Shuttle.CodexTerminal.prepare("app-session-1", runner: Runner)

    assert :alive = WorkerBackend.session_status(Runner, ref)
  end

  test "a failed initial turn retains identity and never creates a viewer or replacement" do
    terminal_fiber("tests/terminal")
    App.set(:result, {:error, :timeout})
    assert {:error, {:app_launch_failed, "app-session-1", :timeout}} = dispatch("tests/terminal")

    assert {:error, :initial_turn_unconfirmed} =
             Shuttle.CodexTerminal.prepare("app-session-1", runner: Runner)

    assert {:error, :already_running} = dispatch("tests/terminal")

    assert {:ok, %{"active" => true, "launch_state" => "blocked", "pending_prompt" => prompt}} =
             AppWorkers.get("app-session-1")

    assert prompt =~ "Fiber: tests/terminal"

    refute Enum.any?(Runner.commands(), fn {cmd, args} ->
             cmd == "tmux" and "new-session" in args
           end)
  end

  test "unconfirmed initial-turn acknowledgments retain the exact identity and pending prompt" do
    terminal_fiber("tests/terminal")

    for turn <- [
          nil,
          %{},
          %{"id" => "turn-1"},
          %{"id" => "", "status" => "inProgress"},
          %{"id" => 1, "status" => "completed"},
          %{"id" => "turn-1", "status" => "failed"},
          %{"id" => "turn-1", "status" => "interrupted"},
          %{"id" => "turn-1", "status" => "unknown"}
        ] do
      App.set(:result, {:ok, turn})

      assert {:error,
              {:app_launch_failed, "app-session-1", {:transport, :unconfirmed_turn_start}}} =
               dispatch("tests/terminal", resume_mode: "fresh")

      assert {:ok, %{"active" => true, "launch_state" => "blocked", "pending_prompt" => prompt}} =
               AppWorkers.get("app-session-1")

      assert prompt =~ "Fiber: tests/terminal"

      assert {:error, :initial_turn_unconfirmed} =
               Shuttle.CodexTerminal.prepare("app-session-1", runner: Runner)

      assert {:error, :already_running} = dispatch("tests/terminal")
      # Explicit test cleanup permits the next independent launch case.
      assert :ok = AppWorkers.deactivate("app-session-1")
    end

    assert 8 == Enum.count(App.calls(), &match?({:start, _}, &1))
    assert 8 == Enum.count(App.calls(), &match?({:turn, _, _, _}, &1))

    refute Enum.any?(Runner.commands(), fn {cmd, args} ->
             cmd == "tmux" and "new-session" in args
           end)
  end

  test "an already completed initial-turn acknowledgment permits the exact terminal viewer" do
    terminal_fiber("tests/terminal")
    App.set(:result, {:ok, %{"id" => "completed-turn", "status" => "completed"}})
    assert {:ok, "codex-app:app-session-1"} = dispatch("tests/terminal")

    assert {:ok,
            %{"launch_state" => "running", "pending_prompt" => nil, "turn_id" => "completed-turn"}} =
             AppWorkers.get("app-session-1")

    assert {:ok, %{created: false}} =
             Shuttle.CodexTerminal.prepare("app-session-1", runner: Runner)
  end

  test "terminal preflight runs before any conversation mutation" do
    terminal_fiber("tests/terminal")
    Runner.set_wrapper_missing(true)
    assert {:error, {:wrapper_unresolved, _}} = dispatch("tests/terminal")
    assert [] = App.calls()
    assert [] = AppWorkers.active()
  end

  test "a changed endpoint or a missing exact native thread cannot create a viewer" do
    terminal_fiber("tests/terminal")
    assert {:ok, ref} = dispatch("tests/terminal")
    Runner.remove_tmux_session(WorkerBackend.tmux(ref))
    assert :ok = AppWorkers.update("app-session-1", %{"backend_endpoint" => "/different/socket"})

    assert {:error, :app_endpoint_changed} =
             Shuttle.CodexTerminal.prepare("app-session-1", runner: Runner)

    assert :ok =
             AppWorkers.update("app-session-1", %{
               "backend_endpoint" => Shuttle.CodexApp.Transport.default_socket()
             })

    App.set(:read_result, {:ok, %{"id" => "other", "status" => %{"type" => "active"}}})

    assert {:error, :native_thread_unverified} =
             Shuttle.CodexTerminal.prepare("app-session-1", runner: Runner)

    assert :alive = WorkerBackend.session_status(Runner, ref)
  end

  test "terminal capture has synchronous identity and claims its backend rather than a tmux process" do
    terminal_fiber("tests/terminal")

    assert {:ok, %{session_uuid: id, surface: "cli", tmux_session: tmux}} =
             Dispatcher.capture("Discuss first",
               runner: Runner,
               work_dir: "/tmp",
               felt_store: Runner.felt_root(),
               agent: "codex",
               surface: "cli"
             )

    assert tmux == "codex-terminal-" <> id
    assert [{:start, _}, {:turn, ^id, prompt, _}, {:read, ^id}, {:resume, ^id, []}] = App.calls()
    assert prompt =~ ~s(\"surface\":\"cli\")
    assert prompt =~ ~s(\"session_uuid\":\"#{id}\")
    refute prompt =~ "tmux_session"

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    assert {:ok, %{session: "codex-app:" <> ^id}} =
             Poller.claim_session(poller, "tests/terminal", nil, surface: "cli", session_uuid: id)

    assert %{session: "codex-app:" <> ^id, context_address: "shuttle://test-host/codex/" <> ^id} =
             Poller.worker_status(poller, "tests/terminal")
  end

  test "restart adopts terminal backend identity even with no terminal" do
    terminal_fiber("tests/terminal")
    assert {:ok, ref} = dispatch("tests/terminal")
    Runner.remove_tmux_session(WorkerBackend.tmux(ref))

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    assert %{session: ^ref, context_address: "shuttle://test-host/codex/app-session-1"} =
             Poller.worker_status(poller, "tests/terminal")

    snapshot = Poller.snapshot(poller)

    assert [
             %{
               surface: "cli",
               tmux_session: "codex-terminal-app-session-1",
               session_uuid: "app-session-1"
             }
           ] = snapshot.eligible

    assert {:ok, %{created: true}} =
             Shuttle.SessionResume.prepare("app-session-1",
               runner: Runner,
               live_sessions: fn -> ["app-session-1"] end
             )
  end

  test "terminal resume of an owned inactive thread has no holder check or new-thread fallback" do
    terminal_fiber("tests/terminal")
    assert {:ok, ref} = dispatch("tests/terminal")
    assert {_, 0} = WorkerBackend.stop(Runner, ref)
    App.set(:resume_result, {:error, :disconnected})

    assert {:error, {:app_launch_failed, "app-session-1", :disconnected}} =
             dispatch("tests/terminal", runner: LegacyHeldRunner, resume_mode: "previous")

    assert 1 == Enum.count(App.calls(), &match?({:start, _}, &1))
    assert :alive = WorkerBackend.session_status(Runner, ref)
  end

  test "prepare-terminal and board attach recreate the same viewer without a turn" do
    terminal_fiber("tests/terminal")
    assert {:ok, ref} = dispatch("tests/terminal")
    tmux = WorkerBackend.tmux(ref)
    Runner.remove_tmux_session(tmux)
    Env.put_app_env(:terminal_runner, Runner)
    Env.put_app_env(:kitty_impl, Kitty)

    body =
      post(
        api_conn(),
        "/api/v1/sessions/prepare-terminal",
        Jason.encode!(%{"fiber" => "01KTHDNZS287ZSSG8X8V59XKWB"})
      )
      |> json_response(200)

    assert body == %{"tmux_session" => tmux, "created" => true}
    Runner.remove_tmux_session(tmux)

    body =
      post(api_conn(), "/api/v1/attach", Jason.encode!(%{"tmux_session" => tmux}))
      |> json_response(200)

    assert body == %{"attached" => true, "session" => tmux}
    assert 1 == Enum.count(App.calls(), &match?({:turn, _, _, _}, &1))

    assert %{"error" => "no owned terminal Codex conversation"} =
             post(
               api_conn(),
               "/api/v1/sessions/prepare-terminal",
               Jason.encode!(%{"fiber" => "not-the-uid"})
             )
             |> json_response(404)

    assert :ok = AppWorkers.deactivate("app-session-1")

    assert %{"error" => "no owned terminal Codex conversation"} =
             post(
               api_conn(),
               "/api/v1/sessions/prepare-terminal",
               Jason.encode!(%{"tmux_session" => tmux})
             )
             |> json_response(404)
  end

  test "a lost initial rollout is never replaced and exposes terminal refusal" do
    terminal_fiber("tests/terminal")

    reason =
      {:peer, %{"code" => -32_600, "message" => "no rollout found for thread id app-session-1"}}

    App.set(:resume_result, {:error, reason})

    assert {:error, {:app_launch_failed, "app-session-1", {:terminal_unavailable, ^reason}}} =
             dispatch("tests/terminal")

    assert {:ok, %{"active" => true, "terminal_error" => error}} = AppWorkers.get("app-session-1")
    assert error =~ "no rollout found"

    assert {502,
            %{
              surface: "cli",
              session_uuid: "app-session-1",
              terminal_error: ^error,
              message: message
            }} =
             ShuttleWeb.DispatchReply.render(
               "tests/terminal",
               {:error, {:app_launch_failed, "app-session-1", {:terminal_unavailable, reason}}}
             )

    assert message =~ "Use shuttle attach"

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    assert [%{terminal_error: ^error, session_uuid: "app-session-1"}] =
             Poller.snapshot(poller).eligible

    assert {:error, :already_running} = dispatch("tests/terminal")
    assert 1 == Enum.count(App.calls(), &match?({:start, _}, &1))

    refute Enum.any?(Runner.commands(), fn {cmd, args} ->
             cmd == "tmux" and "new-session" in args
           end)
  end

  test "uncertain terminal stop retains assignment instead of releasing a usable viewer" do
    terminal_fiber("tests/terminal")
    assert {:ok, ref} = dispatch("tests/terminal")
    Runner.set_kill_session_failure(true)
    assert {_, 1} = WorkerBackend.stop(Runner, ref)
    assert :alive = WorkerBackend.session_status(Runner, ref)
    assert {:error, :already_running} = dispatch("tests/terminal")
    Runner.set_kill_session_failure(false)
    assert {_, 0} = WorkerBackend.stop(Runner, ref)
    assert :gone = WorkerBackend.session_status(Runner, ref)
  end

  test "unknown legacy Codex identity cannot migrate while an embedded process holds it" do
    terminal_fiber("tests/terminal")

    Runner.set_shuttle(
      "tests/terminal",
      "kind: oneshot\nagent: codex\nsurface: cli\nruntime:\n  session_uuid: 11111111-2222-3333-4444-555555555555\n",
      "active"
    )

    assert {:error, {:transcript_held, message}} =
             dispatch("tests/terminal", runner: LegacyHeldRunner, resume_mode: "previous")

    assert message =~ "1234"
    assert [] = App.calls()
    assert [] = AppWorkers.active()
  end

  for surface <- ["cli", "app"] do
    test "#{surface} owner host and endpoint fence every managed native operation and resume" do
      id = "tests/owner-fence"
      terminal_fiber(id)

      Runner.set_shuttle(
        id,
        "kind: oneshot\nagent: codex\nsurface: #{unquote(surface)}\nhost: #{Poller.own_host_id()}\nproject_dir: /tmp\n",
        "active"
      )

      assert {:ok, session} = dispatch(id)
      assert {:ok, record} = AppWorkers.get("app-session-1")
      App.set(:calls, [])
      App.set(:state, :not_loaded)

      for {key, value, expected} <- [
            {"backend_endpoint", "/another-owner.sock", :app_endpoint_changed},
            {"backend_host", "another-host", :app_host_changed}
          ] do
        assert :ok = AppWorkers.put(Map.put(record, key, value))

        assert {:error, ^expected} =
                 AppWorkers.recover("app-session-1", id, record["uid"], Runner.felt_root())

        assert {:error, ^expected} = AppWorkers.start_turn("app-session-1", "do not start", [])

        assert :unknown =
                 WorkerBackend.observe(session, %{
                   fiber_id: id,
                   uid: record["uid"],
                   felt_store: Runner.felt_root()
                 })

        assert {reason, 1} = WorkerBackend.stop(Runner, session)
        assert reason =~ Atom.to_string(expected)
        assert :alive = WorkerBackend.session_status(Runner, session)
        assert :ok = AppWorkers.deactivate("app-session-1")
        assert {:error, ^expected} = dispatch(id, resume_mode: "previous")
        assert {:ok, retained} = AppWorkers.get("app-session-1")
        assert retained[key] == value
        assert [] = App.calls()
      end
    end
  end

  test "unrecorded ownership refuses native operations without guessing a migration" do
    fiber("tests/unrecorded")
    assert {:ok, session} = dispatch("tests/unrecorded")
    assert {:ok, record} = AppWorkers.get("app-session-1")
    App.set(:calls, [])

    for {key, expected} <- [
          {"backend_host", :app_host_unrecorded},
          {"backend_endpoint", :app_endpoint_unrecorded}
        ] do
      assert :ok = AppWorkers.put(Map.delete(record, key))

      assert {:error, ^expected} =
               AppWorkers.recover(
                 "app-session-1",
                 "tests/unrecorded",
                 record["uid"],
                 Runner.felt_root()
               )

      assert {:error, ^expected} = AppWorkers.start_turn("app-session-1", "do not start", [])
      assert {_, 1} = WorkerBackend.stop(Runner, session)
      assert [] = App.calls()
      assert {:ok, retained} = AppWorkers.get("app-session-1")
      refute Map.has_key?(retained, key)
    end
  end

  test "dispatch records exact app identity before its first turn and never launches tmux" do
    fiber("tests/app")
    assert {:ok, "codex-app:app-session-1"} = dispatch("tests/app")
    assert {:ok, record} = AppWorkers.get("app-session-1")
    assert record["fiber_id"] == "tests/app"
    assert record["launch_state"] == "running"
    assert record["turn_id"] == "turn-1"
    assert [{:start, _}, {:turn, "app-session-1", prompt, _}] = App.calls()
    assert prompt =~ "Surface: app"
    assert prompt =~ "Activate the felt and shuttle skills"
    refute prompt =~ "env -u TMUX"

    refute Enum.any?(Runner.commands(), fn {cmd, args} ->
             cmd == "tmux" and "new-session" in args
           end)

    assert {:error, :already_running} = dispatch("tests/app")
    assert length(App.calls()) == 2
  end

  test "an uncertain start keeps identity reserved and exposes the launch error" do
    fiber("tests/app")
    App.set(:result, {:error, :timeout})
    assert {:error, {:app_launch_failed, "app-session-1", :timeout}} = dispatch("tests/app")

    assert {:ok, %{"active" => true, "launch_state" => "blocked"}} =
             AppWorkers.get("app-session-1")

    assert {:error, :already_running} = dispatch("tests/app")
    assert length(App.calls()) == 2
  end

  test "capture records a real conversation before a fiber exists and can claim only one fiber" do
    assert {:ok, %{session_uuid: id}} =
             Dispatcher.capture("Discuss the design first",
               runner: Runner,
               work_dir: "/tmp",
               felt_store: Runner.felt_root(),
               agent: "codex",
               surface: "app",
               host: "test-host"
             )

    assert {:ok, %{"fiber_id" => nil}} = AppWorkers.get(id)
    first = %{"id" => "tests/first", "uid" => "first"}
    assert :ok = AppWorkers.claim(id, first, Runner.felt_root())
    assert :ok = AppWorkers.claim(id, first, Runner.felt_root())

    assert {:error, :already_claimed} =
             AppWorkers.claim(
               id,
               %{"id" => "tests/second", "uid" => "second"},
               Runner.felt_root()
             )

    assert {:error, :not_found} = AppWorkers.claim("invented", first, Runner.felt_root())
  end

  test "claim adopts a verified native conversation without interrupting its active turn" do
    id = "tests/adopt-existing"

    Runner.set_fiber(id, make_fiber(id, %{"uid" => "adopt-uid", "status" => "open"}))

    Runner.set_shuttle(
      id,
      "kind: oneshot\nagent: codex\nsurface: app\nhost: #{Poller.own_host_id()}\nproject_dir: /tmp\n",
      "open"
    )

    App.set(
      :read_result,
      {:ok,
       %{
         "id" => "existing-thread",
         "sessionId" => "native-transcript",
         "projectId" => "native-project",
         "cwd" => "/native/project",
         "status" => %{"type" => "active"}
       }}
    )

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    assert {:ok, %{session: "codex-app:existing-thread", agent_id: "codex"}} =
             Poller.claim_session(poller, id, nil,
               surface: "app",
               session_uuid: "existing-thread"
             )

    assert {:ok, record} = AppWorkers.get("existing-thread")
    assert record["fiber_id"] == id
    assert record["uid"] == "adopt-uid"
    assert record["transcript_session_uuid"] == "native-transcript"
    assert record["project_id"] == "native-project"
    assert record["cwd"] == "/native/project"
    assert record["active"] == true

    assert [{:read, "existing-thread"}] = App.calls()
    refute Enum.any?(App.calls(), &match?({tag, _, _} when tag in [:start, :resume, :turn], &1))

    assert get_in(Runner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == "existing-thread"
    assert %{session: "codex-app:existing-thread"} = Poller.worker_status(poller, id)

    assert Enum.any?(Shuttle.SessionLedger.read_since(0), fn entry ->
             entry["kind"] == "claim" and entry["fiber"] == id and
               entry["session"] == "native-transcript" and
               entry["thread_id"] == "existing-thread"
           end)
  end

  test "claim adopts an idle native conversation" do
    fiber = %{"id" => "tests/adopt-idle", "uid" => "idle-uid"}

    App.set(:read_result, {:ok, %{"id" => "idle-thread", "status" => %{"type" => "idle"}}})

    assert :ok = AppWorkers.claim_or_adopt("idle-thread", fiber, Runner.felt_root())

    assert {:ok, %{"fiber_id" => "tests/adopt-idle", "active" => true}} =
             AppWorkers.get("idle-thread")

    assert [{:read, "idle-thread"}] = App.calls()
  end

  test "marker failure retains an adopted conversation for a same-session claim retry" do
    id = "tests/adopt-marker-retry"
    thread = "marker-retry-thread"

    Runner.set_fiber(id, make_fiber(id, %{"uid" => "marker-retry-uid", "status" => "open"}))

    Runner.set_shuttle(
      id,
      "kind: oneshot\nagent: codex\nsurface: app\nhost: #{Poller.own_host_id()}\nproject_dir: /tmp\n",
      "open"
    )

    App.set(:read_result, {:ok, %{"id" => thread, "status" => %{"type" => "active"}}})
    start_supervised!(MarkerFailsOnceRunner)

    {:ok, poller} =
      start_poller!(
        runner: MarkerFailsOnceRunner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    assert {:error, _} =
             Poller.claim_session(poller, id, nil, surface: "app", session_uuid: thread)

    assert {:ok, %{"active" => true, "fiber_id" => ^id}} = AppWorkers.get(thread)
    assert [{:read, ^thread}] = App.calls()

    assert {:ok, %{session: "codex-app:" <> ^thread}} =
             Poller.claim_session(poller, id, nil, surface: "app", session_uuid: thread)

    assert [{:read, ^thread}] = App.calls()
    assert get_in(Runner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == thread
    assert %{session: "codex-app:" <> ^thread} = Poller.worker_status(poller, id)
  end

  test "claim refuses an unverified native conversation without creating ownership" do
    id = "tests/adopt-missing"

    Runner.set_fiber(id, make_fiber(id, %{"uid" => "missing-uid", "status" => "open"}))

    Runner.set_shuttle(
      id,
      "kind: oneshot\nagent: codex\nsurface: app\nhost: #{Poller.own_host_id()}\nproject_dir: /tmp\n",
      "open"
    )

    App.set(:read_result, {:error, :not_found})

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    assert {:error, :native_thread_unverified} =
             Poller.claim_session(poller, id, nil, surface: "app", session_uuid: "missing-thread")

    assert {:error, :not_found} = AppWorkers.get("missing-thread")
    assert [{:read, "missing-thread"}] = App.calls()
    assert get_in(Runner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == nil
  end

  test "adoption records ownership only for the requested thread confirmed live" do
    # Adoption only reads: a native answer that is not the requested thread in
    # an active or idle state — absent, unreachable, malformed, another
    # thread's, or non-live — refuses without recording an owner.
    id = "claimed-thread"
    fiber = %{"id" => "tests/adopt", "uid" => "adopt-uid"}

    reads =
      [
        {:error, :not_found},
        {:error, :disconnected},
        {:ok, %{"id" => id}},
        {:ok, %{"id" => "other-thread", "status" => %{"type" => "active"}}}
      ] ++
        for state <- ["missing", "notLoaded", "unknown"],
            do: {:ok, %{"id" => id, "status" => %{"type" => state}}}

    for read <- reads do
      App.set(:calls, [])
      App.set(:read_result, read)

      assert {:error, :native_thread_unverified} =
               AppWorkers.claim_or_adopt(id, fiber, Runner.felt_root()),
             "read #{inspect(read)}"

      assert {:error, :not_found} = AppWorkers.get(id), "read #{inspect(read)}"
      assert App.calls() == [{:read, id}], "read #{inspect(read)}"
    end
  end

  test "concurrent external claims leave one fiber as a native thread's owner" do
    App.set(:read_result, {:ok, %{"id" => "adopt-race", "status" => %{"type" => "active"}}})

    fibers = for n <- 1..30, do: %{"id" => "tests/adopt-race-#{n}", "uid" => "uid-#{n}"}

    results =
      fibers
      |> Task.async_stream(
        &AppWorkers.claim_or_adopt("adopt-race", &1, Runner.felt_root()),
        max_concurrency: 30,
        timeout: @race_timeout
      )
      |> Enum.map(fn {:ok, result} -> result end)

    assert Enum.count(results, &(&1 == :ok)) == 1
    assert Enum.count(results, &(&1 == {:error, :already_claimed})) == 29
    assert {:ok, record} = AppWorkers.get("adopt-race")
    assert record["fiber_id"] in Enum.map(fibers, & &1["id"])
    refute Enum.any?(App.calls(), &match?({tag, _, _} when tag in [:start, :resume, :turn], &1))
  end

  test "adoption never overwrites an unreadable ownership record" do
    path = Path.join(AppWorkers.root(), "corrupt-thread.json")
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, "not json")

    App.set(:read_result, {:ok, %{"id" => "corrupt-thread", "status" => %{"type" => "active"}}})

    assert {:error, :ownership_record_unreadable} =
             AppWorkers.claim_or_adopt(
               "corrupt-thread",
               %{"id" => "tests/adopt-corrupt", "uid" => "corrupt-uid"},
               Runner.felt_root()
             )

    assert {:ok, "not json"} = File.read(path)
  end

  test "UID is authoritative when a slug is reused" do
    :ok =
      AppWorkers.put(%{
        "session_uuid" => "old",
        "backend_host" => Poller.own_host_id(),
        "backend_endpoint" => Shuttle.CodexApp.Transport.default_socket(),
        "active" => true,
        "fiber_id" => "tests/same",
        "uid" => "old-uid"
      })

    assert nil == AppWorkers.for_fiber("tests/same", "new-uid")

    assert {:error, :already_claimed} =
             AppWorkers.claim(
               "old",
               %{"id" => "tests/same", "uid" => "new-uid"},
               Runner.felt_root()
             )
  end

  test "claim never rebinds an owned conversation to another felt store" do
    :ok =
      AppWorkers.put(%{
        "session_uuid" => "store-bound",
        "backend_host" => Poller.own_host_id(),
        "backend_endpoint" => Shuttle.CodexApp.Transport.default_socket(),
        "active" => true,
        "fiber_id" => "tests/store-bound",
        "uid" => "store-uid",
        "felt_store" => "/one-store"
      })

    assert {:error, :already_claimed} =
             AppWorkers.claim(
               "store-bound",
               %{"id" => "tests/store-bound", "uid" => "store-uid"},
               "/another-store"
             )
  end

  test "capture title uses a short sanitized first line even when rename is unavailable" do
    prompt = "  Phone\tidea\n" <> String.duplicate("context", 50)

    assert {:ok, _} =
             Dispatcher.capture(prompt,
               agent: "codex",
               work_dir: "/tmp",
               runner: Runner,
               surface: "app",
               felt_store: Runner.felt_root()
             )

    assert App.names() == [{"app-session-1", "Shuttle — Phone idea"}]
  end

  test "explicit stop releases a thread confirmed missing during native resume" do
    fiber("tests/app")
    assert {:ok, session} = dispatch("tests/app")
    App.set(:state, :unknown)
    App.set(:interrupt_result, {:error, :thread_missing})
    assert {"", 0} = WorkerBackend.stop(Runner, session)
    assert {:ok, %{"active" => false}} = AppWorkers.get("app-session-1")
  end

  test "resume reserves only its original fiber and never overwrites another owner" do
    fiber("tests/app")
    assert {:ok, session} = dispatch("tests/app")
    assert {"", 0} = WorkerBackend.stop(Runner, session)

    assert {:error, :session_owner_mismatch} =
             AppWorkers.reserve_resume(
               "app-session-1",
               "tests/copied",
               "different-uid",
               Runner.felt_root()
             )

    App.set(:resume_id, "unexpected-native-thread")

    assert {:error, {:app_launch_failed, "app-session-1", :resume_identity_mismatch}} =
             dispatch("tests/app", resume_mode: "previous")

    assert {:error, :not_found} = AppWorkers.get("unexpected-native-thread")

    assert {:ok, %{"fiber_id" => "tests/app", "launch_state" => "blocked"}} =
             AppWorkers.get("app-session-1")
  end

  test "dispatch rejects a copied saved marker before native resume side effects" do
    fiber("tests/app")
    assert {:ok, session} = dispatch("tests/app")
    assert {"", 0} = WorkerBackend.stop(Runner, session)
    fiber("tests/copied")

    copied =
      Runner.fiber("tests/copied")
      |> Map.put("uid", "01KTHDNZS287ZSSG8X8V59XKZZ")
      |> put_in(["shuttle", "runtime"], %{"session_uuid" => "app-session-1"})

    Runner.set_fiber("tests/copied", copied)
    before = App.calls()
    assert {:error, :session_owner_mismatch} = dispatch("tests/copied", resume_mode: "previous")
    assert App.calls() == before

    assert {:ok, %{"fiber_id" => "tests/app", "active" => false}} =
             AppWorkers.get("app-session-1")
  end

  test "concurrent resume reservations have exactly one winner" do
    :ok =
      AppWorkers.put(%{
        "session_uuid" => "resume-race",
        "backend_host" => Poller.own_host_id(),
        "backend_endpoint" => Shuttle.CodexApp.Transport.default_socket(),
        "fiber_id" => "tests/app",
        "uid" => "original-uid",
        "felt_store" => Runner.felt_root(),
        "active" => false
      })

    results =
      1..30
      |> Task.async_stream(
        fn _ ->
          AppWorkers.reserve_resume(
            "resume-race",
            "tests/app",
            "original-uid",
            Runner.felt_root()
          )
        end,
        max_concurrency: 30,
        timeout: @race_timeout
      )
      |> Enum.map(fn {:ok, result} -> result end)

    assert Enum.count(results, &(&1 == :ok)) == 1
    assert Enum.count(results, &(&1 == {:error, :already_running})) == 29
  end

  test "watcher recovery reloads only an explicitly not-loaded owned thread without a turn" do
    id = "recover-thread"
    fiber_id = "tests/recover"

    :ok =
      AppWorkers.put(%{
        "session_uuid" => id,
        "thread_id" => id,
        "fiber_id" => fiber_id,
        "uid" => "recover-uid",
        "backend_host" => Poller.own_host_id(),
        "backend_endpoint" => Shuttle.CodexApp.Transport.default_socket(),
        "felt_store" => Runner.felt_root(),
        "active" => true
      })

    App.set(:read_result, {:ok, %{"id" => id, "status" => %{"type" => "notLoaded"}}})
    App.set(:state, :not_loaded)
    assert :not_loaded = WorkerBackend.observe("codex-app:" <> id)
    assert App.calls() == []

    assert :idle =
             WorkerBackend.observe("codex-app:" <> id, %{
               fiber_id: fiber_id,
               uid: "recover-uid",
               felt_store: Runner.felt_root()
             })

    assert [{:read, ^id}, {:resume, ^id, []}] = App.calls()
    assert {:ok, %{"active" => true, "fiber_id" => ^fiber_id}} = AppWorkers.get(id)
    refute Enum.any?(App.calls(), &match?({:turn, _, _, _}, &1))
  end

  test "watcher passes captured UID and store into not-loaded recovery" do
    id = "watcher-recover-thread"
    fiber_id = "tests/watcher-recover"

    :ok =
      AppWorkers.put(%{
        "session_uuid" => id,
        "thread_id" => id,
        "fiber_id" => fiber_id,
        "uid" => "watcher-recover-uid",
        "backend_host" => Poller.own_host_id(),
        "backend_endpoint" => Shuttle.CodexApp.Transport.default_socket(),
        "felt_store" => Runner.felt_root(),
        "active" => true
      })

    App.set(:state, :not_loaded)
    App.set(:read_result, {:ok, %{"id" => id, "status" => %{"type" => "notLoaded"}}})

    {:ok, %{pid: watcher}} =
      Poller.start_watcher(
        %Poller.State{self_ref: self(), runner: Runner, heartbeat_interval_ms: 10},
        fiber_id,
        %{
          session: "codex-app:" <> id,
          uid: "watcher-recover-uid",
          felt_store: Runner.felt_root()
        }
      )

    assert eventually(fn -> Enum.any?(App.calls(), &match?({:resume, ^id, []}, &1)) end)
    assert :ok = Shuttle.WorkerWatcher.stop(watcher)
    assert {:ok, %{"active" => true, "fiber_id" => ^fiber_id}} = AppWorkers.get(id)
  end

  test "concurrent watcher recovery resumes a thread once" do
    id = "recover-race"

    :ok =
      AppWorkers.put(%{
        "session_uuid" => id,
        "thread_id" => id,
        "fiber_id" => "tests/race",
        "uid" => "race-uid",
        "backend_host" => Poller.own_host_id(),
        "backend_endpoint" => Shuttle.CodexApp.Transport.default_socket(),
        "felt_store" => Runner.felt_root(),
        "active" => true
      })

    App.set(:read_result, {:ok, %{"id" => id, "status" => %{"type" => "notLoaded"}}})

    results =
      1..20
      |> Task.async_stream(
        fn _ -> AppWorkers.recover(id, "tests/race", "race-uid", Runner.felt_root()) end,
        max_concurrency: 20,
        timeout: @race_timeout
      )
      |> Enum.map(fn {:ok, result} -> result end)

    assert Enum.all?(results, &(&1 == :ok))
    assert Enum.count(App.calls(), &match?({:resume, ^id, []}, &1)) == 1
  end

  test "watcher recovery rejects stale or mismatched durable ownership before native calls" do
    id = "recover-owner"

    :ok =
      AppWorkers.put(%{
        "session_uuid" => id,
        "thread_id" => id,
        "fiber_id" => "tests/owner",
        "uid" => "owner-uid",
        "backend_host" => Poller.own_host_id(),
        "backend_endpoint" => Shuttle.CodexApp.Transport.default_socket(),
        "felt_store" => Runner.felt_root(),
        "active" => true
      })

    for {fiber_id, uid, store} <- [
          {"tests/owner", "stale-uid", Runner.felt_root()},
          {"tests/owner", "wrong-uid", Runner.felt_root()},
          {"tests/owner", "owner-uid", Runner.felt_root() <> "-other"},
          {"", "owner-uid", Runner.felt_root()},
          {"tests/owner", "", Runner.felt_root()}
        ] do
      assert {:error, :session_owner_mismatch} = AppWorkers.recover(id, fiber_id, uid, store)
    end

    :ok = AppWorkers.deactivate(id)

    assert {:error, :session_owner_mismatch} =
             AppWorkers.recover(id, "tests/owner", "owner-uid", Runner.felt_root())

    assert App.calls() == []
  end

  test "watcher recovery reloads only its own thread, confirmed, and keeps ownership when it cannot" do
    # Recovery resumes a durably owned thread only when the native server
    # answers for exactly that thread, and accepts the resume only when it
    # comes back as that thread, live. Any other answer fails closed; a
    # transport error surfaces as itself. Neither releases ownership.
    id = "recover-verify"

    :ok =
      AppWorkers.put(%{
        "session_uuid" => id,
        "thread_id" => id,
        "fiber_id" => "tests/verify",
        "uid" => "verify-uid",
        "backend_host" => Poller.own_host_id(),
        "backend_endpoint" => Shuttle.CodexApp.Transport.default_socket(),
        "felt_store" => Runner.felt_root(),
        "active" => true
      })

    not_loaded = {:ok, %{"id" => id, "status" => %{"type" => "notLoaded"}}}

    # {read_thread answer, resume_thread answer (nil: never asked), recover/4 result}
    rows = [
      {{:ok, %{"id" => "another-thread", "status" => %{"type" => "notLoaded"}}}, nil,
       {:error, :native_thread_unverified}},
      {{:ok, %{"id" => id}}, nil, {:error, :native_thread_unverified}},
      {{:ok, %{"id" => id, "status" => %{"type" => "missing"}}}, nil,
       {:error, :native_thread_unverified}},
      {{:error, :disconnected}, nil, {:error, :disconnected}},
      {not_loaded, {:ok, %{"id" => "wrong-thread", "status" => %{"type" => "active"}}},
       {:error, :native_thread_unverified}},
      {not_loaded, {:error, :disconnected}, {:error, :disconnected}},
      {not_loaded, {:ok, %{"id" => id, "status" => %{"type" => "active"}}}, :ok}
    ]

    for {read, resume, expected} <- rows do
      row = "read #{inspect(read)}, resume #{inspect(resume)}"
      App.set(:calls, [])
      App.set(:read_result, read)
      if resume, do: App.set(:resume_result, resume)

      assert AppWorkers.recover(id, "tests/verify", "verify-uid", Runner.felt_root()) ==
               expected,
             row

      assert App.calls() == [{:read, id} | if(resume, do: [{:resume, id, []}], else: [])], row
      assert {:ok, %{"active" => true}} = AppWorkers.get(id), row
    end
  end

  test "watcher recovery fails closed on valid JSON without an ownership record" do
    id = "recover-invalid-record"
    :ok = File.mkdir_p(AppWorkers.root())
    :ok = File.write(Path.join(AppWorkers.root(), id <> ".json"), "null")

    assert {:ok, nil} = AppWorkers.get(id)

    assert {:error, :session_owner_mismatch} =
             AppWorkers.recover(id, "tests/invalid-record", "invalid-uid", Runner.felt_root())

    assert App.calls() == []
  end

  test "already loaded watcher recovery performs no native mutation" do
    id = "recover-loaded"

    :ok =
      AppWorkers.put(%{
        "session_uuid" => id,
        "thread_id" => id,
        "fiber_id" => "tests/loaded",
        "backend_host" => Poller.own_host_id(),
        "backend_endpoint" => Shuttle.CodexApp.Transport.default_socket(),
        "uid" => nil,
        "felt_store" => Runner.felt_root(),
        "active" => true
      })

    App.set(:read_result, {:ok, %{"id" => id, "status" => %{"type" => "idle"}}})

    assert :ok = AppWorkers.recover(id, "tests/loaded", nil, Runner.felt_root())
    assert [{:read, ^id}] = App.calls()
  end

  test "a delayed watcher exit cannot release a replacement using the same conversation" do
    fiber("tests/app")
    assert {:ok, session} = dispatch("tests/app")

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    original = Poller.worker_status(poller, "tests/app")
    assert {:ok, ^session} = Poller.kill_session(poller, "tests/app")

    assert {:ok, ^session} =
             Poller.dispatch_fiber(poller, "tests/app", force: true, resume_mode: "previous")

    replacement = Poller.worker_status(poller, "tests/app")
    refute replacement.pid == original.pid
    send(poller, {:worker_exited, "tests/app", original.pid, session, :normal_exit})
    assert %{pid: watcher, session: ^session} = Poller.worker_status(poller, "tests/app")
    assert watcher == replacement.pid
  end

  test "native activity phases reach snapshots without changing idle ownership" do
    fiber("tests/app")
    assert {:ok, session} = dispatch("tests/app")

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    for {state, phase} <- [{:running, "working"}, {:running, "attention"}, {:idle, "waiting"}] do
      App.set(:state, state)
      App.set(:phase, phase)
      assert WorkerBackend.observe(session) == state

      assert [%{phase: ^phase, session_uuid: "app-session-1", state: "running"}] =
               Poller.snapshot(poller).eligible

      meta = Poller.worker_status(poller, "tests/app")
      index = Shuttle.Poller.Snapshot.runtime_index(%{"tests/app" => meta}, %{})
      assert %{phase: ^phase, surface: "app"} = index["tests/app"]
      assert WorkerBackend.session_status(Runner, session) == :alive
    end

    [%{last_activity_at: since}] = Poller.snapshot(poller).eligible
    assert :idle = WorkerBackend.observe(session)
    assert [%{last_activity_at: ^since}] = Poller.snapshot(poller).eligible
    App.set(:state, :unknown)
    App.set(:phase, nil)
    assert :unknown = WorkerBackend.observe(session)
    [uncertain] = Poller.snapshot(poller).eligible
    refute Map.has_key?(uncertain, :phase)
    assert WorkerBackend.session_status(Runner, session) == :alive
  end

  test "durable prompts are private before atomic publication" do
    record = %{
      "session_uuid" => "private-thread",
      "active" => true,
      "pending_prompt" => "private text"
    }

    assert :ok = AppWorkers.put(record)
    assert {:ok, dir_stat} = File.stat(AppWorkers.root())
    assert Bitwise.band(dir_stat.mode, 0o777) == 0o700
    assert {:ok, stat} = File.stat(Path.join(AppWorkers.root(), "private-thread.json"))
    assert Bitwise.band(stat.mode, 0o777) == 0o600
    assert :ok = AppWorkers.update("private-thread", %{"pending_prompt" => "updated"})
    assert {:ok, updated} = File.stat(Path.join(AppWorkers.root(), "private-thread.json"))
    assert Bitwise.band(updated.mode, 0o777) == 0o600
    assert Path.wildcard(Path.join(AppWorkers.root(), "*.tmp")) == []
  end

  test "idle conversations survive poller restart, adopt once, and resume in place" do
    fiber("tests/app")
    assert {:ok, session} = dispatch("tests/app")

    original_start = ~U[2026-09-19 12:00:00Z]

    :ok =
      AppWorkers.update("app-session-1", %{
        "started_at" => DateTime.to_iso8601(original_start),
        "agent_id" => "codex-original"
      })

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    assert %{
             session: ^session,
             started_at: ^original_start,
             last_activity_at: ^original_start,
             agent_id: "codex-original"
           } = Poller.worker_status(poller, "tests/app")

    assert {:ok, ^session} =
             Poller.dispatch_fiber(poller, "tests/app",
               force: true,
               resume_mode: "previous",
               user_message: "Continue here"
             )

    assert [{:start, _}, {:turn, _, _, _}, {:turn, "app-session-1", "Continue here", _}] =
             App.calls()

    assert WorkerBackend.session_status(Runner, session) == :alive
    App.set(:state, :unknown)
    assert WorkerBackend.session_status(Runner, session) == :alive
    assert {:ok, ^session} = Poller.kill_session(poller, "tests/app")
    assert WorkerBackend.session_status(Runner, session) == :gone
  end

  test "next-launch configuration does not replace or relabel an owned app conversation" do
    fiber("tests/app")
    assert {:ok, session} = dispatch("tests/app")
    :ok = AppWorkers.update("app-session-1", %{"agent_id" => "codex-original"})
    calls = App.calls()

    Runner.set_shuttle(
      "tests/app",
      "kind: oneshot\nagent: claude-sonnet\nsurface: cli\nproject_dir: /tmp\n",
      "active"
    )

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    assert %{session: ^session, agent_id: "codex-original"} =
             Poller.worker_status(poller, "tests/app")

    assert :ok = Poller.refresh_document(poller, "tests/app")

    assert %{session: ^session, agent_id: "codex-original"} =
             Poller.worker_status(poller, "tests/app")

    assert App.calls() == calls
    assert WorkerBackend.session_status(Runner, session) == :alive

    assert {:ok, %{"active" => true, "agent_id" => "codex-original"}} =
             AppWorkers.get("app-session-1")
  end

  test "stopped app resumes its exact UUID without a CLI fallback" do
    fiber("tests/app")
    assert {:ok, session} = dispatch("tests/app")
    assert {"", 0} = WorkerBackend.stop(Runner, session)
    assert {:ok, ^session} = dispatch("tests/app", resume_mode: "previous")
    assert Enum.any?(App.calls(), &match?({:resume, "app-session-1", _}, &1))
    assert App.names() == [{"app-session-1", "Shuttle — app"}]
  end

  test "marker failure cannot start a turn or mint another conversation" do
    fiber("tests/app")

    assert {:error, {:app_launch_failed, "app-session-1", {:runtime_marker_failed, _}}} =
             dispatch("tests/app", runner: MarkerFailureRunner)

    assert [{:start, _}] = App.calls()

    assert {:ok, %{"active" => true, "launch_state" => "blocked"}} =
             AppWorkers.get("app-session-1")

    assert {:error, :already_running} = dispatch("tests/app")
  end

  test "force fresh retains ownership if stopping the app is uncertain" do
    fiber("tests/app")
    {:ok, session} = dispatch("tests/app")
    App.set(:interrupt_result, {:error, :disconnected})

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    assert {:error, :already_running} =
             Poller.dispatch_fiber(poller, "tests/app", force: true, resume_mode: "fresh")

    assert %{session: ^session} = Poller.worker_status(poller, "tests/app")
    assert WorkerBackend.session_status(Runner, session) == :alive
    assert Enum.count(App.calls(), &match?({:start, _}, &1)) == 1
  end

  test "a completed handoff survives restart and releases only after its turn is idle" do
    fiber("tests/app")
    {:ok, session} = dispatch("tests/app")
    App.set(:state, :running)

    Runner.put_shuttle_fields("tests/app", %{
      "handed_off_at" => DateTime.to_iso8601(DateTime.utc_now())
    })

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    assert %{session: ^session} = Poller.worker_status(poller, "tests/app")
    settle(poller)
    assert WorkerBackend.session_status(Runner, session) == :alive
    # Close alongside handoff to prevent the autonomous next iteration.
    Runner.set_fiber("tests/app", Map.put(Runner.fiber("tests/app"), "status", "closed"))
    App.set(:state, :idle)
    before = :sys.get_state(poller).poll_cycles
    send(poller, :run_poll_cycle)
    eventually(fn -> :sys.get_state(poller).poll_cycles > before end)
    assert Poller.worker_status(poller, "tests/app") == nil
    assert WorkerBackend.session_status(Runner, session) == :gone
    assert Enum.count(App.calls(), &match?({:start, _}, &1)) == 1
  end

  test "app workers can launch without a tmux executable" do
    fiber("tests/app")
    Env.put_env("REAL_SHUTTLE", FakeCli.real!("shuttle"))
    bin = FakeCli.install!(%{"shuttle" => "#!/bin/sh\nexec \"$REAL_SHUTTLE\" \"$@\"\n"})
    Env.put_env("PATH", bin)
    assert Shuttle.Env.find_executable("tmux") == nil
    assert {:ok, "codex-app:app-session-1"} = dispatch("tests/app", runner: MissingTmuxRunner)

    {:ok, poller} =
      start_poller!(
        runner: MissingTmuxRunner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    assert %{session: "codex-app:app-session-1"} = Poller.worker_status(poller, "tests/app")
  end

  test "an installed but unresponsive tmux still prevents duplicate app dispatch" do
    fiber("tests/app")
    FakeCli.install!(%{"tmux" => "#!/bin/sh\nexit 1\n"})
    assert {:error, :already_running} = dispatch("tests/app", runner: MissingTmuxRunner)
    assert App.calls() == []
  end

  test "confirmed missing conversations block automatic duplication but explicit stop releases ownership" do
    fiber("tests/app")
    {:ok, session} = dispatch("tests/app")
    App.set(:state, :missing)
    App.set(:interrupt_result, {:error, :not_found})

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000,
        heartbeat_interval_ms: 20
      )

    eventually(fn -> match?(%{state: "blocked"}, Poller.worker_status(poller, "tests/app")) end)

    assert {:ok, %{"active" => true, "remote_state" => "missing"}} =
             AppWorkers.get("app-session-1")

    assert {:error, :already_running} = dispatch("tests/app")
    assert {:ok, ^session} = Poller.kill_session(poller, "tests/app")
    assert WorkerBackend.session_status(Runner, session) == :gone
    refute Enum.any?(App.calls(), &match?({:interrupt, _}, &1))
  end

  test "an unavailable app server never releases ownership" do
    fiber("tests/app")
    {:ok, session} = dispatch("tests/app")
    App.set(:state, :unknown)
    assert WorkerBackend.observe(session) == :unknown
    assert WorkerBackend.session_status(Runner, session) == :alive
  end

  test "fork route identity stays distinct from its native transcript identity" do
    fiber("tests/app")
    App.set(:transcript_id, "native-transcript-id")
    assert {:ok, session} = dispatch("tests/app")
    assert {:ok, record} = AppWorkers.get("app-session-1")
    assert record["thread_id"] == "app-session-1"
    assert record["transcript_session_uuid"] == "native-transcript-id"

    assert %{
             thread_id: "app-session-1",
             session_uuid: "app-session-1",
             transcript_session_uuid: "native-transcript-id"
           } = WorkerBackend.wire(session)

    assert get_in(Runner.fiber("tests/app"), ["shuttle", "runtime", "session_uuid"]) ==
             "app-session-1"

    assert Enum.any?(Shuttle.SessionLedger.read_since(0), fn entry ->
             entry["fiber"] == "tests/app" and entry["kind"] == "dispatch" and
               entry["session"] == "native-transcript-id" and
               entry["thread_id"] == "app-session-1"
           end)

    assert {"", 0} = WorkerBackend.stop(Runner, session)
    assert {:ok, ^session} = dispatch("tests/app", resume_mode: "previous")
    assert Enum.any?(App.calls(), &match?({:resume, "app-session-1", _}, &1))
    refute Enum.any?(App.calls(), &match?({:resume, "native-transcript-id", _}, &1))
  end

  test "concurrent randomized claims preserve one authoritative owner" do
    :ok =
      AppWorkers.put(%{
        "session_uuid" => "race",
        "backend_host" => Poller.own_host_id(),
        "backend_endpoint" => Shuttle.CodexApp.Transport.default_socket(),
        "active" => true,
        "fiber_id" => nil,
        "uid" => nil
      })

    fibers = for n <- 1..40, do: %{"id" => "tests/candidate-#{rem(n, 4)}", "uid" => "uid-#{n}"}

    results =
      fibers
      |> Enum.shuffle()
      |> Task.async_stream(
        fn fiber ->
          {fiber, AppWorkers.claim("race", fiber, Runner.felt_root())}
        end,
        max_concurrency: 12,
        timeout: @race_timeout
      )
      |> Enum.map(fn {:ok, result} -> result end)

    assert [{owner, :ok}] = Enum.filter(results, fn {_, result} -> result == :ok end)
    assert {:ok, record} = AppWorkers.get("race")
    assert record["uid"] == owner["uid"]
    assert :ok = AppWorkers.claim("race", owner, Runner.felt_root())
    assert nil == AppWorkers.for_fiber(owner["id"], "recreated-uid")
    assert :ok = AppWorkers.deactivate("race")
    assert {:error, :already_claimed} = AppWorkers.claim("race", owner, Runner.felt_root())
  end

  defp settle(poller), do: eventually(fn -> :sys.get_state(poller).poll_cycles > 0 end)
  # A ceiling of ~30 s, reached only when the condition never holds: a passing
  # test returns as soon as it does, however loaded the machine.
  defp eventually(fun, attempts \\ 1_500)
  defp eventually(fun, 0), do: assert(fun.())

  defp eventually(fun, attempts) do
    if fun.(),
      do: :ok,
      else:
        (
          Process.sleep(20)
          eventually(fun, attempts - 1)
        )
  end
end
