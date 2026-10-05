defmodule ShuttleTest do
  use ExUnit.Case, async: true

  # The version has ONE source, mix.exs's `version:` (which CI stamps with the
  # release tag). This asserts the agreement that makes that true: what the
  # daemon reports at runtime, read out of the app spec, is what the Mix
  # project declared at build time.
  test "version is the mix project version, read from the app spec" do
    assert Shuttle.version() == Mix.Project.config()[:version]
    assert Shuttle.version() =~ ~r/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
  end

  # `configure_endpoint/0` is the daemon's RUNTIME config layer. It matters
  # because a release bakes evaluated compile-time config into the artifact —
  # so the port, the server flag, and the signing key must be decidable on the
  # machine that runs the daemon, not the one that built it.
  describe "Shuttle.Application.configure_endpoint/0" do
    # The inputs are scoped; `endpoint_settings/0` is what
    # `configure_endpoint/0` writes, resolved without writing it.
    defp configured(config, env \\ %{}) do
      Shuttle.Test.Env.put_app_env(ShuttleWeb.Endpoint, config)
      Enum.each(env, fn {k, v} -> Shuttle.Test.Env.put_env(k, v) end)

      {ShuttleWeb.Endpoint, endpoint} =
        List.keyfind(Shuttle.Application.endpoint_settings(), ShuttleWeb.Endpoint, 0)

      endpoint
    end

    test "an explicit server: false survives — the test config must stay authoritative" do
      config = configured(http: [ip: {127, 0, 0, 1}, port: 4002], server: false)
      assert config[:server] == false
      assert config[:http][:port] == 4002
    end

    test "server defaults to true when nothing sets it" do
      assert configured(http: [])[:server] == true
    end

    test "SHUTTLE_PORT outranks the configured port" do
      config = configured([http: [port: 4000], server: true], %{"SHUTTLE_PORT" => "4321"})
      assert config[:http][:port] == 4321
      assert config[:http][:ip] == {127, 0, 0, 1}
    end

    test "an invalid SHUTTLE_PORT fails before the endpoint binds" do
      assert_raise ArgumentError, ~r/SHUTTLE_PORT: port "not-a-port" must be an integer/, fn ->
        configured([http: [port: 4000], server: true], %{"SHUTTLE_PORT" => "not-a-port"})
      end
    end

    test "port falls back to the configured value, then to 4000" do
      assert configured(http: [port: 4002])[:http][:port] == 4002
      assert configured([])[:http][:port] == 4000
    end

    test "a configured secret_key_base wins over the generated one" do
      assert configured(secret_key_base: "pinned")[:secret_key_base] == "pinned"
    end

    test "SHUTTLE_SECRET_KEY_BASE is honored when nothing is configured" do
      config = configured([], %{"SHUTTLE_SECRET_KEY_BASE" => "from-env"})
      assert config[:secret_key_base] == "from-env"
    end

    test "otherwise a fresh key per boot — no literal ships in the source" do
      first = configured([])[:secret_key_base]
      second = configured([])[:secret_key_base]

      assert is_binary(first) and byte_size(first) >= 64
      refute first == second
    end
  end
end
