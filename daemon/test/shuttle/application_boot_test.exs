defmodule Shuttle.ApplicationBootTest do
  use ExUnit.Case, async: false

  test "endpoint starts before Poller and TailnetDial" do
    flags = [:start_poller, :start_tailnet_dial, :start_sent_files_follower]
    previous = Map.new(flags, &{&1, Application.get_env(:shuttle, &1)})

    Enum.each(flags, &Application.put_env(:shuttle, &1, true))
    on_exit(fn -> Enum.each(previous, fn {key, value} -> restore_env(key, value) end) end)

    children = Shuttle.Application.child_specs()
    ids = Enum.map(children, & &1.id)
    endpoint = Enum.find_index(ids, &(&1 == ShuttleWeb.Endpoint))
    poller = Enum.find_index(ids, &(&1 == Shuttle.Poller))
    tailnet = Enum.find_index(ids, &(&1 == Shuttle.TailnetDial))
    sent_files_follower = Enum.find_index(ids, &(&1 == Shuttle.SentFiles.Follower))

    assert is_integer(endpoint)
    assert is_integer(poller)
    assert is_integer(tailnet)
    assert is_integer(sent_files_follower)
    assert endpoint < poller
    assert endpoint < tailnet
    assert endpoint < sent_files_follower

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

  defp restore_env(key, nil), do: Application.delete_env(:shuttle, key)
  defp restore_env(key, value), do: Application.put_env(:shuttle, key, value)
end
