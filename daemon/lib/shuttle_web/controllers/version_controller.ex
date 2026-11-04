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

  def show(conn, params) do
    case Shuttle.OriginRouter.route(Map.get(params, "origin")) do
      :local ->
        show_local(conn)

      {:remote, remote} ->
        case Shuttle.OriginRouter.forward_get(remote, "/api/v1/version", params) do
          {:forwarded, status, content_type, body} ->
            conn |> put_resp_content_type(content_type) |> send_resp(status, body)

          {:error, reason} ->
            conn
            |> put_status(502)
            |> json(%{error: "owner version unavailable", detail: inspect(reason)})
        end

      {:error, {:unknown_origin, origin}} ->
        ShuttleWeb.RelayHelpers.unknown_origin(conn, origin)
    end
  end

  defp show_local(conn) do
    readiness = Shuttle.Readiness.status()
    health = poller_health(readiness.ready)

    json(
      conn,
      Shuttle.BuildStamp.stamp()
      |> Map.put(:contract_level, Shuttle.Contract.expected_level())
      |> Map.put(:ready, readiness.ready)
      |> Map.put(:boot_hold, readiness.boot_hold)
      |> Map.put(:boot, readiness.boot)
      |> Map.put(:excluded_stores, Shuttle.FeltStores.excluded_stores())
      |> Map.put(:boot_duration_ms, readiness.duration_ms)
      |> Map.put(:poller_publication, Shuttle.Poller.published_state_metrics())
      |> Map.merge(health)
      |> Map.put(:host, Shuttle.Poller.daemon_host_id())
      |> Map.put(:terminal, Shuttle.Terminal.primary().id())
      |> Map.put(:listen, Shuttle.listen())
      |> Map.put(:host_class, Shuttle.Host.class_name(Shuttle.host_class()))
      |> Map.put(:peer_gate, Shuttle.Env.app(:peer_gate, "none"))
      |> Map.put(:peer_gate_uid, Shuttle.Env.app(:peer_gate_expected_uid))
      |> Map.put(:peer_gate_uid_source, Shuttle.Env.app(:peer_gate_uid_source))
      |> Map.put(:tailnet_dial, tailnet_dial_status(readiness.ready))
      |> Map.put(:discovery, Shuttle.TailnetPeers.status())
      |> Map.put(:rex_backend, Shuttle.Terminal.backend_health())
      |> Map.put(:transcript_indexer, Shuttle.TranscriptIndexer.status())
    )
  end

  defp poller_health(false), do: unavailable_health("booting")

  defp poller_health(true) do
    snapshot = Shuttle.Poller.snapshot(Shuttle.Env.server(Shuttle.Poller), 1_500)

    %{
      contract: Map.put(snapshot[:contract] || %{}, :expected, Shuttle.Contract.expected_level()),
      reconciliation_hold: get_in(snapshot, [:poll_health, :reconciliation_hold])
    }
  catch
    :exit, _ -> unavailable_health("poller_unavailable")
  end

  defp unavailable_health(reason) do
    %{
      contract: %{
        expected: Shuttle.Contract.expected_level(),
        observed: nil,
        ok: nil,
        reason: reason
      },
      reconciliation_hold: nil
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
