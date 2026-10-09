defmodule Shuttle.KittyTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

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
      Shuttle.Test.Env.put_app_env(:remotes, [
        %{name: "hub-a", port: 4001, ssh: "hub-a-login"}
      ])

      assert Kitty.attach_command("shuttle-foo-bar", "hub-a") ==
               {:ok, ["ssh", "-tt", "hub-a-login", "tmux", "attach", "-t", "=shuttle-foo-bar"]}
    end

    test "a remote the fleet reaches only by url has no ssh path, and says so" do
      # The mesh-VPN shape. `ssh hub-a` would be a guess at a destination the
      # operator deliberately did not give, so attach refuses and names the
      # reason rather than failing slowly inside ssh.
      Shuttle.Test.Env.put_app_env(:remotes, [
        %{name: "hub-a", url: "https://hub-a.example.ts.net", tunnel: %{manager: "none"}}
      ])

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
    # A candidate is `{path, mtime, kind}`. The rule: the most-recently-touched
    # live panel (the user's worker-terminal surface), else the most-recently-
    # touched normal window, else nil. A `:dead` socket — a stale
    # `/tmp/kitty-<pid>` left by a gone process, the cause of the
    # `connect: no such file` launch failure — is never chosen, however recent.
    property "picks the newest panel, else the newest normal window, never a dead socket" do
      check all(
              mtimes <- uniq_list_of(integer(1..1_000), max_length: 6),
              kinds <- list_of(member_of([:panel, :normal, :dead]), length: length(mtimes))
            ) do
        candidates =
          Enum.zip_with(mtimes, kinds, fn m, kind -> {"/tmp/kitty-#{m}", m, kind} end)

        newest = fn kind ->
          candidates
          |> Enum.filter(&(elem(&1, 2) == kind))
          |> Enum.max_by(&elem(&1, 1), fn -> nil end)
        end

        expected =
          case newest.(:panel) || newest.(:normal) do
            {path, _m, kind} -> {"unix:" <> path, kind}
            nil -> nil
          end

        assert Kitty.pick_socket(candidates) == expected, inspect(candidates)
      end
    end
  end
end
