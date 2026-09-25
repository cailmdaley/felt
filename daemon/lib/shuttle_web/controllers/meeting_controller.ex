defmodule ShuttleWeb.MeetingController do
  @moduledoc """
  Controls this daemon's local hark meeting capture.

  Local only: `host` in the request selects hark's scribe host; it never routes
  the HTTP request to another Shuttle daemon.
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.Meeting

  def show(conn, _params) do
    case Meeting.show() do
      {:ok, snapshot} ->
        json(conn, snapshot)

      {:error, reason} ->
        conn
        |> put_status(503)
        |> json(%{error: error_message(reason)})
    end
  end

  def create(conn, params) do
    case Meeting.start(params) do
      {:ok, snapshot} ->
        conn
        |> put_status(202)
        |> json(%{meeting: snapshot.meeting})

      {:error, {:validation, message}} ->
        conn |> put_status(422) |> json(%{error: message})

      {:error, {:conflict, meeting}} ->
        conn |> put_status(409) |> json(%{error: "a meeting is already active", meeting: meeting})

      {:error, :unavailable} ->
        conn |> put_status(503) |> json(%{error: "hark is not available on this host"})

      {:error, reason} ->
        conn
        |> put_status(503)
        |> json(%{error: error_message(reason)})
    end
  end

  def stop(conn, _params) do
    case Meeting.stop() do
      {:ok, snapshot} ->
        conn
        |> put_status(202)
        |> json(%{meeting: snapshot.meeting})

      {:error, :not_found} ->
        conn |> put_status(404) |> json(%{error: "there is no meeting to stop"})

      {:error, reason} ->
        conn
        |> put_status(503)
        |> json(%{error: error_message(reason)})
    end
  end

  defp error_message({:operation, message}), do: message
  defp error_message({:tmux, message}), do: "tmux is unavailable: #{message}"
  defp error_message(reason), do: inspect(reason)
end
