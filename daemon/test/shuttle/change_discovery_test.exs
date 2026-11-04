defmodule Shuttle.Poller.ChangeDiscoveryTest do
  use ExUnit.Case, async: true

  defmodule Runner do
    @behaviour Shuttle.Runner

    def cmd("shuttle", ["-C", _store, "scan-changes"], opts) do
      Process.put({__MODULE__, :input}, Keyword.fetch!(opts, :input))
      Process.get({__MODULE__, :reply})
    end
  end

  test "retains the CLI metadata index as opaque bytes between scans" do
    # Formatting is intentionally non-canonical JSON. Decoding and encoding
    # the index in the daemon would change these bytes before the next scan.
    opaque_index = "{\n  \"nested/path\": [1, 2, 3, 4]\n}"
    Process.put({Runner, :reply}, {~s({"ids":[],"indexed_paths":1}) <> "\n" <> opaque_index, 0})

    state = %{felt_stores: ["store"], runner: Runner}
    first = Shuttle.Poller.ChangeDiscovery.read(state, %{}, self())
    assert %{"store" => {:ok, %{index: ^opaque_index, indexed_paths: 1}}} = first
    assert Process.get({Runner, :input}) == "{}"

    Process.put({Runner, :reply}, {~s({"ids":[],"indexed_paths":1}) <> "\n" <> opaque_index, 0})
    _second = Shuttle.Poller.ChangeDiscovery.read(state, %{"store" => opaque_index}, self())
    assert Process.get({Runner, :input}) == opaque_index
  end

  test "protected stores return an empty index and its health count" do
    if :os.type() == {:unix, :darwin} do
      store = Path.join(Shuttle.Env.home(), "Documents/store")
      state = %{felt_stores: [store], runner: Runner}

      assert %{^store => {:ok, %{index: "{}", indexed_paths: 0, ids: [], rows: []}}} =
               Shuttle.Poller.ChangeDiscovery.read(state, %{}, self())

      refute Process.get({Runner, :input})
    end
  end
end
