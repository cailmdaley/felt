defmodule Shuttle.Actions do
  @moduledoc """
  Classifies Shuttle-owned lifecycle actions for external views.

  The board UI owns gestures and layout; Shuttle owns what those gestures mean
  for a fiber's dispatch lifecycle. This module is the small vocabulary bridge
  between the two.
  """

  @transition_targets ~w(drafts inFlight active awaitingReview tempered composted)

  @spec actions_for(map(), boolean()) :: [map()]
  def actions_for(fiber, running? \\ false) when is_map(fiber) do
    fiber
    |> action_ids(running?)
    |> Enum.map(&render_action(&1, fiber))
  end

  @spec resolve_transition(map(), String.t(), boolean()) ::
          {:ok, map()}
          | {:error, :unknown_target | :standing_unreviewed}
  def resolve_transition(fiber, target, running? \\ false)

  def resolve_transition(fiber, target, running?) when target in @transition_targets do
    target = normalize_target(target)

    case action_for_target(fiber, target, running?) do
      nil -> {:error, :standing_unreviewed}
      action -> {:ok, render_action(action, fiber)}
    end
  end

  def resolve_transition(_fiber, _target, _running?), do: {:error, :unknown_target}

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
  # 409 `action_not_available` from a resolve/availability disagreement: the
  # available set is a projection of the resolver, never a second cond-chain
  # that can drift from it. Order is preserved
  # (`@kanban_targets` then `:pause`) so the rendered list is stable.
  #
  # See `gotcha-shuttle-resolve-invoke-daemon-split`.
  defp action_ids(fiber, running?) do
    derived =
      @kanban_targets
      |> Enum.map(&action_for_target(fiber, &1, running?))

    extras = if running?, do: [:pause], else: []

    (derived ++ extras) |> Enum.reject(&is_nil/1) |> Enum.uniq()
  end

  defp action_for_target(fiber, target, running?) do
    shuttle = shuttle(fiber)
    status = Map.get(fiber, "status")

    cond do
      # A standing constitution has no review: its runs keep the schedule and
      # ask when they need the human. Drafts pauses the schedule, composted
      # retires it, inFlight runs it now, and tempered ends the current run of
      # an armed one, keeping the schedule; review resolves to nothing.
      standing?(shuttle) and target == "tempered" and status == "active" ->
        :close_tempered

      standing?(shuttle) and target in ["awaitingReview", "tempered"] ->
        nil

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

      # A closed fiber dragged to Drafts reopens AS A DRAFT (status:open,
      # verdict cleared — `shuttle reopen --as-draft`): the gesture means
      # "plan this again," not "run it now," so it must not arm the dispatch
      # gate. This is also the park-as-draft verb the kanban composes before
      # a planning-surface drop (timeline date / stash) on a closed card, so
      # the card lands where it was dropped instead of snapping back.
      status == "closed" and target == "drafts" ->
        :reopen_draft

      # inFlight is the one closed-card target that ARMS: reopen → active.
      # (The kanban actually launches via force-dispatch, which reopens en
      # route; this mapping keeps the bare transition coherent.)
      status == "closed" and target == "inFlight" ->
        :reopen

      # A oneshot can return to Awaiting review by clearing its verdict; a
      # thread With its orchestrator moves there by its mark.
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
      # armed standing constitution (an ad-hoc run) and an armed oneshot.
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

  defp render_action(id, fiber) do
    %{id: Atom.to_string(id) |> String.replace("_", "-"), invocation: invocation(id, fiber)}
  end

  # The note a thread carries when the human moves it to review on the board.
  @board_review_note "Moved to review on the board"

  defp invocation(:pause, _), do: %{verb: "pause"}
  defp invocation(:reopen, _), do: %{verb: "reopen"}
  defp invocation(:reopen_draft, _), do: %{verb: "reopen", as_draft: true}
  defp invocation(:dispatch_ad_hoc, _), do: %{verb: "dispatch", ad_hoc: true}

  # Moving a card to review is the human asking to see it. A thread's review
  # otherwise belongs to its orchestrator, so the close marks it for the human.
  defp invocation(:close_awaiting_review, fiber) do
    if is_map(shuttle(fiber)["thread_parent"]),
      do: %{verb: "close", review: @board_review_note},
      else: %{verb: "close"}
  end

  defp invocation(:close_tempered, _), do: %{verb: "close", tempered: true}
  defp invocation(:close_composted, _), do: %{verb: "close", tempered: false}

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

  # A STANDING constitution runs on its schedule and is never reviewed.
  defp standing?(shuttle), do: Shuttle.Poller.block_kind(shuttle) == "standing"
end
