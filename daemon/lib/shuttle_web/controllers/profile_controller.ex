defmodule ShuttleWeb.ProfileController do
  @moduledoc "Host-scoped VM profiling behind the endpoint's ordinary peer gate."
  use Phoenix.Controller, formats: [:json]

  def show(conn, params) do
    opts = if Map.get(params, "mode") == "cpu", do: [mode: :cpu], else: []

    case Shuttle.Profile.run(Map.get(params, "seconds"), opts) do
      {:ok, result} ->
        json(conn, result)

      {:error, :busy} ->
        conn |> put_status(409) |> json(%{error: "profile_in_progress"})

      {:error, reason} ->
        conn |> put_status(503) |> json(%{error: "profile_failed", reason: inspect(reason)})
    end
  end
end
