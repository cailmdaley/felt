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

  test "a standing constitution's next due moving rebuilds an unchanged fiber mtime" do
    due = fn day ->
      candidate("claude")
      |> put_in(["shuttle", "resolved", "next_due"], day)
    end

    {cache, _} =
      DocumentCache.refresh(%{document_cache: %{}}, [due.("2026-01-02T09:00:00Z")], %{
        "hub" => "/store"
      })

    {cache, %{hits: 0, misses: 1}} =
      DocumentCache.refresh(%{document_cache: cache}, [due.("2026-01-03T09:00:00Z")], %{
        "hub" => "/store"
      })

    assert cache["hub"].entry.fiber["shuttle"]["resolved"]["next_due"] == "2026-01-03T09:00:00Z"
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
