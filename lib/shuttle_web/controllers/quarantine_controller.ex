defmodule ShuttleWeb.QuarantineController do
  @moduledoc """
  Agent-API endpoint: POST /api/v1/quarantine/release

  Releases the Poller's boot quarantine — the human "go" that restores fresh
  launch authority to a restarted daemon. A restart parks fresh autonomous
  launches (`pending_launch` in the state snapshot) while dirty-death resumes
  stay automatic; release is pure manual, and this is the release. Idempotent.

  Returns: 200  %{ok: true, boot_quarantine: false}
           503  %{error: "poller_unavailable"} when no Poller is running
  """

  use Phoenix.Controller, formats: [:json]

  def create(conn, _params) do
    case release() do
      :ok ->
        json(conn, %{ok: true, boot_quarantine: false})

      {:error, reason} ->
        conn
        |> put_status(:service_unavailable)
        |> json(%{error: "poller_unavailable", reason: inspect(reason)})
    end
  end

  defp release do
    Shuttle.Poller.release_boot_quarantine()
  catch
    :exit, reason -> {:error, reason}
  end
end
