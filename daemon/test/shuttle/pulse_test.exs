defmodule Shuttle.PulseTest do
  use ExUnit.Case, async: true

  alias Shuttle.{Dispatcher, Pulse}
  alias Shuttle.Test.Env

  @now ~U[2026-11-02 07:00:00Z]

  defp fiber(status \\ "active") do
    %{
      "id" => "seats/watch",
      "uid" => "watch-uid",
      "status" => status,
      "shuttle" => %{
        "kind" => "oneshot",
        "host" => "test-host",
        "pulse" => "59m",
        "resolved" => %{"pulse_interval_ms" => 3_540_000, "agent" => %{"cli" => "claude"}},
        "runtime" => %{
          "session_uuid" => "conversation",
          "dispatched_at" => "2026-11-01T10:00:00Z"
        }
      }
    }
  end

  test "the clock survives reload, skips without catch-up, and pause disarms it", %{} do
    pulses = Pulse.reconcile(%{}, [fiber()], "test-host", @now)

    assert %{"next_tick" => "2026-11-02T07:59:00.000Z", "last_tick" => nil} =
             pulses["watch-uid"]

    refute Pulse.due?(pulses["watch-uid"], @now)
    late = ~U[2026-11-02 14:00:00Z]
    assert Pulse.due?(pulses["watch-uid"], late)
    skipped = Pulse.advance(pulses, fiber(), late)
    assert skipped["watch-uid"]["next_tick"] == "2026-11-02T14:59:00.000Z"
    assert skipped["watch-uid"]["last_tick"] == nil
    assert Pulse.reconcile(skipped, [fiber()], "test-host", late) == skipped
    paused = Pulse.reconcile(skipped, [fiber("open")], "test-host", late)
    assert %{"next_tick" => nil, "state" => "paused"} = paused["watch-uid"]
    refute Pulse.due?(paused["watch-uid"], late)
    assert Pulse.reconcile(paused, [fiber()], "other-host", late) == %{}
    resumed = Pulse.reconcile(paused, [fiber()], "test-host", late)
    assert resumed["watch-uid"]["next_tick"] == "2026-11-02T14:59:00.000Z"
  end

  @tag :tmp_dir
  test "operational persistence keeps the previous delivered tick and next deadline", %{
    tmp_dir: tmp
  } do
    Env.put_env("SHUTTLE_DATA_DIR", tmp)

    pulses =
      Pulse.reconcile(%{}, [fiber()], "test-host", @now) |> Pulse.delivered("watch-uid", @now)

    assert :ok = Pulse.save(pulses)
    assert Pulse.load() == pulses
    message = Pulse.message(pulses["watch-uid"], DateTime.add(@now, 3540))
    assert message =~ "Shuttle pulse."
    assert message =~ "Previous pulse: 2026-11-02T07:00:00Z"
    assert message =~ "end the turn quietly"
  end

  test "active windows use local time, exclude their end, and support overnight and DST" do
    day = %{"start" => "08:00", "end" => "20:00", "tz" => "Europe/Paris"}
    assert Pulse.in_window?(day, @now)
    refute Pulse.in_window?(day, ~U[2026-11-02 19:00:00Z])
    assert Pulse.next_tick(%{window: day}, ~U[2026-11-02 19:00:00Z]) == "2026-11-03T07:00:00Z"
    night = %{day | "start" => "22:00", "end" => "06:00"}
    assert Pulse.in_window?(night, ~U[2026-11-02 23:00:00Z])
    assert Pulse.in_window?(night, ~U[2026-11-03 04:59:59Z])
    refute Pulse.in_window?(night, ~U[2026-11-03 05:00:00Z])
    spring = %{day | "start" => "02:30", "end" => "04:00"}
    assert Pulse.next_tick(%{window: spring}, ~U[2026-03-29 00:00:00Z]) == "2026-03-29T01:00:00Z"
    fall = %{day | "start" => "02:00", "end" => "03:00"}
    assert Pulse.in_window?(fall, ~U[2026-10-25 00:30:00Z])
    assert Pulse.in_window?(fall, ~U[2026-10-25 01:30:00Z])
  end

  test "a dormant pulse resumes a cold session but a handoff starts its successor" do
    opts = [resume_mode: "pulse", transcript: fn _ -> nil end, now: @now]
    assert Dispatcher.check_resume_intent(fiber(), opts) == {:previous, "conversation"}
    handed = put_in(fiber(), ["shuttle", "runtime", "handed_off_at"], "2026-11-01T11:00:00Z")
    assert Dispatcher.check_resume_intent(handed, opts) == :fresh
    row = Pulse.reconcile(%{}, [fiber()], "test-host", @now)["watch-uid"]
    assert Pulse.dormant_wait?(fiber(), row, @now)
    refute Pulse.dormant_wait?(handed, row, @now)
  end

  test "an unsupported pulse cannot hold a dormant session from ordinary dispatch" do
    unsupported = put_in(fiber(), ["shuttle", "resolved", "agent", "cli"], "pi")
    row = Pulse.reconcile(%{}, [unsupported], "test-host", @now)["watch-uid"]

    assert row["state"] == "unsupported"
    refute Pulse.dormant_wait?(unsupported, row, @now)
  end

  test "one pending tick survives reconciliation until a fresh idle event, and handoff clears it" do
    pulses =
      Pulse.reconcile(%{}, [fiber()], "test-host", @now)
      |> Pulse.reserve("watch-uid", "conversation", "conversation", @now)

    later = DateTime.add(@now, 7200)
    assert Pulse.reconcile(pulses, [fiber()], "test-host", later) == pulses
    refute Pulse.due?(pulses["watch-uid"], later)
    stale = %{"conversation" => %{phase: "waiting", last_event_at: DateTime.to_unix(@now, :millisecond)}}
    assert Pulse.observe(pulses, [fiber()], stale, [], later) == pulses
    fresh = put_in(stale, ["conversation", :last_event_at], DateTime.to_unix(later, :millisecond))
    assert Pulse.observe(pulses, [fiber()], fresh, ["watch-uid"], later) == pulses
    released = Pulse.observe(pulses, [fiber()], fresh, [], later)
    assert released["watch-uid"]["pending"] == nil
    assert released["watch-uid"]["state"] == "scheduled"
    refute Pulse.due?(released["watch-uid"], later)

    handed = put_in(fiber(), ["shuttle", "runtime", "handed_off_at"], "2026-11-02T08:00:00Z")
    assert Pulse.reconcile(pulses, [handed], "test-host", later)["watch-uid"]["pending"] == nil
    assert Pulse.reconcile(pulses, [fiber("open")], "test-host", later)["watch-uid"]["pending"] == nil
  end

  test "the feed carries timing outside frontmatter and holds hide its deadline" do
    pulses = Pulse.reconcile(%{}, [fiber()], "test-host", @now)
    assert [%{"next_tick" => nil, "state" => "held"}] = Pulse.rows(pulses, true)

    reserved = Pulse.reserve(pulses, "watch-uid", "conversation", "conversation", @now)
    assert [%{"next_tick" => nil, "state" => "held"}] = Pulse.rows(reserved, true)

    assert [%{fiber: f, pulse: %{"next_tick" => "2026-11-02T07:59:00.000Z"}}] =
             Pulse.stamp([%{fiber: fiber()}], Pulse.rows(pulses))

    refute Map.has_key?(f, "pulse")
    assert f == fiber()
  end
end
