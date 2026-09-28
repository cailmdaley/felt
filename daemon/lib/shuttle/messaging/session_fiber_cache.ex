defmodule Shuttle.Messaging.SessionFiberCache do
  @moduledoc false

  use GenServer

  @table :shuttle_messaging_session_fiber_cache
  @entry :session_fiber_index

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(_opts) do
    :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
    {:ok, nil}
  end

  def lookup do
    case :ets.lookup(@table, @entry) do
      [{@entry, value}] -> value
      _ -> nil
    end
  rescue
    ArgumentError -> nil
  end

  def store(value) do
    :ets.insert(@table, {@entry, value})
    :ok
  rescue
    ArgumentError -> :ok
  end

  def clear do
    :ets.delete(@table, @entry)
    :ok
  rescue
    ArgumentError -> :ok
  end
end
