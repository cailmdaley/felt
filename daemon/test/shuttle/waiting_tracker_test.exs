defmodule Shuttle.WaitingTrackerTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Shuttle.WaitingTracker, as: Tracker

  @now 1_000_000_000_000
  @hour 60 * 60 * 1_000

  defp event(type, id \\ "session-a", attrs \\ %{}) do
    Map.merge(%{"type" => type, "sessionId" => id, "timestamp" => @now}, attrs)
  end

  defp phase(sessions, id, now \\ @now), do: Tracker.phases(sessions, now)[id].phase
  defp fold(events), do: Enum.reduce(events, %{}, &Tracker.apply_event(&2, &1, @now))

  test "session identity is required and does not depend on tmux naming" do
    sessions =
      %{}
      |> Tracker.apply_event(
        event("stop", "raw-session-id", %{"tmuxSession" => "not-shuttle"}),
        @now
      )
      |> Tracker.apply_event(event("stop", "unknown"), @now)
      |> Tracker.apply_event(%{"type" => "stop", "tmuxSession" => "orphan"}, @now)

    assert Map.keys(sessions) == ["raw-session-id"]
    assert phase(sessions, "raw-session-id") == "waiting"
  end

  # Mutation: key apply_event/3 by tmuxSession to make this isolation law fail.
  property "other sessions in the worker's pane cannot change its state or timestamp" do
    check all(
            types <-
              list_of(
                member_of([
                  "session_start",
                  "pre_tool_use",
                  "post_tool_use",
                  "user_prompt_submit",
                  "notification",
                  "stop",
                  "subagent_stop",
                  "session_end"
                ]),
                max_length: 40
              ),
            max_runs: 100
          ) do
      pane = "worker-01J00000000000000000000000-shuttle"
      parent = event("stop", "worker", %{"tmuxSession" => pane, "timestamp" => @now - 1})
      initial = fold([parent])

      result =
        Enum.reduce(types, initial, fn type, sessions ->
          Tracker.apply_event(
            sessions,
            event(type, "nested-probe", %{"tmuxSession" => pane, "harness" => "codex"}),
            @now
          )
        end)

      assert result["worker"] == initial["worker"]

      assert Tracker.phases(result, @now)["worker"] ==
               %{phase: "waiting", last_event_at: @now - 1}
    end
  end

  test "turn transitions derive working, waiting, attention, and terminal states" do
    sessions = fold([event("session_start"), event("pre_tool_use"), event("stop")])
    assert phase(sessions, "session-a") == "waiting"

    sessions = Tracker.apply_event(sessions, event("notification"), @now)
    assert phase(sessions, "session-a") == "attention"

    sessions = Tracker.apply_event(sessions, event("pre_tool_use"), @now)
    assert phase(sessions, "session-a") == "working"

    sessions = Tracker.apply_event(sessions, event("session_end"), @now)
    assert phase(sessions, "session-a") == "waiting"
    assert sessions["session-a"].turn == :ended

    sessions = Tracker.apply_event(sessions, event("pre_tool_use"), @now + 1)
    assert sessions["session-a"].turn == :ended
    assert phase(sessions, "session-a", @now + 1) == "waiting"
  end

  test "idle notification closes the turn without clearing an existing permission" do
    sessions =
      fold([event("notification", "session-a", %{"notificationKind" => "permission_prompt"})])

    assert phase(sessions, "session-a") == "attention"

    sessions =
      Tracker.apply_event(
        sessions,
        event("notification", "session-a", %{"notificationKind" => "idle_prompt"}),
        @now + 1
      )

    assert phase(sessions, "session-a") == "attention"

    sessions = Tracker.apply_event(sessions, event("pre_tool_use"), @now + 2)
    assert phase(sessions, "session-a") == "working"
  end

  test "prompts and starts clear background work; stop restates it and clears pending" do
    sessions = fold([event("stop", "session-a", %{"backgroundTasks" => 2})])
    assert phase(sessions, "session-a") == "working"

    sessions = Tracker.apply_event(sessions, event("notification"), @now + 1)

    sessions =
      Tracker.apply_event(
        sessions,
        event("stop", "session-a", %{"backgroundTasks" => 1}),
        @now + 2
      )

    assert phase(sessions, "session-a") == "working"

    sessions = Tracker.apply_event(sessions, event("user_prompt_submit"), @now + 3)
    assert sessions["session-a"].bg == 0
    assert phase(sessions, "session-a") == "working"

    sessions = Tracker.apply_event(sessions, event("session_start"), @now + 4)
    assert sessions["session-a"].kids == 0
    assert sessions["session-a"].bg == 0
  end

  test "Codex child activity holds a closed turn and only the final return advances its time" do
    spawn1 =
      event("post_tool_use", "parent", %{
        "harness" => "codex",
        "tool" => "collaborationspawn_agent",
        "id" => "spawn-1"
      })

    spawn2 = %{spawn1 | "id" => "spawn-2"}
    sessions = fold([spawn1, spawn2, event("stop", "parent", %{"harness" => "codex"})])
    assert sessions["parent"].kids == 2

    child_tool =
      event("pre_tool_use", "parent", %{
        "harness" => "codex",
        "tool" => "Bash",
        "timestamp" => @now + 1
      })

    sessions = Tracker.apply_event(sessions, child_tool, @now + 1)
    assert sessions["parent"].turn == :closed
    assert phase(sessions, "parent", @now + 1) == "working"

    done =
      event("subagent_stop", "parent", %{
        "harness" => "codex",
        "id" => "done-1",
        "timestamp" => @now + 2
      })

    sessions = Tracker.apply_event(sessions, done, @now + 2)
    assert sessions["parent"].kids == 1
    assert sessions["parent"].at == @now + 1

    # Replaying an identified stop cannot retire another child.
    sessions = Tracker.apply_event(sessions, done, @now + 3)
    assert sessions["parent"].kids == 1

    final = %{done | "id" => "done-2", "timestamp" => @now + 4}
    sessions = Tracker.apply_event(sessions, final, @now + 4)
    assert sessions["parent"].kids == 0
    assert sessions["parent"].at == @now + 4
    assert phase(sessions, "parent", @now + 4) == "waiting"
  end

  test "Codex start resets children; prompts preserve them; end clears them" do
    spawn =
      event("post_tool_use", "p", %{
        "harness" => "codex",
        "tool" => "collaborationfollowup_task",
        "id" => "s1"
      })

    sessions = fold([spawn, event("user_prompt_submit", "p", %{"harness" => "codex"})])
    assert sessions["p"].kids == 1

    sessions =
      Tracker.apply_event(sessions, event("session_start", "p", %{"harness" => "codex"}), @now)

    assert sessions["p"].kids == 0

    sessions = Tracker.apply_event(sessions, spawn, @now)

    sessions =
      Tracker.apply_event(sessions, event("session_end", "p", %{"harness" => "codex"}), @now)

    assert sessions["p"].kids == 0
    assert phase(sessions, "p") == "waiting"
  end

  test "background and child suppression expire after an hour, but permission remains attention" do
    bg = fold([event("stop", "bg", %{"backgroundTasks" => 1})])
    assert phase(bg, "bg", @now + @hour - 1) == "working"
    assert phase(bg, "bg", @now + @hour) == "waiting"

    codex =
      fold([
        event("post_tool_use", "kid", %{
          "harness" => "codex",
          "tool" => "collaborationspawn_agent",
          "id" => "spawn"
        }),
        event("stop", "kid", %{"harness" => "codex"})
      ])

    assert phase(codex, "kid", @now + @hour) == "waiting"

    codex =
      Tracker.apply_event(
        codex,
        event("notification", "kid", %{
          "harness" => "codex",
          "notificationKind" => "permission_prompt"
        }),
        @now + @hour
      )

    assert phase(codex, "kid", @now + @hour * 2) == "attention"
  end

  test "timestamps never regress; file_sent and unknown event types are inert" do
    sessions = fold([event("stop", "a", %{"timestamp" => @now + 5})])

    sessions =
      Tracker.apply_event(sessions, event("pre_tool_use", "a", %{"timestamp" => @now}), @now)

    assert sessions["a"].at == @now + 5
    assert sessions["a"].turn == :open

    unchanged =
      sessions
      |> Tracker.apply_event(event("file_sent", "a", %{"timestamp" => @now + 10}), @now + 10)
      |> Tracker.apply_event(event("future_hook", "a", %{"timestamp" => @now + 10}), @now + 10)

    assert unchanged == sessions
  end

  test "prune and merge_known preserve the freshest known state" do
    old = fold([event("stop", "old", %{"timestamp" => @now - 49 * @hour})])
    fresh = fold([event("stop", "fresh", %{"timestamp" => @now})])
    assert Tracker.prune(Map.merge(old, fresh), @now) == fresh
    assert Tracker.merge_known(fresh, old)["fresh"] == fresh["fresh"]
    assert Tracker.merge_known(fresh, old)["old"] == old["old"]
  end
end
