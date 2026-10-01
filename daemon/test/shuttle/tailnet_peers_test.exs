defmodule Shuttle.TailnetPeersTest do
  use ExUnit.Case, async: false
  import Shuttle.Test.EnvHelpers

  alias Shuttle.Remote
  alias Shuttle.Remotes
  alias Shuttle.TailnetPeers

  @fixture_dir Path.expand("../fixtures/tailnet_peers", __DIR__)

  setup do
    prev_file = System.get_env("SHUTTLE_REMOTES_FILE")
    prev_env = Application.get_env(:shuttle, :remotes)
    prev_socket = Application.get_env(:shuttle, :tailscale_socket)

    on_exit(fn ->
      restore_env("SHUTTLE_REMOTES_FILE", prev_file)
      restore_app_env(:remotes, prev_env)
      restore_app_env(:tailscale_socket, prev_socket)
    end)

    :ok
  end

  describe "parity with the Go resolver" do
    # internal/shuttlecli/remotes_discovery_test.go reads the same fixtures and
    # asserts `resolved` from `remotes` and `discovered`. Discovery itself runs
    # only here, in the daemon that owns it.
    for path <- Path.wildcard(Path.join(@fixture_dir, "*.json")) do
      @fixture Path.basename(path)
      @fixture_case path |> File.read!() |> Jason.decode!()

      test "#{@fixture}" do
        found =
          TailnetPeers.discover(
            @fixture_case["status"],
            @fixture_case["probes"],
            @fixture_case["own_host"]
          )

        assert Enum.map(found.peers, &Map.take(&1, ["name", "url"])) ==
                 @fixture_case["discovered"]

        assert Enum.map(found.rejected, & &1["dns_name"]) == @fixture_case["rejected"]

        resolved =
          @fixture_case["remotes"]
          |> Remotes.resolve(@fixture_case["discovered"])
          |> Enum.map(fn %Remote{} = r ->
            %{
              "name" => r.name,
              "url" => r.url,
              "source" => Atom.to_string(r.source),
              "ssh" => Remote.ssh_host(r) || "",
              "port" => r.port || 0
            }
          end)

        assert resolved == @fixture_case["resolved"]
      end
    end
  end

  describe "discover/5 retention" do
    @status %{
      "BackendState" => "Running",
      "Self" => %{"UserID" => 1},
      "Peer" => %{"k" => %{"DNSName" => "hub-a.example.ts.net.", "UserID" => 1, "Online" => true}}
    }
    @url "https://hub-a.example.ts.net"

    test "a peer seen recently survives a failed probe, then ages out" do
      seen = TailnetPeers.discover(@status, %{@url => %{"body" => body("hub-a")}}, "me", [], 0)
      assert [%{"name" => "hub-a", "seen_at_ms" => 0}] = seen.peers

      failing = %{@url => %{"error" => "timeout"}}
      retained = TailnetPeers.discover(@status, failing, "me", seen.peers, 599_999)
      assert [%{"name" => "hub-a", "seen_at_ms" => 0}] = retained.peers

      expired = TailnetPeers.discover(@status, failing, "me", retained.peers, 600_000)
      assert expired.peers == []
      assert [%{"reason" => "probe failed: timeout"}] = expired.rejected
    end

    test "a peer answering as another daemon's host is dropped at once" do
      seen = TailnetPeers.discover(@status, %{@url => %{"body" => body("hub-a")}}, "me", [], 0)
      imposter = %{@url => %{"body" => body("me")}}

      assert TailnetPeers.discover(@status, imposter, "me", seen.peers, 1).peers == []
    end

    test "a peer offline this round is kept while it is recent" do
      seen = TailnetPeers.discover(@status, %{@url => %{"body" => body("hub-a")}}, "me", [], 0)
      offline = put_in(@status, ["Peer", "k", "Online"], false)

      assert [%{"name" => "hub-a"}] =
               TailnetPeers.discover(offline, %{}, "me", seen.peers, 1).peers
    end
  end

  describe "run_round/2 fallback" do
    setup do
      Application.delete_env(:shuttle, :remotes)
      System.put_env("SHUTTLE_REMOTES_FILE", Path.join(@fixture_dir, "absent.json"))
      :ok
    end

    test "tailscale that cannot be read yields no peers and says why" do
      report =
        TailnetPeers.run_round([],
          read_status: fn -> {:error, "cli", "tailscale CLI not found"} end
        )

      assert report.state == "unavailable"
      assert report.error == "tailscale CLI not found"
      assert report.peers == []
    end

    test "a stopped backend is unavailable and nothing is probed" do
      stopped = Map.put(@status, "BackendState", "Stopped")

      report =
        TailnetPeers.run_round([],
          read_status: fn -> {:ok, stopped, "cli"} end,
          probe: fn _ -> flunk("a stopped tailnet must not be probed") end
        )

      assert report.state == "unavailable"
      assert report.error == "tailscale is Stopped"
    end

    test "defaults.discover false disables the round" do
      file = write_remotes(%{"defaults" => %{"discover" => false}, "remotes" => []})
      System.put_env("SHUTTLE_REMOTES_FILE", file)

      report = TailnetPeers.run_round([], read_status: fn -> flunk("discovery is off") end)
      assert report.state == "disabled"
    end

    test "application config is the whole fleet" do
      Application.put_env(:shuttle, :remotes, [])
      report = TailnetPeers.run_round([], read_status: fn -> flunk("discovery is off") end)
      assert report.state == "disabled"
    end

    test "a running tailnet is probed concurrently and resolved by host id" do
      report =
        TailnetPeers.run_round([],
          read_status: fn -> {:ok, @status, "cli"} end,
          probe: fn @url -> %{"body" => body("hub-a")} end,
          own_host: "me"
        )

      assert report.state == "ok"
      assert [%{"name" => "hub-a", "url" => @url}] = report.peers
    end
  end

  describe "the process" do
    setup do
      Application.delete_env(:shuttle, :remotes)
      System.put_env("SHUTTLE_REMOTES_FILE", Path.join(@fixture_dir, "absent.json"))
      :ok
    end

    test "publishes discovered peers into the resolved fleet and its change token" do
      token_before = Remotes.config_token()
      test_pid = self()

      start_supervised!(
        {TailnetPeers,
         boot_delay_ms: 0,
         interval_ms: 60_000,
         own_host: "me",
         read_status: fn ->
           send(test_pid, :round)
           {:ok, @status, "cli"}
         end,
         probe: fn @url -> %{"body" => body("hub-a")} end}
      )

      assert_receive :round
      wait_until(fn -> TailnetPeers.generation() != 0 end)

      assert [%{"name" => "hub-a", "url" => @url}] = TailnetPeers.peers()
      assert [%Remote{name: "hub-a", url: @url, source: :discovered}] = Remotes.configured()
      assert Remotes.config_token() != token_before

      status = TailnetPeers.status()
      assert status.state == "ok"
      assert status.via == "cli"
      assert [%{name: "hub-a", dns_name: "hub-a.example.ts.net"}] = status.peers
    end

    test "without the process the fleet is the file alone" do
      assert TailnetPeers.peers() == []
      assert TailnetPeers.generation() == 0
      assert TailnetPeers.status().enabled == false
    end
  end

  describe "LocalAPI status" do
    setup do
      prev_home = Application.get_env(:shuttle, :tailscale_home)
      prev_cli = Application.get_env(:shuttle, :tailscale_cli_locations)
      prev_os = Application.get_env(:shuttle, :os_type)

      on_exit(fn ->
        restore_app_env(:tailscale_home, prev_home)
        restore_app_env(:tailscale_cli_locations, prev_cli)
        restore_app_env(:os_type, prev_os)
      end)

      Application.delete_env(:shuttle, :remotes)
      System.put_env("SHUTTLE_REMOTES_FILE", Path.join(@fixture_dir, "absent.json"))
      :ok
    end

    @tag :tmp_dir
    test "reads the status over the configured socket", %{tmp_dir: tmp_dir} do
      socket = Path.join(short_dir(tmp_dir), "ts.sock")
      fake_localapi(socket)
      Application.put_env(:shuttle, :tailscale_socket, socket)

      assert {:ok, status, "localapi"} = TailnetPeers.read_status()
      assert status["BackendState"] == "Running"

      assert_receive {:request,
                      "GET /localapi/v0/status HTTP/1.0\r\nHost: local-tailscaled.sock" <> _}
    end

    test "reads the status over the default userspace socket" do
      home = "/tmp/tph-#{System.unique_integer([:positive])}"
      state = Path.join(home, ".local/state/tailscale")
      File.mkdir_p!(state)
      on_exit(fn -> File.rm_rf(home) end)

      for dir <- [home, Path.join(home, ".local"), Path.join(home, ".local/state")],
          do: File.chmod!(dir, 0o755)

      File.chmod!(state, 0o700)
      fake_localapi(Path.join(state, "tailscaled.sock"))
      Application.delete_env(:shuttle, :tailscale_socket)
      Application.put_env(:shuttle, :tailscale_home, home)
      Application.put_env(:shuttle, :os_type, {:unix, :linux})

      assert {:ok, %{"BackendState" => "Running"}, "localapi"} = TailnetPeers.read_status()
    end

    @tag :tmp_dir
    test "a non-executable CLI is never chosen, and the round reports it", %{tmp_dir: tmp_dir} do
      cli = Path.join(tmp_dir, "tailscale")
      File.write!(cli, "#!/bin/sh\necho '{}'\n")
      File.chmod!(cli, 0o644)
      Application.delete_env(:shuttle, :tailscale_socket)
      Application.put_env(:shuttle, :tailscale_cli_locations, [cli])

      assert TailnetPeers.tailscale_cli() == nil
      assert {:error, "cli", "no executable tailscale CLI found"} = TailnetPeers.read_status()
    end

    @tag :tmp_dir
    test "an executable CLI is run", %{tmp_dir: tmp_dir} do
      cli = Path.join(tmp_dir, "tailscale")

      File.write!(
        cli,
        "#!/bin/sh\necho 'warning: noise'\necho '{\"BackendState\":\"Stopped\"}'\n"
      )

      File.chmod!(cli, 0o755)
      Application.delete_env(:shuttle, :tailscale_socket)
      Application.put_env(:shuttle, :tailscale_cli_locations, [cli])

      assert {:ok, %{"BackendState" => "Stopped"}, "cli"} = TailnetPeers.read_status()
    end
  end

  describe "failures stay inside the round" do
    setup do
      Application.delete_env(:shuttle, :remotes)
      System.put_env("SHUTTLE_REMOTES_FILE", Path.join(@fixture_dir, "absent.json"))
      :ok
    end

    test "a status read that raises or exits is an unavailable report" do
      raising =
        TailnetPeers.run_round([],
          read_status: fn ->
            raise File.Error, reason: :eacces, action: "exec", path: "/x/tailscale"
          end
        )

      assert raising.state == "unavailable"
      assert raising.error =~ "reading the tailnet status failed"

      exiting = TailnetPeers.run_round([], read_status: fn -> exit(:eacces) end)
      assert exiting.state == "unavailable"
      assert exiting.error =~ "eacces"
    end

    test "a probe that raises rejects that peer only" do
      report =
        TailnetPeers.run_round([],
          read_status: fn -> {:ok, @status, "cli"} end,
          probe: fn _ -> raise "boom" end,
          own_host: "me"
        )

      assert report.state == "ok"
      assert report.peers == []
      assert [%{"reason" => "probe failed: boom"}] = report.rejected
    end

    test "the process survives repeated failing rounds" do
      pid =
        start_supervised!(
          {TailnetPeers, boot_delay_ms: 0, interval_ms: 10, read_status: fn -> exit(:eacces) end}
        )

      ref = Process.monitor(pid)
      wait_until(fn -> TailnetPeers.status().state == "unavailable" end)
      Process.sleep(100)
      refute_received {:DOWN, ^ref, _, _, _}
      assert Process.alive?(pid)
      assert TailnetPeers.status().error =~ "eacces"
    end
  end

  defp fake_localapi(socket) do
    body = Jason.encode!(@status)
    {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false, ifaddr: {:local, socket}])
    test_pid = self()

    spawn_link(fn ->
      {:ok, conn} = :gen_tcp.accept(listener)
      {:ok, request} = :gen_tcp.recv(conn, 0, 2_000)
      send(test_pid, {:request, request})

      :gen_tcp.send(conn, "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n" <> body)
      :gen_tcp.close(conn)
    end)

    socket
  end

  defp body(host), do: %{"host" => host, "ready" => true}

  defp write_remotes(doc) do
    path =
      Path.join(System.tmp_dir!(), "tailnet-peers-#{System.unique_integer([:positive])}.json")

    File.write!(path, Jason.encode!(doc))
    on_exit(fn -> File.rm(path) end)
    path
  end

  # A unix socket path must stay under the platform's sun_path limit, which a
  # deep ExUnit tmp_dir can exceed.
  defp short_dir(tmp_dir) do
    if byte_size(tmp_dir) < 80 do
      tmp_dir
    else
      dir = Path.join("/tmp", "tp-#{System.unique_integer([:positive])}")
      File.mkdir_p!(dir)
      on_exit(fn -> File.rm_rf(dir) end)
      dir
    end
  end

  defp wait_until(fun, attempts \\ 100) do
    cond do
      fun.() -> :ok
      attempts == 0 -> flunk("condition never held")
      true -> Process.sleep(10) && wait_until(fun, attempts - 1)
    end
  end
end
