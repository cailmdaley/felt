defmodule Shuttle.HostConfigureEndpointTest do
  # sync: restarts the application's ShuttleWeb.Endpoint, which reads the global app env that configure_endpoint/0 writes
  use ExUnit.Case, async: false

  @fixture_dir Path.expand("../fixtures/host", __DIR__)
  @written [
    ShuttleWeb.Endpoint,
    :listen,
    :host_class,
    :peer_gate,
    :peer_gate_expected_uid,
    :peer_gate_uid_source
  ]

  describe "Shuttle.Application.configure_endpoint/0" do
    setup do
      # configure_endpoint/0 publishes its result into the global app env,
      # as boot does; put back whatever it overwrote.
      previous = Map.new(@written, &{&1, Application.fetch_env(:shuttle, &1)})

      on_exit(fn ->
        Enum.each(previous, fn
          {key, {:ok, value}} -> Application.put_env(:shuttle, key, value)
          {key, :error} -> Application.delete_env(:shuttle, key)
        end)
      end)

      {:ok, previous_endpoint} = previous[ShuttleWeb.Endpoint]

      base = "/tmp/shuttle-cfg-#{System.unique_integer([:positive])}"
      File.mkdir_p!(base)
      # Explicit mode: under a 002 umask mkdir yields 0775 and the ancestry check refuses it.
      File.chmod!(base, 0o755)
      on_exit(fn -> File.rm_rf(base) end)

      Shuttle.Test.Env.delete_env("SHUTTLE_LISTEN")
      Shuttle.Test.Env.delete_env("SHUTTLE_PORT")
      Shuttle.Test.Env.delete_env("SHUTTLE_PEER_UID")
      Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", base)

      {:ok, base: base, endpoint: previous_endpoint}
    end

    test "a shared host's endpoint serves on its unix socket and opens no TCP port", %{
      base: base,
      endpoint: endpoint
    } do
      # The real endpoint, restarted under the configuration boot produces:
      # the running test endpoint is stopped, reconfigured with server: true,
      # and restarted, so Phoenix → Bandit → thousand_island do the binding.
      Shuttle.Test.Env.put_env("SHUTTLE_HOST_CONFIG_FILE", Path.join(@fixture_dir, "shared.json"))
      Shuttle.Test.Env.put_app_env(ShuttleWeb.Endpoint, Keyword.put(endpoint, :server, true))
      sock = Path.join([base, "sock", "daemon.sock"])
      before = listening_sockets()

      :ok = Supervisor.terminate_child(Shuttle.Supervisor, ShuttleWeb.Endpoint)

      on_exit(fn ->
        Supervisor.terminate_child(Shuttle.Supervisor, ShuttleWeb.Endpoint)
        Application.put_env(:shuttle, ShuttleWeb.Endpoint, endpoint)
        Supervisor.restart_child(Shuttle.Supervisor, ShuttleWeb.Endpoint)
      end)

      Shuttle.Application.configure_endpoint()
      {:ok, _} = Supervisor.restart_child(Shuttle.Supervisor, ShuttleWeb.Endpoint)
      Shuttle.Application.restrict_bound_socket()

      assert Shuttle.listen() == "unix://" <> sock
      assert Shuttle.host_class() == :shared_multi_user

      # The probe's new unix socket shares the requested path's inode — so an
      # empty TCP difference below is a finding, not a probe that sees nothing.
      opened = listening_sockets() -- before
      {:ok, %File.Stat{inode: inode}} = File.stat(sock)

      assert Enum.any?(opened, fn
               {:local, path} ->
                 match?({:ok, %File.Stat{inode: ^inode}}, File.stat(path))

               _ ->
                 false
             end)

      assert Enum.filter(opened, &match?({{_, _, _, _}, _}, &1)) == []
      assert Enum.filter(opened, &match?({{_, _, _, _, _, _, _, _}, _}, &1)) == []

      assert {:ok, %File.Stat{type: :other, mode: mode}} = File.lstat(sock)
      assert Bitwise.band(mode, 0o777) == 0o600
      assert {:ok, %File.Stat{mode: dir_mode}} = File.lstat(Path.dirname(sock))
      assert Bitwise.band(dir_mode, 0o777) == 0o700

      {:ok, socket} = :gen_tcp.connect({:local, sock}, 0, [:binary, active: false], 2_000)

      :ok =
        :gen_tcp.send(
          socket,
          "GET /api/v1/version HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n"
        )

      [head, body] = socket |> recv_all("") |> String.split("\r\n\r\n", parts: 2)
      assert head =~ "HTTP/1.1 200"

      assert %{
               "listen" => listen,
               "host_class" => "shared-multi-user",
               "peer_gate" => "none",
               "peer_gate_uid" => nil,
               "peer_gate_uid_source" => nil
             } = Jason.decode!(body)

      assert listen == "unix://" <> sock
    end
  end

  # Every listening socket in this VM, by address: `{ip, port}` for TCP and
  # `{:local, path}` for a unix listener (gen_tcp serves both as inet ports).
  defp listening_sockets do
    for port <- Port.list(),
        {:name, ~c"tcp_inet"} == :erlang.port_info(port, :name),
        %{states: states} <- [safe_inet_info(port)],
        :listen in states,
        {:ok, address} <- [:inet.sockname(port)],
        do: address
  end

  defp safe_inet_info(port) do
    :inet.info(port)
  rescue
    _ -> %{states: []}
  end

  defp recv_all(socket, acc) do
    case :gen_tcp.recv(socket, 0, 5_000) do
      {:ok, data} -> recv_all(socket, acc <> data)
      {:error, :closed} -> acc
    end
  end
end
