defmodule ShuttleWeb.MeetingAudioController do
  @moduledoc """
  `GET /api/v1/meeting/audio`: upgrades to the WebSocket that relays a phone's
  microphone into the live `phone` meeting (`ShuttleWeb.MeetingAudioSocket`).

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

  def upgrade(conn, _params) do
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
        conn
        |> WebSockAdapter.upgrade(
          ShuttleWeb.MeetingAudioSocket,
          Application.get_env(:shuttle, :meeting_audio_socket, []),
          timeout: @idle_timeout_ms,
          max_frame_size: 1_000_000
        )
        |> halt()
    end
  end

  defp websocket_request?(conn) do
    conn
    |> get_req_header("upgrade")
    |> Enum.any?(&(String.downcase(&1) == "websocket"))
  end
end
