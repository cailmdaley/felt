defmodule ShuttleWeb.CaptureController do
  @moduledoc """
  Agent-API endpoint: POST /api/v1/capture

  Spawn-without-constitution: launches a tmux agent session from a free-text
  prompt. The spawned session files a fiber, installs the shuttle block, claims
  itself via `/api/v1/claim`, and continues as the worker realizing it.

  A meeting capture starts hark on the daemon receiving the request before the
  ordinary capture is routed to the project owner (`Shuttle.Meeting.start/5`
  with a capture target). The meeting instructions travel in the capture
  prompt; the owner does not need meeting-specific code. Once the scribe
  launches, its harness session (when the owner reports one) is bound to the
  recording, so the live meeting row can name the scribe.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers,
    only: [app_server_unavailable_message: 0, relay_json: 3, present?: 1]

  alias Shuttle.{Meeting, OriginRouter}

  def create(conn, params) do
    case Map.fetch(params, "meeting") do
      :error ->
        route_capture(conn, params, nil)

      {:ok, meeting} ->
        case Meeting.start(
               meeting,
               {:capture, Map.get(params, "surface")},
               Map.get(params, "prompt"),
               Map.get(params, "origin")
             ) do
          {:ok, %{meeting: row, prompt: prompt, launch: launch}} ->
            params =
              params
              |> Map.delete("meeting")
              |> Map.put("prompt", prompt)
              |> Map.put("surface", "cli")

            conn |> assign(:meeting_launch, launch) |> route_capture(params, row)

          {:error, reason} ->
            meeting_error(conn, reason)
        end
    end
  end

  defp route_capture(conn, params, meeting_row) do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        result = OriginRouter.forward(remote, "/api/v1/capture", params)
        relay_capture(conn, result, meeting_row)

      :local ->
        create_local(conn, params, meeting_row)
    end
  end

  defp create_local(conn, params, meeting_row) do
    prompt = Map.get(params, "prompt")
    project_dir = Map.get(params, "project_dir")

    cond do
      not present?(prompt) ->
        capture_error(conn, 400, %{error: "prompt is required"}, meeting_row)

      not present?(project_dir) ->
        capture_error(conn, 400, %{error: "project_dir is required"}, meeting_row)

      not File.dir?(project_dir) ->
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
               surface: Map.get(params, "surface")
             ) do
          {:ok, %{session: session, agent_id: agent_id} = launched} ->
            capture_json(
              conn,
              %{spawned: true, agent: agent_id}
              |> Map.merge(Shuttle.WorkerBackend.wire(session))
              |> put_session_uuid(launched[:session_uuid]),
              meeting_row
            )

          {:error, {:app_launch_failed, id, reason}} ->
            if reason == :app_server_unavailable do
              app_server_unavailable(conn, %{session_uuid: id}, meeting_row)
            else
              capture_error(
                conn,
                502,
                %{
                  spawned: false,
                  surface: "app",
                  session_uuid: id,
                  tmux_session: nil,
                  reason: "app_launch_failed",
                  error: inspect(reason),
                  message:
                    "The conversation was created, but its turn could not be confirmed. Inspect this same conversation before retrying."
                },
                meeting_row
              )
            end

          {:error, :app_server_unavailable} ->
            app_server_unavailable(conn, %{}, meeting_row)

          {:error, {:invalid_axes, msg}} ->
            capture_error(conn, 422, %{spawned: false, reason: msg}, meeting_row)

          {:error, {tag, msg}}
          when tag in [:wrapper_unresolved, :work_dir_missing, :tmux_server_unavailable] and
                 is_binary(msg) ->
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

  defp relay_capture(conn, result, nil),
    do: relay_json(conn, result, &capture_failed/2)

  defp relay_capture(conn, {:forwarded, status, body}, meeting_row) do
    payload = decode_capture_body(body)
    if status < 300, do: bind_scribe(conn, payload["session_uuid"])
    payload = Map.put(payload, "meeting", meeting_row)
    payload = if status >= 400, do: Map.put(payload, "recording", true), else: payload
    conn |> put_status(status) |> json(payload)
  end

  defp relay_capture(conn, {:error, {:forward_failed, name, reason}}, meeting_row) do
    payload =
      capture_failed(name, reason)
      |> Map.put("meeting", meeting_row)
      |> Map.put("recording", true)

    conn |> put_status(502) |> json(payload)
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
    bind_scribe(conn, payload[:session_uuid])
    json(conn, Map.put(payload, "meeting", row))
  end

  # A terminal capture's harness session, when the launch pre-assigned one.
  defp put_session_uuid(payload, uuid) when is_binary(uuid),
    do: Map.put_new(payload, :session_uuid, uuid)

  defp put_session_uuid(payload, _uuid), do: payload

  defp bind_scribe(conn, session_uuid),
    do: Meeting.bind_scribe(conn.assigns[:meeting_launch], session_uuid)

  defp capture_error(conn, status, payload, nil),
    do: conn |> put_status(status) |> json(payload)

  defp capture_error(conn, status, payload, row) do
    payload = payload |> Map.put("meeting", row) |> Map.put("recording", true)
    conn |> put_status(status) |> json(payload)
  end

  defp meeting_error(conn, reason) do
    {status, body} = ShuttleWeb.MeetingController.start_error(reason)
    conn |> put_status(status) |> json(body)
  end

  defp error_code(reason) when is_binary(reason), do: reason
  defp error_code(reason), do: inspect(reason)

  defp app_server_unavailable(conn, extra, meeting_row) do
    payload =
      Map.merge(
        %{
          spawned: false,
          surface: "app",
          tmux_session: nil,
          reason: "app_server_unavailable",
          message: app_server_unavailable_message()
        },
        extra
      )

    capture_error(conn, 503, payload, meeting_row)
  end

  defp capture_failed(name, reason),
    do: %{spawned: false, reason: "forward_failed", origin: name, error: inspect(reason)}
end
