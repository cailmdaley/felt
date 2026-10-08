defmodule Shuttle.LifecycleStore do
  @moduledoc """
  The daemon's worker-exit and force-dispatch document writers for standing
  constitutions, written straight to the felt document: `mark_awaiting` (a
  standing run's exit closes it to Awaiting review) and `rearm` (a
  force-dispatch opens it to `status: active`). The human verdicts `accept` and
  `resume` are Shuttle's (`Shuttle.LifecycleService`).

  The document is the single source of truth: `status`, `tempered`, `outcome`,
  the cron `schedule`, `agent`, `host`. There is no runtime store and no review
  axis: the document carries the entire lifecycle, and `next_due` is recomputed
  from the cron schedule on the next poll.
  """

  require Logger

  alias Shuttle.{Continuation, FiberDoc}

  # Shuttle keys wiped from the block on every rewrite here: `enabled` and
  # `review` are not part of the block, so a document still carrying them is
  # cleaned; `next_due_at` / `last_run_at` / `session` are daemon-owned and
  # don't live in the synced document.
  @runtime_keys ~w(enabled review next_due_at last_run_at session)

  @doc """
  Standing-worker exit writer: mark a role awaiting review by writing
  `status: closed` (untempered) straight to the felt document — the awaiting
  signal, recognized by Shuttle's `accept`/`resume`, the poller's `eligible?` gate,
  and the kanban classifier. It is also the don't-re-fire gate: a closed role
  is never dispatch-eligible, so the `active → closed → active` cycle encodes
  "already ran this occurrence."

  Awaiting is fully doc-representable: there is no review axis and no
  runtime row, so this is a single document write — the mirror of the accept re-arm,
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
  Re-arm a standing constitution to `status: active` regardless of its current
  verdict.

  This is the **force-dispatch** re-arm: an explicit human "go" from the board
  (force-dispatch) is the verdict, so unlike Shuttle's `accept`/`resume` it does
  not require the awaiting precondition — it reopens a closed run whether it was
  awaiting, tempered, or composted, and arms a paused one (`open → active`), so
  the board's start both spawns the worker now and leaves it armed for its
  schedule. Clears
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
         :ok <- require_standing(shuttle) do
      if Map.get(frontmatter, "status") == "active" do
        {:ok, "#{fiber_id} already active\n"}
      else
        FiberDoc.write!(path, raw_fm, body, rearm_ops() ++ evict_runtime_ops())
        conclude_run(fiber_id, opts)
        {:ok, "re-armed #{fiber_id} (status: active) for force-dispatch\n"}
      end
    end
  end

  defp shuttle_block(%{"shuttle" => shuttle}) when is_map(shuttle), do: {:ok, shuttle}
  defp shuttle_block(_), do: {:error, "fiber has no shuttle: block"}

  # Standing = the cron-driven active→closed→active lifecycle `mark_awaiting`
  # closes (a run closes to awaiting-review; accept advances the recurrence) and
  # `rearm` opens. A oneshot is rejected by both: force-dispatching one runs it
  # once and leaves its status put, with no loop to revive.
  defp require_standing(%{"kind" => "standing"}), do: :ok

  defp require_standing(shuttle),
    do:
      {:error,
       "only applies to standing constitutions (kind=#{inspect(Map.get(shuttle, "kind"))})"}

  # rearm opens a standing constitution by writing `status: active` back to the document — the
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

  # Drop the `@runtime_keys` from inside the `shuttle:` block.
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
  # Shuttle owns the nested runtime writer, so the daemon stamps this after
  # the atomic status write. The sub-ms non-atomic window between the two is the
  # one accepted tradeoff: a daemon crash there leaves the role `active` with no
  # fresh handoff → the dead-orphan reconciler marks it awaiting → the human
  # re-accepts. Recoverable and standing-only. Best-effort: a resolution miss or
  # a non-zero `shuttle` exit is logged, never fails the re-arm.
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
  # `shuttle mark-runtime` needs (run with `-C store`). Uses the daemon's
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
