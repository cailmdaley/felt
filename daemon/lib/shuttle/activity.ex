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
  which is what a temporal view wants from a human (nobody's attention is
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
  "how many times did it need me?". Counted raw, an hour of one unanswered
  permission prompt would paint sixty consecutive marks; it is one event.

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

  Spell state is a function of the lines before an event, never of the
  window being asked for: the fold runs over the whole stream (see "One fold,
  sliced at read time" below), so a spell that opened an hour before a window
  is known to be open at its first minute, and a window that starts mid-spell
  shows no spurious onset. That holds across rotation too — a spell that
  opened in `events.jsonl.1` is still open at the first line of the live file.

  `n` on a `"notify"` bucket therefore counts spell **onsets** in that minute,
  not notifications; `n` on the other two kinds still counts events.

  ## A tool call is an interval, not two instants

  `pre_tool_use` stamps the minute a tool started and `post_tool_use` the
  minute it returned. Nothing stamps the minutes in between, so a seven-minute
  `Bash` would read as two marks with a five-minute hole — work that plainly
  happened, drawn as absence.

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

  Pairing state, like spell state, does not depend on the window: a call that
  began before a window still fills that window's minutes, and a call that
  returns after it fills the minutes inside it.

  ## One fold, sliced at read time

  The fold is window-independent: `new_acc/0`, then `fold_event/2` over every
  event in file order, gives a tally whose content is a function of the stream
  prefix alone, and `slice/3` reads a window out of it by minute. A bucket's
  count never depends on which window asks for it, which is what the
  whole-minutes rule below promises.

  `shuttle hook event` rotates the stream at 64 MB: the live file is renamed to
  `events.jsonl.1` and a fresh one starts (`cmd/shuttle_events.go`). The fold
  reads the rotated sibling first and the live file second, always — a window
  that reaches back past the last rotation is served from both, and a window
  that does not still gets the spell and pairing state the rotated file leaves
  behind. `Shuttle.EventStream` holds this fold in memory and continues
  it across a rotation rather than starting over; see its moduledoc for what a
  rotation drops.

  The fold is in **file order**, not timestamp order: a line moves spell and
  pairing state where it sits in the file, whatever its stamp — including a
  line stamped after the window being read. Writers stamp an event as they
  append it, so the two orders differ only by the milliseconds in which
  concurrent writers interleave.

  Malformed lines and lines missing a `timestamp`/`type` are skipped silently;
  a single bad line never breaks a response.

  ## Window bounds: whole minutes

  `from_ms`/`to_ms` are inclusive epoch milliseconds naming the **minutes**
  served: a bucket is in the response iff its minute `m` lies in
  `from_ms..to_ms`, and every bucket served is complete. `canonical_window/2`
  is that rule as a pair of bounds — `from_ms` ceiled to its minute, `to_ms`
  floored to its minute and widened to that minute's last millisecond — and
  `slice/3` reads the canonical pair. A partial first or last minute is
  therefore never served: the same `{m, s, cwd, k}` key cannot carry two
  different counts for two requests that both include `m`, which is what lets
  a cached remote window be filtered by `m` alone.

  Two windows with the same canonical pair are the same request: the response
  is a function of the canonical pair and the stream the fold has read, and
  nothing else — no wall clock enters the fold. That is the premise
  `ShuttleWeb.ActivityController` builds its validator on. The stream is the
  two files on disk, except across a rotation: the event stream keeps the spells
  still open and the tool calls still pending from the file the rotation
  overwrote, where a fresh fold of the two files cannot know them. The
  stream's answer is the more correct one; it can differ from a fresh fold
  only in onsets and fills near the start of `events.jsonl.1`.

  An inverted window, or one wider than 120 days, is refused rather than
  served — an unbounded window means an unbounded response. A window narrower
  than one whole minute canonicalizes to an empty one and serves no buckets.

  ## Cost: the stream is folded once, not per request

  `Shuttle.EventStream` seeds the fold from both files once at boot and
  then folds only the bytes appended since (`Shuttle.FileTail`), on a timer and
  again before each read, so a read is as fresh as a full rescan. A request
  costs two `stat`s plus a range read of the tally proportional to the buckets
  it returns; the files are read once. When the stream cannot answer — it is
  following another path, or it is not running — `window/3` folds the files
  itself, which is correct and costs a full read of both.
  """

  alias Shuttle.EventStream

  @minute_ms 60_000
  # The widest tool call whose interior is drawn. See the moduledoc's cap note.
  @max_fill_minutes 30
  @max_fill_ms @max_fill_minutes * @minute_ms
  @max_range_days 120
  @max_range_ms @max_range_days * 24 * 60 * 60 * 1_000

  @typedoc "One aggregated bucket, in the wire shape the endpoint serves."
  @type bucket :: %{
          m: integer(),
          s: String.t() | nil,
          cwd: String.t() | nil,
          k: String.t(),
          n: pos_integer()
        }

  @typedoc """
  The fold's state after some prefix of the stream. `tally` maps
  `{m, s, cwd, k}` to a count, or to `:fill` for a minute that exists only
  because a tool call's interior was drawn; it is a `:gb_trees` so a window is
  a range read in key order, which is also the order buckets are served in.
  `spells` holds the identities inside an unanswered waiting spell, `pending`
  each session's open tool call, and `names` one copy of every identity seen
  (see `fold_event/2`).
  """
  @opaque acc :: %{
            tally: :gb_trees.tree(),
            spells: map(),
            pending: map(),
            names: map()
          }

  @doc """
  The buckets for the minutes in the inclusive window `from_ms..to_ms`, sorted
  by `{m, s, cwd, k}`. The window is read through `canonical_window/2` (see the
  moduledoc's whole-minutes rule).

  Served from `Shuttle.EventStream` when it is following the requested
  path; otherwise a one-off fold of that path and its rotated sibling.

  Returns `{:error, :inverted_range}` when `to_ms < from_ms` and
  `{:error, :range_too_wide}` past #{@max_range_days} days. A missing events
  file is not an error — it yields an empty list.

  Opts (for tests): `:events_file`, the live stream path (its rotated sibling
  is that path plus `.1`, exactly as the writer names it); `:stream`, the
  `Shuttle.EventStream` process to ask.
  """
  @spec window(integer(), integer(), keyword()) ::
          {:ok, [bucket()]} | {:error, :inverted_range | :range_too_wide}
  def window(from_ms, to_ms, opts \\ []) when is_integer(from_ms) and is_integer(to_ms) do
    case check_range(from_ms, to_ms) do
      :ok ->
        {from_ms, to_ms} = canonical_window(from_ms, to_ms)
        {:ok, buckets(from_ms, to_ms, opts)}

      error ->
        error
    end
  end

  @doc """
  The event-time bounds that serve exactly the minutes whose start lies in
  `from_ms..to_ms`: `from_ms` ceiled to a minute, `to_ms` floored to one and
  widened to its last millisecond. Idempotent. A window narrower than one whole
  minute comes back inverted, and slicing it yields nothing.
  """
  @spec canonical_window(integer(), integer()) :: {integer(), integer()}
  def canonical_window(from_ms, to_ms) when is_integer(from_ms) and is_integer(to_ms) do
    {ceil_minute(from_ms), floor_minute(to_ms) + @minute_ms - 1}
  end

  @doc """
  Validates a window without reading anything.

  Split out of `window/3` so the endpoint can refuse a bad window — and settle
  a conditional fetch — before touching the tally.
  """
  @spec check_range(integer(), integer()) :: :ok | {:error, :inverted_range | :range_too_wide}
  def check_range(from_ms, to_ms) when is_integer(from_ms) and is_integer(to_ms) do
    cond do
      to_ms < from_ms -> {:error, :inverted_range}
      to_ms - from_ms > @max_range_ms -> {:error, :range_too_wide}
      true -> :ok
    end
  end

  @doc "The widest window `window/3` will serve, in milliseconds."
  @spec max_range_ms() :: pos_integer()
  def max_range_ms, do: @max_range_ms

  @doc "The widest window `window/3` will serve, in days — for error copy."
  @spec max_range_days() :: pos_integer()
  def max_range_days, do: @max_range_days

  defp buckets(from_ms, to_ms, opts) do
    path = Keyword.get(opts, :events_file, EventStream.default_events_file())

    case EventStream.slice(Keyword.get(opts, :stream, EventStream), path, from_ms, to_ms) do
      {:ok, buckets} ->
        buckets

      :miss ->
        EventStream.warn_miss("activity", path)
        path |> fold_stream() |> slice(from_ms, to_ms)
    end
  end

  # ── The fold ───────────────────────────────────────────────────────────────

  @doc "The fold before any line."
  @spec new_acc() :: acc()
  def new_acc, do: %{tally: :gb_trees.empty(), spells: %{}, pending: %{}, names: %{}}

  @doc """
  The whole stream at `live` folded from scratch: the rotated sibling
  (`live <> ".1"`) first, then the live file. Oldest-first is load-bearing:
  spell and pairing state are a forward fold, so the files are read in the
  order they were written. A missing file contributes nothing.
  """
  @spec fold_stream(Path.t()) :: acc()
  def fold_stream(live), do: EventStream.fold_files(live, new_acc(), &fold_event(&2, &1))

  @doc "`lines`, in file order, decoded and folded onto `acc`."
  @spec fold_lines(acc(), Enumerable.t()) :: acc()
  def fold_lines(acc, lines) do
    Enum.reduce(lines, acc, fn line, acc ->
      case EventStream.decode(line) do
        nil -> acc
        event -> fold_event(acc, event)
      end
    end)
  end

  @doc """
  One decoded event folded onto `acc`: the spell machine, the tool-call
  pairing and the tally advance together. An event missing a
  `timestamp`/`type` leaves `acc` untouched.

  The strings the fold keeps are copied out of the event once per distinct
  value (`names`), so the tally never pins the buffer a line was split from.
  """
  @spec fold_event(acc(), map()) :: acc()
  def fold_event(acc, %{"timestamp" => ts, "type" => type} = event)
      when is_integer(ts) and is_binary(type) do
    {identity, acc} = identity(acc, event)
    {kinds, spells} = classify(type, event, identity, acc.spells)
    acc = track_span(%{acc | spells: spells}, type, event, identity, ts)
    minute = floor_minute(ts)
    Enum.reduce(kinds, acc, &bump(&2, minute, identity, &1))
  end

  def fold_event(acc, _event), do: acc

  @doc """
  The buckets whose minute lies in the canonical window of `from_ms..to_ms`,
  sorted by `{m, s, cwd, k}` — a range read of the tally, so its cost follows
  the buckets served, not the buckets held.
  """
  @spec slice(acc(), integer(), integer()) :: [bucket()]
  def slice(%{tally: tally}, from_ms, to_ms) do
    {from_ms, to_ms} = canonical_window(from_ms, to_ms)
    # A number sorts before every atom and binary, so `{from_ms, 0, 0, 0}`
    # precedes every key of the minute `from_ms`, `nil`-attributed ones included.
    {from_ms, 0, 0, 0}
    |> :gb_trees.iterator_from(tally)
    |> :gb_trees.next()
    |> take_through(to_ms, [])
  end

  defp take_through({{m, s, cwd, k}, n, iter}, to_ms, acc) when m <= to_ms do
    bucket = %{m: m, s: s, cwd: cwd, k: k, n: if(n == :fill, do: 1, else: n)}
    take_through(:gb_trees.next(iter), to_ms, [bucket | acc])
  end

  defp take_through(_, _to_ms, acc), do: Enum.reverse(acc)

  @doc """
  `acc` without the buckets whose minute starts before `ts`'s, nor the pending
  tool calls that began before `ts`, nor the interned identities nothing left
  refers to. After a rotation `ts` is the first timestamp of the new rotated
  file, so what remains is what the two files hold, and the state stays
  bounded by them. `nil` drops nothing.
  """
  @spec drop_before(acc(), integer() | nil) :: acc()
  def drop_before(acc, nil), do: acc

  def drop_before(%{tally: tally, pending: pending, spells: spells} = acc, ts) do
    tally = drop_minutes_before(tally, floor_minute(ts))
    pending = Map.reject(pending, fn {_sid, {start_ts, _identity}} -> start_ts < ts end)

    names =
      :gb_trees.keys(tally)
      |> Enum.map(fn {_m, s, cwd, _k} -> {s, cwd} end)
      |> Enum.concat(Map.keys(spells))
      |> Enum.concat(Enum.map(Map.values(pending), &elem(&1, 1)))
      |> Map.new(&{&1, &1})

    %{acc | tally: tally, pending: pending, names: names}
  end

  defp drop_minutes_before(tally, cutoff) do
    case :gb_trees.is_empty(tally) or :gb_trees.smallest(tally) do
      {{m, _, _, _}, _} when m < cutoff ->
        {_key, _n, rest} = :gb_trees.take_smallest(tally)
        drop_minutes_before(rest, cutoff)

      _ ->
        tally
    end
  end

  @doc """
  The timestamp of the first foldable line of `path`, or `nil` when it has
  none or cannot be read. Reads only as far as that line.
  """
  @spec first_timestamp(Path.t()) :: integer() | nil
  def first_timestamp(path) do
    path
    |> File.stream!()
    |> Enum.find_value(fn line ->
      case EventStream.decode(line) do
        %{"timestamp" => ts, "type" => type} when is_integer(ts) and is_binary(type) -> ts
        _ -> nil
      end
    end)
  rescue
    _ -> nil
  end

  defp floor_minute(ts), do: Integer.floor_div(ts, @minute_ms) * @minute_ms
  defp ceil_minute(ts), do: -floor_minute(-ts)

  # `{tmuxSession, cwd}`, as the one copy `names` holds of it.
  defp identity(%{names: names} = acc, event) do
    raw = {presence(event["tmuxSession"]), presence(event["cwd"])}

    case names do
      %{^raw => identity} ->
        {identity, acc}

      _ ->
        {session, cwd} = raw
        identity = {copy(session), copy(cwd)}
        {identity, %{acc | names: Map.put(names, identity, identity)}}
    end
  end

  defp copy(nil), do: nil
  defp copy(binary), do: :binary.copy(binary)

  # A real event owns its bucket outright. If an interval fill got there first,
  # the fill's mark is replaced rather than added to — see the moduledoc.
  defp bump(%{tally: tally} = acc, minute, {session, cwd}, kind) do
    key = {minute, session, cwd, kind}

    n =
      case :gb_trees.lookup(key, tally) do
        {:value, n} when is_integer(n) -> n + 1
        _none_or_fill -> 1
      end

    %{acc | tally: :gb_trees.enter(key, n, tally)}
  end

  # ── Tool calls as intervals ────────────────────────────────────────────────

  # One pending pre per session: a second pre abandons the first, which is what
  # "the most recent unmatched pre" means when nesting is not modelled.
  defp track_span(acc, "pre_tool_use", event, identity, ts) do
    case presence(event["sessionId"]) do
      nil -> acc
      sid -> %{acc | pending: Map.put(acc.pending, copy(sid), {ts, identity})}
    end
  end

  defp track_span(acc, "post_tool_use", event, _identity, ts) do
    case presence(event["sessionId"]) do
      nil ->
        acc

      sid ->
        case Map.pop(acc.pending, sid) do
          {{start_ts, identity}, pending} when start_ts <= ts ->
            fill_interior(%{acc | pending: pending}, start_ts, ts, identity)

          _ ->
            acc
        end
    end
  end

  # A restarted session is not still inside whatever tool it was running.
  defp track_span(acc, "session_start", event, _identity, _ts) do
    case presence(event["sessionId"]) do
      nil -> acc
      sid -> %{acc | pending: Map.delete(acc.pending, sid)}
    end
  end

  defp track_span(acc, _type, _event, _identity, _ts), do: acc

  # The minutes strictly between the two stamped ones, capped.
  defp fill_interior(acc, start_ts, end_ts, {session, cwd}) do
    first = floor_minute(start_ts) + @minute_ms
    last = min(floor_minute(end_ts), floor_minute(start_ts + @max_fill_ms)) - @minute_ms

    tally =
      first
      |> Stream.iterate(&(&1 + @minute_ms))
      |> Stream.take_while(&(&1 <= last))
      |> Enum.reduce(acc.tally, fn minute, tally ->
        key = {minute, session, cwd, "agent"}
        if :gb_trees.is_defined(key, tally), do: tally, else: :gb_trees.insert(key, :fill, tally)
      end)

    %{acc | tally: tally}
  end

  # The spell state machine. Returns the bucket kinds this event contributes —
  # `[]` for a notification swallowed by an open spell — and the spell map
  # after the event. See the moduledoc for why a repeat notification is not a
  # second demand, and why `stop` contributes two kinds rather than one.
  defp classify("file_sent", _event, _identity, spells), do: {[], spells}

  defp classify("notification", _event, identity, spells) do
    if Map.has_key?(spells, identity) do
      {[], spells}
    else
      {["notify"], Map.put(spells, identity, true)}
    end
  end

  # A prompt the HARNESS injected — a task notification, a teammate's message,
  # a system notice — fires the same hook a person typing does. It is not
  # attention: nobody was there. The recorder
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
end
