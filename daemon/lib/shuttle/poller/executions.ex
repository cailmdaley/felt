defmodule Shuttle.Poller.Executions do
  @moduledoc """
  Which fiber a live terminal worker serves, derived from fiber runtimes and
  the process table alone.

  A terminal launch pre-assigns its conversation UUID and names it in its
  fiber's `shuttle.runtime` before the worker starts. A fiber is *assigned*
  an execution while its runtime names it (a UUID, or the pane a claim bound)
  and its dispatch is unconcluded (`Shuttle.Continuation.execution/1`); the
  dispatch generation is `dispatched_at`. The worker is whatever process
  holds that execution (`Shuttle.WorkerProcess.find/3`). tmux session names
  label workers for display and attach; they never decide ownership.

  Nothing here is persisted. Each answer is derived from the documents and
  the process table at the moment it is asked, so a hold clears itself as
  soon as either changes.

  Two or more live fibers assigned one execution — the shape an older build's
  claim could leave — is *shared*: no fiber is adopted onto it, no stop
  signals it, and no dispatch resumes it, until its holder exits or all but
  one of the fibers are concluded.
  """

  alias Shuttle.{Continuation, Poller, WorkerBackend, WorkerProcess}
  alias Shuttle.Poller.State

  @doc """
  The execution `fiber`'s runtime assigns, as a terminal handle
  `%{session, uuid, pane, generation}`, or nil when it names none.
  """
  @spec handle(map(), String.t() | nil) :: map() | nil
  def handle(fiber, session \\ nil) do
    case Continuation.execution(fiber) do
      nil -> nil
      execution -> execution |> Map.put(:session, session) |> Map.put(:uid, fiber["uid"])
    end
  end

  @doc "True when two handles name the same execution: one UUID, or one bound pane."
  @spec same?(map() | nil, map() | nil) :: boolean()
  def same?(%{} = a, %{} = b) do
    (is_binary(a[:uuid]) and a[:uuid] == b[:uuid]) or (is_map(a[:pane]) and a[:pane] == b[:pane])
  end

  def same?(_, _), do: false

  @doc """
  True when tracked worker `meta` runs the execution `handle` names: by its
  launch's UUID or pane, or by the conversation its UUID now continues as
  after a `/clear` or `/resume` (`:session_uuid`).
  """
  @spec runs?(map(), map()) :: boolean()
  def runs?(meta, handle) do
    not Shuttle.AppWorkers.app?(meta.session) and
      (same?(WorkerBackend.handle(meta), handle) or
         (is_binary(handle[:uuid]) and Map.get(meta, :session_uuid) == handle[:uuid]))
  end

  @doc """
  The other fibers assigned the execution `handle` names, besides `fiber_id`:
  tracked workers holding it, and polled live fibers whose runtime names it.
  A polled fiber this daemon tracks counts by its tracked execution, which is
  current, rather than by its polled runtime.
  """
  @spec sharers(%State{}, String.t(), map()) :: [String.t()]
  def sharers(%State{} = state, fiber_id, handle) do
    tracked =
      for {_key, meta} <- state.running,
          id = Poller.fiber_address(meta),
          id != fiber_id,
          runs?(meta, handle),
          do: id

    listed =
      for fiber <- listed(state),
          fiber["id"] != fiber_id,
          fiber["status"] != "closed",
          Poller.running_key(state, fiber["id"]) == nil,
          same?(handle(fiber), handle),
          do: fiber["id"]

    Enum.uniq(tracked ++ listed)
  end

  @doc """
  True when another live fiber is assigned the execution `fiber` names, so it
  must not be resumed.
  """
  @spec shared?(%State{}, map()) :: boolean()
  def shared?(%State{} = state, fiber) do
    case handle(fiber) do
      nil -> false
      handle -> sharers(state, fiber["id"], handle) != []
    end
  end

  @doc """
  The live worker of `fiber` that this daemon does not track, from a fresh
  read of the fiber: `{:ok, handle}` with the holder's current tmux session
  as `:session` (nil when tmux cannot show it), `nil` when nothing holds its
  execution, `:unknown` when the process table cannot say, and `{:shared,
  ids}` when a live holder serves other fibers assigned the same execution
  too. A shared execution nothing holds is nobody's worker: `nil`.
  """
  @spec untracked(%State{}, map()) :: {:ok, map()} | nil | :unknown | {:shared, [String.t()]}
  def untracked(%State{} = state, fiber) do
    with %{} = handle <- handle(fiber),
         {:ok, procs} <- WorkerProcess.scan(state.runner) do
      case WorkerProcess.find(procs, handle, state.runner) do
        nil ->
          nil

        {:error, :unknown} ->
          :unknown

        proc ->
          case sharers(state, fiber["id"], handle) do
            [] -> {:ok, %{handle | session: session_of(state.runner, procs, proc)}}
            ids -> {:shared, ids}
          end
      end
    else
      nil -> nil
      {:error, :unknown} -> :unknown
    end
  end

  @doc "The tmux session currently showing holder `proc`, or nil."
  @spec session_of(module(), [WorkerProcess.proc()], WorkerProcess.proc()) :: String.t() | nil
  def session_of(runner, procs, proc) do
    with {:ok, panes} <- WorkerProcess.panes(runner),
         %{session: session} <- WorkerProcess.pane_of(procs, panes, proc) do
      session
    else
      _ -> nil
    end
  end

  @doc "Every host-owned fiber row in the poll's last listings, once each."
  @spec listed(%State{}) :: [map()]
  def listed(%State{} = state) do
    for rows <- Map.values(state.last_known_listings),
        fiber <- rows,
        Poller.host_owned?(fiber["shuttle"] || %{}, state.own_host_id),
        uniq: true,
        do: fiber
  end
end
