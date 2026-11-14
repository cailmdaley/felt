defmodule ShuttleWeb.RecentSessionsController do
  @moduledoc """
  `GET /api/v1/sessions/recent?since=&host=&harness=`

  Every Claude Code, Codex and Pi session on one host with a transcript
  message since `since`, live or ended. The listing lives in the CLI: on the
  addressed host this route runs `shuttle sessions --since <since> --local
  --json` and relays its document unchanged, `{host, since, sessions, errors}`.
  `host=` names another daemon in the fleet, which this route asks with
  `host=local`; absent, it means this host.

  A CLI failure is a JSON error: 400 for a missing `since`, 502 when the CLI
  fails or prints something that is not the document, 503 for an unreachable
  host, 504 when the CLI outlives the bound.
  """

  use Phoenix.Controller, formats: [:json]

  import Plug.Conn
  import ShuttleWeb.RelayHelpers, only: [present?: 1]

  require Logger

  alias Shuttle.OriginRouter

  @timeout_ms 120_000

  def show(conn, params) do
    since = scalar(params["since"]) |> String.trim()
    harness = scalar(params["harness"]) |> String.trim()

    if since == "" do
      conn |> put_status(400) |> json(%{error: "since is required"})
    else
      case OriginRouter.route(scalar(params["host"])) do
        :local ->
          local(conn, since, harness)

        {:remote, remote} ->
          query = %{"host" => "local", "since" => since}
          query = if present?(harness), do: Map.put(query, "harness", harness), else: query

          case OriginRouter.forward_get(remote, "/api/v1/sessions/recent", query,
                 forward_timeout_ms: @timeout_ms + 10_000
               ) do
            {:forwarded, status, _content_type, body} ->
              conn |> put_resp_content_type("application/json") |> send_resp(status, body)

            {:error, _reason} ->
              fail(conn, 503, "host #{remote.name} is unreachable", "")
          end

        {:error, {:unknown_origin, name}} ->
          fail(conn, 503, "host #{name} is not in this daemon's fleet", "")
      end
    end
  end

  defp local(conn, since, harness) do
    args =
      ["sessions", "--json", "--local", "--since=" <> since] ++
        if(harness == "", do: [], else: ["--harness=" <> harness])

    case Shuttle.CLI.run(args, timeout_ms: @timeout_ms) do
      {:ok, output} ->
        case Jason.decode(output) do
          {:ok, %{"sessions" => sessions} = doc} when is_list(sessions) ->
            json(conn, doc)

          _ ->
            fail(conn, 502, "shuttle sessions printed no session document", output)
        end

      {:command_error, :timeout, _output} ->
        fail(conn, 504, "shuttle sessions timed out", "")

      {:command_error, status, output} ->
        Logger.warning("GET /api/v1/sessions/recent: shuttle exited #{status}")
        fail(conn, 502, "shuttle sessions exited #{status}", output)

      {:error, message} ->
        fail(conn, 502, message, "")
    end
  end

  defp fail(conn, status, message, detail) do
    conn
    |> put_status(status)
    |> json(%{error: message, detail: detail |> String.trim() |> String.slice(0, 2000)})
  end

  defp scalar(value) when is_binary(value), do: value
  defp scalar([first | _]), do: scalar(first)
  defp scalar(_), do: ""
end
