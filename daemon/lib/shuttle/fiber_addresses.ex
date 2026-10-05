defmodule Shuttle.FiberAddresses do
  @moduledoc """
  The slug to hand felt for a fiber UID.

  felt reads a slug directly and walks the whole store for a UID, so a read
  addressed by UID goes through the slug when one is known: the poller's
  uid→slug index for the fibers it polls, else the slug of an earlier answer
  for the same UID. Every answer read this way is checked against the UID by
  `Shuttle.FiberDocuments.get/2`, so a stale slug costs a fallback read,
  never a wrong document. Owns the ETS table of learned slugs; a restart
  costs one walk per UID.
  """

  use GenServer

  @table :shuttle_fiber_addresses

  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, :ok, name: Keyword.get(opts, :name, __MODULE__))

  @impl true
  def init(:ok) do
    :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
    {:ok, nil}
  end

  @doc "The slug to read `uid` through, or nil for a non-UID id or an unknown UID."
  @spec slug_for(String.t()) :: String.t() | nil
  def slug_for(id) when is_binary(id) do
    if Shuttle.ULID.valid?(id), do: learned(id) || Shuttle.Poller.slug_for_uid(id)
  end

  @doc "Remember the slug an answered UID read resolved to."
  @spec learn(String.t(), map()) :: :ok
  def learn(id, %{fibers: [%{fiber: %{"slug" => slug}} | _]})
      when is_binary(slug) and slug != "" do
    if Shuttle.ULID.valid?(id), do: :ets.insert(@table, {id, slug})
    :ok
  rescue
    ArgumentError -> :ok
  end

  def learn(_id, _body), do: :ok

  defp learned(uid) do
    case :ets.lookup(@table, uid) do
      [{^uid, slug}] -> slug
      _ -> nil
    end
  rescue
    ArgumentError -> nil
  end
end
