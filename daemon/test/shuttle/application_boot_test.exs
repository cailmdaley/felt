defmodule Shuttle.ApplicationBootTest do
  use ExUnit.Case, async: true

  test "test startup never starts transcript indexing without scoped enable" do
    refute Process.whereis(Shuttle.TranscriptIndexer)
  end

  test "endpoint precedes independent local and fleet subtrees" do
    flags = [:start_poller, :start_tailnet_dial, :start_event_stream, :start_transcript_indexer]
    Enum.each(flags, &Shuttle.Test.Env.put_app_env(&1, true))
    children = Shuttle.Application.child_specs()
    ids = Enum.map(children, & &1.id)
    endpoint = Enum.find_index(ids, &(&1 == ShuttleWeb.Endpoint))
    local = Enum.find_index(ids, &(&1 == Shuttle.Local))
    fleet = Enum.find_index(ids, &(&1 == Shuttle.Fleet))
    assert endpoint < local
    assert endpoint < fleet
    assert %{start: {Shuttle.Local, :start_link, [locals]}} = Enum.at(children, local)
    assert %{start: {Shuttle.Fleet, :start_link, [remotes]}} = Enum.at(children, fleet)
    assert {Shuttle.Poller, opts} = Enum.find(locals, &match?({Shuttle.Poller, _}, &1))
    assert Keyword.fetch!(opts, :own_host_id) == Shuttle.Poller.daemon_host_id()
    assert Shuttle.EventStream in locals
    assert Shuttle.TranscriptIndexer in locals
    assert Shuttle.TailnetDial in remotes
    assert Enum.find_index(ids, &(&1 == Shuttle.TaskSupervisor)) < endpoint
    assert Enum.find_index(ids, &(&1 == ShuttleWeb.PeerGateThrottle)) < endpoint
  end
end
