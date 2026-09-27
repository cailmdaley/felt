defmodule ShuttleWeb.VersionController do
  @moduledoc """
  Agent-API endpoint: GET /api/v1/version

  Returns the daemon's compile-time build stamp so consumers can detect a
  stale daemon release after a schema-touching source update, plus (S2) the
  daemon-shelled CLI contract level: what this daemon EXPECTS
  (`Shuttle.Contract.expected_level/0`) versus what it PROBED at boot from the
  CLI (`felt shuttle contract`, cached in the Poller's `contract_check`
  state). Makes a skew human-visible remotely, not just in the boot log/board.

  Also where this daemon listens (`listen`, e.g. `"unix:///…/daemon.sock"`),
  the host class that chose it (`host_class`, e.g. `"single-user"`), and the
  TCP peer gate mode, admitted uid, and uid source as bound at boot.
  """

  use Phoenix.Controller, formats: [:json]

  @state_timeout_ms 1_500

  def show(conn, _params) do
    json(
      conn,
      Shuttle.BuildStamp.stamp()
      |> Map.put(:contract, contract_check())
      |> Map.put(:listen, Shuttle.listen())
      |> Map.put(:host_class, Shuttle.Host.class_name(Shuttle.host_class()))
      |> Map.put(:peer_gate, Application.get_env(:shuttle, :peer_gate, "none"))
      |> Map.put(:peer_gate_uid, Application.get_env(:shuttle, :peer_gate_expected_uid))
      |> Map.put(:peer_gate_uid_source, Application.get_env(:shuttle, :peer_gate_uid_source))
    )
  end

  # The Poller probes once at boot and caches the result (`contract_check`
  # state) — reading it here is a cheap GenServer call, not a fresh shell-out.
  # Degrades to "we don't know, ask again" rather than crashing this endpoint
  # if the Poller is unreachable (mirrors `StateController`'s poller-call
  # seam).
  defp contract_check do
    Shuttle.Poller.snapshot(Shuttle.Poller, @state_timeout_ms)
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
end
