defmodule ShuttleWeb.SpeakController do
  @moduledoc """
  The spoken outbox. `POST {fiber_id, text, voice?}` queues a line on the host
  that speaks; `POST {muted}` holds or releases it; `GET` shows what is spoken.
  """
  use Phoenix.Controller, formats: [:json]
  alias Shuttle.{MeetingRouter, Speaker}

  def show(conn, params), do: route(conn, params, :show)
  def create(conn, params), do: route(conn, params, :create)

  defp route(conn, params, action) do
    case MeetingRouter.select_speaker(params) do
      {:ok, :local} ->
        case local(action, params) do
          {:ok, body} -> json(conn, Map.put(body, :recorder, MeetingRouter.own_host()))
          {:error, reason} -> conn |> put_status(422) |> json(%{error: reason})
        end

      {:ok, {:remote, remote}} ->
        {status, body} =
          if action == :show,
            do: MeetingRouter.forward_read(remote, "/api/v1/speak"),
            else: MeetingRouter.forward_control(remote, "/api/v1/speak", params)

        conn |> put_status(status) |> json(body)

      {:error, message} ->
        conn |> put_status(400) |> json(%{error: message})
    end
  end

  defp local(:show, _params), do: {:ok, Speaker.show()}
  defp local(:create, %{"muted" => muted}), do: Speaker.mute(muted)
  defp local(:create, params), do: Speaker.speak(params)
end
