defmodule Shuttle.RemoteRegistry.ClientTest do
  @moduledoc """
  Regression coverage for the real `:httpc`-backed client. The bug: `get/2`
  fetched without `body_format: :binary`, so httpc returned the body as a
  charlist of *bytes* and `List.to_string/1` re-UTF-8-encoded each byte —
  double-encoding every multibyte char (the cmbx "— analysis hub" mojibake on
  the composite board). ASCII (< 128) survived, so the corruption hid until a
  special character appeared. These tests round-trip a real multibyte body
  through a live Bandit server and assert byte-faithfulness.
  """
  use ExUnit.Case, async: false

  alias Shuttle.RemoteRegistry.Client.Default

  defp applied_https_proxy(profile) do
    case :httpc.get_options([:https_proxy], profile) do
      {:ok, [https_proxy: proxy]} -> proxy
      _ -> :no_profile
    end
  end

  # Body with an em-dash (U+2014), multiplication sign (U+00D7), and an accented
  # vowel (U+00E9) — exactly the characters that mojibake'd in the field.
  @utf8_body ~s({"fibers":[{"name":"cmbx — analysis hub","note":"γ×κ Cramér"}]})

  defmodule EchoPlug do
    @moduledoc false
    @behaviour Plug

    @impl true
    def init(opts), do: opts

    @impl true
    def call(conn, body: body) do
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, body)
    end
  end

  setup do
    # Port 0 lets the OS pick: a pinned port makes each test wait for the
    # previous one's listener to be released, and loses the race often enough
    # to fail on :eaddrinuse.
    {:ok, server} =
      Bandit.start_link(
        plug: {EchoPlug, body: @utf8_body},
        port: 0,
        ip: {127, 0, 0, 1}
      )

    {:ok, {_ip, port}} = ThousandIsland.listener_info(server)
    on_exit(fn -> Process.exit(server, :normal) end)
    {:ok, url: "http://127.0.0.1:#{port}/api/v1/fibers"}
  end

  test "get/2 returns the response body byte-for-byte (no double-encoding)", %{url: url} do
    assert {:ok, body} = Default.get(url, 5_000)
    # Byte-identical to what the server sent: the em-dash stays \xe2\x80\x94,
    # not the double-encoded \xc3\xa2\xc2\x80\xc2\x94.
    assert body == @utf8_body
    assert String.contains?(body, "cmbx — analysis hub")
    refute String.contains?(body, "Ã¢")
    assert {:ok, %{"fibers" => [%{"name" => "cmbx — analysis hub"}]}} = Jason.decode(body)
  end

  describe "the fleet proxy" do
    setup do
      prev = Application.get_env(:shuttle, :https_proxy)
      on_exit(fn -> Application.put_env(:shuttle, :https_proxy, prev) end)
      :ok
    end

    test "lands on our proxied profile and nowhere else", %{url: url} do
      # httpc's proxy is per profile, not per request, so the point of owning
      # the profile is that this setting never reaches `:default` and never
      # leaks onto another httpc user in the VM.
      Application.put_env(:shuttle, :https_proxy, "127.0.0.1:1055")
      assert {:ok, _} = Default.get(url, 2_000)

      assert {{~c"127.0.0.1", 1055}, [~c"localhost", ~c"127.0.0.1", ~c"::1"]} =
               applied_https_proxy(:shuttle_fleet)

      assert {:ok, [https_proxy: {:undefined, []}]} = :httpc.get_options([:https_proxy], :default),
             "the default profile must stay untouched"
    end

    test "clearing it switches profiles instead of stopping one", %{url: url} do
      # The direct profile never carries a proxy, so "no proxy" is a profile
      # CHOICE rather than a reconfiguration. That matters because the only way
      # to unset httpc's proxy is to stop the profile, and stopping one kills
      # every request in flight on it with an exit — which would take down the
      # registry that polls inline in its own GenServer.
      Application.put_env(:shuttle, :https_proxy, "127.0.0.1:1055")
      assert {:ok, _} = Default.get(url, 2_000)

      Application.put_env(:shuttle, :https_proxy, false)
      assert {:ok, body} = Default.get(url, 2_000)
      assert body == @utf8_body

      assert {:undefined, []} = applied_https_proxy(:shuttle_fleet_direct)

      # And the proxied profile is still alive, still configured, and still
      # usable the moment the fleet file names a proxy again.
      assert {{~c"127.0.0.1", 1055}, _} = applied_https_proxy(:shuttle_fleet)
    end

    test "an http:// remote is never sent through it", %{url: url} do
      # httpc only consults https_proxy for https URLs, so an ssh-tunnelled
      # remote at http://127.0.0.1:<port> keeps working even when the proxy
      # address points at nothing.
      Application.put_env(:shuttle, :https_proxy, "127.0.0.1:9")
      assert {:ok, body} = Default.get(url, 2_000)
      assert body == @utf8_body
    end
  end

  describe "the fleet proxy on a host that is not single-user" do
    setup do
      prev_proxy = Application.get_env(:shuttle, :https_proxy)
      prev_class = Application.get_env(:shuttle, :host_class)

      on_exit(fn ->
        Application.put_env(:shuttle, :https_proxy, prev_proxy)
        Shuttle.Test.EnvHelpers.restore_app_env(:host_class, prev_class)
      end)

      # Port 9 is discard: if the refusal failed and the request went through
      # the proxy, it would come back as a connect error, not the refusal.
      Application.put_env(:shuttle, :https_proxy, "127.0.0.1:9")
      :ok
    end

    for {class, name} <- [shared_multi_user: "shared-multi-user", exposed: "exposed"] do
      @class class
      @name name

      test "#{name}: an https request fails with the refusal as its reason" do
        Application.put_env(:shuttle, :host_class, @class)
        reason = "https_proxy refused: host class #{@name}"

        assert Default.get("https://hub.example.invalid/api/v1/state", 1_000) == {:error, reason}

        assert Default.get("https://hub.example.invalid/x", [], 1_000) == {:error, reason}

        assert Default.post("https://hub.example.invalid/x", "{}", "application/json", 1_000) ==
                 {:error, reason}

        assert Default.get_file("https://hub.example.invalid/x", 1_000) == {:error, reason}
      end
    end

    test "an http:// remote still goes direct", %{url: url} do
      Application.put_env(:shuttle, :host_class, :shared_multi_user)
      assert {:ok, body} = Default.get(url, 2_000)
      assert body == @utf8_body
    end

    test "a single-user host sends https through the proxy" do
      # A fake proxy: accept one connection and report the first bytes httpc
      # sends it. A CONNECT for the remote's authority is the proxy in use.
      Application.put_env(:shuttle, :host_class, :single_user)
      {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
      {:ok, port} = :inet.port(listener)
      Application.put_env(:shuttle, :https_proxy, "127.0.0.1:#{port}")
      parent = self()

      Task.start(fn ->
        {:ok, conn} = :gen_tcp.accept(listener, 5_000)
        {:ok, data} = :gen_tcp.recv(conn, 0, 5_000)
        send(parent, {:proxy_saw, data})
        :gen_tcp.close(conn)
      end)

      assert {:error, _} = Default.get("https://hub.example.invalid/api/v1/state", 2_000)
      assert_receive {:proxy_saw, data}, 5_000
      assert data =~ ~r/\ACONNECT hub\.example\.invalid:443 HTTP\/1\.1\r\n/
      :gen_tcp.close(listener)
    end

    test "an upper-case HTTPS:// scheme is refused like a lower-case one" do
      Application.put_env(:shuttle, :host_class, :shared_multi_user)

      assert Default.get("HTTPS://hub.example.invalid/api/v1/state", 1_000) ==
               {:error, "https_proxy refused: host class shared-multi-user"}
    end

    test "the refusal surfaces as the remote's last_error in the registry" do
      Application.put_env(:shuttle, :host_class, :shared_multi_user)

      remote = %Shuttle.Remote{
        name: "hub-a",
        url: "https://hub-a.example.invalid",
        poll_interval_ms: 1,
        request_timeout_ms: 1_000,
        stale_multiplier: 2,
        tunnel: %{manager: :none, multiplex: false, label: nil}
      }

      {:ok, _pid} =
        Shuttle.RemoteRegistry.start_link(
          name: :reg_proxy_refused,
          remotes: [remote],
          auto_poll: false,
          tick_interval_ms: 60_000
        )

      :ok = Shuttle.RemoteRegistry.poll_now(:reg_proxy_refused)

      hub = Shuttle.RemoteRegistry.snapshot(:reg_proxy_refused, "hub-a")
      assert hub.stale
      assert hub.last_error == "https_proxy refused: host class shared-multi-user"
    end
  end
end
