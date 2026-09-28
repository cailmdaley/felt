defmodule ShuttleWeb.MeetingController do
  @moduledoc """
  Starts, reports and stops this daemon's local hark meeting capture.

  A recording always runs on the daemon receiving the request, on its
  microphone. `POST /api/v1/capture` with `meeting` starts one for a new capture
  agent; `POST /api/v1/meeting/join` starts one for an existing constitution and
  delivers the meeting message to its worker through the owner-routed
  `/deliver` path. Report and stop never leave this daemon.
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.Meeting

  def show(conn, _params) do
    case Meeting.show() do
      {:ok, snapshot} ->
        json(conn, snapshot)

      {:error, reason} ->
        conn |> put_status(503) |> json(%{error: error_message(reason)})
    end
  end

  @doc """
  Body `{fiber_id, origin?, meeting: {mode}, note?}`. Records locally, mirrors
  the transcript toward `origin`, and delivers the meeting message to the
  fiber's worker. The answer carries the delivery's status: 202 with
  `delivery.delivered: null` when the message was sent but its arrival is
  unconfirmed; a delivery failure after recording began adds `recording: true`
  and the error beside the live row.
  """
  def join(conn, params) do
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
          ShuttleWeb.DeliverController.route(fiber_id, prompt, origin, "shuttle meeting")

        body = %{meeting: row, delivery: delivery}

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
        conn |> put_status(status) |> json(body)
    end
  end

  def stop(conn, _params) do
    case Meeting.stop() do
      {:ok, snapshot} ->
        conn |> put_status(202) |> json(%{meeting: snapshot.meeting})

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
