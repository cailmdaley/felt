defmodule ShuttleWeb.ClaimController do
  @moduledoc """
  Agent-API endpoint: POST /api/v1/claim

  First-class worker self-claim: registers an already-live tmux session as
  the running worker for a fiber, exactly as if the daemon had dispatched it
  (watcher, exit handling, kanban liveness). The write-and-claim leg of the
  chat-to-card capture flow — the spawned capture session authors its fiber,
  then claims itself here.

  Owner-routed like the other write verbs: a claim carrying an `origin` for a
  remote-owned fiber forwards to the owning daemon's identical `/claim`
  (origin stripped), since only the owner can see the tmux session and run
  the watcher.

  Body: `fiber_id` (required), `tmux_session` (required), `agent` (optional
  registry name; defaults to the fiber's shuttle.agent), `session_uuid`
  (optional harness transcript UUID — written into the dispatch-shaped felt
  history event so Resume previous works on claimed sessions too).
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [relay_json: 3, present?: 1]

  alias Shuttle.OriginRouter

  def create(conn, params) do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_json(conn, OriginRouter.forward(remote, "/api/v1/claim", conn.body_params), &claim_failed/2)

      :local ->
        create_local(conn, params)
    end
  end

  defp create_local(conn, params) do
    fiber_id = Map.get(params, "fiber_id")
    tmux_session = Map.get(params, "tmux_session")

    cond do
      not present?(fiber_id) ->
        conn |> put_status(400) |> json(%{error: "fiber_id is required"})

      not present?(tmux_session) ->
        conn |> put_status(400) |> json(%{error: "tmux_session is required"})

      true ->
        case Shuttle.Poller.claim_session(fiber_id, tmux_session,
               agent: Map.get(params, "agent"),
               session_uuid: Map.get(params, "session_uuid")
             ) do
          {:ok, %{session: session, agent_id: agent_id}} ->
            json(conn, %{
              claimed: true,
              fiber_id: fiber_id,
              tmux_session: session,
              agent: agent_id
            })

          {:error, reason} ->
            {status, code} = error_status(reason)

            conn
            |> put_status(status)
            |> json(%{claimed: false, reason: code, fiber_id: fiber_id})
        end
    end
  end

  defp error_status(:not_found), do: {404, "not_found"}
  defp error_status(:closed), do: {422, "closed"}
  defp error_status(:already_running), do: {409, "already_running"}
  defp error_status(:session_not_found), do: {422, "session_not_found"}
  defp error_status(:rename_failed), do: {500, "rename_failed"}
  defp error_status(other), do: {500, inspect(other)}

  defp claim_failed(name, reason),
    do: %{claimed: false, reason: "forward_failed", origin: name, error: inspect(reason)}
end
