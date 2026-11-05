defmodule Shuttle.OwnerExitTest do
  use ExUnit.Case, async: true
  alias Shuttle.OwnerExit
  alias Shuttle.Test.Env
  @uid "01ARZ3NDEKTSV4RRFFQ69G5FAX"

  setup do
    Env.put_app_env(:remotes, [%Shuttle.Remote{name: "worker", url: "http://127.0.0.1:1"}])
    :ok
  end

  test "the shared state table distinguishes quiescence from execution evidence" do
    cases =
      Path.join([__DIR__, "..", "fixtures", "planning", "states.json"])
      |> File.read!()
      |> Jason.decode!()

    for %{"name" => name, "fiber" => fiber, "quiescent" => expected} <- cases do
      assert OwnerExit.quiescent?(fiber) == expected, name
    end

    refute OwnerExit.quiescent?(%{
             "shuttle" => %{
               "runtime" => %{
                 "dispatched_at" => "2026-11-04T10:00:00",
                 "handed_off_at" => "2026-11-04T11:00:00"
               }
             }
           })
  end

  defp row(fields \\ %{}) do
    %{
      "origin" => "worker",
      "felt_store" => "/owner",
      "path" => "team/task/task.md",
      "fiber" =>
        Map.merge(
          %{
            "id" => @uid,
            "uid" => @uid,
            "status" => "open",
            "name" => "Owner content",
            "outcome" => "Owner result",
            "updated_at" => "2026-11-04T10:00:00Z",
            "shuttle" => %{"host" => "worker", "kind" => "oneshot"}
          },
          fields
        )
    }
  end

  defp mirror(fields \\ %{}) do
    row(
      Map.merge(
        %{
          "shuttle" => %{
            "host" => "worker",
            "kind" => "oneshot",
            "runtime" => %{"mirrored_at" => "2026-11-04T11:00:00Z"}
          }
        },
        fields
      )
    )
    |> Map.put("felt_store", "/archive")
  end

  test "only a newer mirror stamp projects exit fields, preserving owner addresses, content and configuration" do
    owner =
      row(%{"tempered" => true, "status" => "closed", "due" => "2026-12-01", "cold" => true})

    archive =
      mirror(%{
        "horizon" => "stashed",
        "status" => "open",
        "name" => "Archive body",
        "outcome" => "Local result"
      })

    assert [
             %{
               "origin" => "worker",
               "felt_store" => "/owner",
               "fiber" => fiber,
               "local_exit" => true
             }
           ] =
             OwnerExit.reconcile([owner], [archive], %{"worker" => true}, "hub")

    assert fiber["status"] == "open"
    assert fiber["horizon"] == "stashed"
    refute Map.has_key?(fiber, "tempered")
    assert fiber["outcome"] == "Owner result"
    assert fiber["name"] == "Owner content"
    assert fiber["due"] == "2026-12-01"
    assert fiber["cold"] == true
  end

  test "a body-only edit cannot reopen owner review or replace its outcome" do
    owner = row(%{"status" => "closed"})

    archive =
      row(%{
        "status" => "open",
        "outcome" => "Not authoritative",
        "updated_at" => "2026-11-04T12:00:00Z"
      })

    assert [%{"fiber" => fiber, "exit_copy_pending" => false}] =
             OwnerExit.reconcile([owner], [archive], %{"worker" => true}, "hub")

    assert fiber == owner["fiber"]
  end

  test "a returning healthy owner wins before Git sync and exposes the waiting copy" do
    owner = row()

    assert [%{"fiber" => fiber, "exit_copy_pending" => true}] =
             OwnerExit.reconcile(
               [owner],
               [mirror(%{"horizon" => "stashed"})],
               %{"worker" => false},
               "hub"
             )

    assert fiber == owner["fiber"]
    # A local-only document absent on that healthy owner is not a live phantom.
    assert [] == OwnerExit.reconcile([], [mirror()], %{"worker" => false}, "hub")
  end

  test "Git synchronization acknowledges the same mirror stamp even with an older document date" do
    [row] =
      OwnerExit.reconcile(
        [mirror()],
        [mirror(%{"horizon" => "stashed"})],
        %{"worker" => false},
        "hub"
      )

    refute row["exit_copy_pending"]
    refute Map.has_key?(row["fiber"], "horizon")
  end

  test "equal or older mirror stamps, armed copies and known owner workers do not project" do
    for {owner, copy} <- [
          {row(%{"modified_at" => "2026-11-04T11:00:00Z"}), mirror(%{"horizon" => "stashed"})},
          {row(), mirror(%{"status" => "active", "horizon" => "stashed"})},
          {row(%{"status" => "active"}), mirror(%{"horizon" => "stashed"})},
          {Map.put(row(), "runtime", %{"state" => "running"}), mirror(%{"horizon" => "stashed"})}
        ] do
      assert [%{"fiber" => fiber}] =
               OwnerExit.reconcile([owner], [copy], %{"worker" => true}, "hub")

      assert fiber == owner["fiber"]
    end
  end

  test "UID, execution host and unique physical copy constrain the capability" do
    owner = row()

    for copies <- [
          [mirror(%{"uid" => nil, "id" => "task"})],
          [mirror(%{"shuttle" => %{"host" => "replacement", "kind" => "oneshot"}})],
          [mirror(), Map.put(mirror(), "felt_store", "/duplicate")]
        ] do
      [projected | _] = OwnerExit.reconcile([owner], copies, %{"worker" => true}, "hub")
      assert projected["fiber"] == owner["fiber"]
      refute projected["local_exit"]
    end

    copy = row(%{"uid" => nil, "id" => "task"})
    assert [%{"local_exit" => false}] = OwnerExit.reconcile([], [copy], %{}, "hub")
  end

  test "scheduled standing work needs its owner; a proven removed owner may retire" do
    fiber =
      row()["fiber"]
      |> put_in(["shuttle", "kind"], "standing")
      |> put_in(["shuttle", "schedule"], %{"expr" => "0 9 * * *"})

    refute OwnerExit.eligible?(fiber)
    refute OwnerExit.eligible?(update_in(fiber, ["shuttle"], &Map.delete(&1, "schedule")))
    Env.put_app_env(:remotes, [])
    assert OwnerExit.eligible?(fiber)
    assert OwnerExit.eligible?(Map.put(fiber, "status", "active"))

    for runtime <- [nil, [], "unknown"] do
      assert OwnerExit.eligible?(put_in(fiber, ["shuttle", "runtime"], runtime))
    end
  end

  test "absence requires a complete fleet, no configured entry, and neither peers nor rejected candidates" do
    doc = %{"remotes" => []}
    report = %{state: "ok", peers: [], rejected: []}
    policy = OwnerExit.policy(doc, report, nil, [])
    assert OwnerExit.removed?("worker", policy)
    assert OwnerExit.eligible?(row(%{"status" => "active"})["fiber"], policy)

    for {doc, report} <- [
          {%{"remotes" => [%{"name" => "worker", "enabled" => false}]}, report},
          {doc, %{report | state: "pending"}},
          {doc, %{report | state: "unavailable"}},
          {doc, %{report | peers: [%{"name" => "worker"}]}},
          {doc, %{report | rejected: [%{dns_name: "worker.example.ts.net.", reason: "offline"}]}},
          {nil, report}
        ] do
      policy = OwnerExit.policy(doc, report, nil, [])
      refute OwnerExit.removed?("worker", policy)
      refute OwnerExit.eligible?(row()["fiber"], policy)
    end
  end

  test "a running owner never labels an unacknowledged local copy as a pending exit" do
    for owner <- [
          row(%{"status" => "active"}),
          Map.put(row(), "runtime", %{"state" => "running"})
        ] do
      [result] =
        OwnerExit.reconcile(
          [owner],
          [mirror(%{"horizon" => "stashed"})],
          %{"worker" => false},
          "hub"
        )

      refute result["exit_copy_pending"]
      assert result["fiber"] == owner["fiber"]
    end
  end

  test "a zero owner document time cannot acknowledge a newer local intent" do
    owner = row(%{"modified_at" => "0001-01-01T00:00:00Z"})

    [result] =
      OwnerExit.reconcile(
        [owner],
        [mirror(%{"horizon" => "stashed"})],
        %{"worker" => true},
        "hub"
      )

    assert result["fiber"] == owner["fiber"]
  end

  @tag :tmp_dir
  test "incomplete discovery is not removal; a closed fleet proves it", %{tmp_dir: tmp} do
    path = Path.join(tmp, "remotes.json")
    Env.delete_app_env(:remotes)
    Env.put_env("SHUTTLE_REMOTES_FILE", path)
    File.write!(path, ~s({"version":1,"remotes":[]}))
    refute OwnerExit.removed?("worker")
    File.write!(path, ~s({"version":1,"defaults":{"discover":false},"remotes":[]}))
    assert OwnerExit.removed?("worker")
  end
end
