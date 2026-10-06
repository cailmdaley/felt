defmodule Shuttle.Test.StubGetFileClient do
  @moduledoc """
  GET transport stub for owner-routed byte requests (`forward_get` and
  `forward_file_get` → `get_file/2` or `get_file/3`).

  Records the last URL and request headers and replays a scripted response, so
  a cross-host body read runs without a real tunnel. Injected by putting this
  module name in `:write_forward_client`.

  One instance per test: `start!/0` starts it under the test supervisor and
  registers it in the test's scope (`Shuttle.Test.Env.start_scoped!/1`), where
  every process acting for the test finds it.
  """

  use Agent

  @doc "Start this test's instance (see the moduledoc); returns its pid."
  def start!, do: Shuttle.Test.Env.start_scoped!(__MODULE__)

  defp server, do: Shuttle.Test.Env.server!(__MODULE__)

  def start_link(_ \\ []),
    do: Agent.start_link(fn -> %{response: nil, last: nil} end)

  def set_response(response), do: Agent.update(server(), &Map.put(&1, :response, response))
  def last, do: Agent.get(server(), & &1.last)

  def get_file(url, timeout_ms), do: get_file(url, [], timeout_ms)

  def get_file(url, req_headers, timeout_ms) do
    Agent.update(
      server(),
      &Map.put(&1, :last, %{url: url, headers: req_headers, timeout: timeout_ms})
    )

    Agent.get(server(), & &1.response)
  end
end
