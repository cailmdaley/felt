defmodule ShuttleWeb.DispatchReply do
  @moduledoc """
  The HTTP status and JSON body for a local `Shuttle.Poller.dispatch_fiber/2`
  result. `/dispatch` and `/deliver` both launch through the Poller and answer
  with the same envelope, so a client reads one vocabulary of launch outcomes.
  """

  import ShuttleWeb.RelayHelpers, only: [app_server_unavailable_message: 0]
  require Shuttle.Dispatcher

  @spec render(String.t(), term()) :: {pos_integer(), map()}
  def render(fiber_id, {:ok, session}) do
    # A forced dispatch may have re-armed the doc (status:active). Re-read it
    # into the document cache so the board's post-dispatch refetch moves the
    # card to inFlight immediately rather than after the next poll.
    Shuttle.Poller.refresh_document(fiber_id)

    # WHICH session this dispatch started. The tmux session name is
    # `<leaf>-<uid>-shuttle` — keyed on the FIBER's uid, so it is byte-for-byte
    # identical before and after a fresh dispatch and cannot distinguish the
    # new session from the one it replaced. The runtime UUID can: it is
    # stamped synchronously at launch for a Claude worker, and the refresh
    # above just re-read it off disk. `nil` for a codex/pi worker (scraped
    # and backfilled seconds later) — a client then falls back to comparing
    # against the value it saw before dispatching.
    {200,
     Map.merge(
       %{
         dispatched: true,
         fiber_id: fiber_id,
         session_uuid: Shuttle.Poller.session_uuid(fiber_id)
       },
       Shuttle.WorkerBackend.wire(session)
     )}
  end

  def render(fiber_id, {:error, {:app_launch_failed, id, :app_server_unavailable}}),
    do: app_server_unavailable(fiber_id, %{session_uuid: id})

  def render(_fiber_id, {:error, {:app_launch_failed, id, reason}}) do
    {502,
     %{
       dispatched: false,
       surface: "app",
       session_uuid: id,
       tmux_session: nil,
       reason: "app_launch_failed",
       error: inspect(reason),
       message:
         "The conversation was created, but its turn could not be confirmed. Inspect this same conversation before retrying."
     }}
  end

  def render(fiber_id, {:error, :app_server_unavailable}), do: app_server_unavailable(fiber_id)

  def render(fiber_id, {:error, :already_running}), do: {409, already_running_body(fiber_id)}

  def render(fiber_id, {:error, :not_eligible}),
    do: {422, %{dispatched: false, reason: "not_eligible", fiber_id: fiber_id}}

  def render(fiber_id, {:error, {:not_eligible, detail}}) do
    {422,
     Map.merge(
       %{dispatched: false, reason: "not_eligible", fiber_id: fiber_id},
       ineligible_detail(detail)
     )}
  end

  def render(fiber_id, {:error, :reopen_failed}) do
    {422,
     %{
       dispatched: false,
       reason: "reopen_failed",
       fiber_id: fiber_id,
       message:
         "Could not reopen the closed fiber — no worker was spawned. " <>
           "Reopen it (`felt shuttle reopen #{fiber_id}`) and try again."
     }}
  end

  # A dispatch preflight refused before anything spawned
  # (`Shuttle.Dispatcher.refusal?/2`): the agent's wrapper does not resolve in
  # the login bash the worker launches through, the work directory is not on
  # this host, (macOS) there is no tmux server the daemon is allowed to fork
  # under, or the session a resume targets is still open in another process.
  # None is a server fault, so 422 with the message that names the thing and
  # the fix. No worker was spawned.
  def render(fiber_id, {:error, {tag, message}}) when Shuttle.Dispatcher.refusal?(tag, message) do
    {422,
     %{
       dispatched: false,
       reason: to_string(tag),
       fiber_id: fiber_id,
       message: message
     }}
  end

  def render(fiber_id, {:error, reason}),
    do: {500, %{dispatched: false, reason: inspect(reason), fiber_id: fiber_id}}

  defp already_running_body(fiber_id) do
    base = %{dispatched: false, reason: "already_running", fiber_id: fiber_id}

    case Shuttle.Poller.worker_status(fiber_id) do
      %{session: session} = worker when is_binary(session) and session != "" ->
        Map.merge(Map.merge(base, Shuttle.WorkerBackend.wire(session)), %{
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

  defp app_server_unavailable(fiber_id, extra \\ %{}) do
    {503,
     Map.merge(
       %{
         dispatched: false,
         surface: "app",
         fiber_id: fiber_id,
         tmux_session: nil,
         reason: "app_server_unavailable",
         message: app_server_unavailable_message()
       },
       extra
     )}
  end

  # Turns a structured ineligibility detail into a stable `detail` code plus a
  # human `message`. The kanban renders `detail` to accurate copy and falls
  # back to `message`.
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

  defp ineligible_detail(:no_shuttle_block),
    do: %{detail: "no_shuttle_block", message: "Fiber has no shuttle: block to dispatch."}

  defp ineligible_detail(:not_due_or_blocked),
    do: %{
      detail: "not_due_or_blocked",
      message: "Not currently dispatchable — not yet due, or held by another gate."
    }

  defp ineligible_detail(other),
    do: %{detail: to_string(other)}

  defp describe_host(value) when is_binary(value) and value != "", do: value
  defp describe_host(_), do: "(unset)"
end
