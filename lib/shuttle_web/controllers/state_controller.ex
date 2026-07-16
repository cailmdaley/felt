defmodule ShuttleWeb.StateController do
  @moduledoc """
  Agent-API endpoints for orchestrator state.

  * `GET /api/v1/state` — full local state (running workers, retry
    queue, waiters).

  * `GET /api/v1/state/composite` — local state plus per-origin remote
    snapshots, for the laptop's cross-host kanban view. See
    [[constitution-shuttle-remote-dispatch]].
  """

  use Phoenix.Controller, formats: [:json]

  @state_timeout_ms 1_500

  def show(conn, _params) do
    case poller_state() do
      {:ok, state} ->
        json(conn, state)

      {:error, reason} ->
        conn
        |> put_status(:service_unavailable)
        |> json(%{
          host: Shuttle.Poller.own_host_id(),
          error: "poller_unavailable",
          reason: render_error(reason),
          eligible: [],
          blocked: [],
          retrying: [],
          running: [],
          running_detail: [],
          waiters: []
        })
    end
  end

  def composite(conn, _params) do
    local = local_snapshot()
    remotes = remote_snapshots()

    body = %{
      local: local,
      remotes: render_remotes(remotes)
    }

    json(conn, body)
  end

  # Render remotes as a JSON-friendly map. `last_polled_at` is a
  # DateTime — serialize as an ISO8601 string for the kanban frontend.
  defp render_remotes(remotes) when is_map(remotes) do
    Map.new(remotes, fn {name, entry} ->
      {name, render_entry(entry)}
    end)
  end

  defp render_remotes(_), do: %{}

  defp poller_state do
    {:ok, Shuttle.Poller.orchestrator_state(Shuttle.Poller, @state_timeout_ms)}
  catch
    :exit, reason -> {:error, reason}
  end

  defp local_snapshot do
    Shuttle.Poller.snapshot(Shuttle.Poller, @state_timeout_ms)
  catch
    :exit, reason ->
      %{
        host: Shuttle.Poller.own_host_id(),
        error: "poller_unavailable",
        reason: render_error(reason),
        eligible: [],
        blocked: [],
        retrying: [],
        running: []
      }
  end

  defp remote_snapshots do
    Shuttle.RemoteRegistry.snapshots(Shuttle.RemoteRegistry, @state_timeout_ms)
  catch
    :exit, reason ->
      %{
        "_registry" => %{
          snapshot: nil,
          stale: true,
          last_error: reason,
          recovery: %{state: :unavailable, attempt: 0, last_error: reason}
        }
      }
  end

  defp render_entry(%{} = entry) do
    %{
      snapshot: Map.get(entry, :snapshot),
      last_polled_at: format_dt(Map.get(entry, :last_polled_at)),
      stale: Map.get(entry, :stale, true),
      last_error: render_error(Map.get(entry, :last_error)),
      recovery: render_recovery(Map.get(entry, :recovery))
    }
  end

  defp format_dt(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  defp format_dt(_), do: nil

  defp render_recovery(%{} = recovery) do
    %{
      state: recovery |> Map.get(:state, :healthy) |> to_string(),
      attempt: Map.get(recovery, :attempt, 0),
      last_error: render_error(Map.get(recovery, :last_error)),
      last_action: Map.get(recovery, :last_action),
      next_retry_at: format_dt(Map.get(recovery, :next_retry_at))
    }
  end

  defp render_recovery(_), do: nil

  # `:httpc` failure reasons are erlang terms (often tuples). Render as
  # a string so the JSON encoder doesn't need to know about them.
  defp render_error(nil), do: nil
  defp render_error(reason) when is_binary(reason), do: reason
  defp render_error(reason) when is_atom(reason), do: to_string(reason)
  defp render_error(reason), do: inspect(reason)
end
