defmodule Shuttle.ThreadResultStoreMoveTest do
  # Regression for old thread closes replaying to the orchestrator: on 19 Nov
  # 2026 the felt tree moved from one store to another, every thread result
  # from the last fourteen days was captured again under a new id, and the
  # orchestrator's fresh session was offered about fifteen settled closes.
  # A result is captured once whichever store holds its thread, and a result
  # captured under the id that named the store is not captured again.
  use Shuttle.Test.ThreadsCase, async: true

  alias Shuttle.Test.InboxPublications

  defp capture!(store) do
    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    Threads.deliver_results(entries, "test-host")
  end

  defp routed(data) do
    root = InboxPublications.routing_dir(data)
    Path.wildcard(Path.join(root, "{pending,offered}/*.json"))
  end

  test "a thread result is captured once across a move to another store", %{
    store: store,
    data: data
  } do
    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])
    capture!(store)
    assert [%{"request" => %{"text" => "thread hub/child closed" <> _}}] = pending(data)
    assert [_] = routed(data)

    moved = Path.join(store, "moved")
    File.mkdir_p!(moved)
    File.cp_r!(Path.join(store, ".felt"), Path.join(moved, ".felt"))
    capture!(moved)

    assert [_] = pending(data)
    assert [_] = routed(data)
  end

  test "a result captured under the id that named its store is not captured again", %{
    store: store,
    data: data
  } do
    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])
    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    entry = Enum.find(entries, &(Threads.address(&1.fiber) == "hub/child"))
    child = entry.fiber

    named_store =
      "thread-" <>
        (:crypto.hash(
           :sha256,
           :erlang.term_to_binary({entry.felt_store, child["uid"], "closed", child["closed_at"]})
         )
         |> Base.encode16(case: :lower))

    InboxPublications.capture([{named_store, %{"text" => "captured before", "wake" => false}}])
    capture!(store)

    assert [_] = routed(data)
  end
end
