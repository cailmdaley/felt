defmodule ShuttleWeb.VoiceController do
  @moduledoc "Recorder-addressed live voice state and controls."
  use Phoenix.Controller, formats: [:json]
  alias Shuttle.{Meeting, MeetingRouter, OriginRouter, Remote, Voice}

  def show(conn, params), do: route(conn, params, :show, "/api/v1/voice")
  def update(conn, params), do: route(conn, params, :update, "/api/v1/voice")
  def target(conn, params), do: route(conn, params, :target, "/api/v1/voice/target")
  def toggle(conn, params), do: route(conn, params, :toggle, "/api/v1/voice/toggle")
  def discard(conn, params), do: route(conn, params, :discard, "/api/v1/voice/discard")

  @doc """
  The board's one live stream. Streams the target as server-sent `target` events,
  the current one on connect, while the recorder is on this host. With `rex=1`
  it also streams each worker Rex moves to as `focus` events, whether or not
  voice is on; Rex's app is on this daemon's host, whatever the recorder, and
  nothing is sent for it on connect. A comment every 15 s holds the connection.
  A stream with nothing to carry answers 501, and the board polls.
  """
  def events(conn, params) do
    rex = params["rex"] == "1"

    recorder =
      match?({:ok, :local}, MeetingRouter.select_start(Map.drop(params, ["prefer", "rex"])))

    if recorder or rex do
      if recorder, do: Voice.subscribe()
      if rex, do: Shuttle.RexFocus.subscribe()

      conn =
        conn
        |> put_resp_content_type("text/event-stream")
        |> put_resp_header("cache-control", "no-cache, no-transform")
        |> put_resp_header("x-accel-buffering", "no")
        |> send_chunked(200)

      first = if recorder, do: event("target", Voice.snapshot().target), else: ": open\n\n"

      case chunk(conn, first) do
        {:ok, conn} -> stream(conn)
        {:error, _} -> conn
      end
    else
      conn |> put_status(501) |> json(%{error: "voice events stream from the recorder's host"})
    end
  end

  defp stream(conn) do
    next =
      receive do
        {:voice_target, target} -> event("target", target)
        {:rex_focus, target} -> event("focus", target)
      after
        15_000 -> ": keepalive\n\n"
      end

    case chunk(conn, next) do
      {:ok, conn} -> stream(conn)
      {:error, _} -> conn
    end
  end

  defp event(name, payload), do: "event: #{name}\ndata: #{Jason.encode!(payload)}\n\n"

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

  defp local(:target, params) do
    with {:ok, _} <- Voice.target(Map.put(params, "source", "board")), do: {:ok, Voice.show()}
  end

  defp local(:update, params), do: Voice.update(params)
  defp local(:toggle, _params), do: Voice.toggle()
  defp local(:discard, _params), do: Voice.discard()

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
