defmodule Shuttle.ApplicationBootTest do
  use ExUnit.Case, async: true

  test "endpoint starts before Poller and TailnetDial" do
    flags = [:start_poller, :start_tailnet_dial, :start_event_stream]
    Enum.each(flags, &Shuttle.Test.Env.put_app_env(&1, true))

    children = Shuttle.Application.child_specs()
    ids = Enum.map(children, & &1.id)
    endpoint = Enum.find_index(ids, &(&1 == ShuttleWeb.Endpoint))
    poller = Enum.find_index(ids, &(&1 == Shuttle.Poller))
    tailnet = Enum.find_index(ids, &(&1 == Shuttle.TailnetDial))
    event_stream = Enum.find_index(ids, &(&1 == Shuttle.EventStream))

    assert is_integer(endpoint)
    assert is_integer(poller)
    assert is_integer(tailnet)
    assert is_integer(event_stream)
    assert endpoint < poller
    assert endpoint < tailnet
    assert endpoint < event_stream

    # The Poller takes the identity application start froze instead of
    # shelling felt for its own.
    assert %{start: {Shuttle.Poller, :start_link, [poller_opts]}} = Enum.at(children, poller)
    assert Keyword.fetch!(poller_opts, :own_host_id) == Shuttle.Poller.daemon_host_id()

    task_supervisor =
      Enum.find_index(children, fn child ->
        match?({Task.Supervisor, :start_link, _}, child.start)
      end)

    peer_gate =
      Enum.find_index(children, fn child ->
        match?({ShuttleWeb.PeerGateThrottle, :start_link, _}, child.start)
      end)

    assert is_integer(task_supervisor) and task_supervisor < endpoint
    assert is_integer(peer_gate) and peer_gate < endpoint
  end
end
