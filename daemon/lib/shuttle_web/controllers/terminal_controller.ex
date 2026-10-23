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
               Map.drop(params, ["origin", "shuttle_host"])
             ) do
          {:forwarded, status, body} ->
            conn |> put_resp_content_type("application/json") |> send_resp(status, body)

          {:error, reason} ->
            conn |> put_status(502) |> json(%{error: inspect(reason)})
        end

      {:error, reason} ->
        conn |> put_status(422) |> json(%{error: inspect(reason)})
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
               runner: Shuttle.Env.app(:terminal_runner, Shuttle.Runner.Default)
             ) do
          {:ok, result} ->
            json(conn, result)

          {:error, reason} ->
            conn |> put_status(422) |> json(%{error: inspect(reason), session_uuid: id})
        end

      _ ->
        conn |> put_status(404) |> json(%{error: "no owned terminal Codex conversation"})
    end
  end
end
