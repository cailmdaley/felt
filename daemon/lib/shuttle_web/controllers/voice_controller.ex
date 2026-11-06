defmodule ShuttleWeb.VoiceController do
  @moduledoc "Recorder-addressed live voice state, controls and spoken-time targets."
  use Phoenix.Controller, formats: [:json]
  alias Shuttle.{MeetingRouter, OriginRouter, Remote, Voice}

  def show(conn, params), do: route(conn, params, :show, "/api/v1/voice")
  def update(conn, params), do: route(conn, params, :update, "/api/v1/voice")
  def target(conn, params), do: route(conn, params, :target, "/api/v1/voice/target")
  def draft(conn, params), do: route(conn, params, :draft, "/api/v1/voice/draft")
  def release(conn, params), do: route(conn, params, :release, "/api/v1/voice/release")

  defp route(conn, params, action, path) do
    # origin belongs to the constitution receiving speech, not the recorder.
    case MeetingRouter.select_start(Map.delete(params, "prefer")) do
      {:ok, :local} ->
        result =
          case action do
            :show ->
              {:ok, Voice.show()}

            action when action in [:draft, :release] ->
              case apply(Shuttle.Meeting.TranscriptRelay, action, [params]) do
                :ok -> {:ok, Voice.show()}
                error -> error
              end

            _ ->
              apply(Voice, action, [params])
          end

        case result do
          {:ok, body} ->
            json(conn, Map.put(body, :recorder, MeetingRouter.own_host()))

          {:error, :conflict} ->
            conn |> put_status(409) |> json(%{error: "held speech has already been consumed"})

          {:error, reason} ->
            conn |> put_status(422) |> json(%{error: reason})
        end

      {:ok, {:remote, remote}} ->
        {status, body} =
          if action == :show,
            do: forward_read(remote),
            else: MeetingRouter.forward_control(remote, path, params)

        conn |> put_status(status) |> json(body)

      {:error, message} ->
        conn |> put_status(400) |> json(%{error: message})
    end
  end

  defp forward_read(remote) do
    case OriginRouter.forward_client().get_file(Remote.url_for(remote, "/api/v1/voice"), 2_000) do
      {:ok, status, _type, bytes} ->
        case Jason.decode(bytes) do
          {:ok, body} -> {status, Map.put(body, "recorder", remote.name)}
          _ -> {502, %{error: "recorder returned invalid voice state"}}
        end

      {:error, reason} ->
        {502, %{error: "cannot inspect recorder: #{inspect(reason)}", recorder: remote.name}}
    end
  end
end
