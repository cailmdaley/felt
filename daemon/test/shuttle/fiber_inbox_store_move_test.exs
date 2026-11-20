defmodule Shuttle.FiberInboxStoreMoveTest do
  # Regression for a fiber's inbox key naming its store: on 19 Nov 2026 the
  # felt tree moved from one store to another, and every entry pending in a
  # fiber's inbox, scheduled check-ins included, stayed under the key that
  # named the old store while the daemon read an empty inbox under the new.
  # A fiber's inbox is the same whichever store holds it, and boot moves an
  # inbox still keyed by a store to the fiber's uid key.
  use Shuttle.Test.ThreadsCase, async: true

  @later "2999-01-01T00:00:00Z"

  defp hub(store) do
    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    {entries, Enum.find(entries, &(Threads.address(&1.fiber) == "hub"))}
  end

  defp move!(store) do
    moved = Path.join(store, "moved")
    File.mkdir_p!(moved)
    File.cp_r!(Path.join(store, ".felt"), Path.join(moved, ".felt"))
    moved
  end

  defp put!(key, id, flags \\ []) do
    assert {:ok, _} = CLI.run(["inbox", "put", key, id, "text of " <> id | flags])
  end

  defp waiting(store) do
    {entries, hub} = hub(store)
    {counts, scheduled} = Threads.pending_results(entries, "test-host", [])
    uid = hub.fiber["uid"]
    {counts[uid], Enum.map(scheduled[uid] || [], & &1["id"])}
  end

  test "a fiber's pending entries survive its tree moving to another store", %{store: store} do
    {_, hub} = hub(store)
    put!(Shuttle.Delivery.context_key(hub), "now")
    put!(Shuttle.Delivery.context_key(hub), "check-in", ["--turn", "ask", "--not-before", @later])
    assert waiting(store) == {1, ["check-in"]}

    assert waiting(move!(store)) == {1, ["check-in"]}
  end

  test "boot's rekey moves an inbox keyed by the store a tree moved out of", %{
    store: store,
    data: data
  } do
    {_, hub} = hub(store)
    old = store <> ":" <> hub.fiber["uid"]
    put!(old, "now")
    put!(old, "check-in", ["--turn", "ask", "--not-before", @later])

    session = "shuttle://test-host/claude/11111111-1111-4111-8111-111111111111"

    assert {:ok, _} =
             CLI.run(["context-mailbox", "receiver", old, "worker:1", session],
               env: [{"SHUTTLE_HOST", "test-host"}]
             )

    moved = move!(store)
    assert :ok = Shuttle.Inbox.rekey([moved, store])
    assert waiting(moved) == {1, ["check-in"]}

    key = Shuttle.Delivery.context_key(elem(hub(moved), 1))

    assert {:ok, receiver} =
             CLI.run(["context-mailbox", "get", key], env: [{"SHUTTLE_HOST", "test-host"}])

    assert %{"identity" => "worker:1"} = receiver |> String.trim() |> Jason.decode!()

    assert [link] = Path.wildcard(Path.join(data, "mailboxes/claude/*/fibers/*.json"))
    assert %{"fiber" => ^key} = link |> File.read!() |> Jason.decode!()

    assert :ok = Shuttle.Inbox.rekey([moved, store])
    assert waiting(moved) == {1, ["check-in"]}
  end
end
