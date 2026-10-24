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
      if parent = Agent.get(__MODULE__, &Map.get(&1, :notify)), do: send(parent, :thread_started)

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
      if hook = Agent.get(__MODULE__, &Map.get(&1, :read_hook)), do: hook.(id)
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

  defmodule ContextRunner do
    def cmd("felt", ["session"], opts) do
      send(Shuttle.Env.app(:context_test_pid), {:context_command, opts})
      {"# Felt Workflow Context\nFELT_CONTEXT_MARKER\n", 0}
    end

    def cmd("shuttle", args, opts) do
      {output, status} = Runner.cmd("shuttle", args, opts)

      if "--json" in args and ("show" in args or "resolve" in args) and status == 0 do
        data = Jason.decode!(output)
        agent = if "show" in args, do: get_in(data, ["shuttle", "resolved", "agent"]), else: data

        agent =
          agent
          |> Map.put("developer_instructions", "AGENT_CONTEXT_MARKER")
          |> Map.put("extra_flags", Shuttle.Env.app(:context_extra_flags, agent["extra_flags"]))

        data =
          if "show" in args,
            do: put_in(data, ["shuttle", "resolved", "agent"], agent),
            else: agent

        {Jason.encode!(data), 0}
      else
        {output, status}
      end
    end

    def cmd(cmd, args, opts), do: Runner.cmd(cmd, args, opts)
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
    Env.put_env("SHUTTLE_SESSIONS_FILE", Path.join(root, "sessions.jsonl"))

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

  defmodule Dependency do
    def status,
      do: %{
        state: Shuttle.Env.app(:test_codex_dependency, :starting),
        error: "initializing",
        endpoint: "/tmp/fixture.sock"
      }
  end

  test "backend readiness waits without conversations or cooldown, then retries on the next poll" do
    fiber("tests/waiting")
    Env.put_app_env(:codex_backend, Dependency)

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    await_boot_cycle!(poller)
    assert :ok = Poller.release_boot_quarantine(poller)
    assert {:error, {:backend_not_ready, _}} = Poller.dispatch_fiber(poller, "tests/waiting", [])
    assert [] = App.calls()
    assert [] = AppWorkers.active()
    assert [%{attempts: 0, reason: message}] = Poller.snapshot(poller).blocked
    assert message =~ "initializing"
    assert {:error, {:backend_not_ready, _}} = Poller.dispatch_fiber(poller, "tests/waiting", [])
    assert [] = App.calls()
    App.set(:notify, self())
    Env.put_app_env(:test_codex_dependency, :ready)
    send(poller, :run_poll_cycle)
    assert_receive :thread_started
    assert [] = Poller.snapshot(poller).blocked
    assert [{:start, _}, {:turn, "app-session-1", _, _}] = App.calls()
  end

  test "capture returns waiting and does not create an unassigned conversation" do
    Env.put_app_env(:codex_backend, Dependency)

    assert {:error, {:backend_not_ready, _}} =
             Dispatcher.capture("Discuss",
               runner: Runner,
               work_dir: "/tmp",
               felt_store: Runner.felt_root(),
               agent: "codex",
               surface: "app"
             )

    assert [] = App.calls()
    assert [] = AppWorkers.active()
  end

  for surface <- ["cli", "app"], operation <- [:dispatch, :capture] do
    @tag surface: surface, operation: operation
    test "#{surface} #{operation} passes composed developer instructions to the backend",
         context do
      home = Path.join(Runner.felt_root(), "home")
      File.mkdir_p!(Path.join(home, ".codex"))
      File.write!(Path.join(home, ".codex/WAKE.md"), "SHUTTLE_WAKE_CONTEXT_MARKER")
      Env.put_env("HOME", home)
      Env.put_app_env(:context_test_pid, self())

      for key <- ~w(CODEX_THREAD_ID TMUX SHUTTLE_FIBER_PATH),
          do: Env.put_env(key, "parent-identity")

      if context.operation == :dispatch do
        fiber("tests/context")
        Runner.put_shuttle_fields("tests/context", %{"surface" => context.surface})

        assert {:ok, _} =
                 dispatch("tests/context",
                   runner: ContextRunner,
                   developer_instructions: "DISPATCH_CONTEXT_MARKER"
                 )
      else
        assert {:ok, _} =
                 Dispatcher.capture("Discuss context",
                   runner: ContextRunner,
                   work_dir: "/tmp",
                   felt_store: Runner.felt_root(),
                   agent: "codex",
                   surface: context.surface,
                   developer_instructions: "DISPATCH_CONTEXT_MARKER"
                 )
      end

      assert {:start, start_opts} = hd(App.calls())

      assert start_opts[:developer_instructions] ==
               "SHUTTLE_WAKE_CONTEXT_MARKER\n\n# Felt Workflow Context\nFELT_CONTEXT_MARKER\n\nAGENT_CONTEXT_MARKER\n\nDISPATCH_CONTEXT_MARKER"

      assert_receive {:context_command, command_opts}
      assert command_opts[:cd] == "/tmp"
      assert command_opts[:timeout_ms] == 15_000

      for key <- ~w(CODEX_THREAD_ID TMUX SHUTTLE_FIBER_PATH) do
        assert {^key, nil} = List.keyfind(command_opts[:env], key, 0)
      end

      assert {:turn, _, prompt, _} = Enum.find(App.calls(), &match?({:turn, _, _, _}, &1))
      assert prompt =~ "Activate the felt and shuttle skills"
      assert prompt =~ Runner.felt_root()
    end
  end

  for surface <- ["cli", "app"], operation <- [:dispatch, :capture] do
    @tag surface: surface, operation: operation
    test "#{surface} #{operation} refuses CLI developer config before creating a conversation",
         context do
      Env.put_app_env(:context_test_pid, self())

      Env.put_app_env(
        :context_extra_flags,
        ~s(--approve-for-me -c developer_instructions="CUSTOM_MARKER")
      )

      result =
        if context.operation == :dispatch do
          fiber("tests/refused-context")
          Runner.put_shuttle_fields("tests/refused-context", %{"surface" => context.surface})
          dispatch("tests/refused-context", runner: ContextRunner)
        else
          Dispatcher.capture("Discuss",
            runner: ContextRunner,
            work_dir: "/tmp",
            felt_store: Runner.felt_root(),
            agent: "codex",
            surface: context.surface
          )
        end

      assert {:error, {:invalid_axes, message}} = result
      assert message =~ "developer_instructions field or the dispatch option"
      assert App.calls() == []
      refute_receive {:context_command, _}
    end
  end

  test "managed resume retains native context unless dispatch explicitly supplies a replacement" do
    fiber("tests/context-resume")
    Env.put_app_env(:context_test_pid, self())

    assert {:ok, _} =
             dispatch("tests/context-resume",
               runner: ContextRunner,
               developer_instructions: "ORIGINAL_DISPATCH_MARKER"
             )

    assert_receive {:context_command, _}
    assert :ok = AppWorkers.deactivate("app-session-1")
    App.set(:calls, [])

    assert {:ok, _} =
             dispatch("tests/context-resume", runner: ContextRunner, resume_mode: "previous")

    assert {:resume, "app-session-1", opts} = Enum.find(App.calls(), &match?({:resume, _, _}, &1))
    assert is_nil(opts[:developer_instructions])
    refute_receive {:context_command, _}

    assert :ok = AppWorkers.deactivate("app-session-1")
    App.set(:calls, [])

    assert {:ok, _} =
             dispatch("tests/context-resume",
               runner: ContextRunner,
               resume_mode: "previous",
               developer_instructions: "NEW_DISPATCH_MARKER"
             )

    assert {:resume, "app-session-1", opts} = Enum.find(App.calls(), &match?({:resume, _, _}, &1))

    assert opts[:developer_instructions] =~
             "FELT_CONTEXT_MARKER\n\nAGENT_CONTEXT_MARKER\n\nNEW_DISPATCH_MARKER"

    assert_receive {:context_command, _}
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

  defp embedded_fiber(id \\ "11111111-2222-3333-4444-555555555555") do
    terminal_fiber("tests/terminal")
    saved = Runner.fiber("tests/terminal")

    Runner.set_fiber(
      "tests/terminal",
      put_in(saved, ["shuttle", "runtime"], %{"session_uuid" => id})
    )

    Shuttle.SessionLedger.record(
      fiber: "tests/terminal",
      uid: saved["uid"],
      session: id,
      harness: "codex",
      kind: :dispatch,
      tmux: Dispatcher.session_name("tests/terminal", saved["uid"])
    )

    id
  end

  defmodule UnknownHolderRunner do
    def cmd("ps", _args, _opts), do: {"scan unavailable", 1}
    def cmd(cmd, args, opts), do: Runner.cmd(cmd, args, opts)
  end

  test "stopped embedded runtime migrates the exact ID with persisted ownership and no context override" do
    id = embedded_fiber()
    assert {:ok, ref} = dispatch("tests/terminal", runner: ContextRunner, resume_mode: "previous")
    assert ref == AppWorkers.ref(id)

    assert [{:resume, ^id, opts}, {:turn, ^id, _, _}, {:read, ^id}, {:resume, ^id, []}] =
             App.calls()

    assert opts[:developer_instructions] == nil
    assert {:ok, record} = AppWorkers.get(id)
    assert record["active"]
    assert record["backend_host"] == Poller.own_host_id()
    assert record["backend_endpoint"] == Shuttle.CodexApp.Transport.default_socket()
    assert record["terminal_tmux"] == Shuttle.CodexTerminal.tmux_name(id)
  end

  test "History import can be reassigned only to its recorded fiber without rebinding the backend" do
    id = embedded_fiber()
    assert {:ok, %{"id" => ^id}} = AppWorkers.import_embedded(id, %{}, [], Runner)
    uid = Runner.fiber("tests/terminal")["uid"]

    Shuttle.SessionLedger.record(
      fiber: "tests/terminal",
      uid: uid,
      session: id,
      thread_id: id,
      harness: "codex",
      kind: :resume,
      at: System.system_time(:millisecond) + 1
    )

    assert %{"thread_id" => ^id} = Shuttle.SessionLedger.latest_for_session(id)

    assert {:error, :session_owner_mismatch} =
             AppWorkers.reserve_resume(id, "tests/copied", "OTHER", Runner.felt_root())

    assert {:ok, %{"resume_origin" => %{"uid" => ^uid, "host" => host}}} = AppWorkers.get(id)
    assert host == Poller.own_host_id()
    App.set(:calls, [])
    assert {:ok, ref} = dispatch("tests/terminal", resume_mode: "previous")
    assert ref == AppWorkers.ref(id)
    assert {:ok, record} = AppWorkers.get(id)
    assert record["uid"] == uid
    assert record["felt_store"] == Runner.felt_root()
    assert record["backend_endpoint"] == Shuttle.CodexApp.Transport.default_socket()
    assert [{:resume, ^id, _}, {:turn, ^id, _, _}, {:read, ^id}, {:resume, ^id, []}] = App.calls()
  end

  test "embedded migration refuses unknown process observations without native calls" do
    id = embedded_fiber()

    assert {:error, :already_running} =
             dispatch("tests/terminal", runner: UnknownHolderRunner, resume_mode: "previous")

    assert {:error, {:unknown, _}} = AppWorkers.import_embedded(id, %{}, [], UnknownHolderRunner)

    assert [] = App.calls()
  end

  defmodule ReceiverHolderRunner do
    def cmd("ps", _args, _opts), do: {"813 1 /usr/bin/sleep 60\n", 0}

    def cmd("shuttle", ["process-identity", "813"], _opts),
      do: Shuttle.Env.app(:test_receiver_identity, {~s({"status":"unknown"}), 0})

    def cmd(cmd, args, opts), do: Runner.cmd(cmd, args, opts)
  end

  defp embedded_receiver(id, start) do
    root = Shuttle.Env.app(:app_workers_dir)
    Env.put_env("SHUTTLE_DATA_DIR", root)
    key = :crypto.hash(:sha256, id) |> Base.encode16(case: :lower)
    dir = Path.join([root, "mailboxes", "codex", key])
    File.mkdir_p!(dir)

    File.write!(
      Path.join(dir, "receiver.json"),
      Jason.encode!(%{"id" => id, "host" => Poller.own_host_id(), "pid" => 813, "start" => start})
    )
  end

  test "a recycled hook PID permits managed migration of the exact embedded ID" do
    id = embedded_fiber()
    embedded_receiver(id, "123456")
    Env.put_app_env(:test_receiver_identity, {~s({"status":"present","start":"654321"}), 0})

    assert {:ok, ref} =
             dispatch("tests/terminal", runner: ReceiverHolderRunner, resume_mode: "previous")

    assert ref == AppWorkers.ref(id)
    assert [{:resume, ^id, _}, {:turn, ^id, _, _}, {:read, ^id}, {:resume, ^id, []}] = App.calls()
    assert {:ok, record} = AppWorkers.get(id)
    assert record["backend_host"] == Poller.own_host_id()
    assert record["backend_endpoint"] == Shuttle.CodexApp.Transport.default_socket()
  end

  test "a recycled hook PID permits exact-ID History import" do
    id = embedded_fiber()
    embedded_receiver(id, "1700000000.123456")

    Env.put_app_env(
      :test_receiver_identity,
      {~s({"status":"present","start":"1700000001.123456"}), 0}
    )

    assert {:ok, %{"id" => ^id}} = AppWorkers.import_embedded(id, %{}, [], ReceiverHolderRunner)
    assert [{:resume, ^id, []}] = App.calls()
    assert {:ok, record} = AppWorkers.get(id)
    assert record["backend_host"] == Poller.own_host_id()
  end

  test "unknown receiver lifetime blocks managed migration and History with zero native RPC" do
    id = embedded_fiber()

    for start <- ["123456", "1700000000.123456", nil, ""] do
      embedded_receiver(id, start)

      for result <- [{~s({"status":"unknown"}), 0}, {"permission denied", 1}] do
        Env.put_app_env(:test_receiver_identity, result)

        assert {:error, {:transcript_held, _}} =
                 dispatch("tests/terminal", runner: ReceiverHolderRunner, resume_mode: "previous")

        assert {:error, {:unknown, _}} =
                 AppWorkers.import_embedded(id, %{}, [], ReceiverHolderRunner)

        assert [] = App.calls()
        assert {:error, :not_found} = AppWorkers.get(id)
      end
    end
  end

  test "matching hook lifetime blocks embedded import even without a UUID in argv" do
    id = embedded_fiber()
    embedded_receiver(id, "123456")
    Env.put_app_env(:test_receiver_identity, {~s({"status":"present","start":"123456"}), 0})
    assert {:error, {:held, _}} = AppWorkers.import_embedded(id, %{}, [], ReceiverHolderRunner)
    assert [] = App.calls()
  end

  test "embedded migration rejects remote or App Server ledger provenance without native calls" do
    id = embedded_fiber()
    row = Shuttle.SessionLedger.latest_for_session(id)

    for patch <- [%{"host" => "other-host"}, %{"thread_id" => id}, %{"host" => nil}] do
      File.write!(
        Shuttle.SessionLedger.default_path(),
        Jason.encode!(Map.merge(row, patch)) <> "\n"
      )

      assert {:error, :embedded_origin_unverified} =
               dispatch("tests/terminal", resume_mode: "previous")

      assert [] = App.calls()
    end
  end

  test "embedded migration refuses malformed native acknowledgments and never creates a fresh thread" do
    id = embedded_fiber()

    for result <- [{:ok, %{"id" => "other"}}, {:ok, nil}, {:error, :not_found}] do
      App.set(:resume_result, result)
      assert {:error, _} = dispatch("tests/terminal", resume_mode: "previous")
      assert {:error, :not_found} = AppWorkers.get(id)
      refute Enum.any?(App.calls(), &match?({:start, _}, &1))
    end
  end

  test "clean handoff remains fresh while explicit previous resumes the embedded identity" do
    embedded_fiber()
    saved = Runner.fiber("tests/terminal")
    saved = put_in(saved, ["shuttle", "runtime", "dispatched_at"], "2026-01-01T00:00:00Z")
    saved = put_in(saved, ["shuttle", "runtime", "handed_off_at"], "2026-01-01T00:01:00Z")
    assert :fresh = Dispatcher.check_resume_intent(saved)
    assert {:previous, _} = Dispatcher.check_resume_intent(saved, resume_mode: "previous")
    Runner.set_fiber("tests/terminal", saved)
    assert {:ok, _} = dispatch("tests/terminal")

    assert [
             {:start, _},
             {:turn, "app-session-1", _, _},
             {:read, "app-session-1"},
             {:resume, "app-session-1", []}
           ] = App.calls()
  end

  test "live embedded worker is boot-adopted as terminal and watched without native mutations" do
    embedded_fiber()
    uid = Runner.fiber("tests/terminal")["uid"]
    session = Dispatcher.session_name("tests/terminal", uid)
    Runner.add_tmux_session(session)

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    await_boot_cycle!(poller)
    assert %{session: ^session, pid: watcher} = :sys.get_state(poller).running[uid]
    assert Process.alive?(watcher)
    assert [] = App.calls()
    assert [] = AppWorkers.active()
    Runner.remove_tmux_session(session)
    send(poller, :run_poll_cycle)
    assert eventually(fn -> not Process.alive?(watcher) end)
    assert [] = App.calls()
  end

  test "unknown embedded Codex identity cannot migrate while an embedded process holds it" do
    embedded_fiber()

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

  test "previous managed dispatch refuses corrupt owners without native operations" do
    fiber("tests/corrupt-resume")
    saved = Runner.fiber("tests/corrupt-resume")

    Runner.set_fiber(
      "tests/corrupt-resume",
      put_in(saved, ["shuttle", "runtime"], %{"session_uuid" => "corrupt-resume"})
    )

    File.mkdir_p!(AppWorkers.root())
    path = Path.join(AppWorkers.root(), "corrupt-resume.json")

    for {bytes, reason} <- [
          {"null", :ownership_record_unreadable},
          {Jason.encode!(%{"session_uuid" => "other", "thread_id" => "other"}),
           :session_owner_mismatch}
        ] do
      File.write!(path, bytes)
      assert {:error, ^reason} = dispatch("tests/corrupt-resume", resume_mode: "previous")

      assert {:error, ^reason} =
               AppWorkers.claim_or_adopt("corrupt-resume", saved, Runner.felt_root())

      assert App.calls() == []
      assert File.read!(path) == bytes
    end
  end

  test "adoption propagates corrupt owner errors appearing during native verification" do
    fiber("tests/adopt-race")
    File.mkdir_p!(AppWorkers.root())
    path = Path.join(AppWorkers.root(), "adopt-race.json")
    App.set(:read_hook, fn "adopt-race" -> File.write!(path, "null") end)

    assert {:error, :ownership_record_unreadable} =
             AppWorkers.claim_or_adopt(
               "adopt-race",
               Runner.fiber("tests/adopt-race"),
               Runner.felt_root()
             )

    assert App.calls() == [{:read, "adopt-race"}]
    assert File.read!(path) == "null"
  end

  test "malformed records cannot redirect status writes or register another thread" do
    File.mkdir_p!(AppWorkers.root())
    other = Path.join(AppWorkers.root(), "other.json")

    original =
      Jason.encode!(%{"session_uuid" => "other", "thread_id" => "other", "active" => true})

    File.write!(other, original)
    path = Path.join(AppWorkers.root(), "corrupt.json")

    for record <- [
          nil,
          [],
          42,
          %{},
          %{"session_uuid" => "other", "thread_id" => "other", "active" => true},
          %{"session_uuid" => "corrupt", "thread_id" => "other", "active" => true}
        ] do
      bytes = Jason.encode!(record)
      File.write!(path, bytes)
      assert %{state: :unknown, phase: nil} = AppWorkers.status("corrupt")
      assert {:error, _} = AppWorkers.update("corrupt", %{"backend_error" => "rejected"})
      assert {:error, _} = AppWorkers.check_known_endpoint("corrupt")
      assert File.read!(other) == original
      assert File.read!(path) == bytes
      assert [%{"session_uuid" => "other"}] = AppWorkers.active()
    end
  end

  test "dangling owner records are not unmanaged sessions" do
    assert :ok = AppWorkers.check_known_endpoint("dangling-owner")
    File.mkdir_p!(AppWorkers.root())
    path = Path.join(AppWorkers.root(), "dangling-owner.json")
    File.ln_s!(Path.join(AppWorkers.root(), "missing-target"), path)

    assert {:error, :ownership_record_unreadable} =
             AppWorkers.check_known_endpoint("dangling-owner")
  end

  test "native operations reject records naming another thread" do
    fiber("tests/app")
    assert {:ok, _} = dispatch("tests/app")
    before = App.calls()

    for field <- ["session_uuid", "thread_id"] do
      path = Path.join(AppWorkers.root(), "app-session-1.json")
      original = File.read!(path)
      record = Jason.decode!(original) |> Map.put(field, "another-thread")
      File.write!(path, Jason.encode!(record))

      assert {:error, :session_owner_mismatch} = AppWorkers.check_endpoint("app-session-1")
      assert {:error, :session_owner_mismatch} = AppWorkers.check_known_endpoint("app-session-1")
      assert {:error, :session_owner_mismatch} = AppWorkers.call("app-session-1", :interrupt)
      assert App.calls() == before
      File.write!(path, original)
    end
  end

  test "UID is authoritative when a slug is reused" do
    :ok =
      AppWorkers.put(%{
        "session_uuid" => "old",
        "thread_id" => "old",
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
        "thread_id" => "store-bound",
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
        "thread_id" => "resume-race",
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

    assert {:error, :ownership_record_unreadable} = AppWorkers.get(id)

    assert {:error, :ownership_record_unreadable} =
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
      "thread_id" => "private-thread",
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
    :ok = AppWorkers.update("app-session-1", %{"started_at" => "2026-01-01T00:00:00Z"})
    assert {:ok, ^session} = dispatch("tests/app", resume_mode: "previous")
    assert {:ok, %{"started_at" => started_at}} = AppWorkers.get("app-session-1")
    assert started_at != "2026-01-01T00:00:00Z"
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

  test "completion evidence is scoped to the owned assignment, including a missing dispatch mirror" do
    start = ~U[2026-10-20 12:00:00Z]

    build = fn dispatch, handoff ->
      %{"shuttle" => %{"runtime" => %{"dispatched_at" => dispatch, "handed_off_at" => handoff}}}
    end

    refute WorkerBackend.assignment_ended?(%{}, start)
    refute WorkerBackend.assignment_ended?(build.(nil, "2026-10-20T11:59:59Z"), start)

    refute WorkerBackend.assignment_ended?(
             build.("2026-10-20T12:00:01Z", "2026-10-20T12:00:00Z"),
             start
           )

    assert WorkerBackend.assignment_ended?(build.(nil, "2026-10-20T12:00:00Z"), start)
    assert WorkerBackend.assignment_ended?(%{"status" => "closed"}, start)
  end

  for remote <- [:idle, :not_loaded, :missing, :running, :unknown], boot? <- [true, false] do
    test "handoff with backend #{remote} at boot=#{boot?} separates assignment from conversation" do
      remote = unquote(remote)
      boot? = unquote(boot?)
      fiber("tests/app")
      {:ok, session} = dispatch("tests/app")
      App.set(:state, remote)
      # Do not let a watcher recover the unloaded thread before reconciliation.
      App.set(:read_result, {:error, :disconnected})
      App.set(:interrupt_result, {:error, :disconnected})

      if boot?, do: end_assignment()

      {:ok, poller} =
        start_poller!(
          runner: Runner,
          name: nil,
          felt_stores: [Runner.felt_root()],
          poll_interval_ms: 60_000
        )

      await_boot_cycle!(poller)

      unless boot? do
        assert %{session: ^session} = Poller.worker_status(poller, "tests/app")
        end_assignment()
        before = :sys.get_state(poller).poll_cycles
        send(poller, :run_poll_cycle)
        eventually(fn -> :sys.get_state(poller).poll_cycles > before end)
      end

      if remote in [:idle, :not_loaded, :missing] do
        assert nil == Poller.worker_status(poller, "tests/app")

        assert {:ok, %{"active" => false, "thread_id" => "app-session-1"}} =
                 AppWorkers.get("app-session-1")

        # Next-launch configuration replaces the assignment, never the old identity.
        Runner.set_shuttle(
          "tests/app",
          "kind: oneshot\nagent: claude-sonnet\nsurface: cli\nproject_dir: /tmp\n",
          "active"
        )

        assert {:ok, next} = Poller.dispatch_fiber(poller, "tests/app", force: true)
        assert next != session
        assert %{agent_id: "claude-sonnet"} = Poller.worker_status(poller, "tests/app")
      else
        assert %{session: ^session} = Poller.worker_status(poller, "tests/app")
        assert {:ok, %{"active" => true}} = AppWorkers.get("app-session-1")
      end

      refute Enum.any?(App.calls(), &match?({:interrupt, _}, &1))
    end
  end

  test "stale handoff cannot retire a newer owned assignment at boot" do
    fiber("tests/app")
    {:ok, session} = dispatch("tests/app")
    end_assignment()
    future = DateTime.add(DateTime.utc_now(), 60, :second)
    :ok = AppWorkers.update("app-session-1", %{"started_at" => DateTime.to_iso8601(future)})

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    await_boot_cycle!(poller)
    assert %{session: ^session, started_at: ^future} = Poller.worker_status(poller, "tests/app")
    assert {:ok, %{"active" => true}} = AppWorkers.get("app-session-1")
  end

  test "pause stops the Codex backend after disarming, while no-kill preserves it" do
    fiber("tests/app")
    {:ok, session} = dispatch("tests/app")

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    await_boot_cycle!(poller)
    assert {:ok, _} = Poller.lifecycle_transition(poller, :pause, "tests/app", ["--no-kill"])
    assert %{session: ^session} = Poller.worker_status(poller, "tests/app")
    refute Enum.any?(App.calls(), &match?({:interrupt, _}, &1))
    assert {:ok, _} = Poller.lifecycle_transition(poller, :pause, "tests/app", [])
    assert nil == Poller.worker_status(poller, "tests/app")
    assert {:ok, %{"active" => false}} = AppWorkers.get("app-session-1")
    assert {:interrupt, "app-session-1"} in App.calls()
  end

  defp end_assignment do
    Runner.put_shuttle_fields("tests/app", %{
      "handed_off_at" => DateTime.to_iso8601(DateTime.utc_now())
    })

    Runner.set_fiber("tests/app", Map.put(Runner.fiber("tests/app"), "status", "open"))
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
        "thread_id" => "race",
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
