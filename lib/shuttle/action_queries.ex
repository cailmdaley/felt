defmodule Shuttle.ActionQueries do
  @moduledoc """
  Fast, shared read path for Shuttle lifecycle action affordances.

  Action classification itself lives in `Shuttle.Actions`. This module owns the
  read-side composition needed to classify a fiber by id: resolve the felt
  document through the daemon-local document reader, derive live worker state
  from tmux session names, and call the classifier. It deliberately avoids the
  Poller GenServer so action affordance reads do not wait behind scheduling,
  discovery, or reconciliation work.
  """

  alias Shuttle.{Actions, Dispatcher, FiberDocuments, Runner}

  @type query_result :: {:ok, map()} | {:error, term()}

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

  @spec fetch_fiber(String.t(), keyword()) :: query_result()
  def fetch_fiber(fiber_id, opts \\ []) when is_binary(fiber_id) do
    query_opts = Keyword.take(opts, [:felt_stores, :with_body])

    case FiberDocuments.get(fiber_id, query_opts) do
      {:ok, %{fibers: [%{fiber: fiber} | _]}} when is_map(fiber) ->
        {:ok, fiber}

      {:ok, %{fibers: []}} ->
        {:error, :not_found}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp running?(fiber, opts) do
    case Keyword.fetch(opts, :running) do
      {:ok, value} -> value == true
      :error -> is_binary(live_session(fiber, opts))
    end
  end

  defp live_session(fiber, opts) do
    fiber
    |> fiber_address()
    |> Dispatcher.session_names(fiber_uid(fiber))
    |> Enum.find(&session_live?(&1, opts))
  end

  defp session_live?(session, opts) do
    runner = Keyword.get(opts, :runner, default_runner())
    Shuttle.Tmux.present?(runner, session)
  end

  defp fiber_uid(fiber) do
    case Map.get(fiber, "uid") do
      uid when is_binary(uid) and uid != "" -> uid
      _ -> nil
    end
  end

  defp fiber_address(fiber) do
    case Map.get(fiber, "slug") || Map.get(fiber, "id") do
      address when is_binary(address) and address != "" -> address
      _ -> ""
    end
  end

  defp default_runner do
    Application.get_env(:shuttle, :action_query_runner, Runner.Default)
  end
end
