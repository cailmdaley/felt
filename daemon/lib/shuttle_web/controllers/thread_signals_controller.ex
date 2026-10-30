defmodule ShuttleWeb.ThreadSignalsController do
  @moduledoc "Fresh owner-routed validation for queued thread lifecycle notices."
  use Phoenix.Controller, formats: [:json]

  def create(conn, params) do
    case Shuttle.Threads.signal_current(params) do
      {:ok, current} ->
        json(conn, %{current: current})

      {:error, reason} ->
        conn |> put_status(:service_unavailable) |> json(%{error: inspect(reason)})
    end
  end
end
