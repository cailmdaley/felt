defmodule ShuttleWeb.VersionController do
  @moduledoc """
  Agent-API endpoint: GET /api/v1/version

  Returns the daemon's compile-time build stamp so consumers can detect a
  stale daemon release after a schema-touching source update, plus (S2) the
  daemon-shelled CLI contract level: what this daemon EXPECTS
  (`Shuttle.Contract.expected_level/0`) versus what it PROBED at boot from the
  CLI (`felt shuttle contract`, cached in the Poller's `contract_check`
  state). Makes a skew human-visible remotely, not just in the boot log/board.
  """

  use Phoenix.Controller, formats: [:json]

  @state_timeout_ms 1_500

  def show(conn, _params) do
    json(conn, Map.put(Shuttle.BuildStamp.stamp(), :contract, contract_check()))
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
      %{expected: Shuttle.Contract.expected_level(), observed: nil, ok: nil, reason: "poller_unavailable"}
  end
end
