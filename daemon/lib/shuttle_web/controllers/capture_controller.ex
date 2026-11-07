defmodule ShuttleWeb.CaptureController do
  @moduledoc "Spawn an agent from a free-text prompt; the agent files and claims its constitution."
  use Phoenix.Controller, formats: [:json]
  import ShuttleWeb.RelayHelpers, only: [relay_json: 3, present?: 1]
  alias Shuttle.OriginRouter
  require Shuttle.Dispatcher

  def create(conn, params) do
    params = Map.delete(params, "surface")

    case OriginRouter.route_host(params["origin"]) do
      {:remote, remote} ->
        relay_json(
          conn,
          OriginRouter.forward(remote, "/api/v1/capture", params),
          &capture_failed/2
        )

      :local ->
        create_local(conn, params)

      {:error, {:unknown_origin, origin}} ->
        conn |> put_status(400) |> json(%{error: OriginRouter.unknown_origin_message(origin)})
    end
  end

  defp create_local(conn, params) do
    prompt = params["prompt"]
    project_dir = params["project_dir"]

    cond do
      not present?(prompt) or String.trim(prompt) == "" ->
        conn |> put_status(400) |> json(%{error: "prompt is required"})

      not present?(project_dir) ->
        conn |> put_status(400) |> json(%{error: "project_dir is required"})

      not Shuttle.FS.dir?(project_dir) ->
        conn
        |> put_status(422)
        |> json(%{spawned: false, reason: "project_dir_missing", project_dir: project_dir})

      true ->
        case Shuttle.Poller.capture(prompt,
               work_dir: project_dir,
               agent: params["agent"],
               effort: params["effort"],
               chrome: params["chrome"] == true
             ) do
          {:ok, %{session: session, agent_id: agent_id} = launched} ->
            json(
              conn,
              %{spawned: true, agent: agent_id}
              |> Map.merge(Shuttle.WorkerBackend.wire(session))
              |> put_session_uuid(launched[:session_uuid])
            )

          {:error, {:backend_not_ready, message}} ->
            conn
            |> put_status(503)
            |> json(%{
              spawned: false,
              waiting: true,
              retryable: true,
              reason: "backend_not_ready",
              message: message
            })

          {:error, {:invalid_axes, message}} ->
            conn |> put_status(422) |> json(%{spawned: false, reason: message})

          {:error, {tag, message}} when Shuttle.Dispatcher.refusal?(tag, message) ->
            conn
            |> put_status(422)
            |> json(%{spawned: false, reason: to_string(tag), message: message})

          {:error, reason} ->
            conn |> put_status(500) |> json(%{spawned: false, reason: error_code(reason)})
        end
    end
  end

  defp put_session_uuid(payload, uuid) when is_binary(uuid),
    do: Map.put_new(payload, :session_uuid, uuid)

  defp put_session_uuid(payload, _), do: payload
  defp error_code(reason) when is_binary(reason), do: reason
  defp error_code(reason), do: inspect(reason)

  defp capture_failed(name, reason),
    do: %{spawned: false, reason: "forward_failed", origin: name, error: inspect(reason)}
end
