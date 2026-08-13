defmodule Shuttle.Activity do
  @moduledoc """
  Per-minute activity histogram over this host's hook-event stream — the data
  layer behind `GET /api/v1/activity`.

  ## What a bucket is

  One bucket counts the events sharing a `{minute, tmuxSession, cwd, kind}`
  key inside the requested window:

      %{m: 1_770_000_000_000, s: "morning-post-…-shuttle", cwd: "/repo", k: "attention", n: 3}

  `m` is the minute floor in epoch ms; `s` and `cwd` are `nil` when the event
  carried neither. `k` collapses the eight hook types into the things a
  temporal view distinguishes:

    * `user_prompt_submit` → `"attention"` — a human typed. Unless the event
      carries `machine: true`, in which case it is `"agent"`: the harness
      injected that prompt (a task notification, a teammate's message) and
      nobody was present. The RECORDER makes that call — the hook sees the
      prompt text and stamps the flag — because a daemon that sniffed the
      content to guess would be inventing a fact it cannot know. An event
      without the flag is a person, which is what every event written before
      the flag existed keeps saying; there is no retroactive fallback.
    * `notification` → `"notify"` — the agent asked for a human, **and this
      was the onset of the ask** (see below).
    * everything else (`pre_tool_use`, `post_tool_use`, `stop`,
      `subagent_stop`, `session_start`, `session_end`, …) → `"agent"` — the
      agent worked on its own.

  The three-way split is the whole point: attention marks are where a person
  was present, notify marks are where the agent wanted one, and the agent band
  is the machine's own time. Any hook type invented later lands in `"agent"`
  rather than disappearing.

  ## `"reply"`: a facet of the agent band, not a fourth slice

  A `stop` hook fires when an agent finishes a turn — one completed reply a
  human received. That is the natural counterpart to `"attention"`: together
  they make a *conversation* countable in messages rather than in minutes,
  which is what a week-scale view wants from a human (nobody's attention is
  measured in wall-clock; it is measured in exchanges).

  So a `stop` event emits **two** buckets for its minute: the `"agent"` one it
  has always emitted, and an additional `"reply"` one. `"reply"` is a *facet*
  of agent activity, not a partition of it — the `"agent"` stream is
  byte-identical to what it was before this kind existed, and every consumer
  that folds agent minutes keeps its numbers without knowing `"reply"` exists.
  Consumers that want message counts sum `n` over `"reply"`.

  The duplication is deliberate and is the price of adding a kind to a wire
  format several views read independently. When every consumer counts
  `"reply"` alongside `"agent"` on its own, the `"agent"` copy can be dropped
  and this becomes an ordinary partition.

  ## What "needed your attention" means: the waiting spell

  A raw `notification` hook is not a demand for attention — it is a *reminder*
  of one. Claude Code re-fires the idle notification every 60 s for as long as
  a worker sits blocked, so counting raw notifications answers "how many
  minutes was this session stuck?" when the question a temporal view asks is
  "how many times did it need me?". An hour of one unanswered permission
  prompt used to paint sixty consecutive marks; it is one event.

  So the unit here is the **waiting spell**, the same phase notion
  `Shuttle.WaitingTracker` derives per session at read time — lifted from "the
  state right now" to "the state at every point in the window":

    * A spell **opens** on the first `notification` for an identity that is not
      already inside one. That minute gets a `"notify"` bucket. This is the
      attention *demand*.
    * While the spell is open, further `notification` events are **suppressed**
      — same ask, still unanswered, no new mark.
    * A spell **closes** on any other event for that identity: a
      `user_prompt_submit` (the human answered — that minute is `"attention"`,
      as before) or any agent event (the agent moved on by itself — a
      permission was granted elsewhere, a tool returned, the session
      restarted). The next `notification` after that opens a fresh spell,
      because something genuinely new is being asked. A `stop` closes the
      spell exactly as it always did — a completed reply is agent activity,
      and the extra `"reply"` bucket changes the label, not the machine.

  Identity is the bucket key minus minute and kind: `{tmuxSession, cwd}`. Two
  workers blocked at once hold two independent spells, and an event carrying
  neither field falls into a single unattributed spell rather than crossing
  wires with a named session.

  Spell state is carried by *every* line the scan reads, including lines
  **before `from_ms`**. Those lines are already decoded (the window test comes
  after the parse), so a spell that opened an hour before the window is known
  to be open at its first minute, and a window that starts mid-spell shows no
  spurious onset. The one gap is deliberate: when the rotated sibling is
  skipped by the mtime gate below, its lines cannot seed state, and a spell
  spanning the rotation reopens at its first in-window notification. That
  over-counts by one mark, once, at a file boundary — the conservative
  direction, and cheaper than the 64 MB read that would fix it.

  `n` on a `"notify"` bucket therefore counts spell **onsets** in that minute,
  not notifications; `n` on the other two kinds still counts events.

  ## A tool call is an interval, not two instants

  `pre_tool_use` stamps the minute a tool started and `post_tool_use` the
  minute it returned. Nothing stamps the minutes in between, so a seven-minute
  `Bash` used to read as two marks with a five-minute hole — work that plainly
  happened, drawn as absence. (The Day view's drawing bridge hid holes of five
  minutes or less, which made the bug look like a long-call bug rather than
  what it is: unrecorded interior time.)

  So the fold pairs the two events and **fills the interior**. Within a
  session, a `post_tool_use` closes the most recent unmatched `pre_tool_use`,
  and every minute strictly between the two gains an `"agent"` bucket
  attributed to the pre's `{tmuxSession, cwd}`. Nesting is not modelled: one
  pending pre per session, and a second pre replaces the first.

  Three guards:

    * **Cap.** Only the first 30 minutes after the pre are filled. A pair
      wider than that is either a genuinely enormous call or an abandoned pre
      that a much later post happened to close; filling half a day of ink on
      that guess is worse than under-drawing.
    * **No crossing a `session_start`.** A restart discards the session's
      pending pre — whatever that tool was doing, it was not doing it across
      the restart.
    * **Idempotent w.r.t. real events.** A filled minute is remembered as
      filled; a real event landing on the same `{minute, session, cwd, kind}`
      *replaces* the fill rather than incrementing past it, in either order. A
      filled minute always reads `n: 1` — it is a statement that the minute was
      busy, not a count of anything.

  Pairing state, like spell state, is carried by lines before `from_ms`, so a
  call that began before the window still fills its in-window minutes; fills
  are clipped to the window.

  ## Delegations as intervals: the `spawns` list

  The buckets say a minute was busy. They cannot say the session had five
  agents aloft in it — a fan-out and a long solo `Bash` are the same ink.

  So the same pairing that fills a tool call's interior also emits, separately,
  one interval per **delegation**: a `pre_tool_use` on `Agent` / `Task` /
  `Workflow` opens it, the matching `post_tool_use` closes it. These do not
  touch the buckets at all — they travel beside them as `spawns`, each
  `%{s:, cwd:, tool:, start_ms:, end_ms:, open:}`, carrying the same
  `{tmuxSession, cwd}` identity a bucket does so a view joins them through the
  same ledger.

  **Concurrency is the point, so nesting is modelled here** where the fill
  refuses to model it: a session holds a QUEUE of open delegations, and a
  `post` closes the OLDEST of them. Which post belongs to which pre is not
  knowable — the event stream carries no tool-use id — but the multiset of
  intervals is right either way, and that multiset is what a stack of lines
  draws. A `session_start` closes everything the session had open, at the
  restart.

  **Most delegations never close.** An agent handed off to run in the
  background returns no `post_tool_use` at all (measured: 433 opens to 21
  closes on this host's stream). Drawing those at the cap would be inventing
  hours of duration, so an unclosed delegation is drawn as a STUB —
  `@open_spawn_minutes` long, marked `open: true` — which claims only that one
  started here. A closed pair is drawn at its true length, capped at
  `@max_spawn_minutes` against a pre that a much later post happened to
  collect.

  Intervals are clipped to the window and only those overlapping it are served.

  ## Which files, and why the rotated one is conditional

  `felt hook event` rotates the stream at 64 MB: the live file is renamed to
  `events.jsonl.1` and a fresh one starts (`cmd/shuttle_events.go`). A window
  that reaches back past the last rotation is served only by reading both.

  The rotated sibling is read when its **mtime is at or after `from_ms`**.
  Rotation is a rename followed by no further writes, so that mtime is the
  timestamp of the newest line the file can hold: an earlier mtime is proof
  the window cannot overlap it, and one `stat` buys skipping a 64 MB scan.
  The live file is read whenever it exists.

  Both files are **streamed** line by line, never slurped — the live one is
  tens of megabytes between rollovers. Malformed lines, lines missing a
  `timestamp`/`type`, and lines outside the window are skipped silently; a
  single bad line never breaks a response.

  ## Window bounds

  `from_ms`/`to_ms` are inclusive epoch milliseconds. An inverted window, or
  one wider than 120 days, is refused rather than served — the caller is a
  polling browser view, and an unbounded window means an unbounded scan.

  ## Known cost: every request rescans the whole file

  There is no index and no cache. A request for the last ten minutes still
  streams every line of a stream that grows to 64 MB between rollovers, and a
  polling client pays that on each tick. It is acceptable today because the
  scan is a `Jason.decode` per line over a local file and the window cap bounds
  the worst case — but it does not scale with either poll frequency or the
  number of open boards. The shape of the fix, when it is needed: keep the
  tally in a GenServer that tails the stream the way `Shuttle.WaitingTracker`
  already does (seed once, then read forward from a byte offset) and serve
  buckets from memory, letting requests read slightly stale data rather than
  re-deriving history. Deliberately not built yet.
  """

  require Logger

  @minute_ms 60_000
  # The widest tool call whose interior is drawn. See the moduledoc's cap note.
  @max_fill_minutes 30
  @max_fill_ms @max_fill_minutes * @minute_ms
  @max_range_days 120
  @max_range_ms @max_range_days * 24 * 60 * 60 * 1_000

  # The tools whose call hands work to an agent of its own. Same list the
  # transcript reader uses for its delegation register (`Shuttle.Moment`), for
  # the same reason: these are the calls whose subject is another agent.
  @spawn_tools ~w(Agent Task Workflow)

  # A closed delegation's ceiling. Far wider than the fill's 30 minutes — a
  # subagent working for an hour is ordinary, and this interval IS the claim
  # about duration rather than a bridge across missing marks. It binds only on
  # a pre that a much later post collected.
  @max_spawn_minutes 180
  @max_spawn_ms @max_spawn_minutes * @minute_ms

  # How long an UNCLOSED delegation is drawn. Deliberately short: it is a mark
  # that one started, not a claim about how long it ran. See the moduledoc.
  @open_spawn_minutes 5
  @open_spawn_ms @open_spawn_minutes * @minute_ms

  @typedoc "One aggregated bucket, in the wire shape the endpoint serves."
  @type bucket :: %{
          m: integer(),
          s: String.t() | nil,
          cwd: String.t() | nil,
          k: String.t(),
          n: pos_integer()
        }

  @typedoc """
  One delegation, as an interval. `s`/`cwd` are the bucket identity it shares,
  so a view joins it through the same ledger; `open` marks an interval whose
  close was never recorded and whose length is therefore a stub rather than a
  duration.
  """
  @type spawn_span :: %{
          s: String.t() | nil,
          cwd: String.t() | nil,
          tool: String.t(),
          start_ms: integer(),
          end_ms: integer(),
          open: boolean()
        }

  @doc """
  Everything the stream says about the inclusive window `from_ms..to_ms`: the
  `buckets`, sorted by `{m, s, cwd, k}`, and the `spawns`, sorted by
  `{start_ms, s, cwd}`.

  Returns `{:error, :inverted_range}` when `to_ms < from_ms` and
  `{:error, :range_too_wide}` past #{@max_range_days} days. A missing events
  file is not an error — it yields empty lists.

  Opts (for tests): `:events_file`, the live stream path; its rotated sibling
  is that path plus `.1`, exactly as the writer names it.
  """
  @spec window(integer(), integer(), keyword()) ::
          {:ok, %{buckets: [bucket()], spawns: [spawn_span()]}}
          | {:error, :inverted_range | :range_too_wide}
  def window(from_ms, to_ms, opts \\ []) when is_integer(from_ms) and is_integer(to_ms) do
    case check_range(from_ms, to_ms) do
      :ok -> {:ok, scan(from_ms, to_ms, opts)}
      error -> error
    end
  end

  @doc """
  The window's buckets alone — `window/3` for a caller that draws no
  delegations.
  """
  @spec buckets(integer(), integer(), keyword()) ::
          {:ok, [bucket()]} | {:error, :inverted_range | :range_too_wide}
  def buckets(from_ms, to_ms, opts \\ []) when is_integer(from_ms) and is_integer(to_ms) do
    case window(from_ms, to_ms, opts) do
      {:ok, %{buckets: buckets}} -> {:ok, buckets}
      error -> error
    end
  end

  @doc """
  Validates a window without reading anything.

  Split out of `buckets/3` so the endpoint can refuse a bad window — and settle
  a conditional fetch — before paying for the scan.
  """
  @spec check_range(integer(), integer()) :: :ok | {:error, :inverted_range | :range_too_wide}
  def check_range(from_ms, to_ms) when is_integer(from_ms) and is_integer(to_ms) do
    cond do
      to_ms < from_ms -> {:error, :inverted_range}
      to_ms - from_ms > @max_range_ms -> {:error, :range_too_wide}
      true -> :ok
    end
  end

  @doc "The widest window `buckets/3` will serve, in milliseconds."
  @spec max_range_ms() :: pos_integer()
  def max_range_ms, do: @max_range_ms

  @doc "The widest window `buckets/3` will serve, in days — for error copy."
  @spec max_range_days() :: pos_integer()
  def max_range_days, do: @max_range_days

  defp scan(from_ms, to_ms, opts) do
    live = Keyword.get(opts, :events_file, Shuttle.WaitingTracker.default_events_file())

    live
    |> files_to_scan(from_ms)
    |> Enum.reduce(new_acc(), &tally_file(&1, from_ms, to_ms, &2))
    |> emit(from_ms, to_ms)
  end

  # `tally` counts buckets; `spells` remembers which identities sit inside an
  # unanswered waiting spell; `pending` holds each session's open tool call;
  # `filled` names the buckets that exist only because an interval was drawn;
  # `aloft` holds each session's QUEUE of open delegations and `spans` the ones
  # that have closed.
  defp new_acc,
    do: %{
      tally: %{},
      spells: %{},
      pending: %{},
      filled: MapSet.new(),
      aloft: %{},
      spans: []
    }

  # Rotated (older) first, live second. Oldest-first is now load-bearing, not
  # just cache-friendly: spell state is a forward fold, so the files must be
  # read in the order they were written.
  defp files_to_scan(live, from_ms) do
    rotated = if rotated_overlaps?(live <> ".1", from_ms), do: [live <> ".1"], else: []
    rotated ++ if File.regular?(live), do: [live], else: []
  end

  # An mtime before `from_ms` proves every line predates the window: rotation
  # renames the file and never writes it again. `+ 999` because mtime lands on
  # a whole second and the window bound does not.
  defp rotated_overlaps?(path, from_ms) do
    case File.stat(path, time: :posix) do
      {:ok, %File.Stat{type: :regular, mtime: mtime}} -> mtime * 1_000 + 999 >= from_ms
      _ -> false
    end
  end

  defp tally_file(path, from_ms, to_ms, acc) do
    path
    |> File.stream!()
    |> Enum.reduce(acc, &tally_line(&1, from_ms, to_ms, &2))
  rescue
    # The file vanished or became unreadable between the stat and the stream —
    # a rotation racing this scan. Serve what the other file gave us, but leave
    # a trace: a silently-swallowed read is otherwise indistinguishable from a
    # genuinely quiet hour, which is a miserable thing to debug from a graph.
    error ->
      Logger.debug("activity: skipped #{path} — #{Exception.message(error)}")
      acc
  end

  # Several folds in one pass. Lines before `from_ms` advance `spells` and
  # `pending` only — that is what makes a window opening mid-spell, or
  # mid-tool-call, honest.
  defp tally_line(line, from_ms, to_ms, acc) do
    case Jason.decode(line) do
      # Past `to_ms` only one thing still matters: a tool that returns after the
      # window closes was nonetheless running inside it, and its fill is
      # clipped to the window. Nothing else — no kinds, no spell transition —
      # can reach back across the boundary.
      {:ok, %{"timestamp" => ts, "type" => type} = event}
      when is_integer(ts) and is_binary(type) and ts > to_ms ->
        acc |> track_span(type, event, ts, from_ms, to_ms) |> track_spawn(type, event, ts)

      {:ok, %{"timestamp" => ts, "type" => type} = event}
      when is_integer(ts) and is_binary(type) ->
        identity = {presence(event["tmuxSession"]), presence(event["cwd"])}
        {kinds, spells} = classify(type, event, identity, acc.spells)
        acc = %{acc | spells: spells}
        acc =
          acc |> track_span(type, event, ts, from_ms, to_ms) |> track_spawn(type, event, ts)

        if kinds == [] or ts < from_ms do
          acc
        else
          minute = floor_minute(ts)
          Enum.reduce(kinds, acc, &bump(&2, minute, identity, &1))
        end

      _ ->
        acc
    end
  end

  defp floor_minute(ts), do: div(ts, @minute_ms) * @minute_ms

  # A real event owns its bucket outright. If an interval fill got there first,
  # the fill's mark is replaced rather than added to — see the moduledoc.
  defp bump(acc, minute, {session, cwd}, kind) do
    key = {minute, session, cwd, kind}

    if MapSet.member?(acc.filled, key) do
      %{acc | tally: Map.put(acc.tally, key, 1), filled: MapSet.delete(acc.filled, key)}
    else
      %{acc | tally: Map.update(acc.tally, key, 1, &(&1 + 1))}
    end
  end

  # ── Tool calls as intervals ────────────────────────────────────────────────

  # One pending pre per session: a second pre abandons the first, which is what
  # "the most recent unmatched pre" means when nesting is not modelled.
  defp track_span(acc, "pre_tool_use", event, ts, _from_ms, _to_ms) do
    case presence(event["sessionId"]) do
      nil ->
        acc

      sid ->
        identity = {presence(event["tmuxSession"]), presence(event["cwd"])}
        %{acc | pending: Map.put(acc.pending, sid, {ts, identity})}
    end
  end

  defp track_span(acc, "post_tool_use", event, ts, from_ms, to_ms) do
    case presence(event["sessionId"]) do
      nil ->
        acc

      sid ->
        case Map.pop(acc.pending, sid) do
          {{start_ts, identity}, pending} when start_ts <= ts ->
            fill_interior(%{acc | pending: pending}, start_ts, ts, identity, from_ms, to_ms)

          _ ->
            acc
        end
    end
  end

  # A restarted session is not still inside whatever tool it was running.
  defp track_span(acc, "session_start", event, _ts, _from_ms, _to_ms) do
    case presence(event["sessionId"]) do
      nil -> acc
      sid -> %{acc | pending: Map.delete(acc.pending, sid)}
    end
  end

  defp track_span(acc, _type, _event, _ts, _from_ms, _to_ms), do: acc

  # ── Delegations as intervals ───────────────────────────────────────────────
  #
  # A queue per session, not one slot: a five-way fan-out is five delegations
  # aloft at once, and collapsing them would erase exactly the fact these
  # intervals exist to show. Windowing is left to `emit_spans/3` — an interval
  # that opened before the window or closes after it still ran inside it.

  defp track_spawn(acc, "pre_tool_use", event, ts) do
    with sid when is_binary(sid) <- presence(event["sessionId"]),
         tool when tool in @spawn_tools <- event["tool"] do
      identity = {presence(event["tmuxSession"]), presence(event["cwd"])}
      open = Map.get(acc.aloft, sid, []) ++ [{ts, identity, tool}]
      %{acc | aloft: Map.put(acc.aloft, sid, open)}
    else
      _ -> acc
    end
  end

  defp track_spawn(acc, "post_tool_use", event, ts) do
    with sid when is_binary(sid) <- presence(event["sessionId"]),
         tool when tool in @spawn_tools <- event["tool"],
         [{start_ts, identity, _tool} | rest] <- Map.get(acc.aloft, sid, []) do
      %{
        acc
        | aloft: Map.put(acc.aloft, sid, rest),
          spans: [span(start_ts, min(ts, start_ts + @max_spawn_ms), identity, tool, false) | acc.spans]
      }
    else
      _ -> acc
    end
  end

  # A restart ends every delegation the session was holding, at the restart.
  # Whatever those agents were doing, this session was no longer waiting on it.
  defp track_spawn(acc, "session_start", event, ts) do
    case presence(event["sessionId"]) do
      nil ->
        acc

      sid ->
        closed =
          for {start_ts, identity, tool} <- Map.get(acc.aloft, sid, []),
              do: span(start_ts, min(ts, start_ts + @max_spawn_ms), identity, tool, false)

        %{acc | aloft: Map.delete(acc.aloft, sid), spans: closed ++ acc.spans}
    end
  end

  defp track_spawn(acc, _type, _event, _ts), do: acc

  defp span(start_ms, end_ms, {session, cwd}, tool, open?) do
    %{
      s: session,
      cwd: cwd,
      tool: tool,
      start_ms: start_ms,
      end_ms: max(end_ms, start_ms),
      open: open?
    }
  end

  # The minutes strictly between the two stamped ones, capped and clipped.
  defp fill_interior(acc, start_ts, end_ts, {session, cwd}, from_ms, to_ms) do
    first = floor_minute(start_ts) + @minute_ms
    last = min(floor_minute(end_ts), floor_minute(start_ts + @max_fill_ms)) - @minute_ms

    first
    |> max(floor_minute(from_ms))
    |> Stream.iterate(&(&1 + @minute_ms))
    |> Stream.take_while(&(&1 <= min(last, to_ms)))
    |> Enum.reduce(acc, fn minute, acc ->
      key = {minute, session, cwd, "agent"}

      if Map.has_key?(acc.tally, key) do
        acc
      else
        %{acc | tally: Map.put(acc.tally, key, 1), filled: MapSet.put(acc.filled, key)}
      end
    end)
  end

  # The spell state machine. Returns the bucket kinds this event contributes —
  # `[]` for a notification swallowed by an open spell — and the spell map
  # after the event. See the moduledoc for why a repeat notification is not a
  # second demand, and why `stop` contributes two kinds rather than one.
  defp classify("notification", _event, identity, spells) do
    if Map.has_key?(spells, identity) do
      {[], spells}
    else
      {["notify"], Map.put(spells, identity, true)}
    end
  end

  # A prompt the HARNESS injected — a task notification, a teammate's message,
  # a system notice — fires the same hook a person typing does, and used to draw
  # the same attention mark. It is not attention: nobody was there. The recorder
  # decides (the hook stamps `machine: true`; see the moduledoc), because only
  # the hook can see the prompt text, and the daemon must never sniff content to
  # guess. So this is a two-clause classification on a flag, and an event with no
  # flag is a person — which is also what every event written before the flag
  # existed will keep saying.
  defp classify("user_prompt_submit", %{"machine" => true}, identity, spells) do
    {["agent"], Map.delete(spells, identity)}
  end

  defp classify("user_prompt_submit", _event, identity, spells) do
    {["attention"], Map.delete(spells, identity)}
  end

  # A finished turn is agent activity that also happens to be a message. It
  # closes the spell like any other agent event; the second kind is a label
  # laid over the same event, not a reclassification of it.
  defp classify("stop", _event, identity, spells) do
    {["agent", "reply"], Map.delete(spells, identity)}
  end

  defp classify(_type, _event, identity, spells) do
    {["agent"], Map.delete(spells, identity)}
  end

  defp presence(value) when is_binary(value) and value != "", do: value
  defp presence(_), do: nil

  # Sorted so a polling client can diff two responses positionally. `nil` is an
  # atom and atoms precede binaries in Erlang term order, so unattributed
  # buckets lead their minute — arbitrary, but stable.
  defp emit(%{tally: tally} = acc, from_ms, to_ms) do
    buckets =
      tally
      |> Enum.map(fn {{m, s, cwd, k}, n} -> %{m: m, s: s, cwd: cwd, k: k, n: n} end)
      |> Enum.sort_by(&{&1.m, &1.s, &1.cwd, &1.k})

    %{buckets: buckets, spawns: emit_spans(acc, from_ms, to_ms)}
  end

  # The closed intervals plus a stub for each delegation still aloft at the end
  # of the scan, all clipped to the window and sorted so a polling client can
  # diff two responses positionally.
  defp emit_spans(%{spans: spans, aloft: aloft}, from_ms, to_ms) do
    stubs =
      for {_sid, open} <- aloft,
          {start_ts, identity, tool} <- open,
          do: span(start_ts, start_ts + @open_spawn_ms, identity, tool, true)

    (spans ++ stubs)
    |> Enum.filter(&(&1.start_ms <= to_ms and &1.end_ms >= from_ms))
    |> Enum.map(&%{&1 | start_ms: max(&1.start_ms, from_ms), end_ms: min(&1.end_ms, to_ms)})
    |> Enum.sort_by(&{&1.start_ms, &1.end_ms, &1.s, &1.cwd})
  end
end
