defmodule Shuttle.LifecycleStore do
  @moduledoc """
  The daemon's worker-exit and force-dispatch document writers for perennial
  roles, written straight to the felt document: `mark_awaiting` (a standing
  role's exit closes it to Awaiting review), `park` (a pinned role's dirty exit
  returns it to the strip), and `rearm` (a force-dispatch opens a standing or
  pinned role to `status: active`). The human verdicts `accept` and `resume` are
  felt's (`Shuttle.LifecycleService`).

  The document is the single source of truth: `status`, `tempered`, `outcome`,
  the cron `schedule`, `agent`, `host`. There is no runtime store and no review
  axis: the document carries the entire lifecycle, and `next_due` is recomputed
  from the cron schedule on the next poll.
  """

  require Logger

  alias Shuttle.{Continuation, FiberDoc}

  # Legacy + daemon-owned shuttle keys wiped from the block on every rewrite
  # here: `enabled` and `review` no longer exist; `next_due_at` / `last_run_at` /
  # `session` are daemon-owned and don't live in the synced document.
  @runtime_keys ~w(enabled review next_due_at last_run_at session)

  @doc """
  Standing-worker exit writer: mark a role awaiting review by writing
  `status: closed` (untempered) straight to the felt document — the awaiting
  signal, recognized by felt's `accept`/`resume`, the poller's `eligible?` gate,
  and the kanban classifier. It is also the don't-re-fire gate: a closed role
  is never dispatch-eligible, so the `active → closed → active` cycle encodes
  "already ran this occurrence."

  Awaiting is fully doc-representable: there is no review axis and no
  runtime row, so this is a single felt write — the mirror of the accept re-arm,
  setting `status: closed` where accept sets `status: active`. Atomic via
  `FiberDoc.write!` (tmp + rename). A no-op-shaped error (not standing /
  unreadable) returns `{:error, _}` so the caller can log without crashing the
  exit path.
  """
  @spec mark_awaiting(String.t()) :: {:ok, String.t()} | {:error, String.t()}
  def mark_awaiting(fiber_id) when is_binary(fiber_id) do
    with {:ok, path, raw_fm, frontmatter, body} <- FiberDoc.read(fiber_id),
         {:ok, shuttle} <- shuttle_block(frontmatter),
         :ok <- require_standing(shuttle) do
      ops =
        [
          {:put, "status", "closed"},
          {:put, "closed-at", DateTime.to_iso8601(DateTime.utc_now())},
          {:delete, "tempered"}
        ] ++ evict_runtime_ops()

      FiberDoc.write!(path, raw_fm, body, ops)

      {:ok, "marked #{fiber_id} awaiting review (status: closed, untempered)\n"}
    end
  end

  @doc """
  Re-arm a PERENNIAL role (standing or pinned) to `status: active` regardless of
  its current verdict.

  This is the **force-dispatch** re-arm: an explicit human "go" from the board
  (force-dispatch) is the verdict, so unlike felt's `accept`/`resume` it does
  not require the awaiting precondition — it reopens a closed role whether it was
  awaiting, tempered, or composted, and starts a parked pinned role by writing
  `open → active` so the board's strip → In-flight "start" gesture both spawns
  the worker now AND arms the role for the unified lifecycle. Clears
  `tempered`/`closed-at`, keeps the outcome, and wipes daemon-owned runtime keys.
  A no-op `{:ok, ...}` for a role already active, and an `{:error, _}` for a
  oneshot or unreadable fiber (a force-dispatched oneshot runs once and stays
  put — no loop to revive) so the dispatch path can log without crashing.

  Mirror of `mark_awaiting/1` (the worker-exit closer): this is the open.
  """
  @spec rearm(String.t(), keyword()) :: {:ok, String.t()} | {:error, String.t()}
  def rearm(fiber_id, opts \\ []) when is_binary(fiber_id) do
    with {:ok, path, raw_fm, frontmatter, body} <- FiberDoc.read(fiber_id),
         {:ok, shuttle} <- shuttle_block(frontmatter),
         :ok <- require_perennial(shuttle) do
      if Map.get(frontmatter, "status") == "active" do
        {:ok, "#{fiber_id} already active\n"}
      else
        FiberDoc.write!(path, raw_fm, body, rearm_ops() ++ evict_runtime_ops())
        conclude_run(fiber_id, opts)
        {:ok, "re-armed #{fiber_id} (status: active) for force-dispatch\n"}
      end
    end
  end

  @doc """
  Pinned-worker exit writer: park an interactive role back to its rest state by
  writing `status: open` straight to the felt document — the strip resting state.

  Called on a DIRTY pinned exit (crash, idle exit without a handoff marker, human
  kill): the interface went dark with no fresh-session request, so the role
  returns to the **pinned strip** (`status: open`) rather than staying stuck
  `active` with no live worker in In-flight. Resume from the strip (force-dispatch
  → `rearm`) re-attaches. A CLEAN handoff takes the other branch in
  `handle_worker_exit` — the document is left `active` and the tick redispatches a
  fresh worker, so `park` is never called there.

  Mirror of `mark_awaiting/1` (the standing-role closer, which writes
  `status: closed`): this is the pinned closer. Pinned-only — a no-op-shaped
  `{:error, _}` for any other kind so the exit path can log without crashing.
  Idempotent: `{:ok, ...}` if already parked.
  """
  @spec park(String.t()) :: {:ok, String.t()} | {:error, String.t()}
  def park(fiber_id) when is_binary(fiber_id) do
    with {:ok, path, raw_fm, frontmatter, body} <- FiberDoc.read(fiber_id),
         {:ok, shuttle} <- shuttle_block(frontmatter),
         :ok <- require_pinned(shuttle) do
      if Map.get(frontmatter, "status") == "open" do
        {:ok, "#{fiber_id} already parked\n"}
      else
        ops = [{:put, "status", "open"}, {:delete, "closed-at"}] ++ evict_runtime_ops()
        FiberDoc.write!(path, raw_fm, body, ops)
        {:ok, "parked #{fiber_id} (status: open) on session end\n"}
      end
    end
  end

  defp shuttle_block(%{"shuttle" => shuttle}) when is_map(shuttle), do: {:ok, shuttle}
  defp shuttle_block(_), do: {:error, "fiber has no shuttle: block"}

  # Standing = the cron-driven active→closed→active lifecycle `mark_awaiting`
  # closes (a run closes to awaiting-review; accept advances the recurrence).
  # Pinned is NOT standing: it redispatches on clean handoff and is parked, not
  # closed, when its session ends — so `mark_awaiting` rejects it along with
  # oneshots and non-shuttle fibers.
  defp require_standing(%{"kind" => "standing"}), do: :ok

  defp require_standing(shuttle),
    do:
      {:error,
       "mark-awaiting only applies to standing roles (kind=#{inspect(Map.get(shuttle, "kind"))})"}

  # Perennial = standing OR pinned: roles whose `active` state means perennial
  # dispatch (a cron loop, or the Option-D poll loop). `rearm` (the force-dispatch
  # re-arm) writes them to `active`; a oneshot is rejected — force-dispatching a
  # oneshot runs it once and leaves its status put, with no loop to revive.
  defp require_perennial(%{"kind" => kind}) when kind in ["standing", "pinned"], do: :ok

  defp require_perennial(shuttle),
    do:
      {:error,
       "rearm only applies to standing or pinned roles (kind=#{inspect(Map.get(shuttle, "kind"))})"}

  defp require_pinned(%{"kind" => "pinned"}), do: :ok

  defp require_pinned(shuttle),
    do: {:error, "park only applies to pinned roles (kind=#{inspect(Map.get(shuttle, "kind"))})"}

  # rearm opens a role by writing `status: active` back to the document — the
  # sole dispatch gate (there is no enabled flag, no review block). tempered and
  # closed-at are deleted so the card leaves the Awaiting/Tempered/Composted
  # columns. Emitted as surgical edits against the
  # raw frontmatter text, NOT a re-serialization of the whole map: every other
  # key (notably the `outcome:` block scalar) stays byte-identical.
  #
  # The outcome is never blanked on re-arm: the last run's digest stays the card
  # headline until the next run overwrites it.
  defp rearm_ops do
    [{:put, "status", "active"}, {:delete, "tempered"}, {:delete, "closed-at"}]
  end

  # Drop the daemon-owned / legacy runtime keys from inside the `shuttle:` block.
  # Surgical: each is a {:delete_nested, "shuttle", key} that removes just that
  # child line (and its value span) if present, no-op if absent.
  defp evict_runtime_ops do
    Enum.map(@runtime_keys, &{:delete_nested, "shuttle", &1})
  end

  # Conclude the in-flight run by stamping `shuttle.runtime.handed_off_at = now`.
  # A human force-dispatch rearm declares the run concluded, which is exactly the
  # signal a clean worker exit leaves (`Shuttle.Continuation` reads
  # `handed_off_at`), so the standing-role dead-orphan detector sees a clean exit
  # (`handed_off_at >= dispatched_at`) and the cron lookback baseline advances —
  # stopping the temper oscillation with no separate re-arm field.
  #
  # felt owns the nesting, so the daemon cannot fold this into
  # the atomic status write a single flat op could. It is a
  # SECOND write — `felt shuttle mark-runtime --handed-off-at` — after the status
  # re-arm. The sub-ms non-atomic window between the two is the one accepted
  # tradeoff: a daemon crash there leaves the role `active` with no fresh handoff
  # → the dead-orphan reconciler marks it awaiting → the human re-accepts. Rare
  # (crash during a human action), recoverable, standing-only. Best-effort: a
  # resolution miss or a non-zero `felt` exit is logged, never fails the re-arm.
  #
  # Public because the poller's dead-standing-role reconciler reuses it to
  # SELF-HEAL a run with inverted/implausible markers (`handed_off_at` earlier
  # than `dispatched_at` — physically impossible in a real run): stamping
  # `handed_off_at = now` corrects the marker so the phantom "still dispatched"
  # signal clears and the role stays armed, instead of being force-closed.
  @spec conclude_run(String.t(), keyword()) :: :ok
  def conclude_run(fiber_id, opts \\ []) do
    runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)

    case resolve_runtime_target(fiber_id, Keyword.get(opts, :felt_stores)) do
      {:ok, host, scoped_id} ->
        Continuation.mark_handed_off(runner, host, scoped_id)

      :error ->
        Logger.warning(
          "LifecycleStore: could not resolve #{fiber_id} to conclude its run " <>
            "(shuttle.runtime.handed_off_at not stamped; the dead-orphan reconciler will recover)"
        )
    end

    :ok
  end

  # Resolve a fiber id to its owning felt store + store-scoped id — the pair
  # `felt shuttle mark-runtime` needs (run with `cd: store`). Uses the daemon's
  # configured `felt_stores` when threaded (the poller passes `state.felt_stores`),
  # else the global configured stores.
  defp resolve_runtime_target(fiber_id, felt_stores) do
    resolution =
      if is_list(felt_stores) and felt_stores != [] do
        Shuttle.FeltStores.resolve_fiber(fiber_id, felt_stores)
      else
        Shuttle.FeltStores.resolve_fiber(fiber_id)
      end

    case resolution do
      {:ok, %{store: store, fiber_id: scoped_id}} -> {:ok, store, scoped_id}
      _ -> :error
    end
  end
end
