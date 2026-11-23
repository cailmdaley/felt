defmodule ShuttleWeb.DispatchController do
  @moduledoc """
  Agent-API endpoint: POST /api/v1/dispatch

  The single force/ad-hoc dispatch surface: the kanban's drag-to-In flight
  launch, the fiber page's New session action, and `shuttle dispatch`
  (internal/shuttlecli/daemon_verbs.go) all land here.

    * a request carrying `origin` — a remote-owned card — is forwarded by
      `Shuttle.OriginRouter` to the owning daemon's identical `/dispatch`
      (origin stripped), where the worker must run, and the response is relayed
      verbatim.

  Images pasted into the board's worker line ride as `images`; the owning
  daemon lands them on its host and names their paths in the message
  (`Shuttle.DispatchImages`).

  The kanban requeue carries the user's directive (`user_message`) and
  continuation mode (`resume_mode ∈ {"previous", "fresh", "continue"}` or
  absent) inline in the body; `Shuttle.Delivery.human/3` records the line and
  starts the worker with it, as for a human line through `/deliver`. A
  `from` (with `reply_to`) names the agent session that sent the directive
  (`shuttle dispatch --message` run inside a session): the line is that
  agent's, not the human's.
  `continue` lets the worker's state choose: typed into a live worker, else
  fresh after a clean handoff, else the session resumed or started cold. It is
  the board console's plain send. Both ride the dispatch call into the prompt at launch; the remote
  forward passes `conn.body_params` verbatim, so they survive owner-routing
  intact.

  A forced start never runs a worker in the felt store. `project_dir` is a
  directory the human confirmed: the owning daemon resolves it on its host
  (`shuttle resolve-dir`), then saves it and arms the fiber in one write
  (`shuttle reopen --project-dir`), and the worker starts in the directory the
  CLI saved. Nothing supplies a directory on the human's behalf: a forced start
  of a block without one answers 422 `arm_refused` with `needs: "project_dir"`.

  A remote `shuttle dispatch` carries the caller's copy of the constitution as
  `document` (the raw fiber file text, with `fiber_path` as its address hint),
  and `carry: true` to insist on it. The owner adopts it before dispatching
  (`Shuttle.CarriedDocument`): a copy this host already holds stands unless
  `carry` is set, and any other copy takes the caller's document. adopt's
  output rides back as `carried` when it said anything. A carried request for a
  fiber this host lacks answers 404 `reason` and `error_code`
  `"fiber_not_found"` with this host's id, and an adopt refusal answers 422
  `adopt_refused` without dispatching.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [relay_json: 3]

  alias Shuttle.{CarriedDocument, OriginRouter}

  def create(conn, params) do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:error, {:unknown_origin, origin}} ->
        ShuttleWeb.RelayHelpers.unknown_origin(conn, origin)

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
    force = truthy?(Map.get(params, "force", false))
    ad_hoc = truthy?(Map.get(params, "ad_hoc", false))

    message = normalize_text(Map.get(params, "user_message"))

    with :ok <- if(is_nil(fiber_id), do: {:error, "fiber_id is required"}, else: :ok),
         {:ok, carried} <- CarriedDocument.adopt(params, fiber_id),
         {:ok, message} <- Shuttle.DispatchImages.attach(message, Map.get(params, "images")) do
      result =
        Shuttle.Delivery.human(fiber_id, message,
          from: normalize_text(params["from"]),
          reply_to: normalize_text(params["reply_to"]),
          message_id: params["message_id"],
          resume_mode: normalize_resume_mode(Map.get(params, "resume_mode")),
          force: force or ad_hoc,
          ad_hoc: ad_hoc,
          existing_only: truthy?(Map.get(params, "existing_only", false)),
          release_launch_reservation:
            truthy?(Map.get(params, "release_launch_reservation", false)),
          project_dir: normalize_text(Map.get(params, "project_dir"))
        )

      {status, body} = ShuttleWeb.DispatchReply.render(fiber_id, result)
      conn |> put_status(status) |> json(with_carried(body, carried))
    else
      {:error, :not_found, reason} ->
        conn
        |> put_status(404)
        |> json(%{
          dispatched: false,
          reason: "fiber_not_found",
          fiber_id: fiber_id,
          error_code: "fiber_not_found",
          host: Shuttle.Poller.own_host_id(),
          fiber: fiber_id,
          error: reason
        })

      {:error, kind, reason} when kind in [:timeout, :unavailable] ->
        conn
        |> put_status(503)
        |> json(%{
          dispatched: false,
          reason: "adopt_uncertain",
          fiber_id: fiber_id,
          error: reason,
          retryable: true
        })

      {:command_error, status, output} ->
        conn
        |> put_status(422)
        |> json(%{
          dispatched: false,
          reason: "adopt_refused",
          fiber_id: fiber_id,
          error: "shuttle exited #{status}: #{String.trim(output)}"
        })

      {:error, reason} ->
        conn |> put_status(400) |> json(%{error: reason})
    end
  end

  defp with_carried(body, ""), do: body
  defp with_carried(body, carried), do: Map.put(body, :carried, String.trim_trailing(carried))

  defp dispatch_failed(name, reason),
    do: %{dispatched: false, reason: "forward_failed", origin: name, error: inspect(reason)}

  defp truthy?(value) when value in [true, "true", "1", 1], do: true
  defp truthy?(_), do: false

  # A blank string is no value — the From User block renders only for real
  # content, and a blank project_dir confirms nothing. Non-strings collapse to
  # nil.
  defp normalize_text(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      _ -> value
    end
  end

  defp normalize_text(_), do: nil

  # resume_mode ∈ {"previous", "fresh", "continue"} or absent (→ marker-decided).
  # Anything else is ignored (treated as absent) so a malformed param degrades
  # to the autonomous heuristic rather than a hard error.
  defp normalize_resume_mode(mode) when mode in ["previous", "fresh", "continue"], do: mode
  defp normalize_resume_mode(_), do: nil
end
