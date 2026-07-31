defmodule ShuttleTest do
  use ExUnit.Case

  import ExUnit.CaptureIO

  test "version returns semantic version" do
    assert Shuttle.version() == "0.1.0"
  end

  test "status output includes standing role cycle state" do
    output =
      capture_io(fn ->
        Shuttle.CLI.print_status(%{
          host: "test-host",
          poll_at: 1_777_650_000_000,
          eligible: [],
          retrying: [],
          standing_roles: [
            %{
              fiber_id: "life/email-triage",
              state: "review",
              next_due_at: nil,
              validation_errors: []
            },
            %{
              fiber_id: "life/invalid-role",
              state: "scheduled",
              next_due_at: 1_777_736_400_000,
              validation_errors: ["accepted_run_id must match run_id in accepted review state"]
            }
          ]
        })
      end)

    assert output =~ "Standing roles (2):"
    assert output =~ "life/email-triage — review"
    assert output =~ "life/invalid-role — scheduled"
    assert output =~ "next due: 2026-05-02T15:40:00.000Z"
    assert output =~ "validation: accepted_run_id must match run_id in accepted review state"
  end

  # `configure_endpoint/0` is the daemon's RUNTIME config layer. It matters
  # because `mix escript.build` bakes evaluated compile-time config into the
  # artifact — so the port, the server flag, and the signing key must be
  # decidable on the machine that runs the escript, not the one that built it.
  describe "Shuttle.Application.configure_endpoint/0" do
    setup do
      previous = Application.get_env(:shuttle, ShuttleWeb.Endpoint)
      on_exit(fn -> Application.put_env(:shuttle, ShuttleWeb.Endpoint, previous) end)
      :ok
    end

    defp configured(config, env \\ %{}) do
      Application.put_env(:shuttle, ShuttleWeb.Endpoint, config)
      Enum.each(env, fn {k, v} -> System.put_env(k, v) end)
      on_exit(fn -> Enum.each(env, fn {k, _} -> System.delete_env(k) end) end)
      Shuttle.Application.configure_endpoint()
      Application.get_env(:shuttle, ShuttleWeb.Endpoint)
    end

    test "an explicit server: false survives — the test config must stay authoritative" do
      config = configured(http: [ip: {127, 0, 0, 1}, port: 4002], server: false)
      assert config[:server] == false
      assert config[:http][:port] == 4002
    end

    test "server defaults to true when nothing sets it" do
      assert configured(http: [])[:server] == true
    end

    test "SHUTTLE_PORT is live again — it was dead while dev.exs set server: true" do
      config = configured([http: [port: 4000], server: true], %{"SHUTTLE_PORT" => "4321"})
      assert config[:http][:port] == 4321
      assert config[:http][:ip] == {127, 0, 0, 1}
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
