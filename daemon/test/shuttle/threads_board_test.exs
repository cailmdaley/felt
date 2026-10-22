defmodule Shuttle.ThreadsBoardTest do
  use ExUnit.Case, async: true
  alias Shuttle.Threads

  @mac "/Users/me/loom"
  @cineca "/leonardo/home/me/loom"
  @other "/global/homes/me/other"

  defp local(slug, uid, opts \\ []),
    do: %{origin: "mac", felt_store: @mac, fiber: fiber(slug, uid, opts)}

  defp remote(origin, store, slug, uid, opts \\ []) do
    row = %{"origin" => origin, "felt_store" => store, "fiber" => fiber(slug, uid, opts)}

    case opts[:orchestrator] do
      nil -> row
      claimed -> Map.put(row, "orchestrator", claimed)
    end
  end

  defp fiber(slug, uid, opts) do
    base = %{"id" => uid, "uid" => uid, "slug" => slug}

    if Keyword.get(opts, :shuttle, true),
      do: Map.put(base, "shuttle", %{"kind" => "oneshot"}),
      else: base
  end

  defp orchestrators(rows) do
    Map.new(rows, fn
      %{fiber: f} = row -> {f["uid"], Map.fetch(row, :orchestrator)}
      %{"fiber" => f} = row -> {f["uid"], Map.fetch(row, "orchestrator")}
    end)
  end

  test "containment crosses hosts within a store and never across stores" do
    rows = [
      local("hub", "U-HUB"),
      local("remote-hub/local-child", "U-LC"),
      local("plain", "U-PLAIN", shuttle: false),
      remote("cineca", @cineca, "hub/remote-child", "U-RC", orchestrator: "stale-claim"),
      remote("cineca", @cineca, "hub/remote-child/grandchild", "U-GC"),
      remote("cineca", @cineca, "remote-hub", "U-RH"),
      # A different store whose slugs collide with the loom's.
      remote("nersc", @other, "hub/remote-child", "U-OTHER-RC"),
      remote("nersc", @other, "hub/remote-child/leaf", "U-OTHER-LEAF")
    ]

    # The Mac's document cache holds every loom fiber, wherever it is owned.
    local_stores =
      Map.new(~w(U-HUB U-LC U-PLAIN U-RC U-GC U-RH), &{&1, @mac})

    stamped = orchestrators(Threads.put_board_orchestrators(rows, local_stores))

    # Remote child under a local hub; the remote's own claim is replaced.
    assert stamped["U-RC"] == {:ok, "U-HUB"}
    # Nearest strict ancestor wins over a farther one.
    assert stamped["U-GC"] == {:ok, "U-RC"}
    # Local child under a remote hub.
    assert stamped["U-LC"] == {:ok, "U-RH"}
    assert stamped["U-HUB"] == {:ok, nil}
    # Rows without a shuttle block are left alone.
    assert stamped["U-PLAIN"] == :error
    # Same slug path, different store: never contained by the loom's hub, but
    # contained within its own store.
    assert stamped["U-OTHER-RC"] == {:ok, nil}
    assert stamped["U-OTHER-LEAF"] == {:ok, "U-OTHER-RC"}
  end

  test "a remote location resolves to the local store holding most of its uids" do
    rows = [
      local("hub", "U-HUB"),
      remote("cineca", @cineca, "hub/child", "U-CHILD"),
      # Not yet synced to this host: votes for nothing, follows its location.
      remote("cineca", @cineca, "hub/fresh", "U-FRESH")
    ]

    stamped =
      rows
      |> Threads.put_board_orchestrators(%{"U-HUB" => @mac, "U-CHILD" => @mac})
      |> orchestrators()

    assert stamped["U-CHILD"] == {:ok, "U-HUB"}
    assert stamped["U-FRESH"] == {:ok, "U-HUB"}
  end
end
