defmodule Shuttle.Continuation do
  @moduledoc """
  Worker-continuation signals, carried in the fiber's `shuttle:` frontmatter
  block — the substrate for clean-exit detection and resume-vs-fresh decisions.

  Four runtime fields live under `shuttle.runtime` (nested, machine-managed),
  written at the two natural moments and read straight off the polled fiber map:

    * `shuttle.runtime.session_uuid` + `shuttle.runtime.dispatched_at`
      (+ `shuttle.runtime.run_id` for standing) — **written by the daemon at
      dispatch** (`write_dispatch/4`), before the worker starts: the daemon
      assigns the conversation UUID the harness is started under
      (`--session-id`), so nothing is plumbed to the worker. A claim writes
      the same pair for the fiber it moves a live conversation to, and
      `shuttle.runtime.pane` when the claimer is known only by its pane.
    * `shuttle.runtime.handed_off_at` — **written by the WORKER at clean exit**
      via `shuttle handoff`, and by a human re-arm: Shuttle's `accept` / `resume`
      in the same write as the status, a force-dispatch
      `Shuttle.LifecycleStore.rearm` as a second write after it.
      A clean exit is the only thing that stamps it newer than the dispatch.

  The fields are **per-host by nature** but safe in git: only the owning host
  (`shuttle.host`) dispatches or resumes a fiber, so `session_uuid` is written
  and read by the same host; the git-sync to other hosts is inert (they ignore
  non-owned fibers). Reassigning `host` leaves the session's transcript on the
  old host, so the new owner finds none and starts fresh.

  ## Shuttle owns the nested write

  Shuttle updates `shuttle.runtime` through its YAML-aware writer. The daemon
  never edits the nested structure with text surgery; it shells `shuttle
  mark-runtime`. Writers here take a `runner`, the fiber's felt store, and its
  store-scoped id, instead of editing the `.md` directly.

  ## Reading: nested only

  Readers read ONLY `shuttle.runtime.<key>`. No code writes a flat runtime
  key, and reading one too would let a stale flat key shadow a
  since-written-but-since-cleared nested one. A fiber carrying only flat keys
  reads as having no continuation state (the safe default: absent
  `dispatched_at` treats as fresh).

  ## Continuation decision

  When a fiber's tmux session is gone, the daemon reads these fields off the
  freshly-polled fiber (`shuttle show -j` carries the whole `shuttle:` block):

    * `handed_off_at` present AND `handed_off_at >= dispatched_at` → **fresh**.
    * absent `dispatched_at` → treat as **fresh** (safe default).
    * otherwise (dispatched, no newer handoff) the session died without handing
      off, and its transcript's age decides: written within the warm window
      (`warm_window_s/0`) → **resume `session_uuid`**; older, or not on this
      host → **fresh**, with the prompt naming the cut-off session and its
      transcript. A resume replays the whole transcript into the model, which
      is cheap only while the harness's prompt cache still holds it; past
      that window a fresh worker reading `## Status` costs less at any size.
      A `surface: app` conversation skips the transcript check and resumes: it
      keeps its identity in the Codex App Server.

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

  @warm_window_s 45 * 60

  @doc """
  How long, in seconds, a session's transcript stays warm enough to resume:
  the `:resume_warm_window_s` application setting, else 45 minutes.
  """
  @spec warm_window_s() :: pos_integer()
  def warm_window_s, do: Shuttle.Env.app(:resume_warm_window_s, @warm_window_s)

  @doc """
  The transcript of `session` on this host, as `%{path, mtime}` (`mtime` a UTC
  `DateTime`), or `nil` when no harness here wrote one. One resolve through
  `Shuttle.Transcript.path/2` and one stat.
  """
  @spec transcript_stat(String.t(), keyword()) :: %{path: String.t(), mtime: DateTime.t()} | nil
  def transcript_stat(session, opts \\ []) when is_binary(session) do
    with path when is_binary(path) <- Shuttle.Transcript.path(session, opts),
         {:ok, %File.Stat{mtime: mtime}} <- File.stat(path, time: :posix) do
      %{path: path, mtime: DateTime.from_unix!(mtime)}
    else
      _ -> nil
    end
  end

  @doc """
  True iff `transcript` (as `transcript_stat/2` returns it) was written within
  `window_s` seconds of `now`. A missing transcript is never warm.
  """
  @spec warm?(%{mtime: DateTime.t()} | nil, DateTime.t(), non_neg_integer()) :: boolean()
  def warm?(transcript, now, window_s \\ warm_window_s())

  def warm?(%{mtime: %DateTime{} = mtime}, now, window_s),
    do: DateTime.diff(now, mtime, :second) <= window_s

  def warm?(_transcript, _now, _window_s), do: false

  @doc """
  True iff `transcript` was last written before the fiber's `dispatched_at`
  (compared to the second, the precision of a file mtime): the session id in
  the marker is not the one that dispatch launched. A codex/pi launch stamps
  `dispatched_at` at once but its own session id only when the scrape
  backfills it, so until then the marker still names the predecessor.
  """
  @spec predates_dispatch?(%{mtime: DateTime.t()} | nil, map()) :: boolean()
  def predates_dispatch?(%{mtime: %DateTime{} = mtime}, fiber) do
    case dispatched_at(fiber) do
      nil -> false
      dispatched -> DateTime.compare(mtime, DateTime.truncate(dispatched, :second)) == :lt
    end
  end

  def predates_dispatch?(_transcript, _fiber), do: false

  # ── readers (pure, over the polled fiber map) ────────────────────────────────

  # The `shuttle:` block of a polled fiber map, or `%{}` when absent.
  defp shuttle_block(fiber) when is_map(fiber) do
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

  @doc """
  True iff the worker handed off cleanly since the last dispatch: `handed_off_at`
  exists and is `>= dispatched_at`. The autonomous fresh signal.

  Defaults to clean (true) when there is no `dispatched_at` — uncertainty never
  forces a surprising mid-transcript resume. With a `dispatched_at` but no newer
  `handed_off_at` → false: the session ended without a handoff, and the
  dispatcher weighs its transcript (`Dispatcher.check_resume_intent/2`).
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

  @doc """
  The live execution a fiber's runtime assigns to it — `%{uuid, pane,
  generation}` — while its dispatch is unconcluded (no `handed_off_at` at or
  after `dispatched_at`) and names a conversation or a claimed pane; else
  `nil`. `generation` is the raw `dispatched_at` stamp, the value a
  conditional runtime write compares against.
  """
  @spec execution(map()) ::
          %{uuid: String.t() | nil, pane: map() | nil, generation: String.t()} | nil
  def execution(fiber) do
    uuid = resumable_session_id(fiber)
    pane = pane(fiber)

    if (uuid || pane) && not clean_handoff_since_dispatch?(fiber),
      do: %{uuid: uuid, pane: pane, generation: generation(fiber)}
  end

  @doc "The raw `shuttle.runtime.dispatched_at` stamp, or `\"\"` when none."
  @spec generation(map()) :: String.t()
  def generation(fiber) do
    case fiber |> shuttle_block() |> runtime_field("dispatched_at") do
      stamp when is_binary(stamp) -> stamp
      _ -> ""
    end
  end

  @doc """
  The tmux pane a claim bound, `shuttle.runtime.pane` (`<pid>:<start>`), as
  `%{"pid" => pid, "start" => start}`, or `nil`.
  """
  @spec pane(map()) :: map() | nil
  def pane(fiber) do
    with value when is_binary(value) <- fiber |> shuttle_block() |> runtime_field("pane"),
         [pid, start] when start != "" <- String.split(value, ":", parts: 2),
         {pid, ""} when pid > 0 <- Integer.parse(pid) do
      %{"pid" => pid, "start" => start}
    else
      _ -> nil
    end
  end

  @doc "The runtime encoding of a pane binding."
  @spec encode_pane(map() | nil) :: String.t()
  def encode_pane(%{"pid" => pid, "start" => start}), do: "#{pid}:#{start}"
  def encode_pane(_), do: ""

  # Nested-only. A non-map `runtime:` (degenerate/null) reads as absent —
  # no flat fallback (see the moduledoc's "Reading: nested only" section).
  defp runtime_field(shuttle, key) do
    case shuttle do
      %{"runtime" => runtime} when is_map(runtime) -> Map.get(runtime, key)
      _ -> nil
    end
  end

  # ── writers (shell `shuttle mark-runtime`) ──────────────────────────────

  @doc """
  Stamp the dispatch runtime fields into a fiber's `shuttle.runtime` block:
  `{session_uuid, dispatched_at, run_id, meeting}`, by shelling
  `shuttle -C <felt_store> mark-runtime`. `fiber_id` is the id scoped to
  `felt_store` — the same pair the dispatch read the fiber with — so Shuttle
  resolves it from that store.

  `dispatched_at` is set to now (RFC3339 UTC) unless the caller supplied one.
  `session_uuid` and `pane` are passed on every dispatch, so an absent value
  clears the predecessor's. `run_id` is passed only when present (a plain
  oneshot omits it), as is `meeting`, the launch id of the meeting a claimed
  capture scribes. `:if_dispatched_at` makes the write conditional on the
  generation it replaces (`mark_runtime` below).

  Best-effort: a non-zero `shuttle` exit is logged, not raised, so it can
  never block dispatch. A missing `felt_store`/`fiber_id` is a no-op (the fiber then
  reads as a fresh dispatch — the safe default).
  """
  @spec write_dispatch(module(), String.t(), String.t(), map()) :: :ok | {:error, term()}
  def write_dispatch(runner, felt_store, fiber_id, fields)
      when is_binary(felt_store) and felt_store != "" and is_binary(fiber_id) and fiber_id != "" and
             is_map(fields) do
    flags =
      [{"--dispatched-at", Map.get(fields, :dispatched_at) || iso_now()}]
      |> Kernel.++([{"--session", Map.get(fields, :session_uuid) || ""}])
      |> Kernel.++([{"--pane", encode_pane(Map.get(fields, :pane))}])
      |> add_flag("--run-id", Map.get(fields, :run_id))
      |> add_flag("--meeting", Map.get(fields, :meeting))
      |> if_generation(fields)

    mark_runtime(runner, felt_store, fiber_id, flags)
  end

  def write_dispatch(_runner, _felt_store, _fiber_id, _fields), do: :ok

  @doc """
  Rewrite `shuttle.runtime.session_uuid` in an ALREADY-STAMPED marker,
  without touching `dispatched_at` (or `run_id`) — the conversation a live
  worker continues as after `/clear` or `/resume`. Shells `shuttle mark-runtime --session <uuid>` with no
  `--dispatched-at` flag; `mark-runtime` only writes fields whose flag is
  present, so the boundary written at launch is left untouched. `:pane`
  also binds the worker's pane, so the process stays findable when its argv
  names only the conversation it started as; `:if_dispatched_at` makes the
  write conditional on its generation.
  """
  @spec backfill_session_uuid(module(), String.t(), String.t(), String.t(), map()) ::
          :ok | {:error, term()}
  def backfill_session_uuid(runner, felt_store, fiber_id, uuid, fields \\ %{})

  def backfill_session_uuid(runner, felt_store, fiber_id, uuid, fields)
      when is_binary(felt_store) and felt_store != "" and is_binary(fiber_id) and fiber_id != "" and
             is_binary(uuid) do
    flags =
      case Map.get(fields, :pane) do
        %{} = pane -> [{"--session", uuid}, {"--pane", encode_pane(pane)}]
        _ -> [{"--session", uuid}]
      end

    mark_runtime(runner, felt_store, fiber_id, if_generation(flags, fields))
  end

  def backfill_session_uuid(_runner, _felt_store, _fiber_id, _uuid, _fields), do: :ok

  @doc """
  Stamp `shuttle.runtime.handed_off_at = now` — the clean-exit / human-re-arm
  signal — by shelling `shuttle mark-runtime --handed-off-at`
  (`-C felt_store`). The worker's own exit uses `shuttle handoff`; this is the
  daemon-side entry point (the `LifecycleStore` conclude after a force-dispatch
  rearm or a self-healed standing constitution, and tests).
  """
  @spec mark_handed_off(module(), String.t(), String.t(), map()) :: :ok | {:error, term()}
  def mark_handed_off(runner, felt_store, fiber_id, fields \\ %{})

  def mark_handed_off(runner, felt_store, fiber_id, fields)
      when is_binary(felt_store) and felt_store != "" and is_binary(fiber_id) and fiber_id != "" do
    mark_runtime(
      runner,
      felt_store,
      fiber_id,
      if_generation([{"--handed-off-at", iso_now()}], fields)
    )
  end

  def mark_handed_off(_runner, _felt_store, _fiber_id, _fields), do: :ok

  # ── internals ────────────────────────────────────────────────────────────────

  # Shell `shuttle -C <felt_store> mark-runtime <fiber_id> <flags...>` through
  # the one audited write helper (`Shuttle.CLI`). `flags` is a list of
  # `{flag, value}` pairs; an empty value removes that key. Shuttle resolves its
  # own host from local state, so no `--host` override is passed; see
  # `Shuttle.CLI`'s moduledoc. A conditional write refused because the fiber
  # moved to another generation is `{:error, :generation_mismatch}`.
  defp mark_runtime(runner, felt_store, fiber_id, flags) do
    args = Enum.flat_map(flags, fn {f, v} -> [f, v] end)

    case Shuttle.CLI.run_lifecycle("mark-runtime", fiber_id, args,
           runner: runner,
           felt_store: felt_store
         ) do
      {:ok, _output} ->
        :ok

      {:command_error, status, output} ->
        output = String.trim(to_string(output))

        if String.contains?(output, "dispatched_at mismatch") do
          {:error, :generation_mismatch}
        else
          reason = "shuttle mark-runtime exited #{status}: #{output}"
          Logger.warning("Continuation: #{reason} (fiber=#{fiber_id}, store=#{felt_store})")
          {:error, reason}
        end

      {:error, reason} ->
        Logger.warning(
          "Continuation: shuttle mark-runtime raised #{inspect(reason)} " <>
            "(fiber=#{fiber_id}, store=#{felt_store})"
        )

        {:error, reason}
    end
  end

  # `--if-dispatched-at` when the caller names the generation the write
  # applies to: Shuttle compares it with the fiber's current `dispatched_at`
  # under the fiber lock and refuses the write on a mismatch.
  defp if_generation(flags, %{if_dispatched_at: generation}) when is_binary(generation),
    do: flags ++ [{"--if-dispatched-at", generation}]

  defp if_generation(flags, _fields), do: flags

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
