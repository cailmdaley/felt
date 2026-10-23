defmodule Shuttle.AppWorkerOwnerTest do
  use ExUnit.Case, async: true

  test "unsafe native IDs are rejected before record lookup" do
    for id <- ["../thread-1", "thread.1", "", "/thread-1"] do
      assert {:error, :invalid_session_id} = Shuttle.AppWorkers.check_endpoint(id)
      assert {:error, :invalid_session_id} = Shuttle.AppWorkers.check_known_endpoint(id)
    end
  end

  test "native messaging and daemon share the read-only owner projection" do
    cases =
      Path.join([__DIR__, "..", "fixtures", "app_worker_owners.json"])
      |> File.read!()
      |> Jason.decode!()

    for row <- cases do
      actual =
        case Shuttle.AppWorkers.check_owner(
               row["record"],
               row["requested_id"],
               row["host"],
               row["socket"]
             ) do
          :ok -> "ok"
          {:error, reason} -> Atom.to_string(reason)
        end

      assert actual == row["expected"], row["name"]
    end
  end
end
