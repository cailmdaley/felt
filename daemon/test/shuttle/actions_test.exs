defmodule Shuttle.ActionsTest do
  use ExUnit.Case, async: true

  alias Shuttle.Actions

  # Lifecycle is status + tempered. A oneshot awaits review at `status: closed`
  # + untempered; a standing constitution has no review — drafts pauses its
  # schedule, composted retires it, inFlight runs it now, and tempered ends the
  # current run of an armed one.

  describe "standing constitutions have no review" do
    @pause {"pause", %{verb: "pause"}}
    @reopen {"reopen", %{verb: "reopen"}}
    @reopen_draft {"reopen-draft", %{verb: "reopen", as_draft: true}}
    @ad_hoc {"dispatch-ad-hoc", %{verb: "dispatch", ad_hoc: true}}
    @retire {"close-composted", %{verb: "close", tempered: false}}

    # {status, tempered, running?} => drafts, inFlight, composted
    @standing_resolutions [
      {{"active", nil, false}, [@pause, @ad_hoc, @retire]},
      {{"active", nil, true}, [@pause, @pause, @retire]},
      {{"open", nil, false}, [@pause, @reopen, @retire]},
      {{"closed", false, false}, [@reopen_draft, @reopen, @retire]},
      {{"closed", nil, false}, [@reopen_draft, @reopen, @retire]}
    ]

    test "drafts, inFlight and composted resolve by state; review resolves to nothing, and temper only on an armed one" do
      for {{status, tempered, running?}, expected} <- @standing_resolutions do
        fiber =
          %{"id" => "work/standing", "status" => status, "shuttle" => %{"kind" => "standing"}}
          |> then(&if(is_nil(tempered), do: &1, else: Map.put(&1, "tempered", tempered)))

        label = "standing status=#{status} tempered=#{inspect(tempered)} running=#{running?}"

        for {target, {id, invocation}} <- Enum.zip(~w(drafts inFlight composted), expected) do
          assert Actions.resolve_transition(fiber, target, running?) ==
                   {:ok, %{id: id, invocation: invocation}},
                 "#{label} dragged to #{target} must resolve to #{id}"
        end

        assert Actions.resolve_transition(fiber, "awaitingReview", running?) ==
                 {:error, :standing_unreviewed},
               "#{label} dragged to awaitingReview must resolve to nothing"

        # Temper ends the current run of an armed one and keeps its schedule.
        if status == "active" do
          assert Actions.resolve_transition(fiber, "tempered", running?) ==
                   {:ok, %{id: "close-tempered", invocation: %{verb: "close", tempered: true}}}
        else
          assert Actions.resolve_transition(fiber, "tempered", running?) ==
                   {:error, :standing_unreviewed},
                 "#{label} dragged to tempered must resolve to nothing"
        end

        offered = fiber |> Actions.actions_for(running?) |> Enum.map(& &1.id)
        assert ("close-tempered" in offered) == (status == "active")
        refute "close-awaiting-review" in offered
      end
    end

    test "a standing constitution at rest is retired by Discard" do
      sleeping = %{
        "id" => "work/standing",
        "status" => "active",
        "horizon" => "stashed",
        "shuttle" => %{"kind" => "standing"}
      }

      assert {:ok, %{id: "close-composted", invocation: %{verb: "close", tempered: false}}} =
               Actions.resolve_transition(sleeping, "composted")
    end
  end

  test "oneshots keep the verdict terminus: running + tempered closes tempered" do
    oneshot = %{"id" => "work/once", "status" => "active", "shuttle" => %{"kind" => "oneshot"}}
    assert {:ok, %{id: "close-tempered"}} = Actions.resolve_transition(oneshot, "tempered", true)
  end

  test "oneshot transition vocabulary stays lifecycle-shaped" do
    fiber = %{
      "id" => "work/thing",
      "status" => "closed",
      "shuttle" => %{"kind" => "oneshot"}
    }

    assert {:ok, %{id: "close-tempered", invocation: %{verb: "close", tempered: true}}} =
             Actions.resolve_transition(fiber, "tempered")
  end

  test "paused oneshot drafts can be closed directly into review or verdicts" do
    fiber = %{
      "id" => "work/draft",
      "status" => "open",
      "shuttle" => %{"kind" => "oneshot"}
    }

    actions = Actions.actions_for(fiber)
    assert Enum.any?(actions, &(&1.id == "reopen"))
    assert Enum.any?(actions, &(&1.id == "close-awaiting-review"))
    assert Enum.any?(actions, &(&1.id == "close-tempered"))
    assert Enum.any?(actions, &(&1.id == "close-composted"))

    assert {:ok, %{id: "close-tempered", invocation: %{verb: "close", tempered: true}}} =
             Actions.resolve_transition(fiber, "tempered")
  end

  test "running oneshots can still be closed into review or verdict columns" do
    fiber = %{
      "id" => "work/running",
      "status" => "active",
      "shuttle" => %{"kind" => "oneshot"}
    }

    actions = Actions.actions_for(fiber, true)
    assert Enum.any?(actions, &(&1.id == "pause"))
    assert Enum.any?(actions, &(&1.id == "close-awaiting-review"))
    assert Enum.any?(actions, &(&1.id == "close-tempered"))
    assert Enum.any?(actions, &(&1.id == "close-composted"))
    refute Enum.any?(actions, &(&1.id == "reopen"))
  end

  test "armed idle oneshot dragged to inFlight force-dispatches (not reopen)" do
    # Regression for the 409 `action_not_available` bug: an armed oneshot with
    # no live worker, dragged to inFlight, means "launch it now" → dispatch-ad-hoc
    # (NOT reopen, which only applies to a closed or draft fiber). This test pins
    # the invariant: every resolved action must be present in actions_for.
    # A double dispatch is refused by `Poller.dispatch_fiber`'s own
    # `:already_running`, not by any availability gate.
    fiber = %{
      "id" => "work/idle-armed",
      "status" => "active",
      "shuttle" => %{"kind" => "oneshot"}
    }

    actions = Actions.actions_for(fiber)
    assert Enum.any?(actions, &(&1.id == "dispatch-ad-hoc"))
    assert Enum.any?(actions, &(&1.id == "pause"))
    refute Enum.any?(actions, &(&1.id == "reopen"))

    assert {:ok, %{id: resolved}} = Actions.resolve_transition(fiber, "inFlight")
    assert resolved == "dispatch-ad-hoc"
    # The invariant the bug violated: the resolved action is available.
    assert Enum.any?(actions, &(&1.id == resolved))
  end

  test "a constitution at rest takes Temper and Discard as verdicts" do
    # Resting is status: open + horizon: stashed. Its verdicts close it with
    # the verdict set; nothing arms it on the way.
    resting = %{
      "id" => "work/resting",
      "status" => "open",
      "horizon" => "stashed",
      "shuttle" => %{"kind" => "oneshot"}
    }

    assert {:ok, %{id: "close-tempered", invocation: %{verb: "close", tempered: true}}} =
             Actions.resolve_transition(resting, "tempered")

    assert {:ok, %{id: "close-composted", invocation: %{verb: "close", tempered: false}}} =
             Actions.resolve_transition(resting, "composted")
  end

  test "draft oneshot (status: open) dragged to inFlight reopens (arms it)" do
    # A draft (`status: open`) dragged out of drafts arms it via reopen
    # (→ status:active). reopen remains in actions_for for a draft.
    fiber = %{
      "id" => "work/paused-draft",
      "status" => "open",
      "shuttle" => %{"kind" => "oneshot"}
    }

    actions = Actions.actions_for(fiber)
    assert Enum.any?(actions, &(&1.id == "reopen"))
    refute Enum.any?(actions, &(&1.id == "dispatch-ad-hoc"))

    assert {:ok, %{id: "reopen", invocation: %{verb: "reopen"}}} =
             Actions.resolve_transition(fiber, "inFlight")
  end

  describe "resolve/availability invariant (the whole 409 class)" do
    # The load-bearing property: for every (state × kanban target) combination,
    # the action `resolve_transition` picks for a drag MUST be present in the
    # `actions_for` availability set. action_ids is derived from
    # action_for_target, so the two can never disagree by construction; this
    # test sweeps the full matrix to keep it that way.
    #
    # This invariant is what licenses `Shuttle.Transition` invoking a resolved
    # action with NO availability re-check. If it ever breaks, the daemon stops
    # refusing the drag with 409 `action_not_available` and instead invokes an
    # action the fiber's state does not support — so this sweep is the guard,
    # not a nicety.
    @kanban_targets ~w(drafts inFlight awaitingReview tempered composted)
    @statuses ~w(open active closed)
    @kinds ~w(oneshot standing)
    @tempereds [nil, true, false]

    test "every resolved drag target is an available action across the full matrix" do
      combos =
        for status <- @statuses,
            kind <- @kinds,
            tempered <- @tempereds,
            running? <- [false, true],
            target <- @kanban_targets do
          base = %{
            "id" => "work/matrix",
            "status" => status,
            "shuttle" => %{"kind" => kind}
          }

          fiber = if is_nil(tempered), do: base, else: Map.put(base, "tempered", tempered)

          available = Actions.actions_for(fiber, running?) |> Enum.map(& &1.id)

          resolved =
            case Actions.resolve_transition(fiber, target, running?) do
              {:ok, %{id: id}} ->
                id

              {:error, :standing_unreviewed} ->
                assert kind == "standing" and target in ["awaitingReview", "tempered"]
                assert ("close-tempered" in available) == (status == "active")
                refute "close-awaiting-review" in available
                nil
            end

          {%{
             status: status,
             kind: kind,
             tempered: tempered,
             running: running?,
             target: target,
             resolved: resolved,
             available: available
           }, is_nil(resolved) or resolved in available}
        end

      violations =
        combos
        |> Enum.reject(fn {_combo, ok?} -> ok? end)
        |> Enum.map(fn {combo, _} -> combo end)

      assert violations == [],
             "resolve/availability disagreement for #{length(violations)} combos:\n" <>
               Enum.map_join(violations, "\n", fn v ->
                 "  status=#{v.status} kind=#{v.kind} tempered=#{inspect(v.tempered)} " <>
                   "running=#{v.running} target=#{v.target} " <>
                   "→ resolved=#{v.resolved} NOT IN #{inspect(v.available)}"
               end)
    end

    test "a draft standing role can still be composted (the canary repro)" do
      # canary-local-snapshot: a draft standing role (status: open) used to expose
      # `[:reopen]` only, so dragging it to any close column 409'd. It must offer
      # the full close vocabulary.
      fiber = %{
        "id" => "work/draft-standing",
        "status" => "open",
        "shuttle" => %{"kind" => "standing"}
      }

      actions = Actions.actions_for(fiber) |> Enum.map(& &1.id)
      assert "reopen" in actions
      assert "close-composted" in actions
      refute "close-tempered" in actions

      assert {:ok, %{id: "close-composted"}} = Actions.resolve_transition(fiber, "composted")
    end
  end

  describe "legacy kind: pinned" do
    test "a closed legacy pinned card resolves exactly as a closed oneshot" do
      for target <- @kanban_targets do
        pinned = %{"id" => "work/hub", "status" => "closed", "shuttle" => %{"kind" => "pinned"}}
        oneshot = put_in(pinned, ["shuttle", "kind"], "oneshot")

        assert Actions.resolve_transition(pinned, target) ==
                 Actions.resolve_transition(oneshot, target),
               "legacy pinned dragged to #{target} must resolve as a oneshot"
      end
    end
  end

  describe "an awaiting oneshot (closed + untempered)" do
    # A closed oneshot with no verdict ran and awaits the human verdict. Every
    # column a card can be dropped on has the meaning of that column: drafts
    # parks it as a paused draft, inFlight reopens it, tempered and composted
    # record the verdict, and the same-column awaitingReview drop stays in
    # review.
    @awaiting_resolutions %{
      "drafts" => {"reopen-draft", %{verb: "reopen", as_draft: true}},
      "inFlight" => {"reopen", %{verb: "reopen"}},
      "awaitingReview" => {"close-awaiting-review", %{verb: "close"}},
      "tempered" => {"close-tempered", %{verb: "close", tempered: true}},
      "composted" => {"close-composted", %{verb: "close", tempered: false}}
    }

    test "each column resolves to its verdict, and the actions offered are exactly those" do
      fiber = %{"id" => "work/oneshot", "status" => "closed", "shuttle" => %{"kind" => "oneshot"}}

      assert Enum.sort(Map.keys(@awaiting_resolutions)) == Enum.sort(@kanban_targets)

      for {target, {id, invocation}} <- @awaiting_resolutions do
        assert Actions.resolve_transition(fiber, target) ==
                 {:ok, %{id: id, invocation: invocation}},
               "awaiting oneshot dragged to #{target} must resolve to #{id}"
      end

      offered = fiber |> Actions.actions_for() |> Enum.map(& &1.id) |> Enum.sort()

      resolved =
        @awaiting_resolutions |> Map.values() |> Enum.map(&elem(&1, 0)) |> Enum.sort()

      assert offered == resolved
    end
  end
end
