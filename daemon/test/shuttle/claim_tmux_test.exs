defmodule Shuttle.ClaimTmuxTest do
  @moduledoc """
  The claim transfer end to end against a real tmux server on a private
  socket: a daemon launch, a claim from inside it, the status of both fibers,
  a restart, a stop by exact pane, and the released fiber launching again.
  """

  use ExUnit.Case, async: true
  import Shuttle.Test.PollerHelpers
  alias Shuttle.{Poller, Tmux, WorkerBackend}
  alias Shuttle.Test.{Env, FeltStoreRunner}
  @moduletag :tmp_dir
  @moduletag skip: is_nil(System.find_executable("tmux"))

  defmodule Runner do
    def cmd("tmux", ["new-session" | _] = args, opts) do
      # Exercise the real launch and claim path without starting a model.
      script = List.last(args)
      if String.ends_with?(script, ".sh"), do: File.write!(script, "#!/bin/bash\nsleep 300\n")
      tmux(args, opts)
    end

    def cmd("tmux", args, opts), do: tmux(args, opts)

    # Only what runs under this test's tmux server is visible.
    def cmd("ps", ["-ww", "-o", "pid=,ppid=,args=" | _] = args, opts) do
      case Shuttle.Runner.Default.cmd("ps", args, opts) do
        {output, 0} ->
          procs = Shuttle.WorkerProcess.parse(output)
          server = Shuttle.Env.app(:claim_test_server_pid)

          scoped =
            Enum.filter(procs, fn proc ->
              proc.pid == server or Shuttle.WorkerProcess.tmux_server(procs, proc) == server
            end)

          {Enum.map_join(scoped, "\n", &"#{&1.pid} #{&1.ppid} #{&1.args}"), 0}

        failure ->
          failure
      end
    end

    def cmd("ps", args, opts), do: Shuttle.Runner.Default.cmd("ps", args, opts)

    # A pane kill is the only stop this test expects.
    def cmd("kill", args, _opts) do
      send(Shuttle.Env.app(:claim_test_owner), {:unexpected_signal, args})
      {"unexpected signal refused", 1}
    end

    def cmd("shuttle", ["process-identity" | _] = args, opts),
      do: Shuttle.Runner.Default.cmd("shuttle", args, opts)

    def cmd(command, args, opts), do: FeltStoreRunner.cmd(command, args, opts)

    defp tmux(args, opts),
      do:
        Shuttle.Runner.Default.cmd(
          "tmux",
          ["-S", Shuttle.Env.get("CLAIM_TEST_SOCKET"), "-f", "/dev/null" | args],
          opts
        )
  end

  test "launch, claim, status, restart, stop by pane and relaunch", %{tmp_dir: dir} do
    FeltStoreRunner.start!()
    Env.put_env("SHUTTLE_DATA_DIR", dir)
    Env.delete_env("SHUTTLE_SESSIONS_FILE")
    Env.put_app_env(:claim_test_owner, self())
    socket = Path.join(System.tmp_dir!(), "claim-#{System.unique_integer([:positive])}.sock")
    Env.put_env("CLAIM_TEST_SOCKET", socket)

    on_exit(fn ->
      Shuttle.Env.cmd("tmux", ["-S", socket, "kill-server"], stderr_to_stdout: true)
    end)

    assert {_, 0} =
             Runner.cmd("tmux", ["new-session", "-d", "-s", "test-anchor", "sleep", "300"], [])

    {pid, 0} = Runner.cmd("tmux", ["display-message", "-p", "-t", "=test-anchor:", "\#{pid}"], [])
    Env.put_app_env(:claim_test_server_pid, pid |> String.trim() |> String.to_integer())

    for id <- ["tests/real-a", "tests/real-b"] do
      FeltStoreRunner.set_fiber(id, make_fiber(id))
      FeltStoreRunner.set_shuttle(id, oneshot_shuttle())
    end

    runtime = fn id -> get_in(FeltStoreRunner.fiber(id), ["shuttle", "runtime"]) end

    # Launch: the worker runs under the conversation its fiber names.
    p = start()
    assert {:ok, session} = Poller.dispatch_fiber(p, "tests/real-a", [])
    uuid = runtime.("tests/real-a")["session_uuid"]
    assert Shuttle.Transcript.valid_session?(uuid)
    Shuttle.Test.TranscriptHelpers.write_transcript(uuid)
    assert %{pid: watcher, holder_uuid: ^uuid} = Poller.worker_status(p, "tests/real-a")

    # Claim from inside that session.
    assert {:ok, %{session: ^session}} =
             Poller.claim_session(p, "tests/real-b", session, session_uuid: uuid)

    # Status of the old and the new fiber.
    refute Process.alive?(watcher)
    assert Poller.worker_status(p, "tests/real-a") == nil

    assert Shuttle.Continuation.clean_handoff_since_dispatch?(
             FeltStoreRunner.fiber("tests/real-a")
           )

    assert %{holder_uuid: ^uuid, session: ^session} = Poller.worker_status(p, "tests/real-b")
    assert runtime.("tests/real-b")["session_uuid"] == uuid
    assert Tmux.session_status(Runner, session) == :alive
    assert {:ok, :no_session} = Poller.kill_session(p, "tests/real-a")
    assert Tmux.session_status(Runner, session) == :alive

    # A restart adopts B by its conversation; A is not resurrected.
    GenServer.stop(p)
    restarted = start(boot_quarantine: true)
    assert Poller.worker_status(restarted, "tests/real-a") == nil

    assert %{holder_uuid: ^uuid, session: ^session} =
             b = Poller.worker_status(restarted, "tests/real-b")

    # A server that loses its socket still holds the worker, and nothing it
    # cannot see is signalled.
    File.rename!(socket, socket <> ".hidden")

    try do
      assert WorkerBackend.session_status(Runner, WorkerBackend.handle(b)) == :alive
      assert {:ok, :no_session} = Poller.kill_session(restarted, "tests/real-a")
    after
      File.rename!(socket <> ".hidden", socket)
    end

    # Stop B by its exact pane.
    assert {:ok, ^session} = Poller.kill_session(restarted, "tests/real-b")
    assert Tmux.session_status(Runner, session) == :gone
    assert WorkerBackend.session_status(Runner, WorkerBackend.handle(b)) == :gone

    # Release: A launches fresh, never onto B's conversation.
    assert :ok = Poller.release_boot_quarantine(restarted)
    assert Shuttle.Dispatcher.check_resume_intent(FeltStoreRunner.fiber("tests/real-a")) == :fresh
    assert {:ok, newer} = Poller.dispatch_fiber(restarted, "tests/real-a", [])
    refute newer == session
    refute runtime.("tests/real-a")["session_uuid"] == uuid
    assert {:ok, ^newer} = Poller.kill_session(restarted, "tests/real-a")
    refute_received {:unexpected_signal, _}
  end

  defp start(opts \\ []) do
    {:ok, p} =
      start_poller!(
        Keyword.merge(
          [
            runner: Runner,
            felt_stores: [FeltStoreRunner.felt_root()],
            max_concurrent_workers: 0,
            poll_interval_ms: 600_000,
            heartbeat_interval_ms: 600_000
          ],
          opts
        )
      )

    await_boot_cycle!(p)
    p
  end
end
