defmodule ShuttleWeb.DispatchController do
  @moduledoc """
  Agent-API endpoint: POST /api/v1/dispatch

  The single force/ad-hoc dispatch surface: the kanban's drag-to-inFlight
  launch, the detail modal's requeue / "New session", and `shuttle
  dispatch` (internal/shuttlecli/daemon_verbs.go) all land here.

    * a request carrying `origin` — a remote-owned card — is forwarded by
      `Shuttle.OriginRouter` to the owning daemon's identical `/dispatch`
      (origin stripped), where the worker must run, and the response is relayed
      verbatim.

  The kanban requeue carries the user's directive (`user_message`) and
  continuation mode (`resume_mode ∈ {"previous", "fresh"}` or absent) inline in
  the body. Both ride the dispatch call into the prompt at launch; the remote
  forward passes `conn.body_params` verbatim, so they survive owner-routing
  intact.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [relay_json: 3]

  alias Shuttle.OriginRouter

  def create(conn, params) do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_json(
          conn,
          OriginRouter.forward(remote, "/api/v1/dispatch", conn.body_params),
          &dispatch_failed/2
        )

      :local ->
        create_local(conn, params)
    end
  end

  defp create_local(conn, params) do
    fiber_id = Map.get(params, "fiber_id")
    force = truthy?(Map.get(params, "force", false))
    ad_hoc = truthy?(Map.get(params, "ad_hoc", false))

    if is_nil(fiber_id) do
      conn
      |> put_status(400)
      |> json(%{error: "fiber_id is required"})
    else
      result =
        Shuttle.Poller.dispatch_fiber(fiber_id,
          force: force or ad_hoc,
          ad_hoc: ad_hoc,
          user_message: normalize_message(Map.get(params, "user_message")),
          resume_mode: normalize_resume_mode(Map.get(params, "resume_mode"))
        )

      {status, body} = ShuttleWeb.DispatchReply.render(fiber_id, result)
      conn |> put_status(status) |> json(body)
    end
  end

  defp dispatch_failed(name, reason),
    do: %{dispatched: false, reason: "forward_failed", origin: name, error: inspect(reason)}

  defp truthy?(value) when value in [true, "true", "1", 1], do: true
  defp truthy?(_), do: false

  # A blank message is no message — the From User block renders only for real
  # content. Non-strings collapse to nil.
  defp normalize_message(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      _ -> value
    end
  end

  defp normalize_message(_), do: nil

  # resume_mode ∈ {"previous", "fresh"} or absent (→ marker-decided). Anything
  # else is ignored (treated as absent) so a malformed param degrades to the
  # autonomous heuristic rather than a hard error.
  defp normalize_resume_mode(mode) when mode in ["previous", "fresh"], do: mode
  defp normalize_resume_mode(_), do: nil
end
