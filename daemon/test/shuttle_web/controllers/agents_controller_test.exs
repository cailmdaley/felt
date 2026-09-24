defmodule ShuttleWeb.AgentsControllerTest do
  @moduledoc """
  `POST /api/v1/agents/effort` — the settings page's one structured edit of
  `agents.json`, which shells `felt shuttle agents effort`. felt is stubbed at
  the `:felt_runner` seam, so the argv is the thing under test.
  """
  use ExUnit.Case
  import Shuttle.Test.ApiConn
  import Shuttle.Test.EnvHelpers
  import Phoenix.ConnTest

  alias Shuttle.Test.{ForwardStub, StubPostClient}

  @endpoint ShuttleWeb.Endpoint

  defmodule MockFelt do
    @behaviour Shuttle.Runner

    use Agent

    def start_link(_ \\ []),
      do:
        Agent.start_link(fn -> %{reply: fn _args -> {"", 0} end, calls: []} end, name: __MODULE__)

    def reply_with(fun), do: Agent.update(__MODULE__, &Map.put(&1, :reply, fun))
    def calls, do: Agent.get(__MODULE__, & &1.calls)
    def last_args, do: calls() |> List.last() |> elem(1)

    @impl true
    def cmd(command, args, _opts) do
      Agent.update(__MODULE__, fn s -> %{s | calls: s.calls ++ [{command, args}]} end)
      Agent.get(__MODULE__, & &1.reply).(args)
    end
  end

  setup do
    previous_runner = Application.get_env(:shuttle, :felt_runner)
    previous_remotes = Application.get_env(:shuttle, :remotes)
    Application.put_env(:shuttle, :felt_runner, MockFelt)
    Application.put_env(:shuttle, :remotes, [])
    start_supervised!(MockFelt)

    on_exit(fn ->
      restore_app_env(:felt_runner, previous_runner)
      restore_app_env(:remotes, previous_remotes)
    end)
  end

  test "a level sets the override, and felt's line comes back" do
    MockFelt.reply_with(fn _ -> {"claude-opus: default_effort high in /x/agents.json\n", 0} end)

    conn = post_effort(%{"id" => "claude-opus", "effort" => "high"})

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["ok"] == true
    assert body["host"] == Shuttle.Poller.own_host_id()
    assert body["output"] == "claude-opus: default_effort high in /x/agents.json"
    assert MockFelt.last_args() == ["shuttle", "agents", "effort", "claude-opus", "high"]
  end

  test "a null effort is the reset verb" do
    conn = post_effort(%{"id" => "claude-opus", "effort" => nil})

    assert conn.status == 200
    assert MockFelt.last_args() == ["shuttle", "agents", "effort", "claude-opus", "--reset"]
  end

  test "a missing id or effort is a 400, and felt is never run" do
    assert post_effort(%{"effort" => "high"}).status == 400
    assert post_effort(%{"id" => "claude-opus"}).status == 400
    assert post_effort(%{"id" => "claude-opus", "effort" => ""}).status == 400
    assert MockFelt.calls() == []
  end

  test "felt's refusal is relayed as a 400, in its own words" do
    refusal = ~s(effort "ludicrous" not allowed for agent "claude-opus")
    MockFelt.reply_with(fn _ -> {refusal <> "\n", 1} end)

    conn = post_effort(%{"id" => "claude-opus", "effort" => "ludicrous"})

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] == refusal
  end

  test "felt missing from PATH is a 503, not a refusal" do
    MockFelt.reply_with(fn _ -> {"", 127} end)

    conn = post_effort(%{"id" => "claude-opus", "effort" => "high"})

    assert conn.status == 503
    assert Jason.decode!(conn.resp_body)["unavailable"] == true
  end

  test "a remote origin forwards to its owner, and nothing runs here" do
    reply = Jason.encode!(%{"ok" => true, "host" => "candide", "output" => "set"})

    ForwardStub.stub_forward(
      "candide",
      "http://candide.example:4000",
      {:ok, 200, reply},
      StubPostClient
    )

    conn = post_effort(%{"id" => "claude-opus", "effort" => "high", "origin" => "candide"})

    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["host"] == "candide"
    last = StubPostClient.last()
    assert last.url == "http://candide.example:4000/api/v1/agents/effort"
    assert Jason.decode!(last.body) == %{"id" => "claude-opus", "effort" => "high"}
    assert MockFelt.calls() == []
  end

  test "an unknown origin is a 400" do
    conn = post_effort(%{"id" => "claude-opus", "effort" => "high", "origin" => "nowhere"})

    assert conn.status == 400
    assert MockFelt.calls() == []
  end

  defp post_effort(payload) do
    post(api_conn(), "/api/v1/agents/effort", Jason.encode!(payload))
  end
end
