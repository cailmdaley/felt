defmodule Shuttle.Test.StubGetFileClient do
  @moduledoc """
  GET transport stub for the owner-routed forward leg (`forward_get` →
  `get_file/2`).

  Records the last URL it was asked to fetch and replays a scripted response, so
  a cross-host body read runs without a real tunnel. Injected by putting this
  module name in `:write_forward_client`.

  Globally named, so start it with `start_supervised!/1` from a NON-async test —
  the supervisor tears it down between tests.
  """

  use Agent

  def start_link(_ \\ []),
    do: Agent.start_link(fn -> %{response: nil, last: nil} end, name: __MODULE__)

  def set_response(response), do: Agent.update(__MODULE__, &Map.put(&1, :response, response))
  def last, do: Agent.get(__MODULE__, & &1.last)

  def get_file(url, _timeout_ms) do
    Agent.update(__MODULE__, &Map.put(&1, :last, %{url: url}))
    Agent.get(__MODULE__, & &1.response)
  end
end
