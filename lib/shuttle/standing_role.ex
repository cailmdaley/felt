defmodule Shuttle.StandingRole do
  @moduledoc """
  Parses and classifies `shuttle.kind: standing` fiber declarations.

  Standing roles are still felt fibers. Shuttle interprets the `shuttle:` block
  plus the document's `status`/`tempered` to decide whether a role is sleeping,
  due, or running. "Awaiting review" and "accepted/composted" are document facts
  (`status:closed` + untempered / `tempered`), not a `review.state` axis — there
  is none; the schedule-derived phase here only answers sleeping/due/running for
  an armed role.

  **felt is the cron authority; this module is the timing decider.**
  The daemon no longer parses cron. felt resolves the schedule on every read and
  inlines two timestamps under `shuttle.resolved`: `next_due` (the next
  occurrence strictly after now — display) and `prev_due` (the most recent
  occurrence at or before now — the catch-up dispatch signal). This module reads
  those off the block and answers every timing question by comparing instants.
  The key reduction: "did a tick fire since the role was last serviced?" is
  `prev_due > last_serviced`, equal to the old `NextOccurrence(last_serviced) <=
  now` window check for every schedule with an occurrence inside felt's ~1-year
  catch-up horizon — i.e. every real standing role. The two diverge only for a
  sub-annual schedule on a role unserviced for >1 year (e.g. a leap-Feb-29 role
  between leap years): felt's `prev_due` scans 1 year back from now and omits it,
  so such a role sleeps until its next fire rather than firing an ancient
  catch-up — an accepted, arguably-better behavior at that exotic boundary.
  """

  defstruct [
    :fiber_id,
    # Intrinsic uid (ULID) carried from the candidate document, for the
    # snapshot's runtime join key. nil when the caller didn't supply it or the
    # fiber has no uid.
    :uid,
    :mode,
    # The raw schedule map, carried for the snapshot's display only — never
    # parsed here (felt owns cron). nil for a block without one.
    :schedule,
    # felt-resolved occurrences (shuttle.resolved.{next_due,prev_due}), the sole
    # source of timing. next_due_at: next tick > now (display + the
    # parseable-schedule signal). prev_due: most recent tick <= now (the
    # dispatch/display due signal). Both nil unless felt resolved a standing
    # schedule.
    :next_due_at,
    :prev_due,
    validation_errors: []
  ]

  @type t :: %__MODULE__{
          fiber_id: String.t(),
          uid: String.t() | nil,
          mode: String.t() | nil,
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
      mode: string(data["kind"] || data["mode"]),
      schedule: map_or_nil(data["schedule"]),
      # next_due/prev_due come from felt's resolution; fall back to the legacy
      # flat next_due_at only if felt emitted nothing (pre-Stage-2 documents).
      next_due_at: parse_datetime(resolved["next_due"] || data["next_due_at"]),
      prev_due: parse_datetime(resolved["prev_due"])
    }

    {:ok, %{role | validation_errors: validation_errors(role)}}
  end

  @spec standing?(t() | nil) :: boolean()
  def standing?(%__MODULE__{mode: "standing"}), do: true
  def standing?(_), do: false

  @doc """
  The schedule-derived display phase for an armed role, computed from felt's
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
  # document flips to closed. felt's prev_due is the most recent occurrence; a
  # fixed lookback window is how a just-fired tick is recognized for display
  # (mirrors the dispatch path's `due_by_cron?` window, sized for display rather
  # than the poll cadence).
  @display_due_window_ms 90_000

  # Display due-ness for `state/3`: a valid role whose most recent occurrence
  # (felt's prev_due) fell inside `(now - window, now]`. Pure timestamp compare —
  # no cron parse, no stored next_due_at, no review gate.
  defp due_by_schedule?(%__MODULE__{prev_due: %DateTime{} = prev} = role, %DateTime{} = now) do
    valid?(role) and
      DateTime.compare(prev, DateTime.add(now, -@display_due_window_ms, :millisecond)) == :gt
  end

  defp due_by_schedule?(_, _), do: false

  @doc """
  Occurrence-derived due check for the **dispatch** path: true iff the schedule's
  most recent tick (felt's `prev_due`) fell inside the lookback `(now -
  window_ms, now]` — equivalently, strictly after `window_start = now -
  window_ms`. felt's prev_due is always `<= felt's now <= now`, so the upper
  bound holds for free and only the lower bound is checked.

  Due-ness is a pure timestamp comparison against felt's resolved occurrence, NOT
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

  # Dispatch-path validity: a standing role for which felt resolved a schedule
  # (next_due_at present ⟺ the cron parsed and a future tick exists). Both the
  # dispatch and display paths gate on this alone — there are no review/next_due
  # validations: the document, not a review overlay, is the truth.
  defp dispatchable?(%__MODULE__{mode: "standing", next_due_at: %DateTime{}}), do: true
  defp dispatchable?(_), do: false

  @doc """
  The next scheduled occurrence, for the kanban **display** next_due — felt's
  resolved `next_due` (the next tick strictly after now), read straight off the
  block. Returns nil when felt resolved no schedule. The `now` argument is
  accepted for call-site compatibility but unused: felt computed the occurrence.
  """
  @spec next_due_from_cron(t(), DateTime.t()) :: DateTime.t() | nil
  def next_due_from_cron(%__MODULE__{next_due_at: %DateTime{} = next}, _now), do: next
  def next_due_from_cron(_, _), do: nil

  @spec valid?(t()) :: boolean()
  def valid?(%__MODULE__{validation_errors: []}), do: true
  def valid?(_), do: false

  @doc """
  Run id for a *scheduled* (non-ad-hoc) standing dispatch — a display label for
  the prompt's `Run:` line, minted from felt's next_due (or now).

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

  # Validity is the document's intrinsic shape: a standing role for which felt
  # resolved a schedule (next_due_at present). There are no review/next_due
  # validations — the document (status + tempered) is the truth, and felt already
  # rejected an unparseable schedule on write (emitting no resolved occurrence).
  defp validation_errors(%__MODULE__{} = role) do
    [
      validate_mode(role),
      validate_schedule(role)
    ]
    |> Enum.reject(&is_nil/1)
  end

  defp validate_mode(%__MODULE__{mode: "standing"}), do: nil
  defp validate_mode(%__MODULE__{mode: mode}), do: "kind must be standing, got #{inspect(mode)}"

  # A standing role is well-formed iff felt resolved a next occurrence for it.
  # felt emits next_due only when the cron parsed, so its presence IS the
  # parseable-schedule signal — the daemon never re-validates the expression.
  defp validate_schedule(%__MODULE__{next_due_at: %DateTime{}}), do: nil
  defp validate_schedule(%__MODULE__{}), do: "felt resolved no schedule occurrence (next_due)"

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
