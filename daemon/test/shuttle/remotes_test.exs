defmodule Shuttle.RemotesTest do
  # group: Shuttle.TailnetPeers keeps its peers in an ETS table named after the module, which Remotes.configured/0 reads when :remotes is unset
  use ExUnit.Case, async: true, group: :tailnet_peers

  alias Shuttle.Remote
  alias Shuttle.Remotes

  @fixture_dir Path.expand("../fixtures/remotes", __DIR__)

  setup do
    # The whole suite runs with `remotes: []` from config/test.exs — that `[]` is
    # the shield that stops a developer's real fleet file from leaking into the
    # tests. These cases are about the FILE, so they clear it in their own scope.
    Shuttle.Test.Env.delete_app_env(:remotes)
    Shuttle.Test.Env.delete_app_env(:https_proxy)
    Shuttle.Test.Env.delete_app_env(:tailscale_socket)

    :ok
  end

  describe "parity with the Go reader" do
    # The same fixtures and the same expectation file internal/shuttlecli/remotes_test.go
    # asserts against. Two readers, one contract: a default that drifts in one
    # language fails in both.
    expected =
      "../fixtures/remotes/expected.json"
      |> Path.expand(__DIR__)
      |> File.read!()
      |> Jason.decode!()

    for {fixture, want} <- expected, not String.starts_with?(fixture, "_") do
      @fixture fixture
      @want want

      test "#{fixture} reads identically in both languages" do
        Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", Path.join(@fixture_dir, @fixture))

        assert Remotes.launchd_label_prefix() == @want["launchd_label_prefix"]

        proxy =
          case Remotes.https_proxy() do
            {host, port} -> %{"host" => host, "port" => port}
            nil -> %{"host" => "", "port" => 0}
          end

        assert proxy == @want["https_proxy"]
        assert Remotes.tailscale_socket() == @want["tailscale_socket"]

        got =
          Remotes.registered()
          |> Enum.map(fn %Remote{} = r ->
            %{
              "name" => r.name,
              "url" => r.url,
              "ssh" => Remote.ssh_host(r) || "",
              "display" => Remote.display_name(r),
              "port" => r.port || 0,
              "remote_port" => r.remote_port,
              "remote_socket" => r.remote_socket || "",
              "poll_interval_ms" => r.poll_interval_ms,
              "request_timeout_ms" => r.request_timeout_ms,
              "stale_multiplier" => r.stale_multiplier,
              "label" => Remotes.label_for(r)
            }
            |> with_manager(r, @want)
          end)

        assert got == @want["remotes"]
      end
    end
  end

  describe "fixtures neither reader may accept" do
    # expected.json's `_rejected`: the Go validator refuses the whole file;
    # the daemon drops the named remote and never uses it.
    rejected =
      "../fixtures/remotes/expected.json"
      |> Path.expand(__DIR__)
      |> File.read!()
      |> Jason.decode!()
      |> Map.fetch!("_rejected")
      |> Map.delete("_comment")

    for {fixture, %{"remote" => remote, "field" => field}} <- rejected do
      @fixture fixture
      @remote remote

      test "#{fixture}: the daemon rejects #{field}" do
        Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", Path.join(@fixture_dir, @fixture))
        names = Enum.map(Remotes.registered(), & &1.name)

        if @remote == "" do
          assert names == [], "invalid fleet defaults reject the whole file"
        else
          refute @remote in names
          assert names != [], "the fixture's other valid remotes should still read"
        end
      end
    end
  end

  # `manager` is asserted only where expected.json carries it — on portless
  # entries, the one place the two readers must agree (see its `_comment`).
  defp with_manager(got, remote, want) do
    if Enum.any?(want["remotes"], &Map.has_key?(&1, "manager")) do
      Map.put(got, "manager", to_string(remote.tunnel.manager))
    else
      got
    end
  end

  describe "defaults.tailscale_socket" do
    test "invalid paths reject the fleet instead of enabling an unsafe dial" do
      for path <- ["relative/tailscaled.sock", "/run/../tailscaled.sock", "/run/tailscale/"] do
        file =
          Jason.encode!(%{
            "defaults" => %{"tailscale_socket" => path},
            "remotes" => [%{"name" => "hub-a", "port" => 4001}]
          })
          |> write_remotes()

        Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", file)
        assert Remotes.tailscale_socket() == nil
        assert Remotes.registered() == []
      end
    end
  end

  describe "tunnel manager" do
    # Asserted directly rather than only through the fixtures, because the
    # fixture assertion is platform-dependent: on Linux `:none` is also the
    # host default, so a portless entry would read `:none` there even with the
    # rule removed. This is the case that bites on a Mac hub, where the two
    # answers differ — and where the drift this test exists to stop actually
    # hid. The Go mirror is
    # TestNormalizeRemotes_TunnelManagerDefaultFollowsTheTransport.
    test "a portless entry has no tunnel to supervise, whatever it claims" do
      path =
        write_remotes(~s({"remotes": [
          {"name": "url-only", "url": "https://hub-a.example.ts.net"},
          {"name": "claims-launchd", "url": "https://hub-b.example.ts.net",
           "tunnel": {"manager": "launchd"}},
          {"name": "claims-systemd", "url": "https://hub-c.example.ts.net",
           "tunnel": {"manager": "systemd"}}
        ]}))

      Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", path)

      for %Remote{name: name, tunnel: %{manager: manager}} <- Remotes.registered() do
        assert manager == :none, "#{name} has no port, so it has no tunnel to bounce"
      end
    end

    test "a port entry keeps the host rule, and its other tunnel options survive" do
      path =
        write_remotes(~s({"remotes": [
          {"name": "tunnelled", "port": 4001, "tunnel": {"multiplex": true, "label": "custom"}}
        ]}))

      Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", path)

      assert [%Remote{tunnel: tunnel}] = Remotes.registered()
      assert tunnel.multiplex
      assert tunnel.label == "custom"
    end
  end

  describe "https_proxy" do
    # The mirror of `TestParseProxyEndpoint` in internal/shuttlecli/remotes_test.go.
    # Every row here appears there with the same verdict; a grammar rule that
    # changes in one language fails in both.
    @proxy_grammar [
      # accepted
      {~s("http://localhost:1055"), {"localhost", 1055}},
      {~s("https://localhost:1055"), {"localhost", 1055}},
      {~s("localhost:1055"), {"localhost", 1055}},
      {~s("  http://10.0.0.5:3128  "), {"10.0.0.5", 3128}},
      {~s("HTTP://h:1"), {"h", 1}},
      {~s("http://user:pass@h:3128"), {"h", 3128}},
      {~s("[::1]:1055"), {"::1", 1055}},
      {~s("https://h:443"), {"h", 443}},
      # a zero-padded port normalizes rather than diverging between readers
      {~s("http://h:01055"), {"h", 1055}},
      # rejected: no port written out
      {~s("localhost"), nil},
      {~s("https://h"), nil},
      {~s("h:"), nil},
      {~s(""), nil},
      # rejected: no host
      {~s("http://:1055"), nil},
      # rejected: a proxy address has no path, query, or fragment
      {~s("http://h:1/x"), nil},
      {~s("http://h:1/x/y"), nil},
      {~s("http://h:1?a=b"), nil},
      {~s("http://h:1#f"), nil},
      # rejected: not an HTTP CONNECT proxy
      {~s("socks5://h:1080"), nil},
      # rejected: port out of range, or not a bare decimal
      {~s("http://h:0"), nil},
      {~s("http://h:99999"), nil},
      {~s("http://h:+1055"), nil},
      # rejected: a bare IPv6 address is ambiguous without brackets
      {~s("::1:1055"), nil},
      # rejected: not a string at all
      {"1055", nil}
    ]

    test "reads exactly the grammar the Go reader reads" do
      for {written, want} <- @proxy_grammar do
        path = write_remotes(~s({"defaults": {"https_proxy": #{written}}, "remotes": []}))
        Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", path)

        assert Remotes.https_proxy() == want,
               "#{written} should read as #{inspect(want)}"
      end
    end

    test "absent defaults, an absent file, and a malformed one all mean no proxy" do
      path = write_remotes(~s({"remotes": [{"name": "a", "port": 4001}]}))
      Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", path)
      assert Remotes.https_proxy() == nil

      Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", Path.join(tmp_dir(), "absent.json"))
      assert Remotes.https_proxy() == nil

      Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", write_remotes("{\"defaults\": {"))
      assert Remotes.https_proxy() == nil
    end

    test "application config wins, and false means explicitly none" do
      path = write_remotes(~s({"defaults": {"https_proxy": "localhost:1055"}, "remotes": []}))
      Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", path)

      Shuttle.Test.Env.put_app_env(:https_proxy, "proxy.example:8080")
      assert Remotes.https_proxy() == {"proxy.example", 8080}

      Shuttle.Test.Env.put_app_env(:https_proxy, false)
      assert Remotes.https_proxy() == nil
    end
  end

  describe "file resolution" do
    test "an absent file is a valid local-only host, not an error" do
      Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", Path.join(tmp_dir(), "absent.json"))
      assert Remotes.registered() == []
      assert Remotes.configured() == []
    end

    test "malformed JSON degrades to no remotes rather than failing to boot" do
      # `shuttle remotes list` is the validator that names the typo; a
      # daemon that refuses to serve its OWN board over a bad operator file is
      # worse than one that serves it without the fleet.
      path = write_remotes("{\"remotes\": [")
      Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", path)
      assert Remotes.registered() == []
    end

    test "an unreadable file degrades the same way" do
      path = write_remotes(~s({"remotes": [{"name": "a", "port": 4001}]}))
      File.chmod!(path, 0o000)
      on_exit(fn -> File.chmod(path, 0o644) end)
      Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", path)
      assert Remotes.registered() == []
    end

    test "a disabled entry stays on file without being polled" do
      path =
        write_remotes(~s({"remotes": [
          {"name": "on", "port": 4001},
          {"name": "off", "port": 4002, "enabled": false}
        ]}))

      Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", path)
      assert [%Remote{name: "on"}] = Remotes.registered()
    end
  end

  describe "precedence" do
    test "application config wins over the file — including an explicit []" do
      path = write_remotes(~s({"remotes": [{"name": "from-file", "port": 4001}]}))
      Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", path)

      Shuttle.Test.Env.put_app_env(:remotes, [])
      assert Remotes.configured() == []

      Shuttle.Test.Env.put_app_env(:remotes, [%{name: "from-config", url: "http://x"}])
      assert [%Remote{name: "from-config"}] = Remotes.configured()
    end

    test "unset application config falls through to the file" do
      path = write_remotes(~s({"remotes": [{"name": "from-file", "port": 4001}]}))
      Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", path)
      Shuttle.Test.Env.delete_app_env(:remotes)

      assert [%Remote{name: "from-file", url: "http://127.0.0.1:4001"}] = Remotes.configured()
    end
  end

  describe "label_for/1" do
    test "application config beats the file's prefix" do
      path =
        write_remotes(
          ~s({"launchd_label_prefix": "com.file", "remotes": [{"name": "a", "port": 4001}]})
        )

      Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", path)
      Shuttle.Test.Env.put_app_env(:launchd_label_prefix, "com.override")

      assert Remotes.label_for("a") == "com.override.shuttle-tunnel-a"
    end

    test "a per-entry tunnel.label is a full override" do
      path =
        write_remotes(
          ~s({"remotes": [{"name": "a", "port": 4001, "tunnel": {"label": "legacy.job"}}]})
        )

      Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", path)
      assert [remote] = Remotes.registered()
      assert Remotes.label_for(remote) == "legacy.job"
    end
  end

  describe "config_token/0" do
    test "names an absent file, and changes when the file changes" do
      path = Path.join(tmp_dir(), "token.json")
      Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", path)
      assert {nil, 0, nil} = Remotes.config_token()

      File.write!(path, ~s({"remotes": [{"name": "a", "port": 4001}]}))
      first = Remotes.config_token()
      assert {{_mtime, _size}, 0, nil} = first

      File.write!(
        path,
        ~s({"remotes": [{"name": "a", "port": 4001}, {"name": "b", "port": 4002}]})
      )

      assert Remotes.config_token() != first
    end
  end

  describe "the default LocalAPI socket" do
    setup do
      {home, socket} = socket_home()
      {:ok, socket: socket, home: home}
    end

    # A layout under $HOME: the modes of .local, .local/state and
    # .local/state/tailscale, what sits at the socket path, whether .local/state
    # is a symlink into a private tree, and the OS. The socket is trusted only
    # as a Unix socket on Linux reached through real directories that no group
    # or other can write; its own mode (0666 as tailscaled creates it) is not
    # constrained. Every other candidate is refused with the reason, or absent.
    @layouts [
      # The suite's default layout, then the fleet's real ones.
      {[0o755, 0o755, 0o700], :socket, false, :linux, :ok},
      {[0o700, 0o700, 0o700], {:socket, 0o666}, false, :linux, :ok},
      {[0o755, 0o700, 0o700], {:socket, 0o666}, false, :linux, :ok},
      {[0o750, 0o700, 0o700], {:socket, 0o666}, false, :linux, :ok},
      {[0o700, 0o755, 0o700], {:socket, 0o666}, false, :linux, :ok},
      {[0o775, 0o755, 0o700], :socket, false, :linux,
       {:contains, "$HOME/.local: its mode is 0775, writable by group or others"}},
      {[0o777, 0o755, 0o700], :socket, false, :linux,
       {:contains, "$HOME/.local: its mode is 0777"}},
      {[0o755, 0o755, 0o700], :fifo, false, :linux, {:exact, "$SOCKET is not a Unix socket"}},
      {[0o755, 0o755, 0o700], :regular, false, :linux,
       {:exact, "$SOCKET is a regular, not a Unix socket"}},
      # The resolved path is all private; the literal one runs through a
      # directory anyone could have re-pointed.
      {[0o755, 0o700, 0o700], :socket, true, :linux, {:exact, "$HOME/.local/state is a symlink"}},
      {[0o777, 0o700, 0o700], :socket, true, :linux,
       {:contains, "$HOME/.local: its mode is 0777"}},
      {[0o755, 0o755, 0o700], :socket, false, :darwin, {:exact, "default socket is Linux-only"}},
      {[0o755, 0o755, 0o700], :absent, false, :linux, :absent}
    ]

    test "applies only to a private Linux socket, else is refused with the reason or absent" do
      for {modes, at_path, symlinked?, os, expected} = row <- @layouts do
        {home, socket} = socket_home(modes, at_path, symlinked?)
        Shuttle.Test.Env.put_app_env(:os_type, {:unix, os})
        check = Remotes.default_tailscale_socket_check()

        case expected do
          :ok ->
            assert check == {:ok, socket}, inspect(row)
            assert Remotes.default_tailscale_socket_refusal() == nil, inspect(row)

          :absent ->
            assert check == :absent, inspect(row)
            assert Remotes.default_tailscale_socket_refusal() == nil, inspect(row)

          {match, template} ->
            reason =
              template |> String.replace("$HOME", home) |> String.replace("$SOCKET", socket)

            assert {:refused, ^socket, why} = check, inspect(row)

            if match == :exact,
              do: assert(why == reason, inspect(row)),
              else: assert(why =~ reason, inspect(row))

            assert Remotes.default_tailscale_socket_refusal() == "#{socket}: #{why}", inspect(row)
        end

        # Only a trusted socket becomes the dial transport.
        ok? = expected == :ok
        source = if ok?, do: {:default, socket}, else: {:none, nil}
        assert Remotes.tailscale_socket_source() == source, inspect(row)
        assert Remotes.tailscale_socket_configured?() == ok?, inspect(row)
        assert Remotes.tailscale_socket() == if(ok?, do: socket), inspect(row)
      end
    end

    test "an explicit defaults.tailscale_socket wins", %{home: home} do
      explicit = Path.join(home, "explicit.sock")

      Shuttle.Test.Env.put_env(
        "SHUTTLE_REMOTES_FILE",
        write_remotes(Jason.encode!(%{"defaults" => %{"tailscale_socket" => explicit}}))
      )

      assert Remotes.tailscale_socket_source() == {:configured, explicit}
      assert Remotes.tailscale_socket() == explicit
    end

    test "\"system\" names the system tailscaled and keeps the fleet readable" do
      Shuttle.Test.Env.put_env(
        "SHUTTLE_REMOTES_FILE",
        write_remotes(
          Jason.encode!(%{
            "defaults" => %{"tailscale_socket" => "system"},
            "remotes" => [%{"name" => "hub-a", "url" => "https://hub-a.example.ts.net"}]
          })
        )
      )

      assert Remotes.tailscale_socket_source() == {:system, nil}
      refute Remotes.tailscale_socket_configured?()
      assert Remotes.tailscale_socket() == nil
      assert [%Remote{name: "hub-a"}] = Remotes.registered()
    end

    test "a configured https_proxy suppresses it" do
      Shuttle.Test.Env.put_env(
        "SHUTTLE_REMOTES_FILE",
        write_remotes(Jason.encode!(%{"defaults" => %{"https_proxy" => "localhost:1055"}}))
      )

      assert Remotes.tailscale_socket_source() == {:none, nil}
    end

    test "with the default in effect, a duplicate https authority is dropped" do
      Shuttle.Test.Env.put_env(
        "SHUTTLE_REMOTES_FILE",
        Path.join(@fixture_dir, "duplicate_https_authority_default_socket.json")
      )

      assert ["hub-a"] = Enum.map(Remotes.registered(), & &1.name)

      Shuttle.Test.Env.put_app_env(:tailscale_home, false)
      assert ["hub-a", "hub-a-alias"] = Enum.map(Remotes.registered(), & &1.name)
    end

    test "joins the change token, so a tailscaled started later is noticed", %{socket: socket} do
      assert {_file, _generation, ^socket} = Remotes.config_token()
      Shuttle.Test.Env.put_app_env(:tailscale_home, false)
      assert {_file, _generation, nil} = Remotes.config_token()
    end
  end

  # A $HOME holding the default LocalAPI socket path, with no fleet file, read as
  # Linux; `at_path` is what sits at the socket path. A unix socket path must
  # fit sun_path, so this stays under /tmp.
  defp socket_home(modes \\ [0o755, 0o755, 0o700], at_path \\ :socket, symlinked? \\ false) do
    home = "/tmp/rt-#{System.unique_integer([:positive])}"
    dirs = [".local", ".local/state", ".local/state/tailscale"]
    socket = Path.join(home, ".local/state/tailscale/tailscaled.sock")
    File.mkdir_p!(Path.dirname(socket))
    on_exit(fn -> File.rm_rf(home) end)
    File.chmod!(home, 0o755)

    case at_path do
      :absent ->
        :ok

      :fifo ->
        {_, 0} = System.cmd("mkfifo", [socket])

      :regular ->
        File.write!(socket, "")

      socket_kind ->
        {:ok, listener} = :gen_tcp.listen(0, [:binary, ifaddr: {:local, socket}])
        on_exit(fn -> :gen_tcp.close(listener) end)
        with {:socket, mode} <- socket_kind, do: File.chmod!(socket, mode)
    end

    for {dir, mode} <- Enum.zip(dirs, modes), do: File.chmod!(Path.join(home, dir), mode)

    if symlinked? do
      protected = Path.join(home, "protected")
      File.mkdir_p!(protected)
      File.chmod!(protected, 0o700)
      File.rename!(Path.join(home, ".local/state"), Path.join(protected, "state"))
      File.ln_s!(Path.join(protected, "state"), Path.join(home, ".local/state"))
    end

    Shuttle.Test.Env.put_app_env(:os_type, {:unix, :linux})
    Shuttle.Test.Env.put_app_env(:tailscale_home, home)
    Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", Path.join(home, "absent.json"))
    {home, socket}
  end

  defp write_remotes(body) do
    path = Path.join(tmp_dir(), "remotes-#{System.unique_integer([:positive])}.json")
    File.write!(path, body)
    path
  end

  # A fresh directory per test: these cases write and delete the same file
  # names, and a leftover from an earlier run would make `config_token/0`
  # non-nil before the test writes anything.
  defp tmp_dir do
    dir =
      Path.join([
        System.tmp_dir!(),
        "shuttle-remotes-test",
        "#{System.unique_integer([:positive])}"
      ])

    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    dir
  end
end
