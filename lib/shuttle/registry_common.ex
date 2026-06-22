defmodule Shuttle.RegistryCommon do
  @moduledoc """
  Plumbing shared by the two remote registries (`Shuttle.RemoteRegistry`,
  `Shuttle.RemoteFiberRegistry`). Both poll the same `:remotes` config on a
  self-rescheduling tick and expose a read call guarded by liveness, so the
  config normalization, tick scheduling, liveness check, and read timeout live
  here once rather than verbatim in each.
  """

  alias Shuttle.Remote

  # Read timeout for the synchronous snapshot/feed calls. Generous because a
  # cold first walk on the owning daemon can take seconds.
  @registry_read_timeout_ms 30_000

  @doc "Default timeout (ms) for the registries' synchronous read calls."
  @spec read_timeout_ms() :: pos_integer()
  def read_timeout_ms, do: @registry_read_timeout_ms

  @doc """
  Coerce the configured `:remotes` entries into `%Shuttle.Remote{}` structs,
  accepting structs, maps, or keyword lists.
  """
  @spec normalize_remotes(list()) :: [Remote.t()]
  def normalize_remotes(entries) do
    Enum.flat_map(entries, fn
      %Remote{} = r -> [r]
      other -> List.wrap(Remote.from_config(other))
    end)
  end

  @doc "True iff `server` resolves to a live process."
  @spec registry_alive?(GenServer.server()) :: boolean()
  def registry_alive?(server) do
    case GenServer.whereis(server) do
      nil -> false
      pid when is_pid(pid) -> Process.alive?(pid)
      _ -> false
    end
  end

  @doc """
  (Re)arm the self-rescheduling tick. Cancels any pending timer, then sends a
  fresh `{:tick, token}` after `delay_ms` and stores its ref in `state`'s
  `:tick_timer_ref` field. Works for any state struct carrying that field.
  """
  @spec schedule_tick(struct(), non_neg_integer()) :: struct()
  def schedule_tick(state, delay_ms) do
    if is_reference(state.tick_timer_ref) do
      Process.cancel_timer(state.tick_timer_ref)
    end

    token = make_ref()
    timer_ref = Process.send_after(self(), {:tick, token}, delay_ms)
    %{state | tick_timer_ref: timer_ref}
  end
end
