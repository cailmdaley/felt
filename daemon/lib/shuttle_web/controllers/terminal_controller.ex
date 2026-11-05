defmodule ShuttleWeb.TerminalController do
  @moduledoc "Resolve the terminal currently bound to a worker fiber."

  use Phoenix.Controller, formats: [:json]
  import Plug.Conn

  alias Shuttle.{OriginRouter, SessionLedger, Terminal}

  def create(conn, params) do
    case OriginRouter.route(params["origin"] || params["shuttle_host"],
           routed: OriginRouter.routed?(conn)
         ) do
      :local ->
        create_local(conn, params)

      {:remote, remote} ->
        case OriginRouter.forward(
               remote,
               "/api/v1/sessions/prepare-terminal",
               Map.delete(params, "shuttle_host")
             ) do
          {:forwarded, status, body} ->
            conn |> put_resp_content_type("application/json") |> send_resp(status, body)

          {:error, reason} ->
            conn |> put_status(502) |> json(%{error: "#{remote.name}: #{inspect(reason)}"})
        end

      {:error, reason} ->
        {status, message} = Shuttle.Transition.http_error(reason)
        conn |> put_status(status) |> json(%{error: message})
    end
  end

  defp create_local(conn, %{"fiber" => uid}) when is_binary(uid) and uid != "" do
    case SessionLedger.latest_for_uid(uid) do
      %{"uid" => ^uid, "session" => session, "tmux" => terminal}
      when is_binary(session) and is_binary(terminal) ->
        latest_terminal = SessionLedger.latest_for_terminal(terminal)

        if is_map(latest_terminal) and latest_terminal["session"] == session and
             latest_terminal["uid"] == uid and Terminal.locate(runner(), terminal) != nil do
          json(conn, %{tmux_session: terminal})
        else
          not_found(conn)
        end

      _ ->
        not_found(conn)
    end
  end

  defp create_local(conn, %{"session_uuid" => session}) when is_binary(session) do
    case SessionLedger.latest_for_session(session) do
      %{"session" => ^session, "uid" => uid, "tmux" => terminal}
      when is_binary(uid) and is_binary(terminal) ->
        latest = SessionLedger.latest_for_uid(uid)

        if is_map(latest) and latest["session"] == session and
             latest["tmux"] == terminal and Terminal.locate(runner(), terminal) != nil do
          json(conn, %{tmux_session: terminal})
        else
          not_found(conn)
        end

      _ ->
        not_found(conn)
    end
  end

  defp create_local(conn, _params),
    do: conn |> put_status(400) |> json(%{error: "fiber uid is required"})

  defp runner, do: Shuttle.Env.app(:terminal_runner, Shuttle.Runner.Default)

  defp not_found(conn),
    do: conn |> put_status(404) |> json(%{error: "no current terminal owns this fiber"})
end
