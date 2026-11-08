defmodule ShuttleWeb.SpeakController do
  @moduledoc """
  The spoken outbox. `POST {fiber_id, text, voice?}` queues a line on the host
  that speaks; `POST {muted}` holds or releases it; `POST {inbox: "play" |
  "next" | "stop"}` drives the inbox. `GET` shows what is spoken and held, and
  `GET /voices` the voices and the roles holding them.
  """
  use Phoenix.Controller, formats: [:json]
  alias Shuttle.{RecorderRouter, Speaker}

  def show(conn, params), do: route(conn, params, :show)
  def create(conn, params), do: route(conn, params, :create)
  def voices(conn, params), do: route(conn, params, :voices)

  defp route(conn, params, action) do
    case RecorderRouter.select_speaker(params) do
      {:ok, :local} ->
        case local(action, params) do
          {:ok, body} -> json(conn, Map.put(body, :recorder, Shuttle.Poller.own_host_id()))
          {:error, reason} -> conn |> put_status(422) |> json(%{error: reason})
        end

      {:ok, {:remote, remote}} ->
        {status, body} =
          case action do
            :show -> RecorderRouter.forward_read(remote, "/api/v1/speak")
            :voices -> RecorderRouter.forward_read(remote, "/api/v1/speak/voices")
            :create -> RecorderRouter.forward_control(remote, "/api/v1/speak", params)
          end

        conn |> put_status(status) |> json(body)

      {:error, message} ->
        conn |> put_status(400) |> json(%{error: message})
    end
  end

  defp local(:show, _params), do: {:ok, Speaker.show()}
  defp local(:voices, _params), do: {:ok, %{voices: Speaker.voices()}}
  defp local(:create, %{"muted" => muted}), do: Speaker.mute(muted)
  defp local(:create, %{"inbox" => "play"}), do: Speaker.inbox(:play)
  defp local(:create, %{"inbox" => "next"}), do: Speaker.inbox(:next)
  defp local(:create, %{"inbox" => "stop"}), do: Speaker.inbox(:stop)
  defp local(:create, params), do: Speaker.speak(params)
end
