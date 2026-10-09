defmodule Shuttle.LifecycleService do
  @moduledoc """
  The daemon's serialized writers for `accept`, `resume`, `rest`, `seat`
  and worker-question clearing.

  `:clear_ask` shells `shuttle ask <fiber> --clear` through the same serialized
  write and document-cache refresh path as `accept` and `resume`.

  Seat edits share the Poller's write boundary so they cannot overwrite a
  concurrent worker-exit lifecycle write.

  Shuttle is their writer: `shuttle -C <store> <verb> <fiber> --local`.
  For accept/resume/rest, it re-arms
  the constitution (accept, resume) or puts it in Resting (rest), and
  concludes its run (`shuttle.runtime.handed_off_at = now`) in a single
  document write, so the poller never reads a re-armed constitution without
  the stamp that keeps its just-served occurrence from firing again. A rest
  then stops any live worker through the Poller's backend-aware stop, the one
  `/kill` uses, so an app conversation is interrupted as a tmux worker is.

  `/api/v1/lifecycle` and the kanban's `accept-run` transition both come
  through `transition/3`. With the Poller running, the write happens inside it
  (`Poller.lifecycle_transition/4`), serialized with the Poller's state
  changes, and the fiber's document-cache entry is refreshed after. A poll read
  already in flight (poll reads run in their own task) sees the old document or
  the new one, whose status and `handed_off_at` land in one atomic write.
  Without a Poller (a controller test, a restart window) it is shelled
  directly.
  """

  alias Shuttle.{FeltStores, Poller}

  @type verb :: :accept | :resume | :rest | :seat | :clear_ask

  @spec transition(verb(), String.t(), [String.t()]) ::
          Shuttle.Felt.result() | {:error, :timeout, String.t()}
  def transition(verb, identifier, args \\ [])
      when verb in [:accept, :resume, :rest, :seat, :clear_ask] and is_binary(identifier) do
    with {:ok, %{store: felt_store, fiber_id: fiber_id}} <-
           FeltStores.resolve_fiber_or_error(identifier) do
      if is_pid(GenServer.whereis(Shuttle.Env.server(Poller))) do
        Poller.lifecycle_transition(Shuttle.Env.server(Poller), verb, fiber_id, args)
      else
        write(verb, fiber_id, felt_store: felt_store, args: args)
      end
    end
  end

  @doc """
  Shell `shuttle -C <store> <verb> <fiber_id> --local`. `opts` go to
  `Shuttle.CLI.run_lifecycle/4` (`:felt_store`, `:runner`); `:args` carries
  verb-specific arguments such as a seat's role or `--clear`.
  """
  @spec write(verb(), String.t(), keyword()) :: Shuttle.Felt.result()
  def write(:clear_ask, fiber_id, opts) do
    opts = Keyword.delete(opts, :args)
    Shuttle.CLI.run_lifecycle("ask", fiber_id, ["--clear"], opts)
  end

  def write(verb, fiber_id, opts) when verb in [:accept, :resume, :rest, :seat] do
    {args, opts} = Keyword.pop(opts, :args, [])
    Shuttle.CLI.run_lifecycle(Atom.to_string(verb), fiber_id, args, opts)
  end
end
