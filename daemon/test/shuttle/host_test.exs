defmodule Shuttle.HostTest do
  use ExUnit.Case, async: true
  import ExUnit.CaptureLog

  alias Shuttle.Host

  @fixture_dir Path.expand("../fixtures/host", __DIR__)

  describe "parity with the Go reader" do
    # The same fixtures and expectation file internal/shuttlecli/host_class_test.go
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

        Shuttle.Test.Env.put_env(
          "SHUTTLE_HOST_CONFIG_FILE",
          if(file,
            do: Path.join(@fixture_dir, file),
            else: Path.join(@fixture_dir, "absent.json")
          )
        )

        Shuttle.Test.Env.delete_env("SHUTTLE_LISTEN")
        Shuttle.Test.Env.delete_env("SHUTTLE_PORT")

        Enum.each(Map.merge(@base_env, env), fn {var, value} ->
          Shuttle.Test.Env.put_env(var, value)
        end)

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

  describe "quarantine_auto_release?/0" do
    setup do
      dir = Path.join(System.tmp_dir!(), "shuttle-host-#{System.unique_integer([:positive])}")
      File.mkdir_p!(dir)
      on_exit(fn -> File.rm_rf!(dir) end)
      %{host_file: Path.join(dir, "host.json")}
    end

    test "on only for an explicit true", %{host_file: file} do
      Shuttle.Test.Env.put_env("SHUTTLE_HOST_CONFIG_FILE", file)
      refute Host.quarantine_auto_release?()

      for {body, want} <- [
            {~s({"class":"shared-multi-user","quarantine_auto_release":true}), true},
            {~s({"quarantine_auto_release":false}), false},
            {~s({"class":"shared-multi-user"}), false}
          ] do
        File.write!(file, body)
        assert Host.quarantine_auto_release?() == want, body
      end
    end

    test "any other value is off, with a warning", %{host_file: file} do
      Shuttle.Test.Env.put_env("SHUTTLE_HOST_CONFIG_FILE", file)
      File.write!(file, ~s({"quarantine_auto_release":"yes"}))

      assert capture_log(fn -> refute Host.quarantine_auto_release?() end) =~
               "must be true or false"
    end

    test "a malformed host.json is off rather than a crash", %{host_file: file} do
      Shuttle.Test.Env.put_env("SHUTTLE_HOST_CONFIG_FILE", file)
      File.write!(file, "{not json")
      refute Host.quarantine_auto_release?()
    end
  end

  describe "resolve!/1" do
    test "raises with the file's path on a malformed host.json" do
      path = Path.join(@fixture_dir, "malformed.json")
      Shuttle.Test.Env.put_env("SHUTTLE_HOST_CONFIG_FILE", path)

      assert_raise ArgumentError, ~r/#{Regex.escape(path)}/, fn -> Host.resolve!() end
    end

    test "the single-user default falls back to the endpoint config's port" do
      Shuttle.Test.Env.put_env("SHUTTLE_HOST_CONFIG_FILE", Path.join(@fixture_dir, "absent.json"))
      Shuttle.Test.Env.delete_env("SHUTTLE_LISTEN")
      Shuttle.Test.Env.delete_env("SHUTTLE_PORT")

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
      assert is_binary(Host.prepare_unix_socket!(sock))

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

    test "refuses a symlink owned by a different uid before following it", %{base: base} do
      target = Path.join(base, "target")
      link = Path.join("/tmp", "shuttle-host-link-#{System.unique_integer([:positive])}")
      File.mkdir_p!(target)
      File.chmod!(target, 0o755)
      File.ln_s!(target, link)
      on_exit(fn -> File.rm(link) end)

      error =
        assert_raise ArgumentError, fn ->
          Host.prepare_unix_socket!(Path.join([link, "sock", "daemon.sock"]), euid: 999_999)
        end

      assert error.message =~ link
      assert error.message =~ "refusing to follow symlink"
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

      resolved = Host.prepare_unix_socket!(Path.join([base, "link", "sock", "daemon.sock"]))
      assert String.contains?(resolved, "real")
      refute String.contains?(resolved, "link")
      assert File.dir?(Path.join(real, "sock"))
    end

    test "rejects a physical socket path beyond sun_path after symlink resolution", %{
      base: base
    } do
      target_name = "deep-" <> String.duplicate("x", 96)
      target = Path.join(base, target_name)
      File.mkdir_p!(target)
      File.chmod!(target, 0o755)
      link = Path.join(base, "link")
      File.ln_s!(target, link)
      configured_path = Path.join([link, "sock", "daemon.sock"])

      assert byte_size(configured_path) < 100
      assert byte_size(Path.join([target, "sock", "daemon.sock"])) >= 108

      error = assert_raise ArgumentError, fn -> Host.prepare_unix_socket!(configured_path) end

      [configured_message, resolved_message] =
        String.split(error.message, " resolves to ", parts: 2)

      assert configured_message =~ inspect(configured_path)
      refute resolved_message =~ link
      assert resolved_message =~ target_name
      assert [_, bytes] = Regex.run(~r/\((\d+) bytes\)/, resolved_message)
      assert [_, limit] = Regex.run(~r/platform sun_path limit is (\d+) bytes/, resolved_message)
      assert String.to_integer(bytes) >= String.to_integer(limit)
      assert String.to_integer(limit) in [104, 108]
    end

    test "accepts a sticky world-writable ancestor, as /tmp is", %{base: base} do
      sticky = Path.join(base, "sticky")
      File.mkdir_p!(sticky)
      # Erlang's chmod drops the sticky bit on macOS; the chmod binary keeps it.
      {_, 0} = System.cmd("chmod", ["1777", sticky])
      assert {:ok, %File.Stat{mode: mode}} = File.lstat(sticky)
      assert Bitwise.band(mode, 0o1777) == 0o1777

      assert is_binary(Host.prepare_unix_socket!(Path.join([sticky, "sock", "daemon.sock"])))
    end

    test "creates missing ancestors without group or other write", %{base: base} do
      sock = Path.join([base, "a", "b", "sock", "daemon.sock"])
      assert is_binary(Host.prepare_unix_socket!(sock))

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
      _resolved = Host.prepare_unix_socket!(sock)
      {:ok, listener} = :gen_tcp.listen(0, [{:ifaddr, {:local, sock}}])
      :gen_tcp.close(listener)
      assert {:ok, %File.Stat{type: :other}} = File.lstat(sock)

      assert is_binary(Host.prepare_unix_socket!(sock))
      refute File.exists?(sock)
    end

    test "refuses a socket another daemon is listening on", %{sock: sock} do
      _resolved = Host.prepare_unix_socket!(sock)
      {:ok, listener} = :gen_tcp.listen(0, [{:ifaddr, {:local, sock}}])
      on_exit(fn -> :gen_tcp.close(listener) end)

      assert_raise ArgumentError, ~r/another daemon is listening on unix:\/\//, fn ->
        Host.prepare_unix_socket!(sock)
      end

      assert {:ok, %File.Stat{type: :other}} = File.lstat(sock)
    end

    test "leaves a non-socket file at the path alone", %{sock: sock} do
      _resolved = Host.prepare_unix_socket!(sock)
      File.write!(sock, "not a socket")

      assert_raise ArgumentError, ~r/not a stale socket/, fn ->
        Host.prepare_unix_socket!(sock)
      end

      assert File.read!(sock) == "not a socket"
    end
  end

  # `endpoint_settings/0` is what `configure_endpoint/0` writes into the app
  # env at boot, resolved here without writing it.
  describe "Shuttle.Application.endpoint_settings/0" do
    setup do
      base = "/tmp/shuttle-cfg-#{System.unique_integer([:positive])}"
      File.mkdir_p!(base)
      # Explicit mode: under a 002 umask mkdir yields 0775 and the ancestry check refuses it.
      File.chmod!(base, 0o755)
      on_exit(fn -> File.rm_rf(base) end)

      Shuttle.Test.Env.delete_env("SHUTTLE_LISTEN")
      Shuttle.Test.Env.delete_env("SHUTTLE_PORT")
      Shuttle.Test.Env.delete_env("SHUTTLE_PEER_UID")
      Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", base)

      {:ok, base: base, endpoint: Application.get_env(:shuttle, ShuttleWeb.Endpoint)}
    end

    test "a server: false endpoint resolves the socket without touching disk",
         %{base: base, endpoint: endpoint} do
      Shuttle.Test.Env.put_env("SHUTTLE_HOST_CONFIG_FILE", Path.join(@fixture_dir, "shared.json"))
      Shuttle.Test.Env.put_app_env(ShuttleWeb.Endpoint, Keyword.put(endpoint, :server, false))

      settings = Map.new(Shuttle.Application.endpoint_settings())

      assert settings[:listen] == "unix://" <> Path.join([base, "sock", "daemon.sock"])
      refute File.exists?(Path.join(base, "sock"))
      assert settings[:peer_gate] == "none"
    end

    test "a shared TCP test endpoint bypasses the proc requirement", %{
      base: base,
      endpoint: endpoint
    } do
      Shuttle.Test.Env.put_env("SHUTTLE_HOST_CONFIG_FILE", Path.join(@fixture_dir, "shared.json"))
      Shuttle.Test.Env.put_env("SHUTTLE_LISTEN", "tcp://127.0.0.1:4999")
      Shuttle.Test.Env.put_app_env(:proc_net_root, Path.join(base, "missing-proc"))
      Shuttle.Test.Env.put_app_env(ShuttleWeb.Endpoint, Keyword.put(endpoint, :server, false))

      settings = Map.new(Shuttle.Application.endpoint_settings())

      assert settings[:listen] == "tcp://127.0.0.1:4999"
      assert settings[:peer_gate] == "none"
    end

    test "a shared TCP listener reports the daemon euid and source", %{
      base: base,
      endpoint: endpoint
    } do
      {host_file, proc_root} = shared_tcp_fixtures(base)
      Shuttle.Test.Env.put_env("SHUTTLE_HOST_CONFIG_FILE", host_file)
      Shuttle.Test.Env.put_app_env(:proc_net_root, proc_root)
      Shuttle.Test.Env.put_app_env(ShuttleWeb.Endpoint, Keyword.put(endpoint, :server, true))

      settings = Map.new(Shuttle.Application.endpoint_settings())

      {uid_text, 0} = System.cmd("id", ["-u"])
      assert settings[:peer_gate] == "uid"

      assert settings[:peer_gate_expected_uid] ==
               String.to_integer(String.trim(uid_text))

      assert settings[:peer_gate_uid_source] == "euid"
    end

    test "a shared TCP uid override is reported and warned about", %{
      base: base,
      endpoint: endpoint
    } do
      {host_file, proc_root} = shared_tcp_fixtures(base)
      Shuttle.Test.Env.put_env("SHUTTLE_HOST_CONFIG_FILE", host_file)
      Shuttle.Test.Env.put_env("SHUTTLE_PEER_UID", "424242")
      Shuttle.Test.Env.put_app_env(:proc_net_root, proc_root)
      Shuttle.Test.Env.put_app_env(ShuttleWeb.Endpoint, Keyword.put(endpoint, :server, true))

      {settings, log} = with_log(fn -> Map.new(Shuttle.Application.endpoint_settings()) end)

      assert log =~ "SHUTTLE_PEER_UID is set"
      assert settings[:peer_gate] == "uid"
      assert settings[:peer_gate_expected_uid] == 424_242
      assert settings[:peer_gate_uid_source] == "env"
    end

    test "a shared TCP listener refuses boot when proc is unreadable", %{
      base: base,
      endpoint: endpoint
    } do
      Shuttle.Test.Env.put_env("SHUTTLE_HOST_CONFIG_FILE", Path.join(@fixture_dir, "shared.json"))
      Shuttle.Test.Env.put_env("SHUTTLE_LISTEN", "tcp://127.0.0.1:4999")
      Shuttle.Test.Env.put_app_env(:proc_net_root, Path.join(base, "missing-proc"))
      Shuttle.Test.Env.put_app_env(ShuttleWeb.Endpoint, Keyword.put(endpoint, :server, true))

      error =
        assert_raise ArgumentError, fn ->
          Shuttle.Application.endpoint_settings()
        end

      assert error.message =~ "shared-multi-user"
      assert error.message =~ "tcp://127.0.0.1:4999"
      assert error.message =~ "drop the tcp:// listen"
      assert error.message =~ "declare the host single-user"
    end

    test "an exposed host refuses TCP and directs the front proxy to its socket", %{
      endpoint: endpoint
    } do
      Shuttle.Test.Env.put_env(
        "SHUTTLE_HOST_CONFIG_FILE",
        Path.join(@fixture_dir, "exposed.json")
      )

      Shuttle.Test.Env.put_env("SHUTTLE_LISTEN", "tcp://127.0.0.1:4999")
      Shuttle.Test.Env.put_app_env(ShuttleWeb.Endpoint, Keyword.put(endpoint, :server, true))

      error =
        assert_raise ArgumentError, fn ->
          Shuttle.Application.endpoint_settings()
        end

      assert error.message =~ "host class exposed"
      assert error.message =~ "exposed hosts serve only the unix socket"
      assert error.message =~ "the front proxy must dial the socket"
    end

    test "a single-user host keeps loopback tcp on the configured port", %{endpoint: endpoint} do
      Shuttle.Test.Env.put_env(
        "SHUTTLE_HOST_CONFIG_FILE",
        Path.join(@fixture_dir, "single_user.json")
      )

      Shuttle.Test.Env.put_app_env(ShuttleWeb.Endpoint, endpoint)

      settings = Map.new(Shuttle.Application.endpoint_settings())

      http = settings[ShuttleWeb.Endpoint][:http]
      assert http[:ip] == {127, 0, 0, 1}
      assert http[:port] == 4002
      assert settings[:listen] == "tcp://127.0.0.1:4002"
    end

    test "a non-loopback listen refuses to boot", %{endpoint: endpoint} do
      Shuttle.Test.Env.put_env(
        "SHUTTLE_HOST_CONFIG_FILE",
        Path.join(@fixture_dir, "non_loopback.json")
      )

      Shuttle.Test.Env.put_app_env(ShuttleWeb.Endpoint, endpoint)

      assert_raise ArgumentError, ~r/only 127\.0\.0\.1 is allowed/, fn ->
        Shuttle.Application.endpoint_settings()
      end
    end
  end

  defp shared_tcp_fixtures(base) do
    host_file = Path.join(base, "shared-tcp-host.json")

    File.write!(
      host_file,
      Jason.encode!(%{"class" => "shared-multi-user", "listen" => "tcp://127.0.0.1:4999"})
    )

    proc_root = Path.join(base, "proc")
    net_dir = Path.join(proc_root, "net")
    File.mkdir_p!(net_dir)

    File.write!(
      Path.join(net_dir, "tcp"),
      "  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n"
    )

    {host_file, proc_root}
  end
end
