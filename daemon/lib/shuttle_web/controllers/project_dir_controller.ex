defmodule ShuttleWeb.ProjectDirController do
  @moduledoc "Owner-routed worker directory validation without creating or arming a fiber."
  use Phoenix.Controller, formats: [:json]
  alias Shuttle.{CLI, OriginRouter}
  import ShuttleWeb.RelayHelpers, only: [relay_json: 2, send_cli_result: 3]

  def resolve(conn, params) do
    case OriginRouter.route_host(params["origin"]) do
      {:error, {:unknown_origin, origin}} ->
        conn |> put_status(400) |> json(%{error: OriginRouter.unknown_origin_message(origin)})

      {:remote, remote} ->
        relay_json(
          conn,
          OriginRouter.forward(remote, "/api/v1/project-dir/resolve", conn.body_params)
        )

      :local ->
        case params do
          %{"path" => path} when is_binary(path) and path != "" ->
            case CLI.run(["resolve-dir", path]) do
              {:ok, output} -> json(conn, %{path: String.trim(output)})
              error -> send_cli_result(conn, "shuttle", error)
            end

          _ ->
            send_cli_result(conn, "shuttle", {:error, "path is required"})
        end
    end
  end
end
