defmodule Shuttle.SessionBindingIntegrationTest do
  use ExUnit.Case, async: true
  alias Shuttle.{EventStream, SessionBinding, Poller.Snapshot}
  @moduletag :integration
  @moduletag :tmp_dir

  test "real tmux and hook output isolate nested receiver and follow same-process switch", %{
    tmp_dir: dir
  } do
    root = Path.expand("../../..", __DIR__)
    shuttle = Path.join(dir, "shuttle")
    receiver = Path.join(dir, "receiver")
    assert {_, 0} = System.cmd("go", ["build", "-o", shuttle, "./cmd/shuttle"], cd: root)

    assert {_, 0} =
             System.cmd(
               "go",
               ["build", "-o", receiver, "./daemon/test/fixtures/session_binding/receiver.go"],
               cd: root
             )

    path = Path.join(dir, "events.jsonl")
    socket = "binding-#{System.unique_integer([:positive])}"

    command =
      "SHUTTLE_HOST=fixture SHUTTLE_MESSAGES=off SHUTTLE_EVENTS_FILE='#{path}' SHUTTLE_TMUX_SESSION=shared-shuttle '#{receiver}' '#{shuttle}'; touch '#{dir}/done'"

    assert {_, 0} =
             System.cmd("tmux", ["-L", socket, "new-session", "-d", "-s", "binding", command])

    on_exit(fn -> System.cmd("tmux", ["-L", socket, "kill-server"]) end)

    Enum.reduce_while(1..1200, nil, fn _, _ ->
      if File.exists?(Path.join(dir, "done")),
        do: {:halt, :ok},
        else:
          (
            Process.sleep(25)
            {:cont, nil}
          )
    end)

    assert File.exists?(Path.join(dir, "done"))
    events = File.stream!(path) |> Enum.map(&EventStream.decode/1)
    assert [anchor, nested, notification, switched, stop] = events
    assert anchor["sessionId"] == "anchor"
    assert nested["sessionId"] == "nested"
    assert anchor["receiverPid"] != nested["receiverPid"]
    assert is_binary(anchor["receiverBirth"]) and anchor["receiverBirth"] != ""
    assert switched["receiverPid"] == anchor["receiverPid"]
    assert switched["receiverBirth"] == anchor["receiverBirth"]
    assert Enum.uniq(Enum.map(events, & &1["tmuxSession"])) == ["shared-shuttle"]
    now = stop["timestamp"]

    replay = Path.join(dir, "replay.jsonl")

    File.write!(
      replay,
      Enum.map_join([anchor, nested, notification], "", &(Jason.encode!(&1) <> "\n"))
    )

    name = :binding_real_hook_stream

    start_supervised!(
      {EventStream,
       name: name, events_file: replay, clock: fn -> now end, poll_interval_ms: 60_000}
    )

    meta = %{
      fiber_id: "fiber",
      session: "shared-shuttle",
      agent_id: "test",
      started_at: DateTime.from_unix!(now, :millisecond),
      last_activity_at: DateTime.from_unix!(now, :millisecond)
    }

    entry = %{
      fiber: %{"id" => "fiber", "shuttle" => %{"runtime" => %{"session_uuid" => "anchor"}}}
    }

    snapshot = fn ->
      activity = EventStream.session_activity(name)

      Snapshot.put_runtime(
        entry,
        Snapshot.runtime_index(%{"fiber" => meta}, activity),
        activity,
        EventStream.session_bindings(name)
      )
    end

    assert %{runtime: %{session_uuid: "anchor", phase: "working"}} = snapshot.()

    File.write!(replay, Enum.map_join([switched, stop], "", &(Jason.encode!(&1) <> "\n")), [
      :append
    ])

    EventStream.sent_events(name, replay)
    assert SessionBinding.current(EventStream.session_bindings(name), "anchor") == "switched"
    assert %{runtime: %{session_uuid: "switched", phase: "waiting"}} = snapshot.()
  end
end
