defmodule ShuttleWeb.StateController do
  @moduledoc """
  Agent-API endpoints for orchestrator state.

  * `GET /api/v1/state` — full local state (running workers, blocked and
    parked dispatches, standing constitutions).

  * `GET /api/v1/state/composite` — local state plus per-origin remote
    snapshots, for a hub's cross-host view.
  """

  use Phoenix.Controller, formats: [:json]

  # `:httpc` failure reasons are erlang terms (often tuples); `render_error/1`
  # makes them strings so the JSON encoder need not know about them.
  import ShuttleWeb.TemporalComposite, only: [format_dt: 1, render_error: 1]

  # Remote snapshots retain a bounded mailbox read for a degraded composite.
  @state_timeout_ms 1_500

  def show(conn, _params) do
    Shuttle.Poller.record_state_request(Shuttle.Env.server(Shuttle.Poller))
    validators = get_req_header(conn, "if-none-match")

    case Shuttle.Poller.published_state_response(
           Shuttle.Env.server(Shuttle.Poller),
           validators
         ) do
      {:ok, response} ->
        conn
        |> state_headers(response)
        |> send_resp(:ok, response.body)

      {:not_modified, response} ->
        conn
        |> state_headers(response)
        |> send_resp(:not_modified, "")

      {:error, reason} ->
        conn
        |> put_status(:service_unavailable)
        |> json(%{
          host: Shuttle.Poller.own_host_id(),
          error: "poller_unavailable",
          reason: render_error(reason),
          ready: false,
          eligible: [],
          blocked: [],
          running: [],
          running_detail: []
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

    ShuttleWeb.ConditionalJSON.send(conn, body)
  end

  # Render remotes as a JSON-friendly map. `last_polled_at` is a
  # DateTime — serialize as an ISO8601 string for the kanban frontend.
  defp render_remotes(remotes) do
    Map.new(remotes, fn {name, entry} ->
      {name, render_entry(entry)}
    end)
  end

  defp state_headers(conn, response) do
    conn
    |> put_resp_content_type("application/json")
    |> put_resp_header("etag", response.etag)
    |> put_resp_header("cache-control", "no-cache")
    |> put_resp_header("x-state-generation", Integer.to_string(response.generation))
    |> put_resp_header("x-state-age-ms", Integer.to_string(response.age_ms))
  end

  defp state_timeout_ms,
    do: Shuttle.Env.app(:state_call_timeout_ms, @state_timeout_ms)

  defp local_snapshot do
    Shuttle.Poller.snapshot(Shuttle.Env.server(Shuttle.Poller), state_timeout_ms())
  catch
    :exit, reason ->
      %{
        host: Shuttle.Poller.own_host_id(),
        error: "poller_unavailable",
        reason: render_error(reason),
        eligible: [],
        blocked: [],
        running: []
      }
  end

  defp remote_snapshots do
    Shuttle.RemoteRegistry.snapshots(
      Shuttle.Env.server(Shuttle.RemoteRegistry),
      state_timeout_ms()
    )
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
end
