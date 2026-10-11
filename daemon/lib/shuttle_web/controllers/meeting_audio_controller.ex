defmodule ShuttleWeb.MeetingAudioController do
  @moduledoc """
  `GET /api/v1/meeting/audio?recorder=<host>&launch=<id>` upgrades to
  the local meeting audio socket or a one-hop relay to the explicitly selected
  recorder. Remote upgrades require a launch identity; forwarded upgrades
  must name the receiving daemon and cannot route again.

  Browsers open WebSockets cross-site without CORS, so the upgrade is held to
  the same origin rule as a write (`ShuttleWeb.CORSPlug.write_permitted?/1`):
  another site's page must not speak into a meeting its scribe acts on. Every
  meeting state, including none, upgrades; the socket's first frames say what
  it found, which a browser could not read from a refused upgrade.
  """

  use Phoenix.Controller, formats: [:json]

  # Longer than the page's 100 ms frames by far; a page that stops sending for
  # this long has been suspended, and reconnects when it wakes.
  @idle_timeout_ms 60_000

  def upgrade(conn, params), do: upgrade(conn, params, [])

  def upgrade(conn, params, routing_opts) do
    cond do
      not ShuttleWeb.CORSPlug.write_permitted?(conn) ->
        conn |> put_status(403) |> json(%{error: "origin not allowed"}) |> halt()

      not websocket_request?(conn) ->
        conn
        |> put_status(426)
        |> put_resp_header("upgrade", "websocket")
        |> json(%{error: "this route takes a WebSocket upgrade"})
        |> halt()

      true ->
        case Shuttle.MeetingAudioRelay.route(params, routing_opts) do
          {:local, launch} ->
            upgrade_socket(
              conn,
              ShuttleWeb.MeetingAudioSocket,
              Keyword.put(Shuttle.Env.app(:meeting_audio_socket, []), :launch, launch)
            )

          {:remote, url} ->
            upgrade_socket(conn, ShuttleWeb.MeetingAudioRelaySocket, url: url)

          {:error, reason} ->
            conn |> put_status(409) |> json(%{error: routing_error(reason)}) |> halt()
        end
    end
  end

  defp upgrade_socket(conn, handler, opts) do
    conn
    |> WebSockAdapter.upgrade(handler, opts,
      timeout: @idle_timeout_ms,
      max_frame_size: 1_000_000
    )
    |> halt()
  end

  defp routing_error(:launch_required), do: "remote audio requires an explicit launch"
  defp routing_error(:wrong_recorder), do: "forwarded audio targets a different recorder"
  defp routing_error({:unknown_origin, host}), do: "unknown recorder: #{host}"

  defp websocket_request?(conn) do
    conn
    |> get_req_header("upgrade")
    |> Enum.any?(&(String.downcase(&1) == "websocket"))
  end
end
