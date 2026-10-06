defmodule Shuttle.StandingRoleTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Shuttle.StandingRole

  @now ~U[2026-06-02 10:00:30Z]

  # Shuttle resolves cron schedules and inlines `resolved.prev_due` and
  # `resolved.next_due` on each read; the daemon consumes those without parsing
  # cron. This helper builds a role as `shuttle show -j` presents it: a schedule
  # (carried for display only) plus the two resolved occurrences that drive
  # timing decisions. `prev_s`/`next_s` place those occurrences relative to
  # @now; `overrides` merge over the base block (a stray review key, kind:
  # oneshot, or an empty resolved map for an unparseable schedule).
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
    # The gate is purely the resolved prev_due against the lookback, strictly:
    # a tick exactly window_ms old is not due. The live system anchors the
    # lookback at the role's last service, so a tick the daemon slept through
    # is replayed however late — the catch-up that fires a Friday-08:00 chase
    # when the laptop wakes later — and a tick before the last service is
    # skipped. An invalid role (a oneshot block) or one whose schedule Shuttle
    # could not resolve (empty `resolved`) fails closed; a leftover review key
    # in the block has no effect.
    property "a valid, resolved role is due iff its last tick falls inside the lookback" do
      check all(
              prev_s <- integer(-600..0),
              # How far the lookback reaches past prev_due; > 0 is due.
              reach_ms <-
                frequency([
                  {1, constant(0)},
                  {1, member_of([-1, 1])},
                  {2, integer(-400_000..400_000)}
                ]),
              window_ms = -prev_s * 1000 + reach_ms,
              window_ms > 0,
              defect <- member_of([nil, :oneshot, :unresolved]),
              stray <-
                member_of([%{}, %{"review" => %{"state" => "awaiting", "run_id" => "a-1"}}]),
              max_runs: 100
            ) do
        overrides =
          Map.merge(
            stray,
            case defect do
              nil -> %{}
              :oneshot -> %{"kind" => "oneshot"}
              :unresolved -> %{"resolved" => %{}}
            end
          )

        assert StandingRole.due_by_cron?(role(prev_s, 30, overrides), @now, window_ms) ==
                 (defect == nil and reach_ms > 0),
               "prev_due #{prev_s}s, window #{window_ms}ms, defect #{inspect(defect)}, #{inspect(stray)}"
      end
    end

    test "the property's named cases, pinned" do
      stray_review = %{"review" => %{"state" => "awaiting", "run_id" => "adhoc-1"}}

      # {prev_due s, overrides, window ms, due?}
      for {prev_s, overrides, window_ms, due?} <- [
            {-30, %{}, 90_000, true},
            {-300, %{}, 90_000, false},
            {-90, %{}, 90_000, false},
            {-30, stray_review, 90_000, true},
            {-300, %{}, 6 * 60 * 1000, true},
            {-30, %{"kind" => "oneshot"}, 90_000, false},
            {-30, %{"resolved" => %{}}, 90_000, false}
          ] do
        assert StandingRole.due_by_cron?(role(prev_s, 30, overrides), @now, window_ms) == due?,
               "prev_due #{prev_s}s, window #{window_ms}ms, #{inspect(overrides)}"
      end
    end
  end

  describe "next_due_from_cron — display next_due is Shuttle's resolved next_due" do
    test "returns Shuttle's resolved next occurrence" do
      # next_due placed 30s after now; next_due_from_cron reads it straight off
      # the block (the `now` arg is unused — Shuttle computed the occurrence).
      role = role(-30, 30)
      assert %DateTime{} = next = StandingRole.next_due_from_cron(role)
      assert DateTime.compare(next, DateTime.add(@now, 30, :second)) == :eq
    end

    test "returns nil when Shuttle resolved no schedule" do
      role = role(-30, 30, %{"resolved" => %{}})
      assert StandingRole.next_due_from_cron(role) == nil
    end
  end

  describe "dispatch_run_id — a fresh display label every dispatch" do
    @resume_now ~U[2026-06-05 16:04:19Z]

    test "mints the label from Shuttle's next_due — not load-bearing for resume continuity" do
      # Continuation is decided from the per-host dispatch/handoff markers, not
      # parsed from this id. The id is Shuttle's next_due formatted for display.
      # role()'s next_due is @now + 30s = 2026-06-02 10:01:00Z.
      assert StandingRole.dispatch_run_id(role(), @resume_now) == "20260602T100100+0000"
    end

    test "a stray review.run_id in the block does not pin the id" do
      with_stray_review =
        role(-30, 30, %{"review" => %{"state" => "scheduled", "run_id" => "20260605T070000+0000"}})

      assert StandingRole.dispatch_run_id(with_stray_review, @resume_now) ==
               "20260602T100100+0000"
    end
  end
end
