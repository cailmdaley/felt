defmodule Shuttle.StandingRole do
  @moduledoc """
  Parses and classifies `shuttle.kind: standing` fiber declarations.

  Standing roles are still felt fibers. Shuttle interprets the `shuttle:` block
  plus the document's `status`/`tempered` to decide whether a role is sleeping,
  due, or running. "Awaiting review" and "accepted/composted" are document facts
  (`status:closed` + untempered / `tempered`), not a `review.state` axis — there
  is none; the schedule-derived phase here only answers sleeping/due/running for
  an armed role.

  **Shuttle is the cron authority; this module is the timing decider.** The
  daemon does not parse cron. Shuttle resolves each schedule on read and inlines
  `next_due` (the next occurrence after now) and `prev_due` (the most recent
  occurrence at or before now) under `shuttle.resolved`. This module reads those
  timestamps and compares instants. A role is due when `prev_due` is later than
  its last service time. Shuttle searches one year back for `prev_due`; a role
  unserviced longer than that sleeps until its next occurrence.
  """

  defstruct [
    :fiber_id,
    # Intrinsic uid (ULID) carried from the candidate document, for the
    # snapshot's runtime join key. nil when the caller didn't supply it or the
    # fiber has no uid.
    :uid,
    :kind,
    # The raw schedule map, carried for the snapshot's display only — never
    # parsed here (Shuttle owns cron). nil for a block without one.
    :schedule,
    # Shuttle-resolved occurrences (shuttle.resolved.{next_due,prev_due}), the
    # source of timing. next_due_at: next tick > now (display + the
    # parseable-schedule signal). prev_due: most recent tick <= now (the
    # dispatch/display due signal). Both nil unless Shuttle resolved a standing
    # schedule.
    :next_due_at,
    :prev_due,
    validation_errors: []
  ]

  @type t :: %__MODULE__{
          fiber_id: String.t(),
          uid: String.t() | nil,
          kind: String.t() | nil,
          schedule: map() | nil,
          next_due_at: DateTime.t() | nil,
          prev_due: DateTime.t() | nil,
          validation_errors: [String.t()]
        }

  @spec from_map(String.t(), map(), String.t() | nil) :: {:ok, t()} | {:error, term()}
  def from_map(fiber_id, data, uid \\ nil) when is_map(data) do
    resolved = data["resolved"] || %{}

    role = %__MODULE__{
      fiber_id: fiber_id,
      uid: uid,
      kind: string(data["kind"]),
      schedule: map_or_nil(data["schedule"]),
      # next_due/prev_due come from Shuttle's resolution; use the flat
      # next_due_at field when resolved next_due is absent.
      next_due_at: parse_datetime(resolved["next_due"] || data["next_due_at"]),
      prev_due: parse_datetime(resolved["prev_due"])
    }

    {:ok, %{role | validation_errors: validation_errors(role)}}
  end

  @spec standing?(t() | nil) :: boolean()
  def standing?(%__MODULE__{kind: "standing"}), do: true
  def standing?(_), do: false

  @doc """
  The schedule-derived display phase for an armed role, computed from Shuttle's
  resolved occurrences + liveness — NOT from `review.state` or `enabled`
  (neither axis exists). "Awaiting review", "accepted", and "paused/draft" are
  document facts (`status:closed` + untempered / `tempered`, and `status:open`),
  surfaced by the kanban classifier from the document, not derived here. This
  function only answers the schedule question for an armed role (`status:
  active`): is a worker live, is its last tick recent enough to read "due", or is
  it sleeping.
  """
  @spec state(t(), DateTime.t(), boolean()) :: String.t()
  def state(%__MODULE__{} = role, now, running?) do
    cond do
      # A live worker is a fact, not a schedule conclusion — it wins even for a
      # role paused with `--no-kill`, so the card reads true until the run ends.
      running? -> "running"
      due_by_schedule?(role, now) -> "due"
      true -> "scheduled"
    end
  end

  # Display window for the `state/3` "due" phase — the recent past in which a
  # fired tick still reads as "due" before the poll dispatches it and the
  # document flips to closed. Shuttle's prev_due is the most recent occurrence; a
  # fixed lookback window is how a just-fired tick is recognized for display
  # (mirrors the dispatch path's `due_by_cron?` window, sized for display rather
  # than the poll cadence).
  @display_due_window_ms 90_000

  # Display due-ness for `state/3`: a valid role whose most recent occurrence
  # (Shuttle's prev_due) fell inside `(now - window, now]`. Pure timestamp compare —
  # no cron parse, no stored next_due_at, no review gate.
  defp due_by_schedule?(%__MODULE__{prev_due: %DateTime{} = prev} = role, %DateTime{} = now) do
    valid?(role) and
      DateTime.compare(prev, DateTime.add(now, -@display_due_window_ms, :millisecond)) == :gt
  end

  defp due_by_schedule?(_, _), do: false

  @doc """
  Occurrence-derived due check for the **dispatch** path: true iff the schedule's
  most recent tick (Shuttle's `prev_due`) fell inside the lookback `(now -
  window_ms, now]` — equivalently, strictly after `window_start = now -
  window_ms`. Shuttle's prev_due is always `<=` its resolution time, so the upper
  bound holds for free and only the lower bound is checked.

  Due-ness is a pure timestamp comparison against Shuttle's resolved occurrence, NOT
  a cron parse and NOT a stored `next_due_at`. The *meaning* of the lookback is
  the caller's. The poller (`standing_role_due?`) anchors it at the role's last
  service (`now - last_serviced`), so this reduces to **`prev_due >
  last_serviced`**: "an occurrence elapsed since we last ran" — i.e. the schedule
  self-catches a fire the daemon slept through, however late, rather than
  skipping it.

  A single catch-up fires, not a backlog: once a role fires its document flips
  `active -> closed`, `eligible?` excludes closed, and the run advances the
  anchor to ~now — so the `active -> closed -> accept` transition is the
  per-cycle gate, not a timestamp, and an awaiting role never re-fires until a
  human tempers it.

  It does NOT consult `review.state` — the dispatch gate is the felt document's
  `status`/`tempered` (the poller checks those before calling this).
  """
  @spec due_by_cron?(t(), DateTime.t(), pos_integer()) :: boolean()
  def due_by_cron?(%__MODULE__{prev_due: %DateTime{} = prev} = role, %DateTime{} = now, window_ms)
      when is_integer(window_ms) and window_ms > 0 do
    dispatchable?(role) and
      DateTime.compare(prev, DateTime.add(now, -window_ms, :millisecond)) == :gt
  end

  def due_by_cron?(_, _, _), do: false

  # Dispatch-path validity: a standing role for which Shuttle resolved a schedule
  # (next_due_at present ⟺ the cron parsed and a future tick exists). Both the
  # dispatch and display paths gate on this alone — there are no review/next_due
  # validations: the document, not a review overlay, is the truth.
  defp dispatchable?(%__MODULE__{kind: "standing", next_due_at: %DateTime{}}), do: true
  defp dispatchable?(_), do: false

  @doc """
  The next scheduled occurrence, for the kanban **display** next_due — Shuttle's
  resolved `next_due` (the next tick strictly after now), read straight off the
  block. Returns nil when Shuttle resolved no schedule.
  """
  @spec next_due_from_cron(t()) :: DateTime.t() | nil
  def next_due_from_cron(%__MODULE__{next_due_at: %DateTime{} = next}), do: next
  def next_due_from_cron(_), do: nil

  defp valid?(%__MODULE__{validation_errors: []}), do: true
  defp valid?(_), do: false

  @doc """
  Run id for a *scheduled* (non-ad-hoc) standing dispatch — a display label for
  the prompt's `Run:` line, minted from Shuttle's next_due (or now).

  It is not load-bearing for resume continuity: continuation is decided from the
  fiber's `shuttle.dispatched_at`/`handed_off_at` (`Shuttle.Continuation`), not
  from this id. The id is therefore free to be a fresh timestamp every dispatch.
  """
  @spec dispatch_run_id(t(), DateTime.t()) :: String.t()
  def dispatch_run_id(%__MODULE__{next_due_at: %DateTime{} = next_due_at}, _now) do
    Calendar.strftime(next_due_at, "%Y%m%dT%H%M%S%z")
  end

  def dispatch_run_id(%__MODULE__{}, now) do
    Calendar.strftime(now, "%Y%m%dT%H%M%S%z")
  end

  @spec ad_hoc_run_id(DateTime.t()) :: String.t()
  def ad_hoc_run_id(%DateTime{} = now) do
    "adhoc-#{DateTime.to_unix(now, :millisecond)}"
  end

  @spec ad_hoc_run_id?(String.t() | nil) :: boolean()
  def ad_hoc_run_id?("adhoc-" <> _), do: true
  def ad_hoc_run_id?(_), do: false

  @spec to_snapshot(t(), DateTime.t(), boolean()) :: map()
  def to_snapshot(%__MODULE__{} = role, now, running?) do
    %{
      fiber_id: role.fiber_id,
      state: state(role, now, running?),
      next_due_at: unix_ms(role.next_due_at),
      schedule: role.schedule,
      validation_errors: role.validation_errors
    }
  end

  # Validity is the document's intrinsic shape: a standing role for which
  # Shuttle resolved a schedule (next_due_at present). There are no
  # review/next_due validations — the document (status + tempered) is the truth,
  # and an unparseable schedule produces no resolved occurrence.
  defp validation_errors(%__MODULE__{} = role) do
    [
      validate_kind(role),
      validate_schedule(role)
    ]
    |> Enum.reject(&is_nil/1)
  end

  defp validate_kind(%__MODULE__{kind: "standing"}), do: nil
  defp validate_kind(%__MODULE__{kind: kind}), do: "kind must be standing, got #{inspect(kind)}"

  # A standing role is well-formed iff Shuttle resolved a next occurrence for
  # it. Shuttle emits next_due only when the cron parsed, so its presence IS the
  # parseable-schedule signal — the daemon never re-validates the expression.
  defp validate_schedule(%__MODULE__{next_due_at: %DateTime{}}), do: nil
  defp validate_schedule(%__MODULE__{}), do: "Shuttle resolved no schedule occurrence (next_due)"

  defp parse_datetime(nil), do: nil
  defp parse_datetime(""), do: nil

  defp parse_datetime(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, dt, _} -> dt
      {:error, _} -> nil
    end
  end

  defp parse_datetime(%DateTime{} = value), do: value
  defp parse_datetime(_), do: nil

  defp map_or_nil(value) when is_map(value), do: value
  defp map_or_nil(_), do: nil

  defp string(value) when is_binary(value), do: value
  defp string(nil), do: nil
  defp string(value), do: to_string(value)

  defp unix_ms(%DateTime{} = dt), do: DateTime.to_unix(dt, :millisecond)
  defp unix_ms(_), do: nil
end
