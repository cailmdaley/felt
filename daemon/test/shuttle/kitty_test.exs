defmodule Shuttle.KittyTest do
  use ExUnit.Case, async: true

  alias Shuttle.Kitty

  describe "attach_command/2" do
    test "a local worker (no host) attaches with an exact tmux target" do
      assert Kitty.attach_command("shuttle-foo-bar", nil) ==
               {:ok, ["tmux", "attach", "-t", "=shuttle-foo-bar"]}
    end

    test "an empty host is treated as local" do
      assert Kitty.attach_command("shuttle-foo-bar", "") ==
               {:ok, ["tmux", "attach", "-t", "=shuttle-foo-bar"]}
    end

    test "this daemon's own host id attaches locally, not over ssh" do
      own = Shuttle.Poller.own_host_id()

      assert Kitty.attach_command("shuttle-foo-bar", own) ==
               {:ok, ["tmux", "attach", "-t", "=shuttle-foo-bar"]}
    end

    test "a tunnelled remote wraps the attach in ssh -tt at the fleet's destination" do
      # The destination comes from the fleet file, not from the host id: here
      # they differ, which is the case that catches a reader who assumed the
      # routing name doubles as an ssh host.
      Application.put_env(:shuttle, :remotes, [
        %{name: "hub-a", port: 4001, ssh: "hub-a-login"}
      ])

      on_exit(fn -> Application.put_env(:shuttle, :remotes, []) end)

      assert Kitty.attach_command("shuttle-foo-bar", "hub-a") ==
               {:ok, ["ssh", "-tt", "hub-a-login", "tmux", "attach", "-t", "=shuttle-foo-bar"]}
    end

    test "a remote the fleet reaches only by url has no ssh path, and says so" do
      # The mesh-VPN shape. `ssh hub-a` would be a guess at a destination the
      # operator deliberately did not give, so attach refuses and names the
      # reason rather than failing slowly inside ssh.
      Application.put_env(:shuttle, :remotes, [
        %{name: "hub-a", url: "https://hub-a.example.ts.net", tunnel: %{manager: "none"}}
      ])

      on_exit(fn -> Application.put_env(:shuttle, :remotes, []) end)

      assert {:error, reason} = Kitty.attach_command("shuttle-foo-bar", "hub-a")
      assert reason =~ "no ssh path to hub-a"
      assert reason =~ "https://hub-a.example.ts.net"
    end

    test "a host that is not in the fleet at all is refused, not guessed at" do
      assert {:error, reason} = Kitty.attach_command("shuttle-foo-bar", "nowhere")
      assert reason =~ "not in this host's fleet file"
    end
  end

  describe "open/2" do
    test "rejects an empty session" do
      assert {:error, _} = Kitty.open("", "candide")
    end
  end

  describe "pick_socket/1" do
    test "prefers the quick-access panel — the user's worker-terminal surface" do
      candidates = [
        {"/tmp/kitty-100", 100, :normal},
        {"/tmp/kitty-200", 200, :panel}
      ]

      assert Kitty.pick_socket(candidates) == {"unix:/tmp/kitty-200", :panel}
    end

    test "among panels the most-recently-touched wins" do
      candidates = [
        {"/tmp/kitty-100", 100, :panel},
        {"/tmp/kitty-300", 300, :panel},
        {"/tmp/kitty-200", 200, :panel}
      ]

      assert Kitty.pick_socket(candidates) == {"unix:/tmp/kitty-300", :panel}
    end

    test "falls back to a normal window when no panel is listening" do
      candidates = [
        {"/tmp/kitty-100", 100, :normal},
        {"/tmp/kitty-300", 300, :normal}
      ]

      assert Kitty.pick_socket(candidates) == {"unix:/tmp/kitty-300", :normal}
    end

    test "dead sockets are never chosen" do
      # A stale `/tmp/kitty-<pid>` left by a gone process — the cause of the
      # `connect: no such file` launch failure.
      candidates = [{"/tmp/kitty-999", 999, :dead}]
      assert Kitty.pick_socket(candidates) == nil
    end

    test "a live panel beats a more-recent dead socket" do
      candidates = [
        {"/tmp/kitty-100", 100, :panel},
        {"/tmp/kitty-999", 999, :dead}
      ]

      assert Kitty.pick_socket(candidates) == {"unix:/tmp/kitty-100", :panel}
    end

    test "nil when there are no sockets at all" do
      assert Kitty.pick_socket([]) == nil
    end
  end
end
