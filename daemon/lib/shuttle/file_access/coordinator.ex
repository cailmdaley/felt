defmodule Shuttle.FileAccess.Coordinator do
  @moduledoc false
  use GenServer
  alias Shuttle.FileAccess, as: Access

  # The restartable ingress owns no native leases or folder state. Workers and
  # timers address the independent journal, so replacing ingress cannot lose
  # a late completion, clear a block, or replenish a killed worker's credit.
  def start_link(args), do: GenServer.start_link(__MODULE__, args)

  @impl true
  def init({supervisor, opts}) do
    journal = Access.journal_info(supervisor)
    name = Keyword.get(opts, :name, Access)
    info = %{pid: self(), supervisor: supervisor, timeout: journal.timeout}
    :persistent_term.put({Access, :service, supervisor}, info)
    if name, do: :persistent_term.put({Access, :service, name}, info)
    {:ok, %{supervisor: supervisor, name: name}}
  end

  @impl true
  def handle_cast(message, state) do
    GenServer.cast(Access.journal_info(state.supervisor).pid, message)
    {:noreply, state}
  end

  @impl true
  def handle_call(message, _from, state) do
    result =
      try do
        GenServer.call(Access.journal_info(state.supervisor).pid, message, 40)
      catch
        :exit, reason ->
          if message == :status,
            do: %{active: nil, capacity: nil, blocked_prefixes: [], available: false},
            else: {:transient, %Access.Error{reason: :busy, cause: reason}}
      end

    {:reply, result, state}
  end

  @impl true
  def terminate(_reason, state) do
    :persistent_term.erase({Access, :service, state.supervisor})
    if state.name, do: :persistent_term.erase({Access, :service, state.name})
  end
end
