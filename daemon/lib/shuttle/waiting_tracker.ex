defmodule Shuttle.WaitingTracker do
  @moduledoc """
  The *most recent hook event* per worker session, projected from this host's
  agent hook-event stream (`~/.shuttle/events.jsonl`), so the feed can rank
  in-flight workers by how long they've been idle. This module is the pure
  projection; `Shuttle.EventStream` reads the stream and holds the map, and
  `Shuttle.EventStream.session_activity/1` serves `phases/2` of it.

  ## Why tail the local stream

  `shuttle hook event` — registered by the bundled plugin on both Claude Code and
  Codex — appends every hook event to a host-local `events.jsonl` on every
  machine a worker runs on. The owning
  daemon stamps runtime liveness for *its own* fibers (local daemon for local
  workers, the remote daemon for remote workers — the resolve/invoke split in
  the composite feed). So the simplest transport that respects that split is:
  **each daemon tails its own host's `events.jsonl`** and contributes the real
  last-activity timestamp + a `phase` category to the runtime block it already
  serves. No new cross-host channel — the signal rides the same per-host
  runtime stamping that `tmux_session` liveness already does.

  ## Session activity and live children

  Each tracked session holds the raw type and real timestamp of its most
  recent parent event, plus the background work it left running.
  Codex child tool events refresh a held stop without replacing its type.
  Explicit permission and elicitation notifications signal attention. An idle
  reminder remains waiting; elapsed idle time alone does not require action.

  `at` is the event's **own** `timestamp` (epoch ms carried on every hook line),
  not the poll wall-clock — that's what makes idle-duration ranking real.

  ## Phase category, derived at READ time

  `phases/2` resolves each stored record to `%{last_event_at, phase}`,
  where `phase` is the category of the last event type:

    * `notification` → `"attention"` for permission, elicitation, and untyped
      notifications; `idle_prompt` → `"waiting"`, or `"working"` over outstanding
      background work; see "Waiting on itself" below.
    * `stop` → `"waiting"` (the turn finished; the agent is idle, waiting on
      the next input) — again except over outstanding background work.
    * anything else — `pre_tool_use`, `post_tool_use`, `user_prompt_submit`,
      `session_start`, … → `"working"`. This is the **long-tool guard**: a
      worker mid-tool (last event `pre_tool_use`, no following stop) is
      `"working"` no matter how long ago that event fired, so it sorts to the
      bottom of the in-flight column rather than masquerading as idle.

  ## Waiting on itself, not on you

  An idle session is the human's move only when nothing it started is still
  running. A session that ends its turn with background shells or background
  subagents in flight is idle in the harness's sense and NOT idle in the sense
  the board cares about: nobody needs to do anything, the work is running. Left
  alone it would read as `"waiting"`: the board asking for a hand on a
  worker that is watching its own build.

  Each harness reports its live children in its own way, and each fact is read
  as the harness states it:

    * **Claude Code** — `stop` carries `background_tasks`, the harness's whole
      background registry: detached shells and background subagents.
      The hook writer emits its size as `backgroundTasks`.
      The count is remembered on the session (`bg`) and carried forward until
      the session is resumed by a prompt or restarted, at which point it is zero
      again and the next stop restamps the truth.
    * **Codex** — `stop` names nothing outstanding, but the parent's stream
      carries each `spawn_agent` / `followup_task` call (`post_tool_use`) and
      each child's `subagent_stop`, and the children's own tool events land on
      the parent's session too. Starts minus stops is the live-child count
      (`kids`). A stop over live children HOLDS: the children's tool events
      refresh its time without overwriting it, and the `subagent_stop` that
      takes the count to zero is the moment the session becomes the human's
      move. A prompt does not clear `kids`, because no later stop restates it;
      a session start or end does. Counts are scoped to the Codex session id:
      a nested probe or another harness in the same tmux pane cannot inherit
      them. Hooks don't identify individual children, so this is a bounded
      count rather than an authoritative per-child registry.
    * `notification` carries `notification_type`. Only `idle_prompt` means
      "nobody has typed in a while"; `permission_prompt` and the elicitation
      kinds mean the agent is genuinely blocked ON A HUMAN and stay
      `"attention"` no matter what else is running.

  So an idle-looking session with `bg > 0` or `kids > 0` categorizes as
  `"working"`, which is exactly what it is. A harness that sends none of these
  (Pi, and any line written before them) has both at zero: its idle session
  reads `"waiting"`, the human's turn, which is the safe default for a worker
  that forgot to signal.

  ### The suppression is BOUNDED, and that is the point

  Nothing decrements `bg` when a task finishes: work that ends triggers a
  follow-up turn whose stop restates the count, which is the ordinary path. A
  Codex child that dies without its `subagent_stop` leaves `kids` too high in
  the same way. The task that
  never returns — a dev server, a tail, a shell nobody killed — has no such
  path, and left unbounded it would silence its worker forever. That is a worse
  failure than the one this fixes: a false "needs you" is noise a person
  dismisses, a false "nothing to see" is a worker nobody ever looks at again.

  So the suppression expires — and that bound is doing all of the safety work,
  which is why the writer does not also try to guess which task kinds are
  long-lived. Past `@bg_suppress_ms` of silence the session is
  categorized as if `bg` and `kids` were zero — it has been quiet a long time with nothing
  to show for it, and the board should say so rather than keep vouching for work
  it can no longer confirm is happening. The bound is generous (an hour) because
  a long build is precisely what this is for.

  Idle gating lives on the client, not here: the daemon reports the category
  and the real timestamp, and the client computes idle (`clientNow -
  last_event_at`) to decide whether to show a chip.

  ## A subagent's stop is not the session's

  Outside Codex child tracking, `subagent_stop` says a subagent finished, not
  what the session around it is doing, so it leaves the record alone, as a
  `file_sent` delivery does. It
  fires mid-turn (a foreground `Agent` call returning), while the parent sits
  idle on a background subagent it will wake to digest, and while the session
  is idle with no subagent of its own in flight (apparently Claude Code's away
  summary). Read as a stop, the second would show a worker digesting a result
  as waiting, and the third would move an idle worker's `last_event_at`
  forward. The parent's own
  `stop` and idle `notification` are the session's waiting signals.

  Self-healing: `Shuttle.Poller.stamp_runtime/2` only stamps for sessions still
  in `state.running`, so a dead worker's record is harmless. The age prune
  (`@max_age_ms`, 48h) is hygiene for the rare session that dies stale.

  ## Reading the past (boot seeding)

  On boot `Shuttle.EventStream` SEEDS the map from the existing
  `events.jsonl.1` and `events.jsonl` in a single forward pass (last-event-wins,
  pruning sessions whose last event is older than `@max_age_ms`), THEN follows
  forward from the live file's current end. So a worker that stopped before the
  daemon restarted — e.g. a review left idle 24h ago — is known on the very
  first serve, instead of being invisible until its next event (which, being
  idle, may never come).

  A truncated or replaced file cannot make a remembered session wrong, only
  unrefreshed, so when the stream rebuilds from the files the map keeps what it
  knew (`merge_known/2`).

  Only `*-shuttle` sessions are tracked; events from interactive (non-shuttle)
  sessions are ignored, mirroring the dispatch gate.
  """

  # How long a remembered background-task count may keep a session out of the
  # attention column. See "The suppression is BOUNDED" above.
  @bg_suppress_ms 60 * 60 * 1_000
  @max_age_ms 48 * 60 * 60 * 1_000

  @typedoc """
  Each session record holds `type`, `at`, `kind`, `bg`, `kids`, `harness`,
  and `session_id`: parent activity and live-child facts, scoped to their
  harness session identity.
  """
  @type sessions :: %{optional(String.t()) => map()}

  @doc """
  A `session => %{last_event_at: ms, phase: phase}` map over every tracked
  `*-shuttle` session in `sessions`, at wall-clock `now`: `last_event_at` is
  the real timestamp of the session's most recent hook event and `phase` its
  category — `"attention"`, `"waiting"`, or `"working"` (see the moduledoc).
  The caller (poller) joins this against `state.running` in O(1) and computes
  idle from `last_event_at`; no gating happens here.
  """
  @spec phases(sessions(), integer()) ::
          %{optional(String.t()) => %{last_event_at: integer(), phase: String.t()}}
  def phases(sessions, now) do
    Map.new(sessions, fn {session, %{type: type, at: at} = rec} ->
      live = if now - at >= @bg_suppress_ms, do: 0, else: rec.bg + Map.get(rec, :kids, 0)
      {session, %{last_event_at: at, phase: category(type, rec.kind, live)}}
    end)
  end

  # The phase category of the most-recent event type, read against the two
  # facts the harnesses volunteer: which notification this is, and how much
  # work the session left running under it (background tasks plus live
  # spawned agents).
  #
  # The catch-all is the long-tool guard: anything that isn't an explicit
  # idle/escalation signal (pre_tool_use, post_tool_use, user_prompt_submit,
  # session_start, …) is "working", so a mid-tool worker sinks to the bottom
  # regardless of wall-clock.
  #
  # A session with background work in flight is working by the same logic one
  # foreground tool call away: the difference between the two is only where the
  # harness parked the process, and nobody is being asked for anything either
  # way. A permission prompt or an elicitation is the exception that proves it —
  # there the human IS the blocker, running shells or not.
  defp category("notification", "idle_prompt", bg) when bg > 0, do: "working"
  defp category("notification", "idle_prompt", _bg), do: "waiting"
  defp category("notification", _kind, _bg), do: "attention"
  defp category("stop", _kind, bg) when bg > 0, do: "working"
  defp category("stop", _kind, _bg), do: "waiting"
  defp category(_type, _kind, _bg), do: "working"

  @doc """
  One decoded event folded onto `sessions`. Last-event-wins: every event for a
  `*-shuttle` session overwrites its record with the event's own type and real
  timestamp. The `"timestamp"` field is on every hook line; `now` is only a
  fallback for a line missing it (we never invent a worse-than-now age). A
  `file_sent` event is a delivery and a `subagent_stop` belongs to a subagent;
  neither is the session's own activity, and both leave the record alone,
  except that a `subagent_stop` retires one live Codex child. While a stop
  holds over live children, their tool events refresh its time and keep its
  type (see "Waiting on itself" above).

  The strings kept are copied out of the event, so the map never pins the
  buffer a line was read from.
  """
  @spec apply_event(sessions(), map(), integer()) :: sessions()
  def apply_event(sessions, %{"type" => "file_sent"}, _now), do: sessions

  def apply_event(sessions, %{"type" => "subagent_stop", "tmuxSession" => session} = ev, now)
      when is_binary(session) do
    case Map.get(sessions, session) do
      %{kids: kids, harness: "codex", session_id: id} = rec
      when kids > 0 and id == :erlang.map_get("sessionId", ev) ->
        rec = %{rec | kids: kids - 1}
        # The last child of a held stop returning is when the turn passes to
        # the human; its time is the start of that wait.
        rec =
          if rec.kids == 0 and rec.type in ["stop", "notification"],
            do: %{rec | at: event_at(ev, now)},
            else: rec

        Map.put(sessions, session, rec)

      _ ->
        sessions
    end
  end

  def apply_event(sessions, %{"type" => "subagent_stop"}, _now), do: sessions

  def apply_event(sessions, %{"type" => type, "tmuxSession" => session} = ev, now)
      when is_binary(type) and is_binary(session) and session != "" do
    prev = Map.get(sessions, session)

    if Shuttle.Dispatcher.shuttle_session?(session) and not foreign_end?(prev, ev) do
      at = event_at(ev, now)
      kids = live_children(type, ev, prev)

      record =
        if held?(prev, ev) and kids > 0 and type in ["pre_tool_use", "post_tool_use"] do
          %{prev | at: at, kids: kids}
        else
          %{
            type: :binary.copy(type),
            at: at,
            kind: notification_kind(ev),
            bg: background_tasks(type, ev, prev),
            kids: kids,
            harness: Map.get(ev, "harness"),
            session_id: Map.get(ev, "sessionId")
          }
        end

      Map.put(sessions, :binary.copy(session), record)
    else
      sessions
    end
  end

  def apply_event(sessions, _event, _now), do: sessions

  @doc "`sessions` without those whose last event is older than 48 hours at `now`."
  @spec prune(sessions(), integer()) :: sessions()
  def prune(sessions, now) do
    cutoff = now - @max_age_ms
    Map.reject(sessions, fn {_s, %{at: at}} -> at < cutoff end)
  end

  @doc """
  `rebuilt` over `known`: a session only `known` mentions stays, and where
  both do, the record with the newer event wins, so a rebuild from a truncated
  or replaced file never moves a record back to an older event.
  """
  @spec merge_known(sessions(), sessions()) :: sessions()
  def merge_known(known, rebuilt) do
    Map.merge(known, rebuilt, fn _session, old, new -> if new.at >= old.at, do: new, else: old end)
  end

  # A session ending that is not the one the pane's record follows (a nested
  # probe in the same pane) says nothing about the worker's own turn.
  defp foreign_end?(%{session_id: tracked}, %{"type" => "session_end", "sessionId" => id})
       when is_binary(tracked) and is_binary(id),
       do: tracked != id

  defp foreign_end?(_prev, _ev), do: false

  defp event_at(ev, now) do
    case Map.get(ev, "timestamp") do
      ts when is_integer(ts) -> ts
      _ -> now
    end
  end

  # A stop whose session still has live spawned agents: the turn ended, and
  # the tool events that follow are the children's, not a new parent turn.
  defp held?(
         %{type: type, kids: kids, harness: harness, session_id: id},
         %{"harness" => harness, "sessionId" => id}
       )
       when kids > 0 and type in ["stop", "notification"],
       do: true

  defp held?(_prev, _event), do: false

  # How many spawned agents this session has running, as of this event. A
  # Codex `spawn_agent` or `followup_task` that returned starts a child turn,
  # and its `subagent_stop` (handled above) ends one. A session start or end
  # clears the count. Everything else, a prompt included, carries it forward:
  # no later event restates it.
  defp live_children(type, _ev, _prev) when type in ["session_start", "session_end"], do: 0

  defp live_children(type, %{"harness" => "codex"} = ev, prev) do
    carried =
      case prev do
        %{harness: "codex", session_id: id, kids: kids}
        when id == :erlang.map_get("sessionId", ev) ->
          kids

        _ ->
          0
      end

    if type == "post_tool_use" and
         ev["tool"] in ["collaborationspawn_agent", "collaborationfollowup_task"],
       do: carried + 1,
       else: carried
  end

  defp live_children(_type, _ev, _prev), do: 0

  defp notification_kind(%{"notificationKind" => kind}) when is_binary(kind),
    do: :binary.copy(kind)

  defp notification_kind(_), do: ""

  # How much detached work this session is leaving behind, as of this event.
  #
  # A stop STATES it. A prompt or a session start CLEARS it — the session has
  # been resumed or restarted, and whatever it is now leaving running the next
  # `stop` will say. Everything else CARRIES IT FORWARD, because the notable
  # case is exactly the one where nothing further is recorded: the idle
  # `notification` that arrives a minute after the stop and, on its own, knows
  # nothing about the shells the stop was waiting on.
  defp background_tasks("stop", ev, _prev) do
    case Map.get(ev, "backgroundTasks") do
      n when is_integer(n) and n > 0 -> n
      _ -> 0
    end
  end

  defp background_tasks(type, _ev, _prev)
       when type in ["user_prompt_submit", "session_start", "session_end"],
       do: 0

  defp background_tasks(_type, _ev, %{bg: bg}) when is_integer(bg), do: bg
  defp background_tasks(_type, _ev, _prev), do: 0
end
