defmodule Shuttle.FiberAddresses do
  @moduledoc """
  Where felt can read a fiber named by UID.

  felt reads a traversal id directly and walks the whole store for a UID, so a
  read addressed by UID goes through a known `{store, id}` address: the
  poller's, rewritten each poll for the fibers it polls, else one learned from
  an earlier answer for the same UID. `Shuttle.FiberDocuments.get/2` checks
  the UID on every answer read this way, so a stale address costs a fallback
  read, never a wrong document.

  Owns the ETS table; readers never call the poller. Learned addresses are
  dropped wholesale past `@max_learned`, and a restart clears the table: each
  costs one walk per UID read again.
  """

  use GenServer

  @table :shuttle_fiber_addresses
  @max_learned 20_000

  @type address :: {store :: String.t(), id :: String.t()}

  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, :ok, name: Keyword.get(opts, :name, __MODULE__))

  @impl true
  def init(:ok) do
    :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
    {:ok, nil}
  end

  @doc "The address to read `id` through, or nil for a non-UID id or an unknown UID."
  @spec lookup(String.t()) :: address() | nil
  def lookup(id) when is_binary(id) do
    with {:ok, uid} <- uid(id) do
      fetch({:polled, uid}) || fetch({:learned, uid})
    else
      _ -> nil
    end
  end

  @doc """
  Replace the poller's addresses with this poll's: `addresses` maps each
  polled UID to its `{store, id}`.
  """
  @spec put_polled(%{String.t() => address()}) :: :ok
  def put_polled(addresses) when is_map(addresses) do
    polled =
      for {id, address} <- addresses, {:ok, uid} <- [uid(id)], into: %{}, do: {uid, address}

    :ets.insert(@table, Enum.map(polled, fn {uid, address} -> {{:polled, uid}, address} end))

    for uid <- :ets.select(@table, [{{{:polled, :"$1"}, :_}, [], [:"$1"]}]),
        not Map.has_key?(polled, uid),
        do: :ets.delete(@table, {:polled, uid})

    :ok
  rescue
    ArgumentError -> :ok
  end

  @doc "Remember where felt answered a read of fiber `uid`."
  @spec learn(String.t(), String.t(), String.t()) :: :ok
  def learn(uid, store, id) when is_binary(uid) and is_binary(store) and is_binary(id) do
    with {:ok, uid} <- uid(uid), true <- id != "" do
      if :ets.info(@table, :size) >= @max_learned,
        do: :ets.match_delete(@table, {{:learned, :_}, :_})

      :ets.insert(@table, {{:learned, uid}, {store, id}})
    end

    :ok
  rescue
    ArgumentError -> :ok
  end

  def learn(_uid, _store, _id), do: :ok

  defp uid(id) do
    uid = String.upcase(id)
    if Shuttle.ULID.valid?(uid), do: {:ok, uid}, else: :error
  end

  defp fetch(key) do
    case :ets.lookup(@table, key) do
      [{^key, address}] -> address
      _ -> nil
    end
  rescue
    ArgumentError -> nil
  end
end
