defmodule Shuttle.ActionQueries do
  @moduledoc """
  Fast, shared read path for Shuttle lifecycle action affordances.

  Action classification itself lives in `Shuttle.Actions`. This module owns the
  read-side composition needed to classify a fiber by id: resolve the felt
  document through the daemon-local document reader, derive live worker state
  from the process holding the execution its runtime names, and call the
  classifier. It deliberately avoids the
  Poller GenServer so action affordance reads do not wait behind scheduling,
  discovery, or reconciliation work.
  """

  alias Shuttle.{Actions, Continuation, FiberDocuments, Runner}

  @spec actions_for(String.t(), keyword()) :: {:ok, [map()]} | {:error, term()}
  def actions_for(fiber_id, opts \\ []) when is_binary(fiber_id) do
    with {:ok, fiber} <- fetch_fiber(fiber_id, opts) do
      {:ok, Actions.actions_for(fiber, running?(fiber, opts))}
    end
  end

  @spec resolve_action(String.t(), String.t(), keyword()) :: {:ok, map()} | {:error, term()}
  def resolve_action(fiber_id, target, opts \\ []) when is_binary(fiber_id) do
    with {:ok, fiber} <- fetch_fiber(fiber_id, opts) do
      Actions.resolve_transition(fiber, target, running?(fiber, opts))
    end
  end

  defp fetch_fiber(fiber_id, opts) do
    query_opts = Keyword.take(opts, [:felt_stores])

    case FiberDocuments.get(fiber_id, query_opts) do
      {:ok, %{fibers: [%{fiber: fiber} | _]}} when is_map(fiber) ->
        {:ok, fiber}

      {:ok, %{fibers: []}} ->
        {:error, :not_found}

      {:error, reason} ->
        {:error, reason}
    end
  end

  # An unobservable holder counts as running, as it does everywhere a worker
  # might be live.
  defp running?(fiber, opts) do
    case Continuation.execution(fiber) do
      nil ->
        false

      execution ->
        runner = Keyword.get(opts, :runner, default_runner())
        Shuttle.Tmux.worker_status(runner, Map.put(execution, :session, nil)) != :gone
    end
  end

  defp default_runner do
    Shuttle.Env.app(:action_query_runner, Runner.Default)
  end
end
