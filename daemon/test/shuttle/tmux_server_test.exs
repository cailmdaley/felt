defmodule Shuttle.TmuxServerTest do
  use ExUnit.Case, async: false

  alias Shuttle.TmuxServer

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
        {Map.get(state.replies, List.first(args), {"", 0}),
         %{state | calls: state.calls ++ [{command, args}]}}
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
    setup do
      on_exit(fn -> Application.delete_env(:shuttle, :os_type) end)
      :ok
    end

    test "no darwin, no opinion — an absent server is fine on Linux" do
      Application.put_env(:shuttle, :os_type, {:unix, :linux})
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
      Application.put_env(:shuttle, :os_type, {:unix, :darwin})
      start_supervised!({StubRunner, {"shuttle-anchor\n", 0}})

      assert TmuxServer.ensure_available(StubRunner) == :ok

      assert {"tmux", ["set-option", "-s", "exit-empty", "off"]} in StubRunner.calls()
    end

    test "an uncertain server is left alone — there may be nothing to harden" do
      Application.put_env(:shuttle, :os_type, {:unix, :darwin})
      start_supervised!({StubRunner, {"tmux ls timed out after 60000ms", :timeout}})

      assert TmuxServer.ensure_available(StubRunner) == :ok

      refute Enum.any?(StubRunner.calls(), fn {_cmd, args} ->
               List.first(args) == "set-option"
             end)
    end

    # A `set-option` that fails changes nothing about the dispatch: losing the
    # hardening is not a reason to refuse work that would have run.
    test "a failed hardening never refuses the dispatch" do
      Application.put_env(:shuttle, :os_type, {:unix, :darwin})

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

  describe "refusal_message/1" do
    test "names the kitty error, the erlexec symptom, and the remedy" do
      msg = TmuxServer.refusal_message("no live kitty remote-control socket")

      assert msg =~ "no live kitty remote-control socket"
      assert msg =~ "erlexec"
      assert msg =~ "tmux new-session -d -s shuttle-anchor"
    end
  end
end
