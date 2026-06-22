defmodule Shuttle.StandingRoleTest do
  use ExUnit.Case, async: true

  alias Shuttle.StandingRole

  @now ~U[2026-06-02 10:00:30Z]

  # felt is the cron authority (Stage 4b): it inlines resolved.{prev_due,next_due}
  # on every read and the daemon reads those, never parsing cron. This helper
  # builds a role the way felt's `show -j` presents it — a schedule (carried for
  # the snapshot's display only, never parsed) plus the two resolved occurrences
  # that drive every timing decision. `prev_s`/`next_s` place those occurrences
  # relative to @now; `overrides` merge over the base block (a stray review key,
  # kind: oneshot, an empty resolved standing in for an unparseable schedule).
  defp iso(offset_s), do: DateTime.to_iso8601(DateTime.add(@now, offset_s, :second))

  defp role(prev_s \\ -30, next_s \\ 30, overrides \\ %{}) do
    base = %{
      "kind" => "standing",
      "schedule" => %{"expr" => "* * * * *", "tz" => "Europe/Paris"},
      "resolved" => %{"prev_due" => iso(prev_s), "next_due" => iso(next_s)}
    }

    {:ok, role} = StandingRole.from_map("f", Map.merge(base, overrides))
    role
  end

  # The schedule-derived display phase is resolved-occurrence + liveness only.
  # Paused/draft is a document fact (`status: open`) surfaced by the kanban
  # classifier, not a StandingRole phase — `state/3` answers only the schedule
  # question for an armed role.
  describe "schedule-derived phase (resolved occurrences + liveness)" do
    test "an armed role whose last tick is recent is due" do
      # prev_due 30s before now sits inside the 90s display window.
      assert StandingRole.state(role(-30), @now, false) == "due"
    end

    test "an armed role whose last tick is older than the window is scheduled, not due" do
      # prev_due 10 min ago is outside the 90s window; the next tick is tomorrow.
      assert StandingRole.state(role(-600, 80_000), @now, false) == "scheduled"
    end

    test "a live worker reads running regardless of schedule" do
      assert StandingRole.state(role(-30), @now, true) == "running"
    end
  end

  describe "due_by_cron? — the dispatch gate: prev_due > now - window_ms" do
    @window_ms 90_000

    test "a role whose last tick fell inside the lookback is due" do
      # prev_due 30s ago sits inside the 90s window → due.
      assert StandingRole.due_by_cron?(role(-30), @now, @window_ms)
    end

    test "a role whose last tick fell before the lookback is not due" do
      # prev_due 5 min ago is outside the 90s window — the tick was already
      # serviced (missed ticks before the last service are skipped).
      refute StandingRole.due_by_cron?(role(-300), @now, @window_ms)
    end

    test "due-ness is the occurrence + the doc, never a review axis" do
      # The dispatch gate is purely prev_due vs the lookback (and the poller's
      # document status/tempered check before it). A leftover review key in the
      # block has no effect.
      with_stray_review =
        role(-30, 30, %{"review" => %{"state" => "awaiting", "run_id" => "adhoc-1"}})

      assert StandingRole.due_by_cron?(with_stray_review, @now, @window_ms)
    end

    test "a missed tick IS replayed when the lookback reaches it (catch-up)" do
      # The live system anchors the lookback at the role's last service, so a tick
      # the daemon slept through is caught however late: prev_due 5 min ago with a
      # 6 min lookback (spanning the last service) is due — the catch-up that fires
      # a Friday-08:00 chase when the laptop wakes later.
      assert StandingRole.due_by_cron?(role(-300), @now, 6 * 60 * 1000)
    end

    test "an invalid role is never due" do
      # mode must be standing; a oneshot block fails validation.
      refute StandingRole.due_by_cron?(role(-30, 30, %{"kind" => "oneshot"}), @now, @window_ms)
    end

    test "a role felt resolved no occurrence for (unparseable schedule) is not due" do
      # felt emits no resolved.next_due/prev_due when the cron won't parse →
      # next_due_at/prev_due nil → not dispatchable → not due.
      refute StandingRole.due_by_cron?(role(-30, 30, %{"resolved" => %{}}), @now, @window_ms)
    end
  end

  describe "next_due_from_cron — display next_due is felt's resolved next_due" do
    test "returns felt's resolved next occurrence" do
      # next_due placed 30s after now; next_due_from_cron reads it straight off
      # the block (the `now` arg is unused — felt computed the occurrence).
      role = role(-30, 30)
      assert %DateTime{} = next = StandingRole.next_due_from_cron(role, @now)
      assert DateTime.compare(next, DateTime.add(@now, 30, :second)) == :eq
    end

    test "returns nil when felt resolved no schedule" do
      role = role(-30, 30, %{"resolved" => %{}})
      assert StandingRole.next_due_from_cron(role, @now) == nil
    end
  end

  describe "dispatch_run_id — a fresh display label every dispatch" do
    @resume_now ~U[2026-06-05 16:04:19Z]

    test "agrees with next_run_id — the id is no longer load-bearing for resume continuity" do
      # Continuation is decided from the per-host dispatch/handoff markers, not
      # parsed from this id. The id is a fresh label every dispatch.
      role = role()

      assert StandingRole.dispatch_run_id(role, @resume_now) ==
               StandingRole.next_run_id(role, @resume_now)
    end

    test "a stray review.run_id in the block does not pin the id" do
      with_stray_review =
        role(-30, 30, %{"review" => %{"state" => "scheduled", "run_id" => "20260605T070000+0000"}})

      refute StandingRole.dispatch_run_id(with_stray_review, @resume_now) == "20260605T070000+0000"

      assert StandingRole.dispatch_run_id(with_stray_review, @resume_now) ==
               StandingRole.next_run_id(with_stray_review, @resume_now)
    end
  end
end
