defmodule Shuttle.RemotesTest do
  use ExUnit.Case, async: false
  import Shuttle.Test.EnvHelpers

  alias Shuttle.Remote
  alias Shuttle.Remotes

  @fixture_dir Path.expand("../fixtures/remotes", __DIR__)

  setup do
    prev_file = System.get_env("FELT_REMOTES_FILE")
    prev_env = Application.get_env(:shuttle, :remotes)
    prev_prefix = Application.get_env(:shuttle, :launchd_label_prefix)
    prev_proxy = Application.get_env(:shuttle, :https_proxy)

    # The whole suite runs with `remotes: []` from config/test.exs — that `[]` is
    # the shield that stops a developer's real fleet file from leaking into the
    # tests. These cases are about the FILE, so they clear it and restore it.
    Application.delete_env(:shuttle, :remotes)
    Application.delete_env(:shuttle, :https_proxy)

    on_exit(fn ->
      restore_env("FELT_REMOTES_FILE", prev_file)
      restore_app_env(:remotes, prev_env)
      restore_app_env(:launchd_label_prefix, prev_prefix)
      restore_app_env(:https_proxy, prev_proxy)
    end)

    :ok
  end

  describe "parity with the Go reader" do
    # The same fixtures and the same expectation file cmd/shuttle_remotes_test.go
    # asserts against. Two readers, one contract: a default that drifts in one
    # language fails in both.
    expected =
      "../fixtures/remotes/expected.json"
      |> Path.expand(__DIR__)
      |> File.read!()
      |> Jason.decode!()

    for {fixture, want} <- expected, fixture != "_comment" do
      @fixture fixture
      @want want

      test "#{fixture} reads identically in both languages" do
        System.put_env("FELT_REMOTES_FILE", Path.join(@fixture_dir, @fixture))

        assert Remotes.launchd_label_prefix() == @want["launchd_label_prefix"]

        proxy =
          case Remotes.https_proxy() do
            {host, port} -> %{"host" => host, "port" => port}
            nil -> %{"host" => "", "port" => 0}
          end

        assert proxy == @want["https_proxy"]

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
              "poll_interval_ms" => r.poll_interval_ms,
              "request_timeout_ms" => r.request_timeout_ms,
              "stale_multiplier" => r.stale_multiplier,
              "label" => Remotes.label_for(r)
            }
          end)

        assert got == @want["remotes"]
      end
    end
  end

  describe "https_proxy" do
    # The mirror of `TestParseProxyEndpoint` in cmd/shuttle_remotes_test.go.
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
        System.put_env("FELT_REMOTES_FILE", path)

        assert Remotes.https_proxy() == want,
               "#{written} should read as #{inspect(want)}"
      end
    end

    test "absent defaults, an absent file, and a malformed one all mean no proxy" do
      path = write_remotes(~s({"remotes": [{"name": "a", "port": 4001}]}))
      System.put_env("FELT_REMOTES_FILE", path)
      assert Remotes.https_proxy() == nil

      System.put_env("FELT_REMOTES_FILE", Path.join(tmp_dir(), "absent.json"))
      assert Remotes.https_proxy() == nil

      System.put_env("FELT_REMOTES_FILE", write_remotes("{\"defaults\": {"))
      assert Remotes.https_proxy() == nil
    end

    test "application config wins, and false means explicitly none" do
      path = write_remotes(~s({"defaults": {"https_proxy": "localhost:1055"}, "remotes": []}))
      System.put_env("FELT_REMOTES_FILE", path)

      Application.put_env(:shuttle, :https_proxy, "proxy.example:8080")
      assert Remotes.https_proxy() == {"proxy.example", 8080}

      Application.put_env(:shuttle, :https_proxy, false)
      assert Remotes.https_proxy() == nil
    end
  end

  describe "file resolution" do
    test "an absent file is a valid local-only host, not an error" do
      System.put_env("FELT_REMOTES_FILE", Path.join(tmp_dir(), "absent.json"))
      assert Remotes.registered() == []
      assert Remotes.configured() == []
    end

    test "malformed JSON degrades to no remotes rather than failing to boot" do
      # `felt shuttle remotes list` is the validator that names the typo; a
      # daemon that refuses to serve its OWN board over a bad operator file is
      # worse than one that serves it without the fleet.
      path = write_remotes("{\"remotes\": [")
      System.put_env("FELT_REMOTES_FILE", path)
      assert Remotes.registered() == []
    end

    test "an unreadable file degrades the same way" do
      path = write_remotes(~s({"remotes": [{"name": "a", "port": 4001}]}))
      File.chmod!(path, 0o000)
      on_exit(fn -> File.chmod(path, 0o644) end)
      System.put_env("FELT_REMOTES_FILE", path)
      assert Remotes.registered() == []
    end

    test "a disabled entry stays on file without being polled" do
      path =
        write_remotes(~s({"remotes": [
          {"name": "on", "port": 4001},
          {"name": "off", "port": 4002, "enabled": false}
        ]}))

      System.put_env("FELT_REMOTES_FILE", path)
      assert [%Remote{name: "on"}] = Remotes.registered()
    end
  end

  describe "precedence" do
    test "application config wins over the file — including an explicit []" do
      path = write_remotes(~s({"remotes": [{"name": "from-file", "port": 4001}]}))
      System.put_env("FELT_REMOTES_FILE", path)

      Application.put_env(:shuttle, :remotes, [])
      assert Remotes.configured() == []

      Application.put_env(:shuttle, :remotes, [%{name: "from-config", url: "http://x"}])
      assert [%Remote{name: "from-config"}] = Remotes.configured()
    end

    test "unset application config falls through to the file" do
      path = write_remotes(~s({"remotes": [{"name": "from-file", "port": 4001}]}))
      System.put_env("FELT_REMOTES_FILE", path)
      Application.delete_env(:shuttle, :remotes)

      assert [%Remote{name: "from-file", url: "http://127.0.0.1:4001"}] = Remotes.configured()
    end
  end

  describe "label_for/1" do
    test "application config beats the file's prefix" do
      path =
        write_remotes(
          ~s({"launchd_label_prefix": "com.file", "remotes": [{"name": "a", "port": 4001}]})
        )

      System.put_env("FELT_REMOTES_FILE", path)
      Application.put_env(:shuttle, :launchd_label_prefix, "com.override")

      assert Remotes.label_for("a") == "com.override.shuttle-tunnel-a"
    end

    test "a per-entry tunnel.label is a full override" do
      path =
        write_remotes(
          ~s({"remotes": [{"name": "a", "port": 4001, "tunnel": {"label": "legacy.job"}}]})
        )

      System.put_env("FELT_REMOTES_FILE", path)
      assert [remote] = Remotes.registered()
      assert Remotes.label_for(remote) == "legacy.job"
    end
  end

  describe "config_token/0" do
    test "nil when absent, and changes when the file changes" do
      path = Path.join(tmp_dir(), "token.json")
      System.put_env("FELT_REMOTES_FILE", path)
      assert Remotes.config_token() == nil

      File.write!(path, ~s({"remotes": [{"name": "a", "port": 4001}]}))
      first = Remotes.config_token()
      assert first != nil

      File.write!(
        path,
        ~s({"remotes": [{"name": "a", "port": 4001}, {"name": "b", "port": 4002}]})
      )

      assert Remotes.config_token() != first
    end
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
