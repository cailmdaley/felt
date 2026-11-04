defmodule Shuttle.AssignmentBoundaryRegressionTest do
  use ExUnit.Case, async: true
  alias Shuttle.Test.{Env, FeltStoreRunner, FiberUid}
  alias Shuttle.Poller.{State, SessionReconciliation}

  defmodule PrivateTmuxRunner do
    @behaviour Shuttle.Runner
    def cmd("tmux", args, opts),
      do:
        Shuttle.Runner.Default.cmd(
          "tmux",
          ["-S", Shuttle.Env.app(:lifecycle_test_socket), "-f", "/dev/null" | args],
          opts
        )

    def cmd(command, args, opts), do: FeltStoreRunner.cmd(command, args, opts)
  end

  defmodule FailedRecordRunner do
    @behaviour Shuttle.Runner
    def cmd("tmux", ["new-session" | _] = args, opts) do
      # Launch a harmless real worker without invoking an agent harness.
      PrivateTmuxRunner.cmd("tmux", Enum.drop(args, -3) ++ ["sleep", "60"], opts)
    end

    def cmd("tmux", args, opts), do: PrivateTmuxRunner.cmd("tmux", args, opts)

    def cmd("shuttle", args, opts) do
      if "mark-runtime" in args,
        do: {"simulated post-launch recording failure", 1},
        else: FeltStoreRunner.cmd("shuttle", args, opts)
    end

    def cmd(command, args, opts), do: FeltStoreRunner.cmd(command, args, opts)
  end

  setup do
    FeltStoreRunner.start!()
    Env.put_env("SHUTTLE_STORES", FeltStoreRunner.felt_root())
    Env.put_env("SHUTTLE_HOST", "test-host")
    :ok
  end

  test "fresh dispatch refuses a candidate reassigned to another host" do
    FeltStoreRunner.set_shuttle("foreign", "kind: oneshot\nhost: elsewhere\nagent: claude-sonnet")

    assert {:error, {:foreign_host, _}} =
             Shuttle.Dispatcher.dispatch("foreign",
               runner: FeltStoreRunner,
               felt_store: FeltStoreRunner.felt_root(),
               work_dir: FeltStoreRunner.felt_root(),
               own_host_id: "test-host"
             )

    refute Enum.any?(FeltStoreRunner.commands(), fn {command, args} ->
             command == "tmux" and "new-session" in args
           end)
  end

  @tag :tmp_dir
  test "a foreign closed constitution cannot close a real terminal on a private tmux socket" do
    socket = "/tmp/ism-lifecycle-#{System.unique_integer([:positive])}.sock"
    Env.put_app_env(:lifecycle_test_socket, socket)
    session = FiberUid.session("foreign")

    FeltStoreRunner.set_shuttle(
      "foreign",
      "kind: standing\nhost: elsewhere\nagent: claude-sonnet",
      "closed"
    )

    assert {_, 0} =
             System.cmd("tmux", [
               "-S",
               socket,
               "-f",
               "/dev/null",
               "new-session",
               "-d",
               "-s",
               session,
               "sleep 60"
             ])

    try do
      state = %State{
        own_host_id: "test-host",
        runner: PrivateTmuxRunner,
        felt_stores: [FeltStoreRunner.felt_root()]
      }

      assert SessionReconciliation.adopt_session(state, "foreign", session).running == %{}
      assert {_, 0} = System.cmd("tmux", ["-S", socket, "has-session", "-t", "=" <> session])
    after
      System.cmd("tmux", ["-S", socket, "kill-server"], stderr_to_stdout: true)
    end
  end

  test "a genuine launch can survive failure to record its dispatch marker" do
    socket = "/tmp/ism-lifecycle-launch-#{System.unique_integer([:positive])}.sock"
    Env.put_app_env(:lifecycle_test_socket, socket)
    root = FeltStoreRunner.felt_root()

    FeltStoreRunner.set_shuttle("unrecorded", """
    kind: standing
    host: test-host
    agent: claude-sonnet
    project_dir: #{root}
    schedule:
      expr: "0 8 * * *"
      tz: Europe/Paris
    """)

    try do
      assert {_, 0} =
               System.cmd("tmux", [
                 "-S",
                 socket,
                 "-f",
                 "/dev/null",
                 "new-session",
                 "-d",
                 "-s",
                 "anchor",
                 "sleep 60"
               ])

      assert {:ok, session} =
               Shuttle.Dispatcher.dispatch("unrecorded",
                 runner: FailedRecordRunner,
                 felt_store: root,
                 work_dir: root,
                 own_host_id: "test-host"
               )

      assert {_, 0} = System.cmd("tmux", ["-S", socket, "has-session", "-t", "=" <> session])
      assert {:ok, output} = Shuttle.CLI.run(["-C", root, "show", "unrecorded", "--json"])
      current = Jason.decode!(output)
      assert get_in(current, ["shuttle", "runtime", "dispatched_at"]) == nil
    after
      System.cmd("tmux", ["-S", socket, "kill-server"], stderr_to_stdout: true)
    end
  end

  for status <- ["active", "closed"] do
    test "a foreign #{status} document grants neither adoption nor terminal teardown authority" do
      FeltStoreRunner.set_shuttle(
        "foreign",
        "kind: standing\nhost: elsewhere\nagent: claude-sonnet",
        unquote(status)
      )

      session = FiberUid.session("foreign")
      FeltStoreRunner.add_tmux_session(session)

      state = %State{
        own_host_id: "test-host",
        runner: FeltStoreRunner,
        felt_stores: [FeltStoreRunner.felt_root()],
        self_ref: self(),
        heartbeat_interval_ms: 60_000
      }

      result = SessionReconciliation.adopt_session(state, "foreign", session)
      # Stop test-owned watchers even when exercising the unfixed boundary.
      for {_, meta} <- result.running,
          is_pid(meta[:pid]),
          do: Shuttle.WorkerWatcher.stop(meta.pid)

      assert result.running == %{}

      refute Enum.any?(FeltStoreRunner.commands(), fn {command, args} ->
               command == "tmux" and "kill-session" in args
             end)
    end
  end
end
