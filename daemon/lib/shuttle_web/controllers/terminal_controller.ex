defmodule ShuttleWeb.TerminalController do
  use Phoenix.Controller, formats: [:json]
  import Plug.Conn
  alias Shuttle.{AppWorkers, CodexTerminal, OriginRouter}

  def create(conn, params) do
    case OriginRouter.route_host(params["origin"] || params["shuttle_host"]) do
      :local ->
        create_local(conn, params)

      {:remote, remote} ->
        case OriginRouter.forward(
               remote,
               "/api/v1/sessions/prepare-terminal",
               Map.drop(params, ["origin", "shuttle_host"]),
               forward_timeout_ms: CodexTerminal.forward_timeout_ms()
             ) do
          {:forwarded, status, body} ->
            conn |> put_resp_content_type("application/json") |> send_resp(status, body)

          {:error, _reason} ->
            conn
            |> put_status(502)
            |> json(%{
              error: "#{remote.name} did not answer while preparing this conversation's terminal."
            })
        end

      {:error, {:unknown_origin, origin}} ->
        conn |> put_status(422) |> json(%{error: OriginRouter.unknown_origin_message(origin)})
    end
  end

  defp create_local(conn, params) do
    record =
      Enum.find(AppWorkers.active(), fn record ->
        (is_binary(params["fiber"]) and params["fiber"] == record["uid"]) or
          (is_binary(params["tmux_session"]) and params["tmux_session"] == record["terminal_tmux"])
      end)

    case record do
      %{"surface" => "cli", "session_uuid" => id} ->
        case CodexTerminal.prepare(id,
               runner: Shuttle.Env.app(:terminal_runner, Shuttle.Runner.Default),
               wait_timeout_ms: CodexTerminal.prepare_timeout_ms()
             ) do
          {:ok, result} ->
            json(conn, result)

          {:error, reason} ->
            conn
            |> put_status(422)
            |> json(%{error: CodexTerminal.error_message(reason), session_uuid: id})
        end

      _ ->
        conn |> put_status(404) |> json(%{error: "no owned terminal Codex conversation"})
    end
  end
end
