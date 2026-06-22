defmodule ShuttleWeb.KillController do
  @moduledoc """
  Hard-kill a fiber's live worker: `POST /api/v1/kill`.

  The kanban fires this when a running card is dragged off the in-flight
  column — "off in-flight means stopped." `tmux kill-session` SIGKILLs the
  worker and the daemon tears down its runtime state immediately, so the card
  reads as not-running on the next composite feed. The kill writes NO lifecycle
  verdict; the drag's column write (transition / lifecycle / felt-edit, fired
  right after) is the sole status authority.

  Owner-routed via `Shuttle.OriginRouter`, exactly like `/felt-edit`: the body
  carries the `origin` the composite board stamped. A local-owned card is killed
  here; a remote-owned card forwards to the owning daemon's identical `/kill`
  over the tunnel (origin stripped), and its response is relayed verbatim. Only
  the owning daemon can `tmux kill-session` its own worker, so the routing is
  load-bearing, not an optimization.

  Body: `{ "fiber_id": "...", "origin": "..." }`. Idempotent — killing a fiber
  with no live worker is a 200 `{ "killed": false }`.
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.{OriginRouter, Poller}

  def create(conn, %{"fiber_id" => fiber_id} = params) when is_binary(fiber_id) do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay(conn, OriginRouter.forward(remote, "/api/v1/kill", conn.body_params))

      :local ->
        case Poller.kill_session(fiber_id) do
          {:ok, :no_session} -> json(conn, %{fiber_id: fiber_id, killed: false})
          {:ok, session} -> json(conn, %{fiber_id: fiber_id, killed: true, session: session})
        end
    end
  end

  def create(conn, _params) do
    conn |> put_status(400) |> json(%{error: "fiber_id is required"})
  end

  # Relay a forwarded remote response verbatim (JSON), or surface a tunnel failure.
  defp relay(conn, {:forwarded, status, body}) do
    conn
    |> put_status(status)
    |> put_resp_content_type("application/json")
    |> send_resp(status, body)
  end

  defp relay(conn, {:error, {:forward_failed, name, reason}}) do
    conn
    |> put_status(502)
    |> json(%{error: "forward to #{name} failed: #{inspect(reason)}"})
  end
end
