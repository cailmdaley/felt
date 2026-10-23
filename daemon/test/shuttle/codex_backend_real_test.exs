defmodule Shuttle.CodexBackendRealTest do
  use ExUnit.Case, async: true
  @moduletag :integration
  @moduletag timeout: 90_000
  alias Shuttle.{CodexBackend, CodexEndpoint, Test.Env}

  defmodule Runner do
    def cmd("tmux", args, opts),
      do:
        Shuttle.Runner.Default.cmd(
          "tmux",
          ["-S", Shuttle.Env.get("SHUTTLE_TEST_CODEX_TMUX") | args],
          opts
        )

    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  test "real token-free server: launch, adoption, manager restart, SIGKILL recovery, uncertain holder and hostile-root control" do
    assert codex = Shuttle.Env.find_executable("codex")
    assert Shuttle.Env.find_executable("tmux")
    root = "/tmp/scb-#{System.unique_integer([:positive])}"
    endpoint = Path.join(root, "control.sock")
    assert :ok = CodexEndpoint.ensure_root(endpoint)
    on_exit(fn -> File.rm_rf!(root) end)
    home = Path.join(root, "home")
    File.mkdir!(home)
    File.chmod!(home, 0o700)
    codex_home = Path.join(home, ".codex")
    Env.put_env("HOME", home)
    Env.put_env("CODEX_HOME", codex_home)
    Env.put_env("SHUTTLE_CODEX_SOCKET", endpoint)
    Env.put_env("SHUTTLE_TEST_CODEX_TMUX", Path.join(root, "tmux.sock"))
    Env.put_app_env(:codex_backend, CodexBackend)
    Env.put_env("CODEX_THREAD_ID", "must-not-inherit")
    Env.put_env("SHUTTLE_FIBER_PATH", "/must/not/inherit")
    # Pin the executable lookup after a clean login shell without copying auth.
    File.write!(
      Path.join(home, ".bash_profile"),
      "export PATH='#{Path.dirname(codex)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'\n"
    )

    assert {_, 0} =
             Runner.cmd("tmux", ["new-session", "-d", "-s", "probe-anchor", "sleep", "90"],
               stderr_to_stdout: true
             )

    tmux_socket = Path.join(root, "tmux.sock")

    on_exit(fn ->
      Shuttle.Runner.Default.cmd("tmux", ["-S", tmux_socket, "kill-server"],
        stderr_to_stdout: true
      )

      File.rm_rf!(root)
    end)

    opts = [name: nil, endpoint: {:ok, endpoint}, runner: Runner, interval_ms: 100]
    manager = Env.start_scoped!({CodexBackend, opts})
    assert %{state: :ready, endpoint: ^endpoint} = await_ready(manager)
    pid = backend_pid(endpoint)
    assert pid > 0
    IO.puts("REAL_CODEX first_pid=#{pid} endpoint=#{endpoint}")
    assert %{state: :ready} = CodexBackend.check(endpoint: {:ok, endpoint}, runner: Runner)
    assert backend_pid(endpoint) == pid
    GenServer.stop(manager)
    assert :ok = CodexBackend.probe(endpoint)
    assert backend_pid(endpoint) == pid
    manager = Env.start_scoped!(Supervisor.child_spec({CodexBackend, opts}, id: :replacement))
    assert %{state: :ready} = await_ready(manager)
    assert backend_pid(endpoint) == pid
    IO.puts("REAL_CODEX adopted_pid=#{pid} after_manager_restart=true")

    # Hard death leaves the native alias/socket behind. Only the retained owned
    # dead pane plus a healthy process scan authorizes native stale recovery.
    assert {_, 0} =
             Shuttle.Runner.Default.cmd("kill", ["-KILL", Integer.to_string(pid)],
               stderr_to_stdout: true
             )

    new_pid = await_new_pid(manager, endpoint, pid)
    assert new_pid != pid
    assert :ok = CodexBackend.probe(endpoint)
    IO.puts("REAL_CODEX recovered_pid=#{new_pid} after_SIGKILL=true")

    # Negative control from the co-tenant's position: a precreated writable
    # root must prevent even a connection to a perfectly healthy server.
    File.chmod!(root, 0o777)

    assert %{state: :waiting, error: error} =
             CodexBackend.check(endpoint: {:ok, endpoint}, runner: Runner)

    assert error =~ "unsafe Codex endpoint root"
    assert backend_pid(endpoint) == new_pid
    File.chmod!(root, 0o700)
    assert %{state: :ready} = CodexBackend.check(endpoint: {:ok, endpoint}, runner: Runner)
    IO.puts("REAL_CODEX negative_control=unsafe_root_refused restored=ready")

    # Remove only the isolated test alias while the real holder is alive.
    # It must not become an invitation to create another server.
    GenServer.stop(manager)
    assert :ok = File.rm(endpoint)

    assert %{state: :waiting, error: message} =
             CodexBackend.check(endpoint: {:ok, endpoint}, runner: Runner)

    assert message =~ "live process holds"
    assert backend_pid(endpoint) == new_pid
    IO.puts("REAL_CODEX missing_alias_live_holder=held pid=#{new_pid}")
  end

  defp backend_pid(endpoint) do
    {:ok, processes} = Shuttle.WorkerProcess.scan(Runner)

    case Enum.find(processes, fn p ->
           String.contains?(p.args, "app-server --listen unix://" <> endpoint)
         end) do
      nil -> nil
      process -> process.pid
    end
  end

  defp await_ready(manager, deadline \\ nil) do
    deadline = deadline || System.monotonic_time(:millisecond) + 30_000
    health = CodexBackend.status(manager)

    if health.state == :ready,
      do: health,
      else: retry(fn -> await_ready(manager, deadline) end, deadline, health)
  end

  defp await_new_pid(manager, endpoint, old_pid, deadline \\ nil) do
    deadline = deadline || System.monotonic_time(:millisecond) + 30_000
    health = CodexBackend.status(manager)
    pid = backend_pid(endpoint)

    if health.state == :ready and is_integer(pid) and pid != old_pid,
      do: pid,
      else: retry(fn -> await_new_pid(manager, endpoint, old_pid, deadline) end, deadline, health)
  end

  defp retry(fun, deadline, health) do
    if System.monotonic_time(:millisecond) >= deadline do
      IO.inspect(
        Runner.cmd(
          "tmux",
          [
            "list-panes",
            "-a",
            "-F",
            "\#{session_name}|\#{pane_dead}|\#{pane_dead_status}|\#{pane_start_command}"
          ], stderr_to_stdout: true), label: "panes")

      if health.endpoint do
        IO.inspect(
          Runner.cmd(
            "tmux",
            ["capture-pane", "-p", "-t", "=" <> CodexBackend.session(health.endpoint) <> ":"],
            stderr_to_stdout: true
          ), label: "screen")
      end

      flunk(inspect(health))
    end

    receive do
    after
      30 -> fun.()
    end
  end
end
