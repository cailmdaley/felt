defmodule Shuttle.Continuation do
  @moduledoc """
  Worker-continuation signals, carried in the fiber's `shuttle:` frontmatter
  block — the substrate that replaced felt history (and, before this, the
  per-host marker files).

  Four runtime fields live under `shuttle.runtime` (Stage 5: nested,
  machine-managed), written at the two natural moments and read straight off the
  polled fiber map:

    * `shuttle.runtime.session_uuid` + `shuttle.runtime.dispatched_at`
      (+ `shuttle.runtime.run_id` for standing) — **written by the daemon at
      dispatch** (`write_dispatch/4`). The daemon holds the session UUID
      (claude: the `--session-id` it generated; codex/pi: scraped from the
      JSONL), so nothing is plumbed to the worker.
    * `shuttle.runtime.handed_off_at` — **written by the WORKER at clean exit**
      via `felt shuttle handoff` (Go, nested surgical write), and by a human
      re-arm (`Shuttle.LifecycleStore`, a second write after the status re-arm).
      A clean exit is the only thing that stamps it newer than the dispatch.

  The fields are **per-host by nature** but safe in git: only the owning host
  (`shuttle.host`) dispatches or resumes a fiber, so `session_uuid` is written
  and read by the same host; the git-sync to other hosts is inert (they ignore
  non-owned fibers). Reassigning `host` degrades gracefully to a failed resume →
  fresh.

  ## felt owns the nested write (Stage 5, Option B)

  The runtime nesting lives in ONE engine — felt's `yaml.Node` code. The daemon
  never edits the two-level `shuttle.runtime` structure with its own text
  surgery; it shells `felt shuttle mark-runtime`, felt's daemon-facing
  runtime-write channel. So the writers here take a `runner` + the fiber's felt
  store + its store-scoped id and shell that verb, instead of editing the `.md`
  directly.

  ## Reading: nested only (C5 — the flat fallback is retired)

  Readers read ONLY `shuttle.runtime.<key>`. The migration this shim covered
  (Stage 5's cutover to nested writes) is long done — no code writes a flat
  runtime key anymore (`internal/felt/shuttle.go`'s `SetShuttleField` still
  supports it as a generic primitive, but the only production caller left is
  `set-agent`'s `agent` field, never a runtime key) — so the dual-read was a
  pure ambiguity surface: a STALE flat key left over from before the cutover
  could shadow a since-written-but-since-cleared nested one, or simply mask
  the fact that a fiber was never lifted. `Shuttle.Poller`'s boot-time scan
  (`scan_flat_runtime_fibers_once/2`) logs any fiber still carrying ONLY flat
  keys with no nested counterpart; such a fiber now reads as having no
  continuation state (the existing safe-default: absent `dispatched_at` treats
  as fresh) rather than silently resurrecting a possibly-stale flat value.
  `felt shuttle migrate-runtime <fiber>` lifts it into the nested form.

  ## Continuation decision

  When a fiber's tmux session is gone, the daemon reads these fields off the
  freshly-polled fiber (no file IO — `felt show -j` already carries the whole
  `shuttle:` block):

    * `handed_off_at` present AND `handed_off_at >= dispatched_at` → **fresh**.
    * otherwise (dispatched, no newer handoff) → **resume `session_uuid`**.
    * absent `dispatched_at` → treat as **fresh** (safe default).

  A fresh `dispatched_at` at redispatch naturally supersedes a stale
  `handed_off_at` (the new dispatch is newer than the old handoff), so nothing
  needs clearing.

  Timestamps are **RFC3339 UTC**: the Elixir writer emits
  `DateTime.to_iso8601(DateTime.utc_now())` (`…Z`), the Go writer
  `time.Now().UTC().Format(time.RFC3339Nano)`; both parse identically via
  `DateTime.from_iso8601/1`, and the comparison is on the wire value, so
  sub-second precision is exact.
  """

  require Logger

  # ── readers (pure, over the polled fiber map) ────────────────────────────────

  @doc "The `shuttle:` block of a polled fiber map, or `%{}` when absent."
  @spec shuttle_block(map()) :: map()
  def shuttle_block(fiber) when is_map(fiber) do
    case Map.get(fiber, "shuttle") do
      block when is_map(block) -> block
      _ -> %{}
    end
  end

  @doc "`shuttle.runtime.dispatched_at` as a `DateTime`, or `nil`."
  @spec dispatched_at(map()) :: DateTime.t() | nil
  def dispatched_at(fiber),
    do: fiber |> shuttle_block() |> runtime_field("dispatched_at") |> parse_iso()

  @doc "`shuttle.runtime.handed_off_at` as a `DateTime`, or `nil`."
  @spec handed_off_at(map()) :: DateTime.t() | nil
  def handed_off_at(fiber),
    do: fiber |> shuttle_block() |> runtime_field("handed_off_at") |> parse_iso()

  @doc """
  `shuttle.runtime.run_id` as a string, or `nil` when absent/empty. Stamped by
  the daemon at dispatch; an ad-hoc (force-dispatched extra) run carries an
  `adhoc-<ms>` id (`StandingRole.ad_hoc_run_id/1`), a scheduled run a cron
  timestamp label.
  """
  @spec run_id(map()) :: String.t() | nil
  def run_id(fiber) do
    case fiber |> shuttle_block() |> runtime_field("run_id") do
      id when is_binary(id) and id != "" -> id
      _ -> nil
    end
  end

  @doc """
  The resumable session UUID — `shuttle.runtime.session_uuid`, or `nil` when
  absent/empty. The sole structured home for the resume id.
  """
  @spec resumable_session_id(map()) :: String.t() | nil
  def resumable_session_id(fiber) do
    case fiber |> shuttle_block() |> runtime_field("session_uuid") do
      uuid when is_binary(uuid) and uuid != "" -> uuid
      _ -> nil
    end
  end

  @runtime_keys ~w(dispatched_at session_uuid handed_off_at run_id)

  @doc """
  C5 boot-scan primitive: legacy flat runtime keys present on `fiber`'s
  `shuttle:` block whose nested `shuttle.runtime.<key>` counterpart is
  ABSENT — a fiber never lifted by `felt shuttle migrate-runtime`, which now
  reads as having no continuation state at all (the readers above no longer
  fall back to flat). Returns `[]` when there is nothing to flag (already
  nested, or never had runtime state).
  """
  @spec flat_only_runtime_keys(map()) :: [String.t()]
  def flat_only_runtime_keys(fiber) do
    shuttle = shuttle_block(fiber)

    runtime =
      case Map.get(shuttle, "runtime") do
        m when is_map(m) -> m
        _ -> %{}
      end

    Enum.filter(@runtime_keys, fn key ->
      case Map.get(shuttle, key) do
        v when is_binary(v) and v != "" -> not Map.has_key?(runtime, key)
        _ -> false
      end
    end)
  end

  @doc """
  True iff the worker handed off cleanly since the last dispatch: `handed_off_at`
  exists and is `>= dispatched_at`. The autonomous fresh signal.

  Defaults to clean (true) when there is no `dispatched_at` — uncertainty never
  forces a surprising mid-transcript resume. With a `dispatched_at` but no newer
  `handed_off_at` → false (died mid-thought → resume).
  """
  @spec clean_handoff_since_dispatch?(map()) :: boolean()
  def clean_handoff_since_dispatch?(fiber) do
    case dispatched_at(fiber) do
      nil ->
        true

      dispatch_dt ->
        case handed_off_at(fiber) do
          nil -> false
          handoff_dt -> DateTime.compare(handoff_dt, dispatch_dt) != :lt
        end
    end
  end

  # C5: nested-only. A non-map `runtime:` (degenerate/null) reads as absent —
  # no flat fallback (see the moduledoc's "Reading: nested only" section).
  defp runtime_field(shuttle, key) do
    case shuttle do
      %{"runtime" => runtime} when is_map(runtime) -> Map.get(runtime, key)
      _ -> nil
    end
  end

  # ── writers (shell `felt shuttle mark-runtime` — felt owns the nesting) ───────

  @doc """
  Stamp the dispatch runtime fields into a fiber's `shuttle.runtime` block:
  `{session_uuid, dispatched_at, run_id}`, by shelling `felt shuttle
  mark-runtime` (felt's daemon-facing runtime-write channel) with
  `cd: felt_store`. `fiber_id` is the id scoped to `felt_store` — the same pair
  the dispatch read the fiber with — so felt resolves it from that store.

  `dispatched_at` is set to now (RFC3339 UTC) unless the caller supplied one.
  `session_uuid` is passed only when non-empty (a codex/pi claim with no scraped
  UUID still stamps `dispatched_at`, the run-window anchor). `run_id` is passed
  only when present (a plain oneshot omits it).

  Best-effort: a non-zero `felt` exit is logged, not raised, so it can never
  block dispatch. A missing `felt_store`/`fiber_id` is a no-op (the fiber then
  reads as a fresh dispatch — the safe default).
  """
  @spec write_dispatch(module(), String.t(), String.t(), map()) :: :ok | {:error, term()}
  def write_dispatch(runner, felt_store, fiber_id, fields)
      when is_binary(felt_store) and felt_store != "" and is_binary(fiber_id) and fiber_id != "" and
             is_map(fields) do
    flags =
      [{"--dispatched-at", Map.get(fields, :dispatched_at) || iso_now()}]
      |> add_flag("--session", Map.get(fields, :session_uuid))
      |> add_flag("--run-id", Map.get(fields, :run_id))

    mark_runtime(runner, felt_store, fiber_id, flags)
  end

  def write_dispatch(_runner, _felt_store, _fiber_id, _fields), do: :ok

  @doc """
  Backfill `shuttle.runtime.session_uuid` into an ALREADY-STAMPED marker,
  without touching `dispatched_at` (or `run_id`) — the codex/pi path, where
  `write_dispatch/4` already stamped the dispatch boundary synchronously at
  launch and the session UUID is only scraped from the harness's JSONL
  afterward. Shells `felt shuttle mark-runtime --session <uuid>` with no
  `--dispatched-at` flag; `mark-runtime` only writes fields whose flag is
  present, so the boundary written at launch is left untouched.
  """
  @spec backfill_session_uuid(module(), String.t(), String.t(), String.t()) ::
          :ok | {:error, term()}
  def backfill_session_uuid(runner, felt_store, fiber_id, uuid)
      when is_binary(felt_store) and felt_store != "" and is_binary(fiber_id) and fiber_id != "" and
             is_binary(uuid) and uuid != "" do
    mark_runtime(runner, felt_store, fiber_id, [{"--session", uuid}])
  end

  def backfill_session_uuid(_runner, _felt_store, _fiber_id, _uuid), do: :ok

  @doc """
  Stamp `shuttle.runtime.handed_off_at = now` — the clean-exit / human-re-arm
  signal — by shelling `felt shuttle mark-runtime --handed-off-at`
  (`cd: felt_store`). The worker's own exit uses the Go `felt shuttle handoff`;
  this is the daemon-side entry point (the `LifecycleStore` conclude after an
  accept/resume/rearm, and tests).
  """
  @spec mark_handed_off(module(), String.t(), String.t()) :: :ok | {:error, term()}
  def mark_handed_off(runner, felt_store, fiber_id)
      when is_binary(felt_store) and felt_store != "" and is_binary(fiber_id) and fiber_id != "" do
    mark_runtime(runner, felt_store, fiber_id, [{"--handed-off-at", iso_now()}])
  end

  def mark_handed_off(_runner, _felt_store, _fiber_id), do: :ok

  # ── internals ────────────────────────────────────────────────────────────────

  # Shell `felt shuttle mark-runtime <fiber_id> <flags...>` (cd: felt_store)
  # through the one audited write helper (`Shuttle.Felt.Shuttle`). `flags` is
  # a list of `{flag, value}` pairs, already filtered to non-empty.
  #
  # Post-S1/C1, felt's own `resolveOwnHost` is pure local state — no
  # re-entrant `--host` override needed here (or anywhere else in the
  # daemon-shelled write plane); see `Shuttle.Felt.Shuttle`'s moduledoc.
  defp mark_runtime(runner, felt_store, fiber_id, flags) do
    args = Enum.flat_map(flags, fn {f, v} -> [f, v] end)

    case Shuttle.Felt.Shuttle.run("mark-runtime", fiber_id, args, runner: runner, cd: felt_store) do
      {:ok, _output} ->
        :ok

      {:command_error, status, output} ->
        reason = "felt shuttle mark-runtime exited #{status}: #{String.trim(to_string(output))}"
        Logger.warning("Continuation: #{reason} (fiber=#{fiber_id}, store=#{felt_store})")
        {:error, reason}

      {:error, reason} ->
        Logger.warning(
          "Continuation: felt shuttle mark-runtime raised #{inspect(reason)} " <>
            "(fiber=#{fiber_id}, store=#{felt_store})"
        )

        {:error, reason}
    end
  end

  # Append a `{flag, value}` pair for an OPTIONAL field: only when the caller
  # supplied a non-nil, non-empty value. Keeps `--session` / `--run-id` off the
  # command line when there is nothing to write.
  defp add_flag(flags, _flag, value) when value in [nil, ""], do: flags
  defp add_flag(flags, flag, value) when is_binary(value), do: flags ++ [{flag, value}]
  defp add_flag(flags, flag, value), do: flags ++ [{flag, to_string(value)}]

  defp iso_now, do: DateTime.to_iso8601(DateTime.utc_now())

  defp parse_iso(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, dt, _offset} -> dt
      _ -> nil
    end
  end

  defp parse_iso(_), do: nil
end
