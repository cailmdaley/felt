defmodule Shuttle.Test.RexRealCase do
  @moduledoc """
  The case template for the real-Rex suites (`test/shuttle/terminal/rex_real_*_test.exs`):
  each test starts a private Rex server (`Shuttle.Test.IsolatedRex`), and the
  suites skip where Rex is not installed.
  """

  use ExUnit.CaseTemplate

  alias Shuttle.Test.Env

  using do
    quote do
      alias Shuttle.{Rex, Terminal, WorkerProcess, Test.Env}
      alias Shuttle.Terminal.RexBindings
      alias Shuttle.Terminal.Rex, as: Backend
      @moduletag :tmp_dir
      @moduletag skip: Shuttle.Test.IsolatedRex.skip?()
      @moduletag timeout: 60_000
      @runner Shuttle.Runner.Default
      import Shuttle.Test.IsolatedRex, only: [await: 1]
      import Shuttle.Test.PollerHelpers
      alias Shuttle.Test.RexRealCase.ClaimRunner
      alias Shuttle.Test.RexRealCase.CrashAfterCreateRunner
      alias Shuttle.Test.RexRealCase.RexMustNotRun
    end
  end

  defmodule ClaimRunner do
    def cmd("tmux", _args, _opts), do: {"no server running", 1}

    def cmd(command, args, opts) when command in ["shuttle", "felt"],
      do: Shuttle.Test.FeltStoreRunner.cmd(command, args, opts)

    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  defmodule CrashAfterCreateRunner do
    def cmd(command, args, opts) do
      result = Shuttle.Runner.Default.cmd(command, args, opts)
      if Shuttle.Env.app(:rex_crash_operation) in args, do: throw(:rex_launch_crash)
      result
    end
  end

  defmodule RexMustNotRun do
    def cmd(command, args, _opts),
      do:
        raise(
          "unexpected Rex command while checking a live Linux worker: #{command} #{inspect(args)}"
        )
  end

  setup %{tmp_dir: dir} do
    root = Shuttle.Test.IsolatedRex.start(dir)
    Env.put_env("SHUTTLE_HOST", "probe-isolated-sentinel")
    Env.put_app_env(:paste_submit_delay_ms, 0)
    {:ok, root: root}
  end
end
