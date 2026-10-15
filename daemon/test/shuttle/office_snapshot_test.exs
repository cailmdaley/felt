defmodule Shuttle.OfficeSnapshotTest do
  use ExUnit.Case, async: true

  alias Shuttle.Poller.{Snapshot, State}

  test "snapshot rows project the office and boolean seat from cached shuttle fields" do
    for {shuttle, role, seat} <- [
          {%{"role" => "gardener", "seat" => true}, "gardener", true},
          {%{"role" => "gardener", "seat" => false}, "gardener", false},
          {%{"seat" => "gardener"}, nil, false},
          {%{}, nil, false}
        ] do
      state = %State{
        document_cache: %{
          "office" => %{
            entry: %{
              fiber: %{
                "id" => "tests/office",
                "role" => "ignored",
                "seat" => true,
                "shuttle" => shuttle
              }
            }
          }
        },
        parked_launches: %{
          "office" => %{fiber_id: "tests/office", uid: nil, parked_at: DateTime.utc_now()}
        }
      }

      assert %{pending_launch: [row]} = Snapshot.build_snapshot(state)
      assert row.role == role
      assert row.seat === seat
      refute Map.has_key?(row, :collaboration)
    end
  end
end
