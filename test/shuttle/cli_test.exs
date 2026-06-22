defmodule Shuttle.CLITest do
  @moduledoc """
  Tests for the CLI IPC layer: daemon query, fallback, duplicate-start detection.

  The `query_daemon/1` function is tested against:
    - An unreachable port (verifies {:error, _} returned — fallback path)
    - The actual Phoenix endpoint in server mode (verifies {:ok, state} returned)

  The full integration evidence (N successive status calls leave exactly 1
  beam.smp; launchd-orphan detection; daemon view differs from cold-start view)
  requires running `bin/shuttle` against a live daemon — see the constitution
  Evidence section.
  """

  use ExUnit.Case

  alias Shuttle.CLI

  # ── daemon_port/0 ──

  test "daemon_port returns a valid port integer" do
    port = CLI.daemon_port()
    assert is_integer(port)
    assert port > 0 and port < 65536
  end

  # ── query_daemon/1 — daemon down path ──

  test "query_daemon returns error when nothing is listening" do
    # Port 19999 should have nothing bound in test.
    # This exercises the fallback path: status/snapshot print filesystem view + exit 2.
    result = CLI.query_daemon(19999)
    assert {:error, _reason} = result
  end

  test "query_daemon returns error on another unused port" do
    result = CLI.query_daemon(19998)
    assert {:error, _} = result
  end

  # ── query_daemon/1 — daemon up integration test ──
  #
  # This test verifies the IPC path against a real HTTP server.
  # Run with: mix test --include integration
  #
  # It starts the Phoenix endpoint in server mode on a dedicated port so
  # :httpc can make a real TCP connection. The test env runs the endpoint
  # with server: false by default to avoid port conflicts with ConnTest;
  # we override that here for this specific test.

  @tag :integration
  test "query_daemon returns daemon state when server is live" do
    test_port = 4099

    # Start a Poller. StateController calls Shuttle.Poller by registered name,
    # which is registered globally. We use Shuttle.Poller as the name to
    # match what StateController expects. This is safe because integration tests
    # run in isolation (excluded from the default suite by test_helper.exs).
    {:ok, poller_pid} =
      Shuttle.Poller.start_link(
        runner: Shuttle.Runner.Default,
        poll_interval_ms: 600_000,
        felt_store: "/tmp",
        name: Shuttle.Poller
      )

    # Start Bandit directly so the Plug pipeline (ShuttleWeb.Endpoint) is
    # reachable over TCP — ShuttleWeb.Endpoint is globally started with
    # server: false; we can't restart it, but we CAN serve its Plug pipeline.
    {:ok, bandit_pid} =
      Bandit.start_link(
        plug: ShuttleWeb.Endpoint,
        port: test_port,
        ip: {127, 0, 0, 1}
      )

    Process.sleep(100)

    result = CLI.query_daemon(test_port)

    # Cleanup
    Process.exit(poller_pid, :normal)
    Process.exit(bandit_pid, :normal)

    assert {:ok, state} = result
    assert is_binary(state.host)
    assert is_integer(state.poll_at)
    assert is_list(state.eligible)
    assert is_list(state.retrying)
  end
end
