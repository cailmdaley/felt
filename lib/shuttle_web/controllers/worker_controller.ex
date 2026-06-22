defmodule ShuttleWeb.WorkerController do
  @moduledoc """
  Agent-API endpoint: GET /api/v1/workers/:fiber_id

  Returns whether a worker is running on the given fiber, with runtime metadata.
  """

  use Phoenix.Controller, formats: [:json]

  def show(conn, %{"fiber_id" => fiber_id}) do
    fiber_id = normalize_fiber_id(fiber_id)

    case Shuttle.Poller.worker_status(fiber_id) do
      nil ->
        json(conn, %{fiber_id: fiber_id, running: false})

      worker ->
        json(conn, %{
          fiber_id: fiber_id,
          running: true,
          agent: worker.agent_id,
          started_at: DateTime.to_unix(worker.started_at, :millisecond),
          last_activity_at: DateTime.to_unix(worker.last_activity_at, :millisecond),
          runtime_seconds: runtime(worker.started_at)
        })
    end
  end

  defp runtime(nil), do: 0

  defp runtime(%DateTime{} = started_at) do
    max(0, DateTime.diff(DateTime.utc_now(), started_at, :second))
  end

  defp normalize_fiber_id(fiber_id) when is_list(fiber_id), do: Enum.join(fiber_id, "/")
  defp normalize_fiber_id(fiber_id) when is_binary(fiber_id), do: fiber_id
end
