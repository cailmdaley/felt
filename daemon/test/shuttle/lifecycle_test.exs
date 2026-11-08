defmodule Shuttle.LifecycleTest do
  use ExUnit.Case, async: true

  alias Shuttle.Lifecycle

  @now 1_792_324_800_000
  @ask %{"text" => "OK to adopt the estimator?", "at" => "2026-10-18T10:00:00Z"}

  defp active(shuttle \\ %{}),
    do: %{"status" => "active", "shuttle" => Map.merge(%{"kind" => "oneshot"}, shuttle)}

  defp turn(fiber, runtime, error \\ nil),
    do: Lifecycle.turn(fiber, runtime != nil, runtime, error, @now)

  describe "turn/5" do
    test "reads each worker phase" do
      for {name, fiber, runtime, want} <- [
            {"a question asked while working", active(%{"ask" => @ask}),
             %{state: "running", phase: "working"}, "question"},
            {"a harness prompt", active(), %{state: "running", phase: "attention"}, "question"},
            {"a blocked worker", active(), %{state: "blocked"}, "blocked"},
            {"a launch error over cached activity", active(),
             %{state: "running", phase: "waiting", launch_error: "failed"}, "blocked"},
            {"failed attribution", active(), %{state: "running", phase: "identity_failed"},
             "blocked"},
            {"an ended turn", active(), %{state: "running", phase: "waiting"}, "idle"},
            {"work in progress", active(), %{state: "running", phase: "working"}, "working"},
            {"an identity being acquired", active(),
             %{state: "running", phase: "identity_pending"}, "starting"},
            {"a fresh launch with no hook yet", active(),
             %{state: "running", started_at: @now - 60_000}, "starting"},
            {"an old launch with no hook", active(),
             %{state: "running", started_at: @now - 20 * 3_600_000}, "no-signal"},
            {"a remote row's string keys", active(),
             %{"state" => "running", "phase" => "attention"}, "question"}
          ] do
        assert {name, turn(fiber, runtime)} == {name, want}
      end
    end

    test "a launch refused before any worker is the human's to repair" do
      assert turn(active(), nil, "no project_dir") == "blocked"
    end

    test "counts an ask only on an active constitution, and only with words" do
      assert turn(active(%{"ask" => @ask}), nil) == "question"
      assert turn(%{"status" => "closed", "shuttle" => %{"ask" => @ask}}, nil) == "none"
      assert turn(active(%{"ask" => %{"text" => "  "}}), nil) == "none"
    end

    test "dates a launch from its dispatch stamp when the runtime has none" do
      fiber =
        active(%{
          "runtime" => %{
            "dispatched_at" =>
              DateTime.from_unix!(@now - 60_000, :millisecond) |> DateTime.to_iso8601()
          }
        })

      assert turn(fiber, %{state: "running"}) == "starting"
    end
  end

  test "stamp/2 serves every constitution its column and turn, live by its runtime" do
    now = DateTime.from_unix!(@now, :millisecond)
    draft = %{"status" => "open", "shuttle" => %{"kind" => "oneshot"}}
    note = %{"status" => "open", "tags" => ["cycle"]}

    assert [
             %{column: "in_flight", turn: "idle"},
             %{column: "in_flight", turn: "blocked"},
             %{column: "drafts", turn: "none"},
             stamped_note
           ] =
             Lifecycle.stamp(
               [
                 %{fiber: draft, runtime: %{state: "running", phase: "waiting"}},
                 %{fiber: active(), dispatch_error: "refused"},
                 %{fiber: draft},
                 %{fiber: note}
               ],
               now
             )

    assert stamped_note == %{fiber: note}
  end
end
