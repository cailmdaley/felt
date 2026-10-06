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

  test "a command that completes within its bound is unaffected" do
    assert {"hi\n", 0} = Shuttle.Runner.Default.cmd("echo", ["hi"], timeout_ms: 5_000)
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
               timeout_ms: 5_000
             )
  end

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
    assert {_message, :timeout} =
             Shuttle.Runner.Default.cmd(
               "bash",
               ["-c", "echo $$ > #{pid_file}; exec sleep 30"],
               timeout_ms: 300
             )

    pid = pid_file |> File.read!() |> String.trim()
    assert eventually_dead?(pid), "process #{pid} survived the timeout kill"

    # And nothing from the abandoned port leaks into the caller's mailbox —
    # a non-trapping GenServer caller must never see a stray port message.
    refute_receive _, 200
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

  test "a missing executable still maps to exit 127" do
    assert {message, 127} =
             Shuttle.Runner.Default.cmd("definitely-not-a-command-xyz", [], timeout_ms: 1_000)

    assert message =~ "command not found"
  end
end
