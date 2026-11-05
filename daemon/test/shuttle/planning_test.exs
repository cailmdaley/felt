defmodule Shuttle.PlanningTest do
  use ExUnit.Case, async: true
  alias Shuttle.Planning

  @uid "01ARZ3NDEKTSV4RRFFQ69G5FAX"

  test "the shared state table distinguishes planning from possible execution" do
    cases =
      Path.join([__DIR__, "..", "fixtures", "planning", "states.json"])
      |> File.read!()
      |> Jason.decode!()

    for %{"name" => name, "fiber" => fiber, "quiescent" => expected} <- cases do
      assert Planning.quiescent?(fiber) == expected, name
    end
  end

  defp row(fields) do
    %{
      "origin" => "worker",
      "local_planning" => true,
      "felt_store" => "/owner",
      "path" => "team/task/task.md",
      "fiber" =>
        Map.merge(
          %{
            "id" => @uid,
            "uid" => @uid,
            "status" => "open",
            "name" => "Owner content",
            "updated_at" => "2026-11-04T10:00:00Z",
            "shuttle" => %{"host" => "worker", "kind" => "oneshot"}
          },
          fields
        )
    }
  end

  test "newer planning replaces fields including removals, not owner addresses or content" do
    owner = row(%{"due" => "2026-12-01", "cold" => true})

    archive =
      row(%{
        "name" => "Archive content",
        "horizon" => "stashed",
        "status" => "closed",
        "tempered" => false,
        "updated_at" => "2026-11-04T11:00:00Z",
        "shuttle" => %{"host" => "worker", "kind" => "oneshot", "role" => "editor"}
      })
      |> Map.put("felt_store", "/archive")

    assert [
             %{
               "origin" => "worker",
               "felt_store" => "/owner",
               "fiber" => fiber
             }
           ] =
             Planning.reconcile([owner], [archive], %{"worker" => true}, "hub")

    assert %{
             "name" => "Owner content",
             "horizon" => "stashed",
             "status" => "closed",
             "tempered" => false,
             "shuttle" => %{"host" => "worker", "role" => "editor"}
           } = fiber

    refute Map.has_key?(fiber, "due")
    refute Map.has_key?(fiber, "cold")
  end

  test "fresh owners, equal versions and missing version evidence retain the owner row" do
    owner = row(%{})

    for {archive, stale} <- [
          {row(%{"horizon" => "stashed", "updated_at" => "2026-11-04T11:00:00Z"}), false},
          {row(%{"horizon" => "stashed"}), true},
          {row(%{"horizon" => "stashed", "updated_at" => nil}), true}
        ] do
      assert [^owner] = Planning.reconcile([owner], [archive], %{"worker" => stale}, "hub")
    end
  end

  test "a known owner worker or armed status wins over a newer offline verdict" do
    archive =
      row(%{
        "status" => "closed",
        "tempered" => false,
        "horizon" => "stashed",
        "updated_at" => "2026-11-04T11:00:00Z"
      })

    for owner <- [
          row(%{"status" => "active"}),
          Map.put(row(%{}), "runtime", %{"state" => "running"})
        ] do
      assert [%{"fiber" => fiber} = projected] =
               Planning.reconcile([owner], [archive], %{"worker" => true}, "hub")

      assert fiber["status"] == owner["fiber"]["status"]
      refute Map.has_key?(fiber, "tempered")
      assert projected["runtime"] == owner["runtime"]
      assert fiber["horizon"] == "stashed"
    end
  end

  test "projection requires intrinsic identity and cannot merge UID-less same-slug documents" do
    owner = row(%{"id" => "task", "uid" => nil})

    archive =
      row(%{
        "id" => "task",
        "uid" => nil,
        "horizon" => "stashed",
        "updated_at" => "2026-11-04T11:00:00Z"
      })

    assert [projected] = Planning.reconcile([owner], [archive], %{"worker" => true}, "hub")
    assert projected == Map.put(owner, "local_planning", false)
  end

  test "a changed execution owner cannot supply an old owner's projection or planning capability" do
    owner = row(%{})

    archive =
      row(%{
        "horizon" => "stashed",
        "updated_at" => "2026-11-04T11:00:00Z",
        "shuttle" => %{"host" => "replacement", "kind" => "oneshot"}
      })

    assert [projected] = Planning.reconcile([owner], [archive], %{"worker" => true}, "hub")
    assert projected == Map.put(owner, "local_planning", false)
  end

  test "ambiguous local-only archives cannot promise an offline save" do
    for fields <- [%{}, %{"id" => "task", "uid" => nil}] do
      first = row(fields) |> Map.put("felt_store", "/first")
      second = row(fields) |> Map.put("felt_store", "/second")
      projected = Planning.reconcile([], [first, second], %{}, "hub")
      assert length(projected) == 2
      assert Enum.all?(projected, &(&1["local_planning"] == false))
      assert [%{"local_planning" => true}] = Planning.reconcile([], [first], %{}, "hub")
    end
  end

  test "a removed owner's local-only document remains addressed to that owner" do
    archive = row(%{"horizon" => "stashed"})

    assert [%{"origin" => "worker"}] =
             Planning.reconcile([], [archive], %{}, "hub")
  end
end
