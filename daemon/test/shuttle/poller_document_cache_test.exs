defmodule Shuttle.Poller.DocumentCacheTest do
  use ExUnit.Case, async: true

  alias Shuttle.Poller.DocumentCache

  test "registry-only resolved agent changes rebuild an unchanged fiber mtime" do
    original = candidate("unresolved")
    changed = candidate("claude")

    {cache, %{misses: 1}} =
      DocumentCache.refresh(%{document_cache: %{}}, [original], %{"hub" => "/store"})

    {cache, %{hits: 0, misses: 1}} =
      DocumentCache.refresh(%{document_cache: cache}, [changed], %{"hub" => "/store"})

    assert %{entry: %{fiber: %{"shuttle" => %{"resolved" => %{"agent" => %{"cli" => "claude"}}}}}} =
             cache["hub"]
  end

  test "a rename with stable identity and unchanged mtime rebuilds its address" do
    original = candidate("claude") |> Map.put("uid", "01JZ0000000000000000000000")

    moved =
      original
      |> Map.put("id", "moved")
      |> Map.put("slug", "moved")
      |> Map.put("path", "/store/.felt/moved/moved.md")

    {cache, _} = DocumentCache.refresh(%{document_cache: %{}}, [original], %{"hub" => "/store"})

    {cache, %{hits: 0, misses: 1}} =
      DocumentCache.refresh(%{document_cache: cache}, [moved], %{"moved" => "/store"})

    assert cache[original["uid"]].entry.fiber["slug"] == "moved"
  end

  @tag :tmp_dir
  test "an unreadable document retains a stale address until repaired or removed", %{tmp_dir: tmp} do
    path = Path.join([Path.expand(tmp), ".felt", "hub", "hub.md"])
    File.mkdir_p!(Path.dirname(path))

    File.write!(
      path,
      "---\n<<<<<<< HEAD\nstatus: open\n=======\nstatus: active\n>>>>>>> owner\n---\nBody\n"
    )

    row = candidate("claude") |> Map.put("path", path)
    state = %{document_cache: %{}, felt_stores: [Path.expand(tmp)]}
    {cache, _} = DocumentCache.refresh(state, [row], %{"hub" => Path.expand(tmp)})
    {retained, _} = DocumentCache.refresh(%{state | document_cache: cache}, [], %{})
    assert Map.has_key?(retained, "hub")
    assert retained["hub"].entry.document_stale
    assert DocumentCache.index(retained)["hub"]["id"] == "hub"
    File.write!(path, "---\nname: hub\nstatus: active\nshuttle:\n  kind: oneshot\n---\nBody\n")

    {repaired, _} =
      DocumentCache.refresh(
        %{state | document_cache: retained},
        [Map.put(row, "modified_at", "later")],
        %{"hub" => Path.expand(tmp)}
      )

    refute Map.get(repaired["hub"].entry, :document_stale, false)
    File.rm!(path)
    {removed, _} = DocumentCache.refresh(%{state | document_cache: retained}, [], %{})
    assert removed == %{}
    File.write!(path, "---\nname: An ordinary note\n---\nBody\n")
    {unmanaged, _} = DocumentCache.refresh(%{state | document_cache: retained}, [], %{})
    assert unmanaged == %{}
    File.write!(path, "---\n<<<<<<< HEAD\nbad\n---\n")

    {unconfigured, _} =
      DocumentCache.refresh(%{state | document_cache: retained, felt_stores: []}, [], %{})

    assert unconfigured == %{}
  end

  defp candidate(cli) do
    resolved_agent = if cli == "unresolved", do: nil, else: %{"id" => "receiver", "cli" => cli}

    %{
      "id" => "hub",
      "uid" => "hub",
      "slug" => "hub",
      "name" => "hub",
      "status" => "active",
      "modified_at" => "2026-01-01T00:00:00Z",
      "path" => "/store/.felt/hub/hub.md",
      "shuttle" => %{"agent" => "receiver", "resolved" => %{"agent" => resolved_agent}}
    }
  end
end
