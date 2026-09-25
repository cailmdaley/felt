defmodule ShuttleWeb.MeetingController do
  @moduledoc """
  Reports and stops this daemon's local hark meeting capture.

  Meeting recording starts through `POST /api/v1/capture`; these routes never
  owner-route the local microphone or its transcript.
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

  defp error_message({:operation, message}), do: message
  defp error_message({:tmux, message}), do: "tmux is unavailable: #{message}"
  defp error_message(reason), do: inspect(reason)
end
