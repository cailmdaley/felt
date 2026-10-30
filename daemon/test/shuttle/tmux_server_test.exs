defmodule Shuttle.TmuxServerTest do
  use ExUnit.Case, async: true

  alias Shuttle.TmuxServer

  setup do
    Shuttle.Test.Env.put_app_env(:terminal_backend, Shuttle.Terminal.Tmux)
    :ok
  end

  # ── presence/1 ──

  # A runner that answers per tmux subcommand and remembers every call, so both
  # "what did the daemon decide" and "what did the daemon RUN" are assertable.
  # Anything not in `replies` succeeds silently, which is what a real `tmux
  # set-option` does.
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

  describe "presence/1" do
    test "exit 0 is present" do
      start_supervised!({StubRunner, {"shuttle-anchor\n", 0}})
      assert TmuxServer.presence(StubRunner) == :present
    end

    test "tmux's own absence message is the only evidence of absence" do
      start_supervised!(
        {StubRunner, {"error connecting to /tmp/tmux-501/default (No such file)", 1}}
      )

      assert TmuxServer.presence(StubRunner) == :absent
    end

    test "a timeout is uncertainty, not absence" do
      start_supervised!({StubRunner, {"tmux ls timed out after 60000ms", :timeout}})
      assert TmuxServer.presence(StubRunner) == :unknown
    end

    test "any other failure is uncertainty" do
      start_supervised!({StubRunner, {"tmux: command not found", 127}})
      assert TmuxServer.presence(StubRunner) == :unknown
    end
  end

  describe "ensure_available/1" do
    test "no darwin, no opinion — an absent server is fine on Linux" do
      Shuttle.Test.Env.put_app_env(:os_type, {:unix, :linux})
      start_supervised!({StubRunner, {"no server running on /tmp/tmux-1000/default", 1}})

      assert TmuxServer.ensure_available(StubRunner) == :ok

      # Nothing at all is run on Linux — not even the hardening.
      assert StubRunner.calls() == []
    end

    # The race: `tmux ls` says a server is there, the human closes their last
    # session, the server exits to `exit-empty`, and the dispatcher's
    # `new-session` forks a fresh one rooted at the daemon. Disarming
    # `exit-empty` on a server we did not fork closes that window.
    test "a present server is hardened against exiting when its last session goes" do
      Shuttle.Test.Env.put_app_env(:os_type, {:unix, :darwin})
      start_supervised!({StubRunner, {"shuttle-anchor\n", 0}})

      assert TmuxServer.ensure_available(StubRunner) == :ok

      assert {"tmux", ["set-option", "-s", "exit-empty", "off"]} in StubRunner.calls()
    end

    test "an uncertain server is left alone — there may be nothing to harden" do
      Shuttle.Test.Env.put_app_env(:os_type, {:unix, :darwin})
      start_supervised!({StubRunner, {"tmux ls timed out after 60000ms", :timeout}})

      assert TmuxServer.ensure_available(StubRunner) == :ok

      refute Enum.any?(StubRunner.calls(), fn {_cmd, args} ->
               List.first(args) == "set-option"
             end)
    end

    # A `set-option` that fails changes nothing about the dispatch: losing the
    # hardening is not a reason to refuse work that would have run.
    test "a failed hardening never refuses the dispatch" do
      Shuttle.Test.Env.put_app_env(:os_type, {:unix, :darwin})

      start_supervised!(
        {StubRunner,
         %{
           "ls" => {"shuttle-anchor\n", 0},
           "set-option" => {"no server running on /tmp/tmux-501/default", 1}
         }}
      )

      assert TmuxServer.ensure_available(StubRunner) == :ok
    end
  end

  # The kitty seam receives the dispatch's runner, so the coalition reads and
  # the LaunchServices start run through the same injectable shell as tmux.
  defmodule RunnerEchoKitty do
    def run_background(argv, runner) do
      send(self(), {:kitty_argv, argv})
      send(self(), {:kitty_runner, runner})

      Shuttle.Env.app(
        :kitty_launch_result,
        {:error, "no running kitty is its own responsible app"}
      )
    end
  end

  describe "ensure_available/1 with no server" do
    setup do
      Shuttle.Test.Env.put_app_env(:os_type, {:unix, :darwin})
      Shuttle.Test.Env.put_app_env(:kitty_impl, RunnerEchoKitty)
    end

    test "tmux-primary startup keeps the kitty anchor command unchanged" do
      Shuttle.Test.Env.put_app_env(:kitty_launch_result, :ok)

      start_supervised!(
        {StubRunner, %{"ls" => [{"no server running", 1}, {"shuttle-anchor", 0}]}}
      )

      assert :ok = TmuxServer.ensure_available(StubRunner)

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

    test "forks through kitty with the dispatch's runner, and refuses when kitty cannot" do
      start_supervised!({StubRunner, {"no server running on /tmp/tmux-501/default", 1}})

      assert {:error, {:tmux_server_unavailable, msg}} = TmuxServer.ensure_available(StubRunner)
      assert_received {:kitty_runner, StubRunner}
      assert msg =~ "no running kitty is its own responsible app"
    end
  end

  defmodule RunnerEchoRex do
    def run_background(argv, runner) do
      send(self(), {:rex_launcher, argv, runner})
      Shuttle.Env.app(:rex_launch_result, :ok)
    end
  end

  describe "Rex-primary anchor" do
    @describetag :tmp_dir
    setup %{tmp_dir: dir} do
      Shuttle.Test.Env.put_app_env(:os_type, {:unix, :darwin})
      Shuttle.Test.Env.put_app_env(:terminal_backend, Shuttle.Terminal.Rex)
      Shuttle.Test.Env.put_app_env(:rex_impl, RunnerEchoRex)
      Shuttle.Test.Env.put_app_env(:kitty_impl, RunnerEchoKitty)
      tmux = Path.join(dir, "tmux")
      File.write!(tmux, "#!/bin/sh\nexit 0\n")
      File.chmod!(tmux, 0o700)
      Shuttle.Test.Env.put_env("PATH", dir)
      {:ok, tmux: tmux}
    end

    test "launches through Rex with an absolute tmux path and hardens the resulting server", %{
      tmux: tmux
    } do
      start_supervised!(
        {StubRunner, %{"ls" => [{"no server running", 1}, {"shuttle-anchor", 0}]}}
      )

      assert :ok = TmuxServer.ensure_available(StubRunner)

      assert_received {:rex_launcher,
                       [
                         ^tmux,
                         "new-session",
                         "-d",
                         "-s",
                         "shuttle-anchor",
                         "--",
                         "sh",
                         "-c",
                         "exec sleep 2147483647"
                       ], StubRunner}

      refute_received {:kitty_runner, _}
      assert {"tmux", ["set-option", "-s", "exit-empty", "off"]} in StubRunner.calls()
    end

    test "refuses a failed Rex launch without falling back to kitty or daemon-born tmux" do
      start_supervised!({StubRunner, {"no server running", 1}})
      Shuttle.Test.Env.put_app_env(:rex_launch_result, {:error, "server unreachable"})
      assert {:error, {:tmux_server_unavailable, msg}} = TmuxServer.ensure_available(StubRunner)
      assert msg =~ "Rex"
      assert msg =~ "server unreachable"
      assert msg =~ "Full Disk Access"
      refute msg =~ "kitty"
      refute_received {:kitty_runner, _}
      assert [{"tmux", ["ls", "-F", _]}] = StubRunner.calls()
    end

    test "refuses before launch if the daemon cannot resolve tmux", %{tmux: tmux} do
      File.rm!(tmux)
      Shuttle.Env.invalidate_executable("tmux")
      start_supervised!({StubRunner, {"no server running", 1}})
      assert {:error, {:tmux_server_unavailable, msg}} = TmuxServer.ensure_available(StubRunner)
      assert msg =~ "tmux executable not found"
      refute_received {:rex_launcher, _, _}
      refute_received {:kitty_runner, _}
    end

    test "refuses when Rex accepts but no tmux server appears" do
      start_supervised!({StubRunner, {"no server running", 1}})
      assert {:error, {:tmux_server_unavailable, msg}} = TmuxServer.ensure_available(StubRunner)
      assert msg =~ "rex accepted the command but no tmux server appeared"
      refute_received {:kitty_runner, _}
      refute Enum.any?(StubRunner.calls(), fn {_, args} -> List.first(args) == "set-option" end)
    end

    test "a present auxiliary server is hardened without launching Rex" do
      start_supervised!({StubRunner, {"shuttle-anchor", 0}})
      assert :ok = TmuxServer.ensure_available(StubRunner)
      refute_received {:rex_launcher, _, _}
      refute_received {:kitty_runner, _}
    end
  end

  describe "refusal_message/1" do
    test "names the kitty error, the erlexec symptom, and the remedy" do
      msg = TmuxServer.refusal_message("no live kitty remote-control socket")

      assert msg =~ "no live kitty remote-control socket"
      assert msg =~ "erlexec"
      assert msg =~ "tmux new-session -d -s shuttle-anchor"
    end
  end
end
