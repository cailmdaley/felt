defmodule Shuttle.Actions do
  @moduledoc """
  Classifies Shuttle-owned lifecycle actions for external views.

  Portolan owns gestures and layout; Shuttle owns what those gestures mean for
  a fiber's dispatch lifecycle. This module is the small vocabulary bridge
  between the two.
  """

  @type action_id ::
          :pause
          | :reopen
          | :reopen_draft
          | :accept_run
          | :dispatch_ad_hoc
          | :close_awaiting_review
          | :close_tempered
          | :close_composted

  @transition_targets ~w(drafts inFlight queued active awaitingReview tempered composted)
  @action_ids ~w(pause reopen reopen-draft accept-run dispatch-ad-hoc close-awaiting-review close-tempered close-composted)

  @spec actions_for(map(), boolean()) :: [map()]
  def actions_for(fiber, running? \\ false) when is_map(fiber) do
    fiber
    |> action_ids(running?)
    |> Enum.map(&render_action/1)
  end

  @spec resolve_transition(map(), String.t(), boolean()) ::
          {:ok, map()} | {:error, :unknown_target}
  def resolve_transition(fiber, target, running? \\ false)

  def resolve_transition(fiber, target, running?) when target in @transition_targets do
    target = normalize_target(target)
    {:ok, render_action(action_for_target(fiber, target, running?))}
  end

  def resolve_transition(_fiber, _target, _running?), do: {:error, :unknown_target}

  @spec known_action?(String.t()) :: boolean()
  def known_action?(id), do: id in @action_ids

  # The normalized kanban drag targets, in column order. `action_ids/2`
  # derives the available-action set from `action_for_target/3` over exactly
  # this list, so the two functions can never disagree.
  @kanban_targets ~w(drafts inFlight awaitingReview tempered composted)

  # The available-action set is the distinct set of actions `action_for_target`
  # produces over every kanban drag target, plus `:pause` for a running worker
  # (which is always interruptible even when no column maps to pause in that
  # state — e.g. a closed-but-still-running fiber).
  #
  # Deriving the set *from* the resolver is the load-bearing invariant: for
  # every valid target t, `action_for_target(fiber, t, running?) ∈
  # action_ids(fiber, running?)` holds by construction, so a drag can never
  # 409 `action_not_available` from a resolve/availability disagreement. The
  # two cond-chains that used to be hand-maintained independently drifted
  # apart for 110 of the 270 (state × target) combinations; this collapses the
  # second chain into a projection of the first. Order is preserved
  # (`@kanban_targets` then `:pause`) so the rendered list is stable.
  #
  # See `gotcha-shuttle-resolve-invoke-daemon-split`.
  defp action_ids(fiber, running?) do
    derived =
      @kanban_targets
      |> Enum.map(&action_for_target(fiber, &1, running?))

    extras = if running?, do: [:pause], else: []

    (derived ++ extras) |> Enum.uniq()
  end

  defp action_for_target(fiber, target, running?) do
    shuttle = shuttle(fiber)
    status = Map.get(fiber, "status")

    cond do
      # Temper on a STANDING role with no verdict is ACCEPT in every non-draft
      # state — running (an interactive run just wrapped, worker alive or freshly
      # killed), armed (`status: active`, exit not yet marked awaiting), or
      # awaiting (`status: closed`). close_tempered is a ONESHOT terminus;
      # resolving it here checked a standing role off for good (the morning-post
      # temper bug, 2026-06-12). This clause MUST precede the generic `running?`
      # clauses — a live or just-killed worker is exactly the state where status
      # hasn't flipped to closed yet. Pinned is NOT standing (Option D): a
      # looping pinned role tempered = retire (close_tempered), the oneshot path.
      standing?(shuttle) and untempered?(fiber) and status != "open" and
          target == "tempered" ->
        :accept_run

      # A live worker: the close columns end it, drafts pauses it. inFlight is
      # the column it already lives in (a no-op same-column drop); resolve it to
      # `pause` so it stays a valid, non-destructive-on-its-own action that the
      # daemon already exposes for running workers — never a re-dispatch, which
      # the daemon would bounce as already_running.
      running? and target in ["drafts", "inFlight"] ->
        :pause

      running? and target == "awaitingReview" ->
        :close_awaiting_review

      running? and target == "tempered" ->
        :close_tempered

      running? and target == "composted" ->
        :close_composted

      # A CLOSED standing role with no verdict (`tempered` unset) is the
      # new-model AWAITING signal: status:closed + untempered = "ran this cycle,
      # pending a human verdict" — felt-native, no `review.state`. Only a
      # STANDING role re-arms (a oneshot — and, under Option D, a pinned role —
      # closes for good). The verdict gestures: inFlight/tempered = keep it
      # (accept-run → advance the schedule), composted = reject (close-composted),
      # drafts = park the role as a paused draft (reopen-draft — stopping a role
      # for now is not the same verdict as composting it), awaitingReview = no-op
      # (a same-column drop stays in review). This clause MUST precede the generic
      # `status == "closed"` clauses below — those resolve a closed fiber to
      # reopen/close, which would TERMINATE the role instead of re-arming it
      # (the slice-1 entanglement). Tempered-true and composted (tempered:false)
      # closed roles, and all closed pinned/oneshot roles, are termini and fall
      # through to the generic clauses.
      status == "closed" and standing?(shuttle) and untempered?(fiber) and
          target in ["inFlight", "tempered"] ->
        :accept_run

      status == "closed" and standing?(shuttle) and untempered?(fiber) and
          target == "composted" ->
        :close_composted

      status == "closed" and standing?(shuttle) and untempered?(fiber) and
          target == "awaitingReview" ->
        :close_awaiting_review

      # A closed fiber dragged to Drafts reopens AS A DRAFT (status:open,
      # verdict cleared — `shuttle reopen --as-draft`): the gesture means
      # "plan this again," not "run it now," so it must not arm the dispatch
      # gate. This is also the park-as-draft verb the kanban composes before
      # a planning-surface drop (timeline date / stash) on a closed card —
      # the slides snap-back fix (see Portolan
      # kanban-ux-rework/placement-pipeline-invariants).
      status == "closed" and target == "drafts" ->
        :reopen_draft

      # inFlight is the one closed-card target that ARMS: reopen → active.
      # (The kanban actually launches via force-dispatch, which reopens en
      # route; this mapping keeps the bare transition coherent.)
      status == "closed" and target == "inFlight" ->
        :reopen

      # Dragging a tempered/composted card back to Awaiting review revokes the
      # verdict but keeps the card closed: re-close with tempered cleared.
      # (Resolving this to reopen — as it once did — armed the card and
      # snapped it to In flight instead of Awaiting review.)
      status == "closed" and target == "awaitingReview" ->
        :close_awaiting_review

      status == "closed" and target == "tempered" ->
        :close_tempered

      status == "closed" and target == "composted" ->
        :close_composted

      # A draft (`status: open`) is paused/not-yet-armed (slice 5: status is the
      # sole gate, no enabled flag). Dragging it out of drafts arms it via
      # reopen (→ status:active). A drop ON drafts (reachable from the timeline
      # / stash surfaces) parks it — pause, an idempotent no-op for an open
      # fiber — never reopen, which would arm and snap the card to In flight.
      status == "open" and target == "drafts" ->
        :pause

      status == "open" and target == "inFlight" ->
        :reopen

      # An armed fiber (`status: active`). drafts parks it (pause → status:open).
      # inFlight ("launch it now") force-dispatches, which surfaces the real
      # dispatch outcome (spawned, or a concrete error). This holds for both an
      # armed standing role (ad-hoc tick) and an armed oneshot (launch).
      target == "drafts" ->
        :pause

      target == "inFlight" ->
        :dispatch_ad_hoc

      target == "awaitingReview" ->
        :close_awaiting_review

      target == "tempered" ->
        :close_tempered

      true ->
        :close_composted
    end
  end

  defp render_action(id) do
    %{id: Atom.to_string(id) |> String.replace("_", "-"), invocation: invocation(id)}
  end

  defp invocation(:pause), do: %{verb: "pause"}
  defp invocation(:reopen), do: %{verb: "reopen"}
  defp invocation(:reopen_draft), do: %{verb: "reopen", as_draft: true}
  defp invocation(:accept_run), do: %{verb: "accept"}
  defp invocation(:dispatch_ad_hoc), do: %{verb: "dispatch", ad_hoc: true}
  defp invocation(:close_awaiting_review), do: %{verb: "close"}
  defp invocation(:close_tempered), do: %{verb: "close", tempered: true}
  defp invocation(:close_composted), do: %{verb: "close", tempered: false}

  defp normalize_target("queued"), do: "inFlight"
  defp normalize_target("active"), do: "inFlight"
  defp normalize_target(target), do: target

  # Total accessors: a malformed inline fiber (shuttle/review as a scalar or
  # list rather than a map) must degrade to the default path, not crash the
  # resolver with BadMapError / ArgumentError → a bare Phoenix 500. The current
  # client always builds well-formed shapes, so this is public-contract
  # robustness for any other caller. (overnight-audit C10 / finding 3.)
  defp shuttle(fiber) do
    case Map.get(fiber, "shuttle", %{}) do
      m when is_map(m) -> m
      _ -> %{}
    end
  end

  # Only STANDING roles have the active→closed→active cron lifecycle that the
  # accept/re-arm verdict gestures advance. Pinned roles are not cyclical under
  # Option D — they loop while `active` and park at `open`, so a pinned role that
  # a worker self-closed is a plain terminus (temper = retire), resolved by the
  # generic closed-card clauses just like a oneshot.
  defp standing?(shuttle),
    do: Map.get(shuttle, "kind", Map.get(shuttle, "mode")) == "standing"

  # `tempered` absent (nil) is the no-verdict state — the awaiting signal for a
  # closed fiber. `tempered: true` (accepted oneshot terminus) and
  # `tempered: false` (composted) both have a verdict and are NOT awaiting.
  defp untempered?(fiber), do: is_nil(Map.get(fiber, "tempered"))
end
