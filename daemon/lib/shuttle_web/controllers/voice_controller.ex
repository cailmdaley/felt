defmodule ShuttleWeb.VoiceController do
  @moduledoc "Recorder-addressed live voice state, controls and spoken-time targets."
  use Phoenix.Controller, formats: [:json]
  alias Shuttle.{Meeting, MeetingRouter, OriginRouter, Remote, Voice}

  def show(conn, params), do: route(conn, params, :show, "/api/v1/voice")
  def update(conn, params), do: route(conn, params, :update, "/api/v1/voice")
  def target(conn, params), do: route(conn, params, :target, "/api/v1/voice/target")
  def draft(conn, params), do: route(conn, params, :draft, "/api/v1/voice/draft")
  def release(conn, params), do: route(conn, params, :release, "/api/v1/voice/release")
  def reveal(conn, params), do: route(conn, params, :reveal, "/api/v1/voice/reveal")

  def transcript(conn, params) do
    conn
    |> put_resp_header("cache-control", "no-store")
    |> route(params, :transcript, "/api/v1/voice/transcript")
  end

  defp route(conn, params, action, path) do
    # origin belongs to the constitution receiving speech, not the recorder.
    case MeetingRouter.select_start(Map.delete(params, "prefer")) do
      {:ok, :local} ->
        result = local(action, params)

        case result do
          {:ok, body} ->
            json(conn, Map.put(body, :recorder, MeetingRouter.own_host()))

          {:error, :conflict} ->
            conn |> put_status(409) |> json(%{error: "held speech has already been consumed"})

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
  defp local(:reveal, params), do: {:ok, %{revealed: Shuttle.RexFocus.reveal(params) == :ok}}

  defp local(action, params) when action in [:draft, :release] do
    case apply(Shuttle.Meeting.TranscriptRelay, action, [params]) do
      :ok -> {:ok, Voice.show()}
      error -> error
    end
  end

  defp local(action, params), do: apply(Voice, action, [params])

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
