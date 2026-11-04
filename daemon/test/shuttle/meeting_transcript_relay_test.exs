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
       file: Path.join(root, "relay.json"),
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
    refute File.exists?(Path.join(root, "relay.json"))
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
    state_file = Path.join(root, "relay.json")

    start_supervised!(
      {Shuttle.Meeting.TranscriptRelay,
       name: name, file: state_file, poll_ms: 10, observe: observe, deliver: deliver}
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
    refute File.exists?(state_file)
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
       file: Path.join(root, "relay.json"),
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
