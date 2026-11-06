defmodule ShuttleWeb.VoiceController do
  @moduledoc "Recorder-addressed live voice state and controls."
  use Phoenix.Controller, formats: [:json]
  alias Shuttle.{Meeting, MeetingRouter, OriginRouter, Remote, Voice}

  def show(conn, params), do: route(conn, params, :show, "/api/v1/voice")
  def update(conn, params), do: route(conn, params, :update, "/api/v1/voice")
  def reveal(conn, params), do: route(conn, params, :reveal, "/api/v1/voice/reveal")

  @doc """
  Streams the target as server-sent `target` events: the current one on
  connect, then each new route, with a comment every 15 s to hold the
  connection. A recorder on another host answers 501, and the board polls.
  """
  def events(conn, params) do
    case MeetingRouter.select_start(Map.delete(params, "prefer")) do
      {:ok, :local} ->
        Voice.subscribe()

        conn =
          conn
          |> put_resp_content_type("text/event-stream")
          |> put_resp_header("cache-control", "no-cache, no-transform")
          |> put_resp_header("x-accel-buffering", "no")
          |> send_chunked(200)

        case chunk(conn, target_event(Voice.snapshot().target)) do
          {:ok, conn} -> stream_targets(conn)
          {:error, _} -> conn
        end

      _ ->
        conn |> put_status(501) |> json(%{error: "voice events stream from the recorder's host"})
    end
  end

  defp stream_targets(conn) do
    event =
      receive do
        {:voice_target, target} -> target_event(target)
      after
        15_000 -> ": keepalive\n\n"
      end

    case chunk(conn, event) do
      {:ok, conn} -> stream_targets(conn)
      {:error, _} -> conn
    end
  end

  defp target_event(target), do: "event: target\ndata: #{Jason.encode!(target)}\n\n"

  def transcript(conn, params) do
    conn
    |> put_resp_header("cache-control", "no-store")
    |> route(params, :transcript, "/api/v1/voice/transcript")
  end

  defp route(conn, params, action, path) do
    case MeetingRouter.select_start(Map.delete(params, "prefer")) do
      {:ok, :local} ->
        result = local(action, params)

        case result do
          {:ok, body} ->
            json(conn, Map.put(body, :recorder, MeetingRouter.own_host()))

          {:error, :not_found} ->
            conn |> put_status(404) |> json(%{error: "No listening transcript is available yet"})

          {:error, reason} ->
            conn |> put_status(422) |> json(%{error: reason})
        end

      {:ok, {:remote, remote}} ->
        {status, body} =
          if action in [:show, :transcript],
            do: forward_read(remote, path),
            else: MeetingRouter.forward_control(remote, path, params)

        conn |> put_status(status) |> json(body)

      {:error, message} ->
        conn |> put_status(400) |> json(%{error: message})
    end
  end

  defp local(:show, _params), do: {:ok, Voice.show()}
  defp local(:transcript, _params), do: Meeting.voice_transcript()

  defp local(:reveal, params) do
    case Shuttle.RexFocus.reveal(params) do
      :ok -> {:ok, %{revealed: true}}
      {:skip, reason} -> {:ok, %{revealed: false, skipped: reason}}
    end
  end

  defp local(:update, params), do: Voice.update(params)

  defp forward_read(remote, path) do
    case OriginRouter.forward_client().get_file(Remote.url_for(remote, path), 2_000) do
      {:ok, status, _type, bytes} ->
        case Jason.decode(bytes) do
          {:ok, body} when is_map(body) -> {status, Map.put(body, "recorder", remote.name)}
          _ -> {502, %{error: "recorder returned invalid voice state"}}
        end

      {:error, reason} ->
        {502, %{error: "cannot inspect recorder: #{inspect(reason)}", recorder: remote.name}}
    end
  end
end
