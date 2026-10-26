defmodule Shuttle.RuntimeCache do
  @moduledoc """
  Disposable runtime lookup cache. The supervisor owns the ETS table; readers
  fetch directly and rebuild misses in the caller. A restart drops all entries.
  Keys include the caller's test scope, so overrides never leak between tests.
  """
  use GenServer

  @table __MODULE__

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(_opts) do
    :ets.new(@table, [:named_table, :public, read_concurrency: true])
    {:ok, nil}
  end

  def fetch(key, ttl_ms, load) do
    key = Shuttle.Env.scope_key(key)
    now = System.monotonic_time(:millisecond)

    case :ets.lookup(@table, key) do
      [{^key, value, expires}] when expires > now -> value
      _ -> put_scoped(key, load.(), now + ttl_ms)
    end
  end

  def delete(key), do: :ets.delete(@table, Shuttle.Env.scope_key(key))

  # Missing executables must be discoverable as soon as they are installed.
  defp put_scoped(_key, nil, _expires), do: nil

  defp put_scoped(key, value, expires) do
    :ets.insert(@table, {key, value, expires})
    value
  end
end
