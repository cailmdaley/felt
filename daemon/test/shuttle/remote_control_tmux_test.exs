defmodule Shuttle.RemoteControlTmuxTest do
  use ExUnit.Case, async: true
  alias Shuttle.{RemoteControl, Test.Env}

  @moduletag :tmp_dir
  @moduletag skip: is_nil(System.find_executable("tmux"))

  defmodule Runner do
    @behaviour Shuttle.Runner
    def cmd("tmux", args, opts) do
      Shuttle.Runner.Default.cmd(
        "tmux",
        ["-S", Shuttle.Env.get("RC_TEST_SOCKET"), "-f", "/dev/null" | args],
        opts
      )
    end

    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  # Negative controls: remove `command` from the script, or set remain-on-exit
  # off. Each loses the fake host's receipt or retained exit evidence.
  test "real tmux retains an immediate exit, adopts a live shell, and preserves literal argv", %{
    tmp_dir: dir
  } do
    home = Path.join(dir, "home")
    bin = Path.join(dir, "bin")
    File.mkdir_p!(home)
    File.mkdir_p!(bin)
    socket = Path.join(System.tmp_dir!(), "rc-#{System.unique_integer([:positive])}.sock")
    receipt = Path.join(dir, "receipt")
    fifo = Path.join(dir, "gate")
    {_, 0} = Shuttle.Env.cmd("mkfifo", [fifo])
    fake = Path.join(bin, "claude")

    File.write!(
      fake,
      "#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$RC_RECEIPT\"\nif [ \"$2\" != --instant ]; then read answer < \"$RC_GATE\"; fi\necho 'fake host refusal'\nexit 7\n"
    )

    File.chmod!(fake, 0o700)
    # The login shell has an intentionally hostile function. `command` must
    # select the fake executable instead, never a wrapper or installed harness.
    File.write!(
      Path.join(home, ".bash_profile"),
      "export PATH='#{bin}:/usr/bin:/bin'\nclaude() { echo wrapper > '#{dir}/wrapper'; }\n"
    )

    Env.put_env("HOME", home)
    Env.put_env("RC_TEST_SOCKET", socket)
    Env.put_env("RC_RECEIPT", receipt)
    Env.put_env("RC_GATE", fifo)
    Env.put_app_env(:os_type, {:unix, :linux})
    # Pre-create the isolated server with this test's environment, never the
    # user's server or its inherited credentials / tmux environment.
    assert {_, 0} =
             Runner.cmd("tmux", ["new-session", "-d", "-s", "test-anchor", "sleep", "300"], [])

    on_exit(fn ->
      Shuttle.Env.cmd("tmux", ["-S", socket, "kill-server"], stderr_to_stdout: true)
    end)

    args = [
      "--permission-mode",
      "auto",
      "a'b",
      "$(touch #{dir}/injected)",
      "; false",
      "two words"
    ]

    opts = [
      name: nil,
      runner: Runner,
      interval_ms: :infinity,
      config: fn -> {:ok, %{dir: dir, args: args}} end
    ]

    first = start_supervised!({RemoteControl, opts})
    assert %{state: :starting} = RemoteControl.status(first)
    await(fn -> File.exists?(receipt) end)
    assert File.read!(receipt) == Enum.join(["remote-control" | args], <<0>>) <> <<0>>
    refute File.exists?(Path.join(dir, "wrapper"))
    refute File.exists?(Path.join(dir, "injected"))
    assert %{state: :running, pid: pid, started_at: at} = RemoteControl.reconcile(first)
    {ps, 0} = Runner.cmd("ps", ["-p", to_string(pid), "-o", "args="], [])
    assert ps =~ "bash -l"
    assert ps =~ "shuttle-run-shuttle-remote-control."
    # A missing socket is not permission to duplicate an existing host.
    File.rename!(socket, socket <> ".hidden")
    assert %{state: :error, restarts: 1} = RemoteControl.reconcile(first)
    File.rename!(socket <> ".hidden", socket)
    stop_supervised!(RemoteControl)

    second = start_supervised!({RemoteControl, opts})

    assert %{state: :running, pid: ^pid, started_at: ^at, restarts: 0} =
             RemoteControl.status(second)

    # Release the fake host to die immediately. remain-on-exit must already be
    # set, otherwise there is no pane left to report the status and screen.
    File.write!(fifo, "exit\n")

    await(fn ->
      case Runner.cmd(
             "tmux",
             ["display-message", "-p", "-t", "=shuttle-remote-control:", "\#{pane_dead}"],
             []
           ) do
        {"1\n", 0} -> true
        _ -> false
      end
    end)

    assert %{state: :waiting, last_exit: %{status: 7, screen: screen}} =
             RemoteControl.reconcile(second)

    assert Enum.any?(screen, &String.contains?(&1, "fake host refusal"))
    assert %{state: :waiting, restarts: 0} = RemoteControl.reconcile(second)

    stop_supervised!(RemoteControl)
    {_, 0} = Runner.cmd("tmux", ["kill-session", "-t", "=shuttle-remote-control"], [])
    # Start a host that exits as soon as the login shell reaches the command.
    # The pane must survive even this race, across another daemon adoption.
    instant = Keyword.put(opts, :config, fn -> {:ok, %{dir: dir, args: ["--instant"]}} end)
    third = start_supervised!({RemoteControl, instant})
    assert %{state: :starting} = RemoteControl.status(third)

    await(fn ->
      Runner.cmd(
        "tmux",
        ["display-message", "-p", "-t", "=shuttle-remote-control:", "\#{pane_dead}"],
        []
      ) == {"1\n", 0}
    end)

    stop_supervised!(RemoteControl)
    fourth = start_supervised!({RemoteControl, instant})
    assert %{state: :waiting, restarts: 0, last_exit: %{status: 7}} = RemoteControl.status(fourth)
  end

  defp await(fun), do: await(fun, System.monotonic_time(:millisecond) + 10_000)

  defp await(fun, deadline) do
    if fun.() do
      :ok
    else
      assert System.monotonic_time(:millisecond) < deadline,
             "timed out waiting for fake host event"

      Process.sleep(10)
      await(fun, deadline)
    end
  end
end
