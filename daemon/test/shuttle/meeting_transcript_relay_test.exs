defmodule Shuttle.Meeting.TranscriptRelayTest do
  use ExUnit.Case, async: false

  @moduletag :tmp_dir

  test "sends bounded transcript batches and the end marker", %{tmp_dir: root} do
    transcript = Path.join(root, "meeting.txt")
    lines = Enum.map_join(1..34, "\n", &"turn #{&1}") <> "\n# ended 10:00:00\n"
    File.write!(transcript, lines)
    {:ok, sent} = Agent.start_link(fn -> [] end)
    observe = fn -> {:ok, %{meeting: %{launch: "launch-1", state: "live", error: nil}}} end

    deliver = fn message ->
      Agent.update(sent, &[message | &1])
      {200, %{delivered: true}}
    end

    name = String.to_atom("relay_test_#{System.unique_integer([:positive])}")

    start_supervised!(
      {Shuttle.Meeting.TranscriptRelay,
       name: name,
       directory: Path.join(root, "relays"),
       poll_ms: 10,
       observe: observe,
       deliver: deliver}
    )

    assert :ok =
             Shuttle.Meeting.TranscriptRelay.start(
               %{launch: "launch-1", transcript: transcript, title: "Cube draft"},
               "life/games/mtg",
               "dapmcw68",
               server: name
             )

    wait_for(fn -> length(Agent.get(sent, & &1)) == 2 end)
    messages = Agent.get(sent, &Enum.reverse/1)
    assert Enum.all?(messages, &(&1.fiber_id == "life/games/mtg"))
    assert Enum.all?(messages, &(&1.text =~ "Cube draft"))
    assert hd(messages).text =~ "turn 1"
    assert hd(messages).text =~ "turn 30"
    assert List.last(messages).text =~ "turn 34"
    assert List.last(messages).text =~ "# ended 10:00:00"
    assert hd(messages).message_id != List.last(messages).message_id
    assert {:ok, []} = Shuttle.FS.ls(Path.join(root, "relays"))
  end

  test "retries the same batch identity and closes a failed capture without a transcript",
       %{tmp_dir: root} do
    transcript = Path.join(root, "missing.txt")
    {:ok, sent} = Agent.start_link(fn -> [] end)

    observe = fn ->
      {:ok, %{meeting: %{launch: "launch-2", state: "failed", error: "audio source stopped"}}}
    end

    deliver = fn message ->
      Agent.get_and_update(sent, fn messages ->
        next = [message | messages]

        {if(length(next) == 1,
           do: {202, %{delivered: nil, detail: "arrival is unconfirmed"}},
           else: {200, %{"delivered" => true, "delivery" => "dispatch"}}
         ), next}
      end)
    end

    name = String.to_atom("relay_test_#{System.unique_integer([:positive])}")
    state_directory = Path.join(root, "relays")

    start_supervised!(
      {Shuttle.Meeting.TranscriptRelay,
       name: name, directory: state_directory, poll_ms: 10, observe: observe, deliver: deliver}
    )

    assert :ok =
             Shuttle.Meeting.TranscriptRelay.start(
               %{launch: "launch-2", transcript: transcript, title: "Weekly sync"},
               "science/cmbx",
               nil,
               server: name
             )

    wait_for(fn -> length(Agent.get(sent, & &1)) == 2 end)
    [retry, first] = Agent.get(sent, & &1)
    assert first.message_id == retry.message_id
    assert first.text == retry.text
    assert retry.text =~ "Weekly sync"
    assert retry.text =~ "audio source stopped"
    assert retry.text =~ "# ended"
    assert {:ok, []} = Shuttle.FS.ls(state_directory)
  end

  test "keeps an unconfirmed live transcript batch pending", %{tmp_dir: root} do
    transcript = Path.join(root, "meeting.txt")
    File.write!(transcript, "speaker: keep this line\n")
    {:ok, sent} = Agent.start_link(fn -> [] end)
    observe = fn -> {:ok, %{meeting: %{launch: "launch-3", state: "live", error: nil}}} end

    deliver = fn message ->
      Agent.get_and_update(sent, fn messages ->
        next = [message | messages]

        {if(length(next) == 1,
           do: {202, %{delivered: nil, detail: "arrival is unconfirmed"}},
           else: {200, %{delivered: true}}
         ), next}
      end)
    end

    name = String.to_atom("relay_test_#{System.unique_integer([:positive])}")

    start_supervised!(
      {Shuttle.Meeting.TranscriptRelay,
       name: name,
       directory: Path.join(root, "relays"),
       poll_ms: 10,
       observe: observe,
       deliver: deliver}
    )

    assert :ok =
             Shuttle.Meeting.TranscriptRelay.start(
               %{launch: "launch-3", transcript: transcript, title: "Weekly sync"},
               "science/cmbx",
               nil,
               server: name
             )

    wait_for(fn -> length(Agent.get(sent, & &1)) == 2 end)
    [retry, first] = Agent.get(sent, & &1)
    assert first.message_id == retry.message_id
    assert first.text == retry.text
    assert retry.text =~ "speaker: keep this line"
  end

  test "a second joined meeting does not replace an unconfirmed transcript", %{tmp_dir: root} do
    transcript_a = Path.join(root, "first.txt")
    transcript_b = Path.join(root, "second.txt")
    File.write!(transcript_a, "first meeting line\n# ended\n")
    File.write!(transcript_b, "second meeting line\n# ended\n")
    {:ok, hold_first} = Agent.start_link(fn -> true end)
    {:ok, sent} = Agent.start_link(fn -> [] end)
    observe = fn -> {:ok, %{meeting: nil}} end

    deliver = fn message ->
      Agent.update(sent, &[message | &1])

      if message.fiber_id == "fiber-a" and Agent.get(hold_first, & &1) do
        {202, %{delivered: nil, detail: "arrival is unconfirmed"}}
      else
        {200, %{delivered: true}}
      end
    end

    name = String.to_atom("relay_test_#{System.unique_integer([:positive])}")
    directory = Path.join(root, "relays")

    start_supervised!(
      {Shuttle.Meeting.TranscriptRelay,
       name: name, directory: directory, poll_ms: 10, observe: observe, deliver: deliver}
    )

    assert :ok =
             Shuttle.Meeting.TranscriptRelay.start(
               %{launch: "launch-a", transcript: transcript_a, title: "First"},
               "fiber-a",
               nil,
               server: name
             )

    wait_for(fn -> Agent.get(sent, &length/1) == 1 end)

    assert :ok =
             Shuttle.Meeting.TranscriptRelay.start(
               %{launch: "launch-b", transcript: transcript_b, title: "Second"},
               "fiber-b",
               nil,
               server: name
             )

    wait_for(fn -> Enum.any?(Agent.get(sent, & &1), &(&1.fiber_id == "fiber-b")) end)
    assert {:ok, [_pending_first]} = Shuttle.FS.ls(directory)
    Agent.update(hold_first, fn _ -> false end)
    wait_for(fn -> Shuttle.FS.ls(directory) == {:ok, []} end)

    first_messages = Agent.get(sent, &Enum.filter(&1, fn msg -> msg.fiber_id == "fiber-a" end))
    assert length(first_messages) >= 2
    assert Enum.uniq_by(first_messages, & &1.message_id) |> length() == 1
    assert Enum.all?(first_messages, &(&1.text =~ "first meeting line"))
  end

  test "a worker restart resumes its persisted pending message", %{tmp_dir: root} do
    transcript = Path.join(root, "meeting.txt")
    File.write!(transcript, "pending before crash\n# ended\n")
    {:ok, hold_delivery} = Agent.start_link(fn -> true end)
    {:ok, sent} = Agent.start_link(fn -> [] end)
    observe = fn -> {:ok, %{meeting: nil}} end

    deliver = fn message ->
      Agent.update(sent, &[message | &1])

      if Agent.get(hold_delivery, & &1),
        do: {202, %{delivered: nil, detail: "arrival is unconfirmed"}},
        else: {200, %{delivered: true}}
    end

    name = String.to_atom("relay_test_#{System.unique_integer([:positive])}")
    directory = Path.join(root, "relays")
    dynamic = Module.concat(name, DynamicSupervisor)

    start_supervised!(
      {Shuttle.Meeting.TranscriptRelay,
       name: name, directory: directory, poll_ms: 10, observe: observe, deliver: deliver}
    )

    assert :ok =
             Shuttle.Meeting.TranscriptRelay.start(
               %{launch: "launch-restart", transcript: transcript, title: "Restart test"},
               "fiber-restart",
               nil,
               server: name
             )

    wait_for(fn -> Agent.get(sent, &length/1) == 1 end)
    [{_id, original_pid, _type, _modules}] = DynamicSupervisor.which_children(dynamic)
    Process.exit(original_pid, :kill)
    Agent.update(hold_delivery, fn _ -> false end)

    wait_for(fn ->
      case DynamicSupervisor.which_children(dynamic) do
        [{_id, pid, _type, _modules}] -> pid != original_pid
        _ -> false
      end
    end)

    wait_for(fn -> Shuttle.FS.ls(directory) == {:ok, []} end)

    [retry, first] = Agent.get(sent, &Enum.take(&1, 2))
    assert first.message_id == retry.message_id
    assert first.text == retry.text
  end

  defp wait_for(fun, attempts \\ 200)
  defp wait_for(fun, 0), do: assert(fun.())

  defp wait_for(fun, attempts) do
    if fun.(),
      do: :ok,
      else:
        (
          Process.sleep(10)
          wait_for(fun, attempts - 1)
        )
  end
end
