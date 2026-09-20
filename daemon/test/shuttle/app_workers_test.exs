defmodule Shuttle.AppWorkersTest do
  use ExUnit.Case
  import Shuttle.Test.PollerHelpers
  alias Shuttle.{AppWorkers, Dispatcher, Poller, WorkerBackend}
  alias Shuttle.Test.FeltStoreRunner, as: Runner

  defmodule App do
    use Agent

    def start_link(_),
      do:
        Agent.start_link(fn -> %{calls: [], result: {:ok, %{"id" => "turn-1"}}, state: :idle} end,
          name: __MODULE__
        )

    def calls, do: Agent.get(__MODULE__, & &1.calls)
    def set(key, value), do: Agent.update(__MODULE__, &Map.put(&1, key, value))

    defp record(call),
      do: Agent.update(__MODULE__, &Map.update!(&1, :calls, fn calls -> calls ++ [call] end))

    def start_thread(opts) do
      record({:start, opts})
      {:ok, %{"id" => "app-session-1"}}
    end

    def resume_thread(id, opts) do
      record({:resume, id, opts})
      {:ok, %{"id" => id}}
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
    def cmd("felt", ["shuttle", "mark-runtime" | _], _opts), do: {"write failed", 1}
    def cmd(cmd, args, opts), do: Runner.cmd(cmd, args, opts)
  end

  defmodule MissingTmuxRunner do
    def cmd("tmux", _args, _opts), do: {"tmux unavailable", :timeout}
    def cmd(cmd, args, opts), do: Runner.cmd(cmd, args, opts)
  end

  setup do
    start_supervised!(Runner)
    start_supervised!(App)
    root = Path.join(System.tmp_dir!(), "app-workers-test-#{System.unique_integer([:positive])}")
    previous_root = Application.get_env(:shuttle, :app_workers_dir)
    previous_client = Application.get_env(:shuttle, :codex_app_client)
    Application.put_env(:shuttle, :app_workers_dir, root)
    Application.put_env(:shuttle, :codex_app_client, App)

    on_exit(fn ->
      Application.put_env(:shuttle, :app_workers_dir, previous_root)

      if previous_client,
        do: Application.put_env(:shuttle, :codex_app_client, previous_client),
        else: Application.delete_env(:shuttle, :codex_app_client)

      File.rm_rf!(root)
    end)

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

  test "dispatch records exact app identity before its first turn and never launches tmux" do
    fiber("tests/app")
    assert {:ok, "codex-app:app-session-1"} = dispatch("tests/app")
    assert {:ok, record} = AppWorkers.get("app-session-1")
    assert record["fiber_id"] == "tests/app"
    assert record["launch_state"] == "running"
    assert record["turn_id"] == "turn-1"
    assert [{:start, _}, {:turn, "app-session-1", prompt, _}] = App.calls()
    assert prompt =~ "ChatGPT app"
    assert prompt =~ "env -u TMUX"

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

  test "UID is authoritative when a slug is reused" do
    :ok =
      AppWorkers.put(%{
        "session_uuid" => "old",
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

  test "idle conversations survive poller restart, adopt once, and resume in place" do
    fiber("tests/app")
    assert {:ok, session} = dispatch("tests/app")

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        name: nil,
        felt_stores: [Runner.felt_root()],
        poll_interval_ms: 60_000
      )

    assert %{session: ^session} = Poller.worker_status(poller, "tests/app")

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

  test "stopped app resumes its exact UUID without a CLI fallback" do
    fiber("tests/app")
    assert {:ok, session} = dispatch("tests/app")
    assert {"", 0} = WorkerBackend.stop(Runner, session)
    assert {:ok, ^session} = dispatch("tests/app", resume_mode: "previous")
    assert Enum.any?(App.calls(), &match?({:resume, "app-session-1", _}, &1))
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
    path = System.get_env("PATH")
    System.put_env("PATH", "/does-not-exist")
    on_exit(fn -> System.put_env("PATH", path) end)
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
    bin = Path.join(AppWorkers.root(), "bin")
    File.mkdir_p!(bin)
    File.write!(Path.join(bin, "tmux"), "#!/bin/sh\nexit 1\n")
    File.chmod!(Path.join(bin, "tmux"), 0o755)
    path = System.get_env("PATH")
    System.put_env("PATH", bin)
    on_exit(fn -> System.put_env("PATH", path) end)
    assert {:error, :already_running} = dispatch("tests/app", runner: MissingTmuxRunner)
    assert App.calls() == []
  end

  test "concurrent randomized claims preserve one authoritative owner" do
    :ok =
      AppWorkers.put(%{
        "session_uuid" => "race",
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
        timeout: 10_000
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
  defp eventually(fun, attempts \\ 100)
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
