defmodule Shuttle.Test.StubStreamClient do
  @moduledoc """
  Scoped, flow-controlled stream script for owner-routed transcript requests.
  `set_events/1` queues the opening event and one event per `stream_next/1`.
  `:wait` withholds an event, so relay deadlines can be exercised.
  """
  use Agent

  def start!, do: Shuttle.Test.Env.start_scoped!(__MODULE__)
  defp server, do: Shuttle.Test.Env.server!(__MODULE__)

  def start_link(_ \\ []) do
    Agent.start_link(fn ->
      %{
        events: [],
        error: nil,
        last: nil,
        streams: %{},
        cancelled: [],
        nexts: [],
        cancel_events: []
      }
    end)
  end

  def set_events(events), do: Agent.update(server(), &%{&1 | events: events})
  def set_error(error), do: Agent.update(server(), &%{&1 | error: error})
  def set_cancel_events(events), do: Agent.update(server(), &%{&1 | cancel_events: events})
  def last, do: Agent.get(server(), & &1.last)
  def cancelled, do: Agent.get(server(), & &1.cancelled)
  def nexts, do: Agent.get(server(), & &1.nexts)

  def stream_get(url, headers, owner, timeout) do
    id = make_ref()

    result =
      Agent.get_and_update(server(), fn state ->
        last = %{url: url, headers: headers, owner: owner, timeout: timeout, id: id}
        state = %{state | last: last, streams: Map.put(state.streams, id, {owner, state.events})}
        {state.error, state}
      end)

    case result do
      nil ->
        deliver(id)
        {:ok, id}

      reason ->
        {:error, reason}
    end
  end

  def stream_next(id) do
    Agent.update(server(), &%{&1 | nexts: &1.nexts ++ [id]})
    deliver(id)
  end

  def stream_cancel(id) do
    {owner, events} =
      Agent.get_and_update(server(), fn state ->
        {{owner, _}, streams} = Map.pop(state.streams, id)

        {{owner, state.cancel_events},
         %{state | streams: streams, cancelled: [id | state.cancelled]}}
      end)

    for event <- events, do: send(owner, {:remote_stream, id, event})
    :ok
  end

  defp deliver(id) do
    {owner, event} =
      Agent.get_and_update(server(), fn state ->
        {owner, events} = Map.fetch!(state.streams, id)

        {event, rest} =
          case events do
            [] -> {:wait, []}
            [event | rest] -> {event, rest}
          end

        {{owner, event}, %{state | streams: Map.put(state.streams, id, {owner, rest})}}
      end)

    case event do
      :wait -> :ok
      {:open, headers} -> send(owner, {:remote_stream, id, {:open, headers, id}})
      event -> send(owner, {:remote_stream, id, event})
    end

    :ok
  end
end
