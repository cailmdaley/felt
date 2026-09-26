defmodule Shuttle.HostTest do
  use ExUnit.Case, async: false
  import Shuttle.Test.EnvHelpers

  alias Shuttle.Host

  @fixture_dir Path.expand("../fixtures/host", __DIR__)
  @env_vars ~w(FELT_HOST_FILE SHUTTLE_LISTEN SHUTTLE_PORT SHUTTLE_DATA_DIR SHUTTLE_PEER_UID)

  setup do
    previous = Map.new(@env_vars, &{&1, System.get_env(&1)})
    on_exit(fn -> Enum.each(previous, fn {var, value} -> restore_env(var, value) end) end)
    :ok
  end

  describe "parity with the Go reader" do
    # The same fixtures and expectation file cmd/shuttle_host_class_test.go
    # asserts against. Error kinds are the contract; messages are not.
    expected =
      "../fixtures/host/expected.json"
      |> Path.expand(__DIR__)
      |> File.read!()
      |> Jason.decode!()

    @base_env expected["base_env"]

    for %{"name" => name} = kase <- expected["cases"] do
      @kase kase

      test "#{name} resolves identically in both languages" do
        %{"file" => file, "env" => env, "expect" => want} = @kase

        System.put_env(
          "FELT_HOST_FILE",
          if(file,
            do: Path.join(@fixture_dir, file),
            else: Path.join(@fixture_dir, "absent.json")
          )
        )

        System.delete_env("SHUTTLE_LISTEN")
        System.delete_env("SHUTTLE_PORT")
        Enum.each(Map.merge(@base_env, env), fn {var, value} -> System.put_env(var, value) end)

        got =
          case Host.resolve() do
            {:ok, settings} ->
              %{
                "class" => Host.class_name(settings.class),
                "class_source" => Atom.to_string(settings.class_source),
                "listen" => Host.format_listen(settings.listen),
                "listen_source" =>
                  case settings.listen_source do
                    :env -> "SHUTTLE_LISTEN"
                    :file -> "file"
                    :class_default -> "class-default"
                  end
              }

            {:error, kind, _message} ->
              %{"error" => Atom.to_string(kind)}
          end

        assert got == want
      end
    end
  end

  describe "resolve!/1" do
    test "raises with the file's path on a malformed host.json" do
      path = Path.join(@fixture_dir, "malformed.json")
      System.put_env("FELT_HOST_FILE", path)

      assert_raise ArgumentError, ~r/#{Regex.escape(path)}/, fn -> Host.resolve!() end
    end

    test "the single-user default falls back to the endpoint config's port" do
      System.put_env("FELT_HOST_FILE", Path.join(@fixture_dir, "absent.json"))
      System.delete_env("SHUTTLE_LISTEN")
      System.delete_env("SHUTTLE_PORT")

      assert %{listen: {:tcp, {127, 0, 0, 1}, 4002}} = Host.resolve!(4002)
    end
  end

  describe "prepare_unix_socket!/2" do
    # /tmp rather than System.tmp_dir!(): macOS's per-user temp dir is ~50
    # bytes deep, which leaves little room under the 100-byte socket limit.
    setup do
      base = "/tmp/shuttle-host-#{System.unique_integer([:positive])}"
      File.mkdir_p!(base)
      # Explicit mode: under a 002 umask mkdir yields 0775 and the ancestry check refuses it.
      File.chmod!(base, 0o755)
      on_exit(fn -> File.rm_rf(base) end)
      {:ok, base: base, sock: Path.join([base, "sock", "daemon.sock"])}
    end

    test "creates a missing socket directory 0700", %{sock: sock} do
      assert :ok = Host.prepare_unix_socket!(sock)

      assert {:ok, %File.Stat{type: :directory, mode: mode}} = File.stat(Path.dirname(sock))
      assert Bitwise.band(mode, 0o777) == 0o700
    end

    test "refuses an existing directory that is not 0700, naming it and its mode",
         %{sock: sock} do
      dir = Path.dirname(sock)
      File.mkdir_p!(dir)
      File.chmod!(dir, 0o755)

      error = assert_raise ArgumentError, fn -> Host.prepare_unix_socket!(sock) end
      assert error.message =~ dir
      assert error.message =~ "0755"
      # Refused, not repaired.
      assert {:ok, %File.Stat{mode: mode}} = File.stat(dir)
      assert Bitwise.band(mode, 0o777) == 0o755
    end

    test "refuses a path through a directory owned by another uid", %{sock: sock} do
      # A real foreign-owned directory needs root to create; the owner check
      # is exercised by overriding the uid it compares against instead.
      error =
        assert_raise ArgumentError, fn -> Host.prepare_unix_socket!(sock, euid: 999_999) end

      assert error.message =~ "neither this daemon's uid 999999 nor root"
    end

    test "refuses a socket directory under a group- or world-writable ancestor",
         %{base: base} do
      open = Path.join(base, "open")
      File.mkdir_p!(open)
      File.chmod!(open, 0o777)

      error =
        assert_raise ArgumentError, fn ->
          Host.prepare_unix_socket!(Path.join([open, "sock", "daemon.sock"]))
        end

      assert error.message =~
               ~r/refusing to listen under \S*#{Regex.escape(Path.relative_to(open, "/tmp"))}: its mode is 0777/
    end

    test "refuses the swap: a socket dir symlinked from a writable parent to someone else's",
         %{base: base} do
      # The reviewer's attack: with a writable parent, `sock/` becomes a link
      # to a directory the attacker controls. The walk stops at the parent.
      open = Path.join(base, "open")
      theirs = Path.join(base, "theirs")
      File.mkdir_p!(open)
      File.mkdir_p!(theirs)
      File.chmod!(theirs, 0o700)
      File.chmod!(open, 0o777)
      File.ln_s!(theirs, Path.join(open, "sock"))

      # The walk reports physical paths; /tmp may itself be a symlink.
      assert_raise ArgumentError,
                   ~r/refusing to listen under \S*#{Regex.escape(Path.relative_to(open, "/tmp"))}: its mode is 0777/,
                   fn ->
                     Host.prepare_unix_socket!(Path.join([open, "sock", "daemon.sock"]))
                   end

      refute File.exists?(Path.join(theirs, "daemon.sock"))
    end

    test "follows a symlinked ancestor whose target is itself safe", %{base: base} do
      real = Path.join(base, "real")
      File.mkdir_p!(real)
      File.chmod!(real, 0o755)
      File.ln_s!(real, Path.join(base, "link"))

      assert :ok = Host.prepare_unix_socket!(Path.join([base, "link", "sock", "daemon.sock"]))
      assert File.dir?(Path.join(real, "sock"))
    end

    test "accepts a sticky world-writable ancestor, as /tmp is", %{base: base} do
      sticky = Path.join(base, "sticky")
      File.mkdir_p!(sticky)
      # Erlang's chmod drops the sticky bit on macOS; the chmod binary keeps it.
      {_, 0} = System.cmd("chmod", ["1777", sticky])
      assert {:ok, %File.Stat{mode: mode}} = File.lstat(sticky)
      assert Bitwise.band(mode, 0o1777) == 0o1777

      assert :ok = Host.prepare_unix_socket!(Path.join([sticky, "sock", "daemon.sock"]))
    end

    test "creates missing ancestors without group or other write", %{base: base} do
      sock = Path.join([base, "a", "b", "sock", "daemon.sock"])
      assert :ok = Host.prepare_unix_socket!(sock)

      for dir <- [Path.join(base, "a"), Path.join([base, "a", "b"])] do
        {:ok, %File.Stat{mode: mode}} = File.lstat(dir)
        assert Bitwise.band(mode, 0o022) == 0, "#{dir} is #{Integer.to_string(mode, 8)}"
      end
    end

    test "refuses a symlinked socket directory", %{base: base, sock: sock} do
      real = Path.join(base, "real")
      File.mkdir_p!(real)
      File.chmod!(real, 0o700)
      File.ln_s!(real, Path.dirname(sock))

      assert_raise ArgumentError, ~r/symlink, not a directory/, fn ->
        Host.prepare_unix_socket!(sock)
      end
    end

    test "removes a stale socket nothing answers on", %{sock: sock} do
      :ok = Host.prepare_unix_socket!(sock)
      {:ok, listener} = :gen_tcp.listen(0, [{:ifaddr, {:local, sock}}])
      :gen_tcp.close(listener)
      assert {:ok, %File.Stat{type: :other}} = File.lstat(sock)

      assert :ok = Host.prepare_unix_socket!(sock)
      refute File.exists?(sock)
    end

    test "refuses a socket another daemon is listening on", %{sock: sock} do
      :ok = Host.prepare_unix_socket!(sock)
      {:ok, listener} = :gen_tcp.listen(0, [{:ifaddr, {:local, sock}}])
      on_exit(fn -> :gen_tcp.close(listener) end)

      assert_raise ArgumentError, ~r/another daemon is listening on unix:\/\//, fn ->
        Host.prepare_unix_socket!(sock)
      end

      assert {:ok, %File.Stat{type: :other}} = File.lstat(sock)
    end

    test "leaves a non-socket file at the path alone", %{sock: sock} do
      :ok = Host.prepare_unix_socket!(sock)
      File.write!(sock, "not a socket")

      assert_raise ArgumentError, ~r/not a stale socket/, fn ->
        Host.prepare_unix_socket!(sock)
      end

      assert File.read!(sock) == "not a socket"
    end
  end

  describe "Shuttle.Application.configure_endpoint/0" do
    setup do
      previous_endpoint = Application.get_env(:shuttle, ShuttleWeb.Endpoint)
      previous_listen = Application.get_env(:shuttle, :listen)
      previous_class = Application.get_env(:shuttle, :host_class)
      previous_peer_gate = Application.get_env(:shuttle, :peer_gate)
      previous_peer_gate_uid = Application.get_env(:shuttle, :peer_gate_expected_uid)
      previous_proc_root = Application.get_env(:shuttle, :proc_net_root)

      on_exit(fn ->
        Application.put_env(:shuttle, ShuttleWeb.Endpoint, previous_endpoint)
        restore_app_env(:listen, previous_listen)
        restore_app_env(:host_class, previous_class)
        restore_app_env(:peer_gate, previous_peer_gate)
        restore_app_env(:peer_gate_expected_uid, previous_peer_gate_uid)
        restore_app_env(:proc_net_root, previous_proc_root)
      end)

      base = "/tmp/shuttle-cfg-#{System.unique_integer([:positive])}"
      File.mkdir_p!(base)
      # Explicit mode: under a 002 umask mkdir yields 0775 and the ancestry check refuses it.
      File.chmod!(base, 0o755)
      on_exit(fn -> File.rm_rf(base) end)

      System.delete_env("SHUTTLE_LISTEN")
      System.delete_env("SHUTTLE_PORT")
      System.delete_env("SHUTTLE_PEER_UID")
      System.put_env("SHUTTLE_DATA_DIR", base)

      {:ok, base: base, endpoint: previous_endpoint}
    end

    test "a shared host's endpoint serves on its unix socket and opens no TCP port", %{
      base: base,
      endpoint: endpoint
    } do
      # The real endpoint, restarted under the configuration boot produces:
      # the running test endpoint is stopped, reconfigured with server: true,
      # and restarted, so Phoenix → Bandit → thousand_island do the binding.
      System.put_env("FELT_HOST_FILE", Path.join(@fixture_dir, "shared.json"))
      Application.put_env(:shuttle, ShuttleWeb.Endpoint, Keyword.put(endpoint, :server, true))
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

      # The probe sees the unix listener it was asked about — so an empty TCP
      # difference below is a finding, not a probe that sees nothing.
      opened = listening_sockets() -- before
      assert {:local, sock} in opened
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

      assert %{"listen" => listen, "host_class" => "shared-multi-user", "peer_gate" => "none"} =
               Jason.decode!(body)

      assert listen == "unix://" <> sock
    end

    test "a server: false endpoint resolves the socket without touching disk",
         %{base: base, endpoint: endpoint} do
      System.put_env("FELT_HOST_FILE", Path.join(@fixture_dir, "shared.json"))
      Application.put_env(:shuttle, ShuttleWeb.Endpoint, Keyword.put(endpoint, :server, false))

      Shuttle.Application.configure_endpoint()

      assert Shuttle.listen() == "unix://" <> Path.join([base, "sock", "daemon.sock"])
      refute File.exists?(Path.join(base, "sock"))
      assert Application.get_env(:shuttle, :peer_gate) == "none"
    end

    test "a shared TCP test endpoint bypasses the proc requirement", %{
      base: base,
      endpoint: endpoint
    } do
      System.put_env("FELT_HOST_FILE", Path.join(@fixture_dir, "shared.json"))
      System.put_env("SHUTTLE_LISTEN", "tcp://127.0.0.1:4999")
      Application.put_env(:shuttle, :proc_net_root, Path.join(base, "missing-proc"))
      Application.put_env(:shuttle, ShuttleWeb.Endpoint, Keyword.put(endpoint, :server, false))

      Shuttle.Application.configure_endpoint()

      assert Shuttle.listen() == "tcp://127.0.0.1:4999"
      assert Application.get_env(:shuttle, :peer_gate) == "none"
    end

    test "a shared TCP listener refuses boot when proc is unreadable", %{
      base: base,
      endpoint: endpoint
    } do
      System.put_env("FELT_HOST_FILE", Path.join(@fixture_dir, "shared.json"))
      System.put_env("SHUTTLE_LISTEN", "tcp://127.0.0.1:4999")
      Application.put_env(:shuttle, :proc_net_root, Path.join(base, "missing-proc"))
      Application.put_env(:shuttle, ShuttleWeb.Endpoint, Keyword.put(endpoint, :server, true))

      error =
        assert_raise ArgumentError, fn ->
          Shuttle.Application.configure_endpoint()
        end

      assert error.message =~ "shared-multi-user"
      assert error.message =~ "tcp://127.0.0.1:4999"
      assert error.message =~ "drop the tcp:// listen"
      assert error.message =~ "declare the host single-user"
    end

    test "a single-user host keeps loopback tcp on the configured port", %{endpoint: endpoint} do
      System.put_env("FELT_HOST_FILE", Path.join(@fixture_dir, "single_user.json"))
      Application.put_env(:shuttle, ShuttleWeb.Endpoint, endpoint)

      Shuttle.Application.configure_endpoint()

      http = Application.get_env(:shuttle, ShuttleWeb.Endpoint)[:http]
      assert http[:ip] == {127, 0, 0, 1}
      assert http[:port] == 4002
      assert Shuttle.listen() == "tcp://127.0.0.1:4002"
    end

    test "a non-loopback listen refuses to boot", %{endpoint: endpoint} do
      System.put_env("FELT_HOST_FILE", Path.join(@fixture_dir, "non_loopback.json"))
      Application.put_env(:shuttle, ShuttleWeb.Endpoint, endpoint)

      assert_raise ArgumentError, ~r/only 127\.0\.0\.1 is allowed/, fn ->
        Shuttle.Application.configure_endpoint()
      end
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
