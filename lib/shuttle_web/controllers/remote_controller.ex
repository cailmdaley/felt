defmodule ShuttleWeb.RemoteController do
  @moduledoc """
  Agent-API endpoint: POST /api/v1/remotes/:name/reset

  Resets a remote's tripped circuit breaker — the human "go" that lets the
  RemoteRegistry run its recovery cascade once more after `trip_threshold`
  failed revive attempts. The attempt counter is preserved, so one reset buys
  exactly one cascade (see `Shuttle.RemoteRegistry.reset_breaker/2`). The CLI
  verb `shuttle reset <remote>` posts here.

  Returns: 200  %{ok: true, remote: name}
           404  %{error: "unknown_remote"} when the name isn't configured
           409  %{error: "not_tripped"} when the breaker isn't tripped
           503  %{error: "registry_unavailable"} when no RemoteRegistry runs
  """

  use Phoenix.Controller, formats: [:json]

  def reset(conn, %{"name" => name}) do
    case reset_breaker(name) do
      :ok ->
        json(conn, %{ok: true, remote: name})

      {:error, :unknown_remote} ->
        conn
        |> put_status(:not_found)
        |> json(%{error: "unknown_remote", remote: name})

      {:error, :not_tripped} ->
        conn
        |> put_status(:conflict)
        |> json(%{error: "not_tripped", remote: name})

      {:error, reason} ->
        conn
        |> put_status(:service_unavailable)
        |> json(%{error: "registry_unavailable", reason: inspect(reason)})
    end
  end

  defp reset_breaker(name) do
    Shuttle.RemoteRegistry.reset_breaker(name)
  catch
    :exit, reason -> {:error, reason}
  end
end
