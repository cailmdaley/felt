defmodule Shuttle.ActionsTest do
  use ExUnit.Case, async: true

  alias Shuttle.Actions

  # Lifecycle is status + tempered, uniform across kinds (slice 5: no enabled
  # flag, no review axis). Awaiting review is `status: closed` + untempered.

  test "awaiting standing-role transitions resolve to accept-run" do
    fiber = awaiting_standing()

    assert {:ok, %{id: "accept-run", invocation: %{verb: "accept"}}} =
             Actions.resolve_transition(fiber, "tempered")

    assert {:ok, %{id: "accept-run", invocation: %{verb: "accept"}}} =
             Actions.resolve_transition(fiber, "inFlight")
  end

  test "armed standing-role in-flight transition resolves to ad-hoc dispatch" do
    fiber = armed_standing()

    assert {:ok, %{id: "dispatch-ad-hoc", invocation: %{verb: "dispatch", ad_hoc: true}}} =
             Actions.resolve_transition(fiber, "inFlight")
  end

  test "closed + untempered standing role is awaiting: re-arm or compost, not reopen" do
    # New-model awaiting: `status: closed` + no `tempered` on a standing role.
    # The verdict gestures re-arm (accept-run) or reject (close-composted); this
    # closed role does NOT collapse to reopen the way a oneshot does.
    fiber = awaiting_standing()

    assert {:ok, %{id: "accept-run", invocation: %{verb: "accept"}}} =
             Actions.resolve_transition(fiber, "inFlight")

    assert {:ok, %{id: "accept-run", invocation: %{verb: "accept"}}} =
             Actions.resolve_transition(fiber, "tempered")

    assert {:ok, %{id: "close-composted", invocation: %{verb: "close", tempered: false}}} =
             Actions.resolve_transition(fiber, "composted")

    # Drafts parks the role as a paused draft — a "stop for now," not a
    # compost verdict (reopen-draft → status:open, never armed).
    assert {:ok, %{id: "reopen-draft", invocation: %{verb: "reopen", as_draft: true}}} =
             Actions.resolve_transition(fiber, "drafts")

    assert {:ok, %{id: "close-awaiting-review"}} =
             Actions.resolve_transition(fiber, "awaitingReview")

    # Every resolved action is in the available set (drag-safety invariant).
    actions = Actions.actions_for(fiber)
    assert Enum.any?(actions, &(&1.id == "accept-run"))
    refute Enum.any?(actions, &(&1.id == "reopen"))
  end

  test "temper on a running or armed standing role resolves to accept-run, never close-tempered" do
    # The morning-post temper bug (2026-06-12): Cail clicked Temper right as an
    # interactive run wrapped — worker alive (or just killed by the kanban),
    # `status: active` because the exit writer hadn't marked awaiting yet. The
    # old `running? → close_tempered` clause checked the standing role off for
    # good. Temper on an untempered cyclical role is ACCEPT in every non-draft
    # state.
    running = armed_standing()

    assert {:ok, %{id: "accept-run", invocation: %{verb: "accept"}}} =
             Actions.resolve_transition(running, "tempered", true)

    # Armed but idle (worker killed, status not yet flipped) — same verb.
    assert {:ok, %{id: "accept-run", invocation: %{verb: "accept"}}} =
             Actions.resolve_transition(running, "tempered")

    # Drag-safety invariant: the resolved action is in the available set.
    assert Enum.any?(Actions.actions_for(running, true), &(&1.id == "accept-run"))

    # A DRAFT standing role (status: open) does not accept — tempering a parked
    # draft would arm it; it falls through to the generic close.
    draft = Map.put(armed_standing(), "status", "open")

    assert {:ok, %{id: "close-tempered"}} = Actions.resolve_transition(draft, "tempered")

    # Oneshots keep the terminus: running + tempered = close-tempered.
    oneshot = %{"id" => "work/once", "status" => "active", "shuttle" => %{"kind" => "oneshot"}}

    assert {:ok, %{id: "close-tempered"}} = Actions.resolve_transition(oneshot, "tempered", true)
  end

  test "closed + composted standing role (tempered:false) is a terminus, reopen to revive" do
    # A rejected standing role carries a verdict (`tempered: false`), so it is
    # NOT awaiting — it falls through to the generic closed clauses: reopen to
    # revive, close columns re-close with a verdict.
    fiber = Map.merge(armed_standing(), %{"status" => "closed", "tempered" => false})

    assert {:ok, %{id: "reopen", invocation: %{verb: "reopen"}}} =
             Actions.resolve_transition(fiber, "inFlight")

    assert {:ok, %{id: "close-tempered", invocation: %{verb: "close", tempered: true}}} =
             Actions.resolve_transition(fiber, "tempered")
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

  test "awaiting standing-role offers accept or compost, not a continue verb" do
    fiber = awaiting_standing()
    actions = Actions.actions_for(fiber)

    assert Enum.any?(actions, &(&1.id == "accept-run"))
    assert Enum.any?(actions, &(&1.id == "close-composted"))
    refute Enum.any?(actions, &(&1.id == "continue-run-fresh"))
    refute Enum.any?(actions, &(&1.id == "continue-run-previous"))
  end

  describe "resolve/availability invariant (the whole 409 class)" do
    # The load-bearing property: for every (state × kanban target) combination,
    # the action `resolve_transition` picks for a drag MUST be present in the
    # `actions_for` availability set. When it isn't, the daemon's
    # `validate_available` rejects the invoke with 409 `action_not_available`.
    # action_ids is derived from action_for_target, so the two can never disagree
    # by construction; this test sweeps the full matrix to keep it that way.
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
          {:ok, %{id: resolved}} = Actions.resolve_transition(fiber, target, running?)

          {%{
             status: status,
             kind: kind,
             tempered: tempered,
             running: running?,
             target: target,
             resolved: resolved,
             available: available
           }, resolved in available}
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

    test "a CLOSED standing role WITH A VERDICT (tempered set) resolves to close/reopen, never accept-run" do
      # The verdict-protection invariant in new-model terms. Awaiting is now
      # `status: closed` + tempered UNSET; the moment a verdict lands (`tempered`
      # present, true or false) the role is a terminus, not awaiting, so the
      # awaiting re-arm clauses must NOT fire. accept-run is reserved for
      # genuinely-awaiting (untempered) closed roles; a role the user already
      # ruled on falls through to the generic closed clauses.
      fiber = %{
        "id" => "work/closed-verdict",
        "status" => "closed",
        "tempered" => false,
        "shuttle" => %{"kind" => "standing"}
      }

      assert {:ok, %{id: "close-tempered", invocation: %{verb: "close", tempered: true}}} =
               Actions.resolve_transition(fiber, "tempered")

      assert {:ok, %{id: "close-composted", invocation: %{verb: "close", tempered: false}}} =
               Actions.resolve_transition(fiber, "composted")

      # The open-lifecycle columns clear the verdict, each with the meaning of
      # its own column: inFlight arms (reopen → active), drafts parks as a
      # paused draft (reopen-draft → open), awaitingReview re-closes with the
      # verdict cleared (back to review). accept-run must NOT appear for a
      # closed role that already has a verdict.
      assert {:ok, %{id: "reopen"}} = Actions.resolve_transition(fiber, "inFlight")

      assert {:ok, %{id: "reopen-draft", invocation: %{verb: "reopen", as_draft: true}}} =
               Actions.resolve_transition(fiber, "drafts")

      assert {:ok, %{id: "close-awaiting-review"}} =
               Actions.resolve_transition(fiber, "awaitingReview")

      available = Actions.actions_for(fiber) |> Enum.map(& &1.id)
      refute "accept-run" in available
    end

    test "same-column awaitingReview drop on an awaiting standing role is non-destructive" do
      # The awaiting role's HOME column is awaitingReview. A drop there is a
      # same-column no-op; it must not silently compost the pending run. Resolves
      # to close-awaiting-review (the non-verdict "stays in review" verb), never
      # close-composted. Pins the legit verdict columns at the same time:
      # tempered/inFlight = accept (keep the run), composted = compost (drop it).
      fiber = awaiting_standing()

      assert {:ok, %{id: "close-awaiting-review", invocation: %{verb: "close"}}} =
               Actions.resolve_transition(fiber, "awaitingReview")

      assert {:ok, %{id: "accept-run"}} = Actions.resolve_transition(fiber, "tempered")
      assert {:ok, %{id: "accept-run"}} = Actions.resolve_transition(fiber, "inFlight")
      assert {:ok, %{id: "close-composted"}} = Actions.resolve_transition(fiber, "composted")
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
      assert "close-tempered" in actions

      assert {:ok, %{id: "close-composted"}} = Actions.resolve_transition(fiber, "composted")
      assert {:ok, %{id: "close-tempered"}} = Actions.resolve_transition(fiber, "tempered")
    end
  end

  # An armed standing role: status:active, no verdict.
  defp armed_standing do
    %{
      "id" => "work/standing",
      "status" => "active",
      "shuttle" => %{"kind" => "standing"}
    }
  end

  # An awaiting standing role: status:closed + untempered (slice 5: the
  # felt-native awaiting signal, no review.state axis).
  defp awaiting_standing do
    %{
      "id" => "work/standing",
      "status" => "closed",
      "shuttle" => %{"kind" => "standing"}
    }
  end
end
