defmodule Shuttle.TmuxServerTest do
  use ExUnit.Case, async: false

  alias Shuttle.TmuxServer

  # ── classify_origin/2 (pure) ──

  describe "classify_origin/2" do
    test "any marker means kitty started the server" do
      assert TmuxServer.classify_origin("SHUTTLE_TMUX_ORIGIN=kitty:2026-09-12T22:15:03Z", nil) ==
               :kitty_born

      # The marker wins even over daemon-shaped argv: the only way a marker
      # exists is that we stamped it after a kitty start.
      assert TmuxServer.classify_origin(
               "SHUTTLE_TMUX_ORIGIN=kitty:2026-09-12T22:15:03Z",
               "tmux new-session -d -s x-shuttle"
             ) == :kitty_born
    end

    test "a whitespace-only marker is no marker" do
      assert TmuxServer.classify_origin("  \n", nil) == :absent
    end

    test "the real daemon-born argv captured from this machine is daemon_born" do
      argv =
        "tmux new-session -d -s civbench-01KTHDNZS287ZSSG8X8V59XKWB-shuttle " <>
          "-c /Users/someone/loom bash -l /var/folders/xx/T/shuttle-run-2115.sh"

      assert TmuxServer.classify_origin(nil, argv) == :daemon_born
    end

    test "either daemon fingerprint alone is enough" do
      assert TmuxServer.classify_origin(nil, "bash -l /tmp/shuttle-run-7.sh") == :daemon_born
      assert TmuxServer.classify_origin(nil, "tmux new-session -d -s leaf-uid-shuttle") ==
               :daemon_born
    end

    test "a human's own server is unknown, never daemon_born" do
      assert TmuxServer.classify_origin(nil, "tmux -CC attach") == :unknown
      assert TmuxServer.classify_origin(nil, "tmux new-session -d -s shuttle-anchor") == :unknown
    end

    test "no argv at all means no server" do
      assert TmuxServer.classify_origin(nil, nil) == :absent
      assert TmuxServer.classify_origin(nil, "") == :absent
    end
  end

  # ── presence/1 ──

  defmodule StubRunner do
    @behaviour Shuttle.Runner

    use Agent

    def start_link(reply), do: Agent.start_link(fn -> reply end, name: __MODULE__)

    @impl true
    def cmd(_command, _args, _opts), do: Agent.get(__MODULE__, & &1)
  end

  describe "presence/1" do
    test "exit 0 is present" do
      start_supervised!({StubRunner, {"shuttle-anchor\n", 0}})
      assert TmuxServer.presence(StubRunner) == :present
    end

    test "tmux's own absence message is the only evidence of absence" do
      start_supervised!({StubRunner, {"error connecting to /tmp/tmux-501/default (No such file)", 1}})
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
