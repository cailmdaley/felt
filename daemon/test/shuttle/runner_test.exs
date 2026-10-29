defmodule Shuttle.RunnerTest do
  use ExUnit.Case, async: true

  test "default runner clears inherited TMUX for tmux commands" do
    env_path =
      Path.join(
        System.tmp_dir!(),
        "shuttle-runner-tmux-env-#{System.unique_integer([:positive])}"
      )

    Shuttle.Test.FakeCli.install!(%{
      "tmux" => """
      #!/usr/bin/env bash
      printf '%s' "$TMUX" > "$TMUX_ENV_FILE"
      """
    })

    Shuttle.Test.Env.put_env("TMUX_ENV_FILE", env_path)
    Shuttle.Test.Env.put_env("TMUX", "/private/tmp/tmux-test/private,1,0")
    on_exit(fn -> File.rm(env_path) end)

    assert {"", 0} = Shuttle.Runner.Default.cmd("tmux", ["ls"], stderr_to_stdout: true)
    assert File.read!(env_path) == ""
  end

  @tag :tmp_dir
  test "lookup reuses PATH results and a stale spawn retries once", %{tmp_dir: dir} do
    first = Path.join(dir, "first")
    second = Path.join(dir, "second")
    File.mkdir_p!(first)
    File.mkdir_p!(second)
    command = "cached-tool"
    a = Path.join(first, command)
    b = Path.join(second, command)
    File.write!(a, "#!/bin/sh\nprintf first")
    File.write!(b, "#!/bin/sh\nprintf second")
    File.chmod!(a, 0o755)
    File.chmod!(b, 0o755)
    Shuttle.Test.Env.put_env("PATH", first <> ":" <> second)

    assert Shuttle.Env.find_executable(command) == a
    File.rm!(a)
    # A fresh lookup would return b; this proves the result was cached.
    assert Shuttle.Env.find_executable(command) == a
    assert {"second", 0} = Shuttle.Runner.Default.cmd(command, [], [])
    assert Shuttle.Env.find_executable(command) == b

    File.chmod!(b, 0o644)
    assert {_message, 127} = Shuttle.Runner.Default.cmd(command, [], [])
    File.chmod!(b, 0o755)
    # Negative lookups aren't retained when a tool is installed or repaired.
    assert {"second", 0} = Shuttle.Runner.Default.cmd(command, [], [])

    Shuttle.Test.Env.put_env("PATH", first)
    assert Shuttle.Env.find_executable(command) == nil
    Shuttle.Test.Env.delete_env("PATH")
    assert Shuttle.Env.find_executable(b) == b
    assert {"second", 0} = Shuttle.Runner.Default.cmd(b, [], [])
  end

  test "relative PATH lookup and runner tolerate an unlinked working directory" do
    script = """
    detached = Path.join(System.tmp_dir!(), "shuttle-detached-cwd-#{System.unique_integer([:positive])}")
    File.mkdir_p!(detached)
    File.cd!(detached)
    File.rm_rf!(detached)
    {:error, _reason} = File.cwd()

    # Empty PATH components resolve against cwd. Absolute candidates later in
    # PATH must remain usable even when cwd no longer names a directory.
    System.put_env("PATH", "/bin::/usr/bin:")
    executable = Shuttle.Env.find_executable("sh")
    true = executable in ["/bin/sh", "/usr/bin/sh"]
    true = Shuttle.Env.find_executable("sh") in ["/bin/sh", "/usr/bin/sh"]
    # Port.open cannot apply its child `cd` before spawning from a cwd that no
    # longer exists, so this host reports its documented :enoent tuple.
    {"sh: command not found", 127} =
      Shuttle.Runner.Default.cmd("sh", ["-c", "printf 'runner ok'"], cd: "/")
    IO.puts("detached cwd lookup ok")
    """

    assert {"detached cwd lookup ok\n", 0} =
             System.cmd("elixir", ["-pa", "_build/test/lib/shuttle/ebin", "-e", script],
               env: [{"ERL_FLAGS", "+S 2:2"}],
               stderr_to_stdout: true
             )
  end

  test "a command that completes within its bound is unaffected" do
    assert {"hi\n", 0} = Shuttle.Runner.Default.cmd("echo", ["hi"], timeout_ms: 5_000)
  end

  test "output at the byte ceiling is returned intact across port messages" do
    assert {"12345678", 0} =
             Shuttle.Runner.Default.cmd("bash", ["-c", "printf 1234; sleep 0.02; printf 5678"],
               max_output_bytes: 8,
               timeout_ms: 5_000
             )
  end

  @tag :tmp_dir
  test "overflowing output kills the real child and discards partial output", %{tmp_dir: root} do
    pid_file = Path.join(root, "pid")

    assert {message, :output_limit} =
             Shuttle.Runner.Default.cmd(
               "bash",
               [
                 "-c",
                 "echo $$ > \"$PID_FILE\"; printf 1234; sleep 0.02; printf 5678; exec sleep 30"
               ],
               env: [{"PID_FILE", pid_file}],
               max_output_bytes: 7,
               timeout_ms: 2_000
             )

    assert message =~ "output byte limit"
    refute message =~ "1234"
    pid = pid_file |> File.read!() |> String.trim()
    assert eventually_dead?(pid), "process #{pid} survived the output limit"
    refute_receive _, 200
  end

  test "input sends one frame without waiting for EOF" do
    assert {~s({"ok":true}\n), 0} =
             Shuttle.Runner.Default.cmd(
               "bash",
               [
                 "-c",
                 "IFS= read -r frame; test \"$frame\" = '{\"text\":\"hello\"}' && printf '{\"ok\":true}\\n'"
               ],
               input: ~s({"text":"hello"}\n),
               timeout_ms: 30_000
             )
  end

  # The runner's wall-clock deadline is the subject: 100 ms against a 10 s
  # command, with the elapsed bound halfway between.
  @tag :timing
  test "a wedged command times out into {message, :timeout} instead of blocking" do
    started = System.monotonic_time(:millisecond)
    assert {message, :timeout} = Shuttle.Runner.Default.cmd("sleep", ["10"], timeout_ms: 100)
    assert message =~ "timed out after 100ms"
    # The caller is unblocked promptly — the bound, not the command, decides.
    assert System.monotonic_time(:millisecond) - started < 5_000
  end

  test "the OS process is killed on timeout, not merely abandoned" do
    pid_file =
      Path.join(System.tmp_dir!(), "shuttle-runner-pid-#{System.unique_integer([:positive])}")

    on_exit(fn -> File.rm(pid_file) end)

    # `exec` keeps the pid: the shell that writes the pid file BECOMES the
    # sleep, so `kill -0` on it probes the exact process the runner must reap.
    # The deadline leaves a loaded machine time to start bash and write the
    # file before the kill.
    assert {_message, :timeout} =
             Shuttle.Runner.Default.cmd(
               "bash",
               ["-c", "echo $$ > #{pid_file}; exec sleep 30"],
               timeout_ms: 2_000
             )

    pid = pid_file |> File.read!() |> String.trim()
    assert eventually_dead?(pid), "process #{pid} survived the timeout kill"

    # And nothing from the abandoned port leaks into the caller's mailbox —
    # a non-trapping GenServer caller must never see a stray port message.
    refute_receive _, 200
  end

  # The Poller's stall watchdog `Process.exit(task, :kill)`s a poll task that may
  # be mid-command; the task's own timeout path never runs, so whoever owns the
  # command must reap it when the caller dies.
  for {name, script} <- [
        {"a direct child", "echo $$ > $PID_FILE; exec sleep 1000"},
        {"a grandchild", "sleep 1000 & echo $! > $PID_FILE; wait"}
      ] do
    test "killing the caller mid-command reaps #{name}" do
      pid_file =
        Path.join(
          System.tmp_dir!(),
          "shuttle-runner-orphan-#{System.unique_integer([:positive])}"
        )

      on_exit(fn -> File.rm(pid_file) end)

      task =
        Task.async(fn ->
          Shuttle.Runner.Default.cmd("bash", ["-c", unquote(script)],
            env: [{"PID_FILE", pid_file}],
            timeout_ms: 600_000
          )
        end)

      pid = await_pid_file(pid_file)
      assert {_, 0} = System.cmd("kill", ["-0", pid], stderr_to_stdout: true)

      Process.unlink(task.pid)
      Process.exit(task.pid, :kill)

      assert eventually_dead?(pid), "process #{pid} outlived its killed caller"
    end
  end

  defp await_pid_file(path, attempts \\ 1_500) do
    body = File.read(path)

    cond do
      match?({:ok, b} when b != "", body) and String.ends_with?(elem(body, 1), "\n") ->
        body |> elem(1) |> String.trim()

      attempts > 0 ->
        Process.sleep(20)
        await_pid_file(path, attempts - 1)

      true ->
        flunk("child never wrote #{path}")
    end
  end

  # A ceiling of ~30 s, reached only when the condition never holds: a passing
  # test returns as soon as it does, however loaded the machine.
  defp eventually_dead?(pid, attempts \\ 1_500) do
    case System.cmd("kill", ["-0", pid], stderr_to_stdout: true) do
      {_, 0} when attempts > 0 ->
        Process.sleep(20)
        eventually_dead?(pid, attempts - 1)

      {_, 0} ->
        false

      _ ->
        true
    end
  end

  @tag :tmp_dir
  test "completion-owned mutations release their index lock even when the caller dies", %{
    tmp_dir: root
  } do
    pid_file = Path.join(root, "pid")
    lock = Path.join(root, "index.lock")
    release = Path.join(root, "release")
    done = Path.join(root, "done")
    Shuttle.Test.Env.put_app_env(:cmd_timeout_ms, 1)
    on_exit(fn -> File.write(release, "release") end)

    task =
      Task.async(fn ->
        Shuttle.Runner.Default.cmd(
          "bash",
          [
            "-c",
            ": > \"$LOCK\"; echo $$ > \"$PID_FILE\"; while [ ! -e \"$RELEASE\" ]; do sleep 0.01; done; rm \"$LOCK\"; echo done > \"$DONE\""
          ],
          env: [{"PID_FILE", pid_file}, {"LOCK", lock}, {"RELEASE", release}, {"DONE", done}],
          timeout_ms: :infinity
        )
      end)

    pid = await_pid_file(pid_file)
    assert File.exists?(lock)
    Process.unlink(task.pid)
    Process.exit(task.pid, :kill)
    ref = task.ref
    assert_receive {:DOWN, ^ref, :process, _, :killed}
    assert {_, 0} = System.cmd("kill", ["-0", pid], stderr_to_stdout: true)
    File.write!(release, "release")
    assert eventually_dead?(pid)
    assert File.read!(done) == "done\n"
    refute File.exists?(lock)
  end

  test "a missing executable still maps to exit 127" do
    assert {message, 127} =
             Shuttle.Runner.Default.cmd("definitely-not-a-command-xyz", [], timeout_ms: 1_000)

    assert message =~ "command not found"
  end
end
