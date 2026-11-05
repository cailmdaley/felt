defmodule Shuttle.OwnerExitTest do
  use ExUnit.Case, async: true
  alias Shuttle.OwnerExit
  alias Shuttle.Test.Env
  @uid "01ARZ3NDEKTSV4RRFFQ69G5FAX"

  setup do
    remote = %Shuttle.Remote{name: "worker", url: "http://127.0.0.1:1"}
    Env.put_app_env(:remotes, [remote])

    Env.start_scoped!(
      {Shuttle.RemoteFiberRegistry,
       name: nil, remotes: [remote], auto_poll: false, store_dir: nil}
    )

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

  test "mirror exits are plain Rest, Close and Discard, never Pause or rest --until" do
    for params <- [
          %{"action" => "rest"},
          %{"action" => "close"},
          %{"action" => "close", "tempered" => false}
        ],
        do: assert(OwnerExit.action?(params))

    for params <- [
          %{"action" => "pause"},
          %{"action" => "pause", "no_kill" => true},
          %{"action" => "pause", "until" => ""},
          %{"action" => "rest", "until" => ""},
          %{"action" => "rest", "until" => "2026-12-01"},
          %{"action" => "rest", "until" => "work/blocker"},
          %{"action" => "close", "tempered" => true}
        ],
        do: refute(OwnerExit.action?(params))
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
          "shuttle-exit-at" => "2026-11-04T11:00:00Z",
          "shuttle" => %{"host" => "worker", "kind" => "oneshot"}
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

  test "a healthy composite has main's owner row set, not hostless or retired archive cards" do
    local = row() |> Map.put("origin", "hub") |> put_in(["fiber", "shuttle", "host"], "hub")
    remote = row(%{"id" => "01ARZ3NDEKTSV4RRFFQ69G5FA0", "uid" => "01ARZ3NDEKTSV4RRFFQ69G5FA0"})
    owners = [local, remote]

    archives =
      Enum.with_index([nil, "", "hub", "retired"])
      |> Enum.map(fn {host, index} ->
        id = "01ARZ3NDEKTSV4RRFFQ69G5FB#{index}"
        row(%{"id" => id, "uid" => id, "shuttle" => %{"host" => host, "kind" => "oneshot"}})
      end)

    result = OwnerExit.reconcile(owners, owners ++ archives, %{"worker" => false}, "hub")
    assert Enum.map(result, & &1["fiber"]["id"]) == Enum.map(owners, & &1["fiber"]["id"])
  end

  test "a stale composite never invents an owner row from an archive" do
    assert [] ==
             OwnerExit.reconcile(
               [],
               [mirror(%{"horizon" => "stashed"})],
               %{"worker" => true},
               "hub"
             )
  end

  test "local owner rows remain native rather than gaining mirror metadata" do
    local = row() |> Map.put("origin", "hub") |> put_in(["fiber", "shuttle", "host"], "hub")
    assert [^local] = OwnerExit.reconcile([local], [local], %{}, "hub")
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
          {Map.put(row(), "runtime", %{"state" => "running"}), mirror(%{"horizon" => "stashed"})},
          {Map.put(row(), "document_stale", true), mirror(%{"horizon" => "stashed"})}
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

    assert [] == OwnerExit.reconcile([], [copy], %{"worker" => true}, "hub")
  end

  test "an absent fleet entry never authorizes an exit, including active and standing copies" do
    Env.put_app_env(:remotes, [])

    for fields <- [
          %{},
          %{"status" => "active"},
          %{"shuttle" => %{"host" => "worker", "kind" => "standing"}},
          %{"shuttle" => %{"host" => "worker", "runtime" => %{"session_uuid" => "live"}}}
        ] do
      refute OwnerExit.eligible?(row(fields)["fiber"])
    end
  end

  test "standing work always needs its owner, with or without a schedule" do
    fiber = put_in(row()["fiber"], ["shuttle", "kind"], "standing")
    refute OwnerExit.eligible?(fiber)
    refute OwnerExit.eligible?(put_in(fiber, ["shuttle", "schedule"], %{"expr" => "0 9 * * *"}))
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
end
