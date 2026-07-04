defmodule ShuttleWeb.DispatchController do
  @moduledoc """
  Agent-API endpoint: POST /api/v1/dispatch

  Dispatches a worker. Two callers:

    * the `confer` pattern — Worker A asks Shuttle to dispatch Worker B and
      subscribes to `shuttle:worker:<fiber_id>` for exit notification. No
      `origin`, so it always runs locally (the channel is on this daemon).
    * the kanban's requeue verb — re-dispatch a remote-owned card. It carries
      the `origin` the composite board stamped, so `Shuttle.OriginRouter`
      forwards to the owning daemon's identical `/dispatch` (origin stripped),
      where the worker must run, and relays the response verbatim.

  STORE 3 — the kanban requeue carries the user's directive (`user_message`) and
  continuation mode (`resume_mode ∈ {"previous", "fresh"}` or absent) inline in
  the body, replacing the prior file-a-review-comment-then-dispatch two-step.
  Both ride the dispatch call into the prompt at launch; the remote forward
  passes `conn.body_params` verbatim, so they survive owner-routing intact.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [relay_json: 3]

  alias Shuttle.OriginRouter

  def create(conn, params) do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_json(
          conn,
          OriginRouter.forward(remote, "/api/v1/dispatch", conn.body_params),
          &dispatch_failed/2
        )

      :local ->
        create_local(conn, params)
    end
  end

  defp create_local(conn, params) do
    fiber_id = Map.get(params, "fiber_id")
    notify_on_exit = Map.get(params, "notify_on_exit", false)
    force = truthy?(Map.get(params, "force", false))
    ad_hoc = truthy?(Map.get(params, "ad_hoc", false))

    if is_nil(fiber_id) do
      conn
      |> put_status(400)
      |> json(%{error: "fiber_id is required"})
    else
      case Shuttle.Poller.dispatch_fiber(fiber_id,
             notify_on_exit: notify_on_exit,
             force: force or ad_hoc,
             ad_hoc: ad_hoc,
             # STORE 3: the directive + continuation mode ride the dispatch.
             user_message: normalize_message(Map.get(params, "user_message")),
             resume_mode: normalize_resume_mode(Map.get(params, "resume_mode"))
           ) do
        {:ok, session} ->
          # A forced dispatch may have re-armed the doc (status:active). Re-read it
          # into the document cache so the board's post-dispatch refetch moves the
          # card to inFlight immediately rather than after the next poll.
          Shuttle.Poller.refresh_document(fiber_id)

          json(conn, %{
            dispatched: true,
            fiber_id: fiber_id,
            tmux_session: session,
            notify_on_exit: notify_on_exit,
            channel_topic: "shuttle:worker:#{fiber_id}"
          })

        {:error, :already_running} ->
          conn
          |> put_status(409)
          |> json(already_running_body(fiber_id))

        {:error, :not_eligible} ->
          conn
          |> put_status(422)
          |> json(%{dispatched: false, reason: "not_eligible", fiber_id: fiber_id})

        {:error, {:not_eligible, detail}} ->
          conn
          |> put_status(422)
          |> json(
            Map.merge(
              %{dispatched: false, reason: "not_eligible", fiber_id: fiber_id},
              ineligible_detail(detail)
            )
          )

        {:error, {:awaiting_review, run_id, completed_at}} ->
          conn
          |> put_status(422)
          |> json(%{
            dispatched: false,
            reason: "awaiting_review",
            fiber_id: fiber_id,
            run_id: run_id,
            completed_at: completed_at,
            message:
              "This role is awaiting review#{review_detail(run_id, completed_at)}. Accept first with `felt shuttle accept #{fiber_id}`, or use `felt shuttle resume #{fiber_id}` to continue the same run."
          })

        {:error, reopen} when reopen in [:reopen_unavailable, :reopen_failed] ->
          conn
          |> put_status(422)
          |> json(%{
            dispatched: false,
            reason: to_string(reopen),
            fiber_id: fiber_id,
            message:
              "Could not reopen the closed fiber — no worker was spawned. " <>
                "Reopen it (`felt shuttle reopen #{fiber_id}`) and try again."
          })

        {:error, reason} ->
          conn
          |> put_status(500)
          |> json(%{dispatched: false, reason: inspect(reason), fiber_id: fiber_id})
      end
    end
  end

  defp dispatch_failed(name, reason),
    do: %{dispatched: false, reason: "forward_failed", origin: name, error: inspect(reason)}

  defp already_running_body(fiber_id) do
    base = %{dispatched: false, reason: "already_running", fiber_id: fiber_id}

    case Shuttle.Poller.worker_status(fiber_id) do
      %{session: session} = worker when is_binary(session) and session != "" ->
        Map.merge(base, %{
          tmux_session: session,
          agent: Map.get(worker, :agent_id),
          started_at: maybe_unix_ms(Map.get(worker, :started_at)),
          last_activity_at: maybe_unix_ms(Map.get(worker, :last_activity_at))
        })

      _ ->
        base
    end
  end

  defp maybe_unix_ms(%DateTime{} = dt), do: DateTime.to_unix(dt, :millisecond)
  defp maybe_unix_ms(_), do: nil

  defp truthy?(value) when value in [true, "true", "1", 1], do: true
  defp truthy?(_), do: false

  # A blank message is no message — the From User block renders only for real
  # content. Non-strings collapse to nil.
  defp normalize_message(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      _ -> value
    end
  end

  defp normalize_message(_), do: nil

  # resume_mode ∈ {"previous", "fresh"} or absent (→ marker-decided). Anything
  # else is ignored (treated as absent) so a malformed param degrades to the
  # autonomous heuristic rather than a hard error.
  defp normalize_resume_mode(mode) when mode in ["previous", "fresh"], do: mode
  defp normalize_resume_mode(_), do: nil

  # Turns a structured ineligibility detail into a stable `detail` code plus a
  # human `message`. The kanban renders `detail` to accurate copy and falls
  # back to `message`; both beat the old flat "not_eligible".
  defp ineligible_detail({:homed_elsewhere, fiber_host, own_host}) do
    %{
      detail: "homed_elsewhere",
      fiber_host: fiber_host,
      daemon_host: own_host,
      message:
        "This fiber is homed on #{describe_host(fiber_host)} and can only run there. " <>
          "The daemon that received this dispatch is #{describe_host(own_host)}."
    }
  end

  defp ineligible_detail({:project_dir_missing, dir}) do
    %{
      detail: "project_dir_missing",
      project_dir: dir,
      message:
        "The fiber's project_dir (#{describe_host(dir)}) does not exist on the owning host."
    }
  end

  defp ineligible_detail(:disabled),
    do: %{detail: "disabled", message: "Draft — set status: active to allow dispatch."}

  defp ineligible_detail(:closed),
    do: %{detail: "closed", message: "Fiber is closed — reopen it before dispatching."}

  defp ineligible_detail(:human_worker),
    do: %{detail: "human_worker", message: "Human-worker fiber — there is nothing to dispatch."}

  defp ineligible_detail(:no_shuttle_block),
    do: %{detail: "no_shuttle_block", message: "Fiber has no shuttle: block to dispatch."}

  defp ineligible_detail(:not_due_or_blocked),
    do: %{
      detail: "not_due_or_blocked",
      message: "Not currently dispatchable — not yet due, or blocked by an unmet dependency."
    }

  defp ineligible_detail(other),
    do: %{detail: to_string(other)}

  defp describe_host(value) when is_binary(value) and value != "", do: value
  defp describe_host(_), do: "(unset)"

  defp review_detail(run_id, completed_at) do
    parts =
      [
        if(is_binary(run_id) and run_id != "", do: "run #{run_id}"),
        if(is_binary(completed_at) and completed_at != "", do: "completed #{completed_at}")
      ]
      |> Enum.reject(&is_nil/1)

    case parts do
      [] -> ""
      _ -> " (" <> Enum.join(parts, ", ") <> ")"
    end
  end
end
