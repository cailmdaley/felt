defmodule ShuttleWeb.TransitionController do
  @moduledoc """
  The unified kanban write-plane: `POST /api/v1/transition`.

  One call per kanban drag. The body is `{fiber_id, target, origin?}` — move the
  fiber to that column; `origin` is the host that owns it (the composite board
  stamps every fiber with its owner). The local daemon resolves the target to a
  lifecycle action and invokes it on the owning daemon, forwarding over the
  tunnel when the owner is a remote. The kanban never has to resolve, route, or
  pick a daemon URL itself — `Shuttle.Transition` hides all of it.

  Replaces the kanban's prior two-leg dance (resolve on the local daemon, then
  invoke on the owning daemon). This is the sole write-plane; the resolve +
  invoke pipeline and its HTTP-status mapping live in `Shuttle.Transition`.
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.Transition

  def create(conn, %{"fiber_id" => fiber_id, "target" => target} = params) do
    origin = Map.get(params, "origin")

    case Transition.transition(fiber_id, target, origin) do
      {:ok, action} ->
        json(conn, %{
          fiber_id: fiber_id,
          target: target,
          origin: origin,
          action: action,
          invoked: true
        })

      # A remote owner handled it; relay its verbatim response (origin already
      # re-stamped to what the caller routed to).
      {:forwarded, status, body} ->
        conn |> put_status(status) |> json(body)

      {:error, reason} ->
        {http_status, error} = Transition.http_error(reason)

        conn
        |> put_status(http_status)
        |> json(%{
          fiber_id: fiber_id,
          target: target,
          origin: origin,
          invoked: false,
          error: error
        })
    end
  end

  def create(conn, _params) do
    conn |> put_status(400) |> json(%{error: "fiber_id and target are required"})
  end
end
