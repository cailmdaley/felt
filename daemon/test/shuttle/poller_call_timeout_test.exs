defmodule Shuttle.PollerCallTimeoutTest do
  # A Poller call that outlives its budget answers instead of exiting its
  # caller, so `/dispatch` and `/lifecycle` report uncertainty rather than
  # dropping the connection, and a forwarding daemon always outlasts the owner.
  use ExUnit.Case, async: true

  alias Shuttle.{OriginRouter, Poller}

  defmodule Silent do
    use GenServer
    def start_link, do: GenServer.start_link(__MODULE__, nil)
    @impl true
    def init(state), do: {:ok, state}
    @impl true
    def handle_call(_request, _from, state), do: {:noreply, state}
  end

  setup do
    Shuttle.Test.Env.put_app_env(:dispatch_call_timeout_ms, 50)
    {:ok, server} = Silent.start_link()
    %{server: server}
  end

  test "a dispatch the Poller does not answer in time is poller_busy", %{server: server} do
    assert Poller.dispatch_fiber(server, "a/fiber", []) == {:error, :poller_busy}
  end

  test "a lifecycle write the Poller does not answer in time is a timeout with a reason",
       %{server: server} do
    assert {:error, :timeout, reason} =
             Poller.lifecycle_transition(server, :resume, "a/fiber", [])

    assert reason =~ "outcome"
    assert reason =~ "lost on restart"
    assert reason =~ "Check the fiber after the poller settles or restarts"
  end

  test "a queued close lost when the poller stops has an honest timeout", %{server: server} do
    :sys.suspend(server)
    assert {:error, :timeout, reason} = Poller.lifecycle_transition(server, :close, "a/fiber", [])
    Process.unlink(server)
    Process.exit(server, :kill)
    assert reason =~ "lost on restart"
    assert reason =~ "Check the fiber after the poller settles or restarts"
  end

  test "a poller stopping while a close waits returns a retryable error", %{server: server} do
    :sys.suspend(server)
    caller = Task.async(fn -> Poller.lifecycle_transition(server, :close, "a/fiber", []) end)
    Process.unlink(server)
    Process.exit(server, :shutdown)
    assert {:error, :timeout, reason} = Task.await(caller, 30_000)
    assert reason =~ "outcome"
    assert reason =~ "Check the fiber after the poller settles or restarts"
  end

  test "poller_busy renders as 504 with a message naming the uncertainty" do
    {status, body} = ShuttleWeb.DispatchReply.render("a/fiber", {:error, :poller_busy})
    assert status == 504
    assert body.reason == "poller_busy"
    assert body.message =~ "may launch"
  end

  test "the default forward outlasts the owner's Poller call by the transit margin" do
    assert OriginRouter.default_forward_timeout_ms() == Poller.dispatch_call_timeout_ms() + 10_000
  end

  # internal/shuttlecli/timeout_ladder_test.go mirrors these two numbers.
  test "the shipped budgets are 30s for the owner and 40s for the forward" do
    Shuttle.Test.Env.delete_app_env(:dispatch_call_timeout_ms)
    assert Poller.dispatch_call_timeout_ms() == 30_000
    assert OriginRouter.default_forward_timeout_ms() == 40_000
  end
end
