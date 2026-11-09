defmodule Shuttle.LifecycleService do
  @moduledoc """
  The daemon's serialized writers for `resume`, `reopen`, `close`, `pause`, `rest`, `role`, `seat`
  and worker-question clearing.

  `:clear_ask` shells `shuttle ask <fiber> --clear` through the same serialized
  write and document-cache refresh path as `resume`.

  Role and seat edits share the Poller's write boundary so they cannot overwrite a
  concurrent worker-exit lifecycle write.

  Shuttle is their writer: `shuttle -C <store> <verb> <fiber> --local`.
  Resume arms the constitution; on a standing one it also concludes the run
  (`shuttle.runtime.handed_off_at = now`) in the same document write, so the
  poller never reads it armed without the stamp that rests it until its next
  tick. Rest puts it in Resting (pausing a standing schedule), and a verdict
  (`close --tempered=…`) closes it or, on a standing constitution, tempers its
  current run; each then stops any live worker through the Poller's
  backend-aware stop, the one `/kill` uses, so an app conversation is
  interrupted as a tmux worker is.

  `/api/v1/lifecycle` comes through `transition/3`. With the Poller running, the write happens inside it
  (`Poller.lifecycle_transition/4`), serialized with the Poller's state
  changes, and the fiber's document-cache entry is refreshed after. A poll read
  already in flight (poll reads run in their own task) sees the old document or
  the new one, whose status and `handed_off_at` land in one atomic write.
  Without a Poller (a controller test, a restart window) it is shelled
  directly.
  """

  alias Shuttle.{FeltStores, Poller}

  @type verb :: :resume | :reopen | :close | :pause | :rest | :role | :seat | :clear_ask

  @spec transition(verb(), String.t(), [String.t()], String.t() | nil) ::
          Shuttle.Felt.result() | {:error, :timeout, String.t()}
  def transition(verb, identifier, args \\ [], path_hint \\ nil)
      when verb in [:resume, :reopen, :close, :pause, :rest, :role, :seat, :clear_ask] and
             is_binary(identifier) do
    with {:ok, %{store: felt_store, fiber_id: fiber_id} = resolved} <-
           FeltStores.resolve_request(identifier, path_hint) do
      if is_pid(GenServer.whereis(Shuttle.Env.server(Poller))) do
        Poller.lifecycle_transition(Shuttle.Env.server(Poller), verb, resolved, args)
      else
        write(verb, resolved.uid || fiber_id,
          felt_store: felt_store,
          args: args ++ hint_args(resolved)
        )
      end
    end
  end

  @doc false
  def hint_args(%{fiber_id: id}), do: ["--fiber-path", id]
  def hint_args(_), do: []

  @doc """
  Shell `shuttle -C <store> <verb> <fiber_id> --local`. `opts` go to
  `Shuttle.CLI.run_lifecycle/4` (`:felt_store`, `:runner`); `:args` carries
  verb-specific arguments such as an office slug or `--clear`.
  """
  @spec write(verb(), String.t(), keyword()) :: Shuttle.Felt.result()
  def write(:clear_ask, fiber_id, opts) do
    {args, opts} = Keyword.pop(opts, :args, [])
    Shuttle.CLI.run_lifecycle("ask", fiber_id, ["--clear" | args], opts)
  end

  def write(verb, fiber_id, opts)
      when verb in [:resume, :reopen, :close, :pause, :rest, :role, :seat] do
    {args, opts} = Keyword.pop(opts, :args, [])
    Shuttle.CLI.run_lifecycle(Atom.to_string(verb), fiber_id, args, opts)
  end
end
