defmodule ShuttleWeb.VoiceController do
  @moduledoc "Recorder-addressed live voice state and controls."
  use Phoenix.Controller, formats: [:json]
  alias Shuttle.{RecorderRouter, Voice}

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
  nothing is sent for it on connect. Every stream carries `open` events from
  `open/2`. A comment every 15 s holds the connection.
  """
  def events(conn, params) do
    recorder =
      match?({:ok, :local}, RecorderRouter.select_start(Map.drop(params, ["prefer", "rex"])))

    if recorder, do: Voice.subscribe()
    if params["rex"] == "1", do: Shuttle.RexFocus.subscribe()
    Registry.register(Shuttle.Voice.Streams, :board_open, nil)

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
  end

  @doc """
  `POST /api/v1/board/open {fiber_id, origin?, page}` asks every board in the
  fleet to show a page of a fiber: `constitution`, `tapestry` or `files`. The
  origin defaults to this host. This daemon tells its own boards and passes the
  request, marked `forwarded`, to every other daemon in the fleet, which tells
  only its own: a worker on any host reaches the board the human is looking at.
  """
  def open(conn, %{"fiber_id" => id, "page" => page} = params)
      when is_binary(id) and id != "" and page in ~w(constitution tapestry files) do
    open = %{fiber_id: id, origin: params["origin"] || Shuttle.Poller.own_host_id(), page: page}

    Registry.dispatch(Shuttle.Voice.Streams, :board_open, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:board_open, open})
    end)

    unless params["forwarded"] == true, do: forward_open(open)
    json(conn, %{ok: true})
  end

  def open(conn, _params),
    do: conn |> put_status(400) |> json(%{error: "fiber_id and page are required"})

  defp forward_open(open) do
    own = Shuttle.Poller.own_host_id()
    body = open |> Map.put(:forwarded, true) |> Jason.encode!()
    client = Shuttle.OriginRouter.forward_client()

    for remote <- Shuttle.RegistryCommon.configured_remotes(), remote.name != own do
      Task.Supervisor.start_child(Shuttle.TaskSupervisor, fn ->
        client.post(
          Shuttle.Remote.url_for(remote, "/api/v1/board/open"),
          body,
          "application/json",
          2_000
        )
      end)
    end
  end

  defp stream(conn) do
    next =
      receive do
        {:voice_target, target} -> event("target", target)
        {:rex_focus, target} -> event("focus", target)
        {:board_open, open} -> event("open", open)
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
    case RecorderRouter.select_start(Map.delete(params, "prefer")) do
      {:ok, :local} ->
        result = local(action, params)

        case result do
          {:ok, body} ->
            json(conn, Map.put(body, :recorder, Shuttle.Poller.own_host_id()))

          {:error, :not_found} ->
            conn |> put_status(404) |> json(%{error: "No listening transcript is available yet"})

          {:error, reason} ->
            conn |> put_status(422) |> json(%{error: reason})
        end

      {:ok, {:remote, remote}} ->
        {status, body} =
          if action in [:show, :transcript],
            do:
              RecorderRouter.forward_read(
                remote,
                path,
                params |> Map.take(~w(date fiber since)) |> Map.put("recorder", remote.name)
              ),
            else: RecorderRouter.forward_control(remote, path, params)

        conn |> put_status(status) |> json(body)

      {:error, message} ->
        conn |> put_status(400) |> json(%{error: message})
    end
  end

  defp local(:show, _params), do: {:ok, Voice.show()}
  defp local(:transcript, params), do: Shuttle.Voice.Transcript.read(params)

  defp local(:target, params) do
    with {:ok, _} <- Voice.target(Map.put(params, "source", "board")), do: {:ok, Voice.show()}
  end

  defp local(:update, params), do: Voice.update(params)
  defp local(:toggle, _params), do: Voice.toggle()
  defp local(:discard, _params), do: Voice.discard()
end
