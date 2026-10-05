defmodule ShuttleWeb.VersionController do
  @moduledoc """
  Agent-API endpoint: GET /api/v1/version

  Returns the daemon's compile-time build stamp, listener and host identity,
  plus the independent application-readiness bit. `host` is the frozen host id
  this daemon dispatches under; other daemons' tailnet discovery
  (`Shuttle.TailnetPeers`) names this daemon by it. `discovery` is this
  daemon's own discovery report. It never calls into the
  Poller: this probe must stay prompt while Poller boot work is still running.
  """

  use Phoenix.Controller, formats: [:json]

  def show(conn, _params) do
    readiness = Shuttle.Readiness.status()

    json(
      conn,
      Shuttle.BuildStamp.stamp()
      |> Map.put(:ready, readiness.ready)
      |> Map.put(:boot_duration_ms, readiness.duration_ms)
      |> Map.put(:contract, contract_check(readiness.ready))
      |> Map.put(:host, Shuttle.Poller.daemon_host_id())
      |> Map.put(:listen, Shuttle.listen())
      |> Map.put(:host_class, Shuttle.Host.class_name(Shuttle.host_class()))
      |> Map.put(:peer_gate, Shuttle.Env.app(:peer_gate, "none"))
      |> Map.put(:peer_gate_uid, Shuttle.Env.app(:peer_gate_expected_uid))
      |> Map.put(:peer_gate_uid_source, Shuttle.Env.app(:peer_gate_uid_source))
      |> Map.put(:tailnet_dial, tailnet_dial_status(readiness.ready))
      |> Map.put(:discovery, Shuttle.TailnetPeers.status())
    )
  end

  defp contract_check(false) do
    %{
      expected: Shuttle.Contract.expected_level(),
      observed: nil,
      ok: nil,
      reason: "booting"
    }
  end

  defp contract_check(true) do
    Shuttle.Poller.snapshot(Shuttle.Poller, 1_500)
    |> Map.get(:contract, %{})
    |> Map.put(:expected, Shuttle.Contract.expected_level())
  catch
    :exit, _ ->
      %{
        expected: Shuttle.Contract.expected_level(),
        observed: nil,
        ok: nil,
        reason: "poller_unavailable"
      }
  end

  defp tailnet_dial_status(false),
    do: %{configured: nil, socket: nil, bridges: [], status: "booting"}

  defp tailnet_dial_status(true) do
    if Process.whereis(Shuttle.TailnetDial.Reconciler) do
      Shuttle.TailnetDial.status()
    else
      %{configured: false, socket: nil, bridges: []}
    end
  end
end
