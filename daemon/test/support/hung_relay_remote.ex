defmodule Shuttle.Test.HungRelayRemote do
  @moduledoc """
  Real TCP HTTP peer that records requests but never sends a response.
  Accepted sockets close only when the client cancels or the fixture stops.
  """
  use GenServer

  def start_link(_opts), do: GenServer.start_link(__MODULE__, [])
  def snapshot(pid), do: GenServer.call(pid, :snapshot)

  @impl true
  def init([]) do
    {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
    {:ok, port} = :inet.port(listener)
    owner = self()
    acceptor = spawn_link(fn -> accept(listener, owner) end)

    {:ok,
     %{listener: listener, acceptor: acceptor, port: port, sockets: MapSet.new(), requests: 0}}
  end

  defp accept(listener, owner) do
    case :gen_tcp.accept(listener) do
      {:ok, socket} ->
        :ok = :gen_tcp.controlling_process(socket, owner)
        send(owner, {:accepted, socket})
        accept(listener, owner)

      {:error, :closed} ->
        :ok
    end
  end

  @impl true
  def handle_call(:snapshot, _from, state) do
    {:reply,
     %{
       url: "http://127.0.0.1:#{state.port}",
       active: MapSet.size(state.sockets),
       requests: state.requests
     }, state}
  end

  @impl true
  def handle_info({:accepted, socket}, state) do
    :inet.setopts(socket, active: :once)
    {:noreply, %{state | sockets: MapSet.put(state.sockets, socket)}}
  end

  def handle_info({:tcp, socket, _data}, state) do
    :inet.setopts(socket, active: true)
    {:noreply, %{state | requests: state.requests + 1}}
  end

  def handle_info({:tcp_closed, socket}, state),
    do: {:noreply, %{state | sockets: MapSet.delete(state.sockets, socket)}}

  def handle_info({:tcp_error, socket, _reason}, state) do
    :gen_tcp.close(socket)
    {:noreply, %{state | sockets: MapSet.delete(state.sockets, socket)}}
  end

  @impl true
  def terminate(_reason, state) do
    :gen_tcp.close(state.listener)
    Enum.each(state.sockets, &:gen_tcp.close/1)
    Process.exit(state.acceptor, :kill)
  end
end
