defmodule Shuttle.Test.StubPostClient do
  @moduledoc """
  POST transport stub for the owner-routed forward leg.

  Records POST request history and replays a scripted
  response, so the forward leg is exercised without a real tunnel. It also
  answers the read `get/2` callback for the suites that script one; the rest
  never call it and it stays at `{:error, :not_set}`.

  It deliberately does NOT declare `@behaviour Shuttle.RemoteRegistry.Client` —
  it is injected by module name via `:write_forward_client`, and declaring the
  behaviour would warn about callbacks these tests have no need of.

  One instance per test: `start!/0` starts it under the test supervisor and
  registers it in the test's scope (`Shuttle.Test.Env.start_scoped!/1`), where
  every process acting for the test finds it.
  """

  use Agent

  @doc "Start this test's instance (see the moduledoc); returns its pid."
  def start!, do: Shuttle.Test.Env.start_scoped!(__MODULE__)

  defp server, do: Shuttle.Test.Env.server!(__MODULE__)

  def start_link(_ \\ []),
    do:
      Agent.start_link(fn ->
        %{
          response: nil,
          get_response: {:error, :not_set},
          get_responses: [],
          last: nil,
          last_get: nil,
          gets: [],
          posts: []
        }
      end)

  def set_response(response), do: Agent.update(server(), &Map.put(&1, :response, response))

  def set_get_response(response),
    do: Agent.update(server(), &Map.put(&1, :get_response, response))

  def set_get_responses(responses) when is_list(responses),
    do: Agent.update(server(), &Map.put(&1, :get_responses, responses))

  def last, do: Agent.get(server(), & &1.last)
  def posts, do: Agent.get(server(), &Enum.reverse(&1.posts))
  def last_get, do: Agent.get(server(), & &1.last_get)
  def gets, do: Agent.get(server(), &Enum.reverse(&1.gets))

  def get(url, _timeout_ms) do
    Agent.get_and_update(server(), fn state ->
      response = List.first(state.get_responses) || state.get_response
      responses = if state.get_responses == [], do: [], else: tl(state.get_responses)
      get = %{url: url}
      {response, %{state | last_get: get, gets: [get | state.gets], get_responses: responses}}
    end)
  end

  def get_file(url, timeout_ms) do
    case get(url, timeout_ms) do
      {:ok, status, body} -> {:ok, status, "application/json", body}
      error -> error
    end
  end

  def post(url, body, _content_type, _timeout_ms) do
    Agent.update(server(), fn state ->
      request = %{url: url, body: body}
      %{state | last: request, posts: [request | state.posts]}
    end)

    Agent.get(server(), & &1.response)
  end
end
