defmodule ShuttleWeb.MeetingController do
  @moduledoc """
  Starts, reports and stops a pinned recorder's hark meeting capture.
  Phone capture prefers a reachable device-capable remote recorder; agent
  delivery remains owner-routed independently of the recording host.

  `start/2` records without any agent: it is Join's recorder routing and hark
  start with neither a capture nor a `/deliver`, for a caller that follows the
  transcript itself (`shuttle meeting start`).
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.{Meeting, MeetingRouter}

  def show(conn, params) do
    case MeetingRouter.select(params) do
      {:ok, :local} ->
        show_local(conn)

      {:ok, {:remote, remote}} ->
        {status, body} = MeetingRouter.forward_read(remote)
        conn |> put_status(status) |> json(body)

      {:error, message} ->
        conn |> put_status(400) |> json(%{error: message})
    end
  end

  defp show_local(conn) do
    case Meeting.show() do
      {:ok, snapshot} ->
        json(conn, MeetingRouter.stamp(snapshot))

      {:error, reason} ->
        conn |> put_status(503) |> json(%{error: error_message(reason)})
    end
  end

  @doc """
  Body `{fiber_id, origin?, recorder?, meeting: {mode}, note?}`. Selects a recorder, mirrors
  the transcript toward `origin`, and delivers the meeting message to the
  fiber's worker. The answer carries the delivery's status: 202 with
  `delivery.delivered: null` when the message was sent but its arrival is
  unconfirmed; a delivery failure after recording began adds `recording: true`
  and the error beside the live row.
  """
  def join(conn, params) do
    case MeetingRouter.select_start(params) do
      {:ok, :local} ->
        join_local(conn, params)

      {:ok, {:remote, remote}} ->
        {status, body} = MeetingRouter.forward_start(remote, "/api/v1/meeting/join", params)
        conn |> put_status(status) |> json(body)

      {:error, message} ->
        conn |> put_status(400) |> json(%{error: message})
    end
  end

  @doc """
  Body `{origin?, recorder?, meeting: {mode}, note?}`. Selects a recorder and
  records there, mirrored toward `origin` (this daemon when omitted), and starts
  no agent. The answer is `{meeting, recorder, origin, transcript}`, where
  `transcript` is the path on `origin` that a follower reads. A remote
  recorder can only name it `~/`-relative; the origin's own daemon expands it
  as the answer passes back through it.
  """
  def start(conn, params) do
    case MeetingRouter.select_start(params) do
      {:ok, :local} ->
        start_local(conn, params)

      {:ok, {:remote, remote}} ->
        {status, body} = MeetingRouter.forward_start(remote, "/api/v1/meeting/start", params)
        conn |> put_status(status) |> json(expand_own_transcript(status, body))

      {:error, message} ->
        conn |> put_status(400) |> json(%{error: message})
    end
  end

  defp start_local(conn, params) do
    case Meeting.start(
           Map.get(params, "meeting"),
           :record,
           Map.get(params, "note"),
           params["origin"]
         ) do
      {:ok, %{meeting: row, transcript: transcript, mirror_host: mirror_host}} ->
        body = %{
          meeting: row,
          origin: mirror_host || MeetingRouter.own_host(),
          transcript: transcript
        }

        json(conn, MeetingRouter.stamp(body))

      {:error, reason} ->
        {status, body} = start_error(reason)
        conn |> put_status(status) |> json(MeetingRouter.stamp(body))
    end
  end

  # The recorder writes the mirror as `~/.hark/meetings/<name>.txt` on the
  # origin; on the origin itself that `~` is this daemon's home.
  defp expand_own_transcript(
         status,
         %{"origin" => origin, "transcript" => "~/" <> _ = path} = body
       )
       when status in 200..299 do
    if origin == MeetingRouter.own_host(),
      do: Map.put(body, "transcript", Shuttle.Env.expand(path)),
      else: body
  end

  defp expand_own_transcript(_status, body), do: body

  defp join_local(conn, params) do
    fiber_id = Map.get(params, "fiber_id")
    origin = Map.get(params, "origin")

    case Meeting.start(
           Map.get(params, "meeting"),
           {:fiber, fiber_id},
           Map.get(params, "note"),
           origin
         ) do
      {:ok, %{meeting: row, prompt: prompt}} ->
        {status, delivery} =
          ShuttleWeb.DeliverController.route(fiber_id, prompt, origin, "shuttle")

        Meeting.log_delivery(row, status, delivery)
        body = MeetingRouter.stamp(%{meeting: row, delivery: delivery})

        body =
          if status < 300,
            do: body,
            else:
              Map.merge(body, %{
                recording: true,
                error: delivery_error(delivery)
              })

        conn |> put_status(status) |> json(body)

      {:error, reason} ->
        {status, body} = start_error(reason)
        conn |> put_status(status) |> json(MeetingRouter.stamp(body))
    end
  end

  def stop(conn, params) do
    cond do
      params["recorder"] not in [nil, ""] and params["launch"] in [nil, ""] ->
        conn |> put_status(422) |> json(%{error: "launch is required for an addressed stop"})

      true ->
        case MeetingRouter.select(Map.delete(params, "prefer")) do
          {:ok, :local} ->
            stop_local(conn, params)

          {:ok, {:remote, remote}} ->
            {status, body} = MeetingRouter.forward_stop(remote, params)
            conn |> put_status(status) |> json(body)

          {:error, message} ->
            conn |> put_status(400) |> json(%{error: message})
        end
    end
  end

  defp stop_local(conn, params) do
    case Meeting.stop(launch: params["launch"]) do
      {:ok, snapshot} ->
        conn |> put_status(202) |> json(MeetingRouter.stamp(%{meeting: snapshot.meeting}))

      {:error, {:stale_launch, row}} ->
        conn
        |> put_status(409)
        |> json(
          MeetingRouter.stamp(%{error: "a different meeting is recording now", meeting: row})
        )

      {:error, :not_found} ->
        conn |> put_status(404) |> json(%{error: "there is no meeting to stop"})

      {:error, reason} ->
        conn |> put_status(503) |> json(%{error: error_message(reason)})
    end
  end

  @doc "The status and body for a meeting that could not start."
  @spec start_error(term()) :: {pos_integer(), map()}
  def start_error({:validation, message}), do: {422, %{error: message}}

  def start_error({:conflict, meeting}),
    do: {409, %{error: "a meeting is already active", meeting: meeting}}

  def start_error({:launch_failed, meeting}) do
    {503,
     %{
       error:
         "recording did not start: #{meeting.error || "hark exited before recording started"}",
       meeting: meeting,
       recording: false
     }}
  end

  def start_error(:unavailable), do: {503, %{error: "hark is not available on this host"}}
  def start_error(reason), do: {503, %{error: error_message(reason)}}

  defp delivery_error(delivery) do
    Enum.find_value(["message", "error", "detail", "reason"], fn key ->
      case Map.get(delivery, key) || Map.get(delivery, String.to_atom(key)) do
        value when is_binary(value) and value != "" -> value
        _ -> nil
      end
    end) || "the constitution's worker did not receive the meeting"
  end

  defp error_message({:operation, message}), do: message
  defp error_message({:tmux, message}), do: "tmux is unavailable: #{message}"
  defp error_message(reason), do: inspect(reason)
end
