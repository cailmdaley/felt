defmodule Shuttle.Terminal.RexOpenTimingTest do
  use ExUnit.Case, async: true
  alias Shuttle.{Opener, Rex, Test.Env}
  alias Shuttle.Terminal.Rex, as: Backend
  @moduletag :tmp_dir
  @moduletag skip: Shuttle.Test.IsolatedRex.skip?()

  # Read-only RPCs reach a private real server. Display operations are replaced
  # by subprocesses with representative CLI/activation costs; no app is raised.
  defmodule Runner do
    def cmd(command, args, opts) do
      {us, result} = :timer.tc(fn -> run(command, args, opts) end)
      send(Shuttle.Env.app(:open_timing_owner), {:command_timing, args, us})
      result
    end

    defp run("open", _, _) do
      Shuttle.Runner.Default.cmd("/bin/sleep", ["0.06"], [])
    end

    defp run(command, args, opts) do
      cond do
        "client" in args ->
          {_, 0} = Shuttle.Runner.Default.cmd("/bin/sleep", ["0.025"], [])
          {~s({"clients":[{"client_id":"client:probe","info":{"kind":"app"}}]}), 0}

        "client.perform" in args ->
          {_, 0} = Shuttle.Runner.Default.cmd("/bin/sleep", ["0.025"], [])
          {"{}", 0}

        true ->
          Shuttle.Runner.Default.cmd(command, args, opts)
      end
    end
  end

  @tag :timing
  test "local Rex opens use real isolated inventory without touching the display", %{tmp_dir: dir} do
    root = Shuttle.Test.IsolatedRex.start(dir)
    Env.put_app_env(:terminal_backend, Backend)
    Env.put_app_env(:rex_runner, Runner)
    Env.put_app_env(:open_timing_owner, self())
    script = Path.join(root, "worker.sh")
    File.write!(script, "sleep 60\n")
    assert :ok = Backend.launch(Shuttle.Runner.Default, "probe-open", root, script, [])
    assert {:ok, [_]} = Rex.sessions(Shuttle.Runner.Default)

    samples =
      for _ <- 1..5 do
        {us, :ok} = :timer.tc(fn -> Opener.open("probe-open") end)
        us / 1000
      end

    commands = drain([])
    assert Enum.count(commands, fn {args, _} -> "session.list_blocks" in args end) == 5
    refute Enum.any?(commands, fn {args, _} -> "session.list" in args end)

    if Shuttle.Env.get("SHUTTLE_OPEN_TIMINGS") == "1" do
      IO.puts("\nRex open timing (ms): #{inspect(samples)}")
      IO.puts("Rex open commands (args, ms): #{inspect(commands, limit: :infinity)}")
    end
  end

  defp drain(acc) do
    receive do
      {:command_timing, args, us} -> drain([{args, us / 1000} | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end
end
