defmodule ShuttleTest do
  use ExUnit.Case

  import ExUnit.CaptureIO

  test "version returns semantic version" do
    assert Shuttle.version() == "0.1.0"
  end

  test "status output includes standing role cycle state" do
    output =
      capture_io(fn ->
        Shuttle.CLI.print_status(%{
          host: "test-host",
          poll_at: 1_777_650_000_000,
          eligible: [],
          retrying: [],
          standing_roles: [
            %{
              fiber_id: "life/email-triage",
              state: "review",
              run_id: "20260502T090000+0200",
              next_due_at: nil,
              last_run_at: 1_777_650_600_000,
              validation_errors: []
            },
            %{
              fiber_id: "life/invalid-role",
              state: "scheduled",
              run_id: nil,
              next_due_at: 1_777_736_400_000,
              last_run_at: nil,
              validation_errors: ["accepted_run_id must match run_id in accepted review state"]
            }
          ]
        })
      end)

    assert output =~ "Standing roles (2):"
    assert output =~ "life/email-triage — review"
    assert output =~ "run: 20260502T090000+0200"
    assert output =~ "last run: 2026-05-01T15:50:00.000Z"
    assert output =~ "life/invalid-role — scheduled"
    assert output =~ "next due: 2026-05-02T15:40:00.000Z"
    assert output =~ "validation: accepted_run_id must match run_id in accepted review state"
  end
end
