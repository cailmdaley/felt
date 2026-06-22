defmodule ShuttleWeb.CaptureController do
  @moduledoc """
  Agent-API endpoint: POST /api/v1/capture

  Spawn-without-constitution: launches a tmux agent session from a free-text
  prompt — no pre-existing fiber. The chat-to-card intake: the board's "new
  idea" dialog posts the user's yap here; the spawned session crystallizes it
  into a fiber, installs the shuttle block, claims itself via `/api/v1/claim`,
  and continues as the worker realizing it.

  Owner-routed: a capture carrying an `origin` for a remote host forwards to
  the owning daemon's identical `/capture` (origin stripped) — the session
  must spawn where the project lives.

  Body: `prompt` (required, the yap verbatim), `project_dir` (required,
  absolute path on the owning host), `agent` (optional registry name,
  default claude-sonnet), `effort` (optional reasoning-effort token, validated
  against the agent's `effort_levels`), `chrome` (optional boolean, claude
  harness only), `origin` (optional owner-routing key).
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [relay_json: 3, present?: 1]

  alias Shuttle.OriginRouter

  def create(conn, params) do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_json(conn, OriginRouter.forward(remote, "/api/v1/capture", conn.body_params), &capture_failed/2)

      :local ->
        create_local(conn, params)
    end
  end

  defp create_local(conn, params) do
    prompt = Map.get(params, "prompt")
    project_dir = Map.get(params, "project_dir")

    cond do
      not present?(prompt) ->
        conn |> put_status(400) |> json(%{error: "prompt is required"})

      not present?(project_dir) ->
        conn |> put_status(400) |> json(%{error: "project_dir is required"})

      not File.dir?(project_dir) ->
        conn
        |> put_status(422)
        |> json(%{spawned: false, reason: "project_dir_missing", project_dir: project_dir})

      true ->
        case Shuttle.Poller.capture(prompt,
               work_dir: project_dir,
               agent: Map.get(params, "agent"),
               effort: Map.get(params, "effort"),
               chrome: Map.get(params, "chrome") == true
             ) do
          {:ok, %{session: session, agent_id: agent_id}} ->
            json(conn, %{spawned: true, tmux_session: session, agent: agent_id})

          {:error, {:invalid_axes, msg}} ->
            # Axes-validation failures are client errors (bad effort token,
            # chrome on a non-claude harness) — 422 naming the constraint.
            conn |> put_status(422) |> json(%{spawned: false, reason: msg})

          {:error, reason} ->
            conn
            |> put_status(500)
            |> json(%{spawned: false, reason: error_code(reason)})
        end
    end
  end

  defp error_code(reason) when is_binary(reason), do: reason
  defp error_code(reason), do: inspect(reason)

  defp capture_failed(name, reason),
    do: %{spawned: false, reason: "forward_failed", origin: name, error: inspect(reason)}
end
