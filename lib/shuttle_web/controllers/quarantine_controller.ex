defmodule ShuttleWeb.QuarantineController do
  @moduledoc """
  Agent-API endpoint: POST /api/v1/quarantine/release

  Releases the Poller's boot quarantine — the human "go" that restores fresh
  launch authority to a restarted daemon. A restart parks fresh autonomous
  launches (`pending_launch` in the state snapshot) while dirty-death resumes
  stay automatic; release is pure manual, and this is the release. Idempotent.

  **Owner-routed.** A held card is served by the daemon that OWNS it, and the
  quarantine lives in that daemon's Poller — so the release must land there.
  The body may carry `origin` (the owning host the composite board stamped on
  the card); it routes through `Shuttle.OriginRouter` exactly like the other
  write endpoints. `nil` / `"local"` / this daemon's own id releases the local
  quarantine; a configured remote forwards over the tunnel. This lets the
  kanban's `⏹︎ held` → `▶ release` click free a remote-owned host's parked
  launches, not just the local board's.

  Returns: 200  %{ok: true, boot_quarantine: false}
           502  %{ok: false, error: "forward_failed"} on a tunnel failure
           503  %{ok: false, error: "poller_unavailable"} when no Poller runs
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [relay_json: 3]

  alias Shuttle.{OriginRouter, Remote}

  def create(conn, params) do
    origin = Map.get(params, "origin")

    case OriginRouter.route(origin) do
      :local -> release_local(conn)
      {:remote, %Remote{} = remote} -> forward(conn, remote, origin)
    end
  end

  defp release_local(conn) do
    case release() do
      :ok ->
        json(conn, %{ok: true, boot_quarantine: false})

      {:error, reason} ->
        conn
        |> put_status(:service_unavailable)
        |> json(%{ok: false, error: "poller_unavailable", reason: inspect(reason)})
    end
  end

  defp forward(conn, remote, origin) do
    relay_json(
      conn,
      OriginRouter.forward(remote, "/api/v1/quarantine/release", %{"origin" => origin}),
      fn name, reason ->
        %{
          ok: false,
          error: "forward_failed",
          origin: origin,
          reason: "forward to #{name} failed: #{inspect(reason)}"
        }
      end
    )
  end

  defp release do
    Shuttle.Poller.release_boot_quarantine()
  catch
    :exit, reason -> {:error, reason}
  end
end
