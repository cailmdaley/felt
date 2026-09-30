defmodule Shuttle.LifecycleService do
  @moduledoc """
  The daemon's side of the role lifecycle verbs `accept` and `resume`.

  felt is their one writer: `felt shuttle <verb> <fiber> --local` re-arms (or,
  for a pinned accept, re-parks) the role and concludes its run
  (`shuttle.runtime.handed_off_at = now`) in a single document write, so the
  poller never reads a re-armed role without the stamp that keeps its
  just-served occurrence from firing again.

  `/api/v1/lifecycle` and the kanban's `accept-run` transition both come
  through `transition/2`. With the Poller running, the write happens inside it
  (`Poller.lifecycle_transition/3`), serialized with the Poller's state
  changes, and the fiber's document-cache entry is refreshed after. A poll read
  already in flight (poll reads run in their own task) sees the old document or
  the new one, whose status and `handed_off_at` land in one atomic write.
  Without a Poller (a controller test, a restart window) it is shelled
  directly.
  """

  alias Shuttle.{FeltStores, Poller}

  @type verb :: :accept | :resume

  @spec transition(verb(), String.t()) ::
          Shuttle.Felt.result() | {:error, :timeout, String.t()}
  def transition(verb, identifier) when verb in [:accept, :resume] and is_binary(identifier) do
    with {:ok, %{store: felt_store, fiber_id: fiber_id}} <-
           FeltStores.resolve_fiber_or_error(identifier) do
      if is_pid(Process.whereis(Poller)) do
        Poller.lifecycle_transition(verb, fiber_id)
      else
        write(verb, fiber_id, felt_store: felt_store)
      end
    end
  end

  @doc """
  Shell `shuttle <verb> <fiber_id> --local`. `opts` go to
  `Shuttle.CLI.run_lifecycle/4` (`:felt_store`, `:runner`).
  """
  @spec write(verb(), String.t(), keyword()) :: Shuttle.Felt.result()
  def write(verb, fiber_id, opts) when verb in [:accept, :resume] do
    Shuttle.CLI.run_lifecycle(Atom.to_string(verb), fiber_id, [], opts)
  end
end
