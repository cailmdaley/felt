defmodule ShuttleWeb.CaptureController do
  @moduledoc """
  Agent-API endpoint: POST /api/v1/capture

  Spawn-without-constitution: launches a tmux agent session from a free-text
  prompt. The spawned session files a fiber, installs the shuttle block, claims
  itself via `/api/v1/claim`, and continues as the worker realizing it.

  A meeting capture starts hark on the selected recorder before the
  ordinary capture is routed to the project owner (`Shuttle.Meeting.start/5`
  with a capture target). The meeting instructions travel in the capture
  prompt, and the recording's launch id travels as `meeting_launch`: the owner
  puts it in the scribe's `Claim` body, so the claim stamps it on the fiber
  the scribe files (`shuttle.runtime.meeting`). The meeting's daemon finds its
  fiber from that stamp (`Shuttle.Meeting`), wherever the owner is and whether
  or not the owner can reach back.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers,
    only: [relay_json: 3, present?: 1]

  alias Shuttle.{Meeting, MeetingRouter, OriginRouter}
  require Shuttle.Dispatcher

  def create(conn, params) do
    case Map.fetch(params, "meeting") do
      :error ->
        route_capture(conn, params, nil)

      {:ok, _meeting} ->
        case MeetingRouter.select_start(params) do
          {:ok, :local} ->
            create_meeting_local(conn, params)

          {:ok, {:remote, remote}} ->
            {status, body} = MeetingRouter.forward_start(remote, "/api/v1/capture", params)
            conn |> put_status(status) |> json(body)

          {:error, message} ->
            conn |> put_status(400) |> json(%{error: message})
        end
    end
  end

  defp create_meeting_local(conn, params) do
    case Meeting.start(
           params["meeting"],
           :capture,
           Map.get(params, "prompt"),
           Map.get(params, "origin"),
           capture_destination: Map.get(params, "project_dir")
         ) do
      {:ok, %{meeting: row, prompt: prompt, launch: launch}} ->
        params =
          params
          |> Map.delete("meeting")
          |> Map.put("prompt", prompt)
          |> Map.put("meeting_launch", launch)

        row = Map.put(row, "recorder", MeetingRouter.own_host())
        route_capture(conn, params, row)

      {:error, reason} ->
        meeting_error(conn, reason)
    end
  end

  defp route_capture(conn, params, meeting_row) do
    params = Map.delete(params, "surface")

    case OriginRouter.route_host(Map.get(params, "origin")) do
      {:remote, remote} ->
        result = OriginRouter.forward(remote, "/api/v1/capture", params)
        relay_capture(conn, result, meeting_row, params["origin"])

      :local ->
        create_local(conn, params, meeting_row)

      {:error, {:unknown_origin, origin}} ->
        capture_error(
          conn,
          400,
          %{error: OriginRouter.unknown_origin_message(origin)},
          meeting_row
        )
    end
  end

  defp create_local(conn, params, meeting_row) do
    prompt = Map.get(params, "prompt")
    project_dir = Map.get(params, "project_dir")

    cond do
      not present?(prompt) or String.trim(prompt) == "" ->
        capture_error(conn, 400, %{error: "prompt is required"}, meeting_row)

      not present?(project_dir) ->
        capture_error(conn, 400, %{error: "project_dir is required"}, meeting_row)

      not Shuttle.FS.dir?(project_dir) ->
        capture_error(
          conn,
          422,
          %{spawned: false, reason: "project_dir_missing", project_dir: project_dir},
          meeting_row
        )

      true ->
        case Shuttle.Poller.capture(prompt,
               work_dir: project_dir,
               agent: Map.get(params, "agent"),
               effort: Map.get(params, "effort"),
               chrome: Map.get(params, "chrome") == true,
               meeting: Map.get(params, "meeting_launch")
             ) do
          {:ok, %{session: session, agent_id: agent_id} = launched} ->
            capture_json(
              conn,
              %{spawned: true, agent: agent_id}
              |> Map.merge(Shuttle.WorkerBackend.wire(session))
              |> put_session_uuid(launched[:session_uuid]),
              meeting_row
            )

          {:error, {:backend_not_ready, message}} ->
            capture_error(
              conn,
              503,
              %{
                spawned: false,
                waiting: true,
                retryable: true,
                reason: "backend_not_ready",
                message: message
              },
              meeting_row
            )

          {:error, {:invalid_axes, msg}} ->
            capture_error(conn, 422, %{spawned: false, reason: msg}, meeting_row)

          {:error, {tag, msg}} when Shuttle.Dispatcher.refusal?(tag, msg) ->
            capture_error(
              conn,
              422,
              %{spawned: false, reason: to_string(tag), message: msg},
              meeting_row
            )

          {:error, reason} ->
            capture_error(conn, 500, %{spawned: false, reason: error_code(reason)}, meeting_row)
        end
    end
  end

  defp relay_capture(conn, result, nil, _origin),
    do: relay_json(conn, result, &capture_failed/2)

  defp relay_capture(conn, {:forwarded, status, body}, meeting_row, origin) do
    outcome = decode_capture_body(body)
    meeting_row = Meeting.log_delivery(meeting_row, status, outcome)

    meeting_row =
      if status in 200..299 and outcome["spawned"] == true,
        do: start_capture_relay(meeting_row, origin),
        else: meeting_row

    payload = Map.put(outcome, "meeting", meeting_row)
    payload = if status >= 400, do: Map.put(payload, "recording", true), else: payload
    conn |> put_status(status) |> json(MeetingRouter.stamp(payload))
  end

  defp relay_capture(conn, {:error, {:forward_failed, name, reason}}, meeting_row, _origin) do
    outcome = capture_failed(name, reason)
    meeting_row = Meeting.log_delivery(meeting_row, :unconfirmed, outcome)

    payload =
      outcome
      |> Map.put("meeting", meeting_row)
      |> Map.put("recording", true)

    conn |> put_status(502) |> json(MeetingRouter.stamp(payload))
  end

  defp decode_capture_body(body) do
    case Jason.decode(body) do
      {:ok, payload} when is_map(payload) -> payload
      {:ok, payload} -> %{"response" => payload}
      {:error, _reason} -> %{"error" => body}
    end
  end

  defp capture_json(conn, payload, nil), do: json(conn, payload)

  defp capture_json(conn, payload, row) do
    row = Meeting.log_delivery(row, 200, payload) |> start_capture_relay(nil)
    json(conn, MeetingRouter.stamp(Map.put(payload, "meeting", row)))
  end

  defp start_capture_relay(row, origin) do
    if Shuttle.Env.app(:start_meeting_transcript_relay, true) do
      start =
        Shuttle.Env.app(:meeting_transcript_relay_start, &Shuttle.Meeting.TranscriptRelay.start/3)

      case start.(row, nil, origin) do
        :ok -> row
        {:error, reason} -> Map.put(row, :relay_error, inspect(reason))
      end
    else
      row
    end
  end

  # A terminal capture's harness session, when the launch pre-assigned one.
  defp put_session_uuid(payload, uuid) when is_binary(uuid),
    do: Map.put_new(payload, :session_uuid, uuid)

  defp put_session_uuid(payload, _uuid), do: payload

  defp capture_error(conn, status, payload, nil),
    do: conn |> put_status(status) |> json(payload)

  defp capture_error(conn, status, payload, row) do
    row = Meeting.log_delivery(row, status, payload)
    payload = payload |> Map.put("meeting", row) |> Map.put("recording", true)
    conn |> put_status(status) |> json(MeetingRouter.stamp(payload))
  end

  defp meeting_error(conn, reason) do
    {status, body} = ShuttleWeb.MeetingController.start_error(reason)
    conn |> put_status(status) |> json(MeetingRouter.stamp(body))
  end

  defp error_code(reason) when is_binary(reason), do: reason
  defp error_code(reason), do: inspect(reason)

  defp capture_failed(name, reason),
    do: %{spawned: false, reason: "forward_failed", origin: name, error: inspect(reason)}
end
