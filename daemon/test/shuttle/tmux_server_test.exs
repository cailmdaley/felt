defmodule Shuttle.TmuxServerTest do
  use ExUnit.Case, async: true

  alias Shuttle.TmuxServer

  setup do
    Shuttle.Test.Env.put_app_env(:terminal_backend, Shuttle.Terminal.Tmux)
    :ok
  end

  defmodule StubRunner do
    @behaviour Shuttle.Runner
    use Agent

    def start_link(reply) when is_tuple(reply), do: start_link(%{"ls" => reply})

    def start_link(replies) when is_map(replies),
      do: Agent.start_link(fn -> %{replies: replies, calls: []} end, name: __MODULE__)

    @impl true
    def cmd(command, args, _opts) do
      Agent.get_and_update(__MODULE__, fn state ->
        key = List.first(args)

        {reply, replies} =
          case Map.get(state.replies, key, {"", 0}) do
            [reply | rest] -> {reply, Map.put(state.replies, key, rest)}
            reply -> {reply, state.replies}
          end

        {reply, %{state | replies: replies, calls: state.calls ++ [{command, args}]}}
      end)
    end

    def calls, do: Agent.get(__MODULE__, & &1.calls)
  end

  defmodule RunnerEchoKitty do
    def run_background(argv, runner) do
      send(self(), {:kitty_argv, argv})
      send(self(), {:kitty_runner, runner})
      Shuttle.Env.app(:kitty_launch_result, {:error, "no live kitty remote-control socket"})
    end
  end

  describe "presence/1" do
    test "exit 0 is present" do
      start_supervised!({StubRunner, {"shuttle-anchor\\n", 0}})
      assert TmuxServer.presence(StubRunner) == :present
    end

    test "tmux's own absence message is the only evidence of absence" do
      start_supervised!(
        {StubRunner, {"error connecting to /tmp/tmux-501/default (No such file)", 1}}
      )

      assert TmuxServer.presence(StubRunner) == :absent
    end

    test "a timeout is uncertainty, not absence" do
      start_supervised!({StubRunner, {"tmux ls timed out", :timeout}})
      assert TmuxServer.presence(StubRunner) == :unknown
    end
  end

  describe "ensure_available/1" do
    test "Linux does not inspect or change tmux" do
      Shuttle.Test.Env.put_app_env(:os_type, {:unix, :linux})
      start_supervised!({StubRunner, {"no server running", 1}})
      assert :ok = TmuxServer.ensure_available(StubRunner)
      assert [] = StubRunner.calls()
    end

    test "Rex hosts do not start or inspect tmux on macOS" do
      Shuttle.Test.Env.put_app_env(:os_type, {:unix, :darwin})
      Shuttle.Test.Env.put_app_env(:terminal_backend, Shuttle.Terminal.Rex)
      start_supervised!({StubRunner, {"no server running", 1}})
      assert :ok = TmuxServer.ensure_available(StubRunner)
      assert [] = StubRunner.calls()
    end

    test "a present tmux server is kept alive" do
      Shuttle.Test.Env.put_app_env(:os_type, {:unix, :darwin})
      start_supervised!({StubRunner, {"shuttle-anchor\\n", 0}})
      assert :ok = TmuxServer.ensure_available(StubRunner)
      assert {"tmux", ["set-option", "-s", "exit-empty", "off"]} in StubRunner.calls()
    end

    test "an absent tmux server starts through kitty" do
      Shuttle.Test.Env.put_app_env(:os_type, {:unix, :darwin})
      Shuttle.Test.Env.put_app_env(:kitty_impl, RunnerEchoKitty)
      Shuttle.Test.Env.put_app_env(:kitty_launch_result, :ok)

      start_supervised!(
        {StubRunner, %{"ls" => [{"no server running", 1}, {"shuttle-anchor", 0}]}}
      )

      assert :ok = TmuxServer.ensure_available(StubRunner)
      assert_received {:kitty_runner, StubRunner}

      assert_received {:kitty_argv,
                       [
                         "tmux",
                         "new-session",
                         "-d",
                         "-s",
                         "shuttle-anchor",
                         "--",
                         "sh",
                         "-c",
                         "exec sleep 2147483647"
                       ]}

      assert {"tmux", ["set-option", "-s", "exit-empty", "off"]} in StubRunner.calls()
    end

    test "a failed kitty launch is surfaced" do
      Shuttle.Test.Env.put_app_env(:os_type, {:unix, :darwin})
      Shuttle.Test.Env.put_app_env(:kitty_impl, RunnerEchoKitty)
      start_supervised!({StubRunner, {"no server running", 1}})

      assert {:error, {:tmux_server_unavailable, message}} =
               TmuxServer.ensure_available(StubRunner)

      assert message =~ "no live kitty remote-control socket"
    end
  end

  test "refusal message gives the kitty remedy" do
    message = TmuxServer.refusal_message("no live kitty remote-control socket")
    assert message =~ "tmux new-session -d -s shuttle-anchor"
    assert message =~ "no live kitty remote-control socket"
  end
end
