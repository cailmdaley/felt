defmodule Shuttle.Activity do
  @moduledoc """
  Per-minute activity histogram over this host's hook-event stream — the data
  layer behind `GET /api/v1/activity`.

  ## What a bucket is

  One bucket counts the events sharing a `{minute, tmuxSession, cwd, kind}`
  key inside the requested window:

      %{m: 1_770_000_000_000, s: "morning-post-…-shuttle", cwd: "/repo", k: "attention", n: 3}

  `m` is the minute floor in epoch ms; `s` and `cwd` are `nil` when the event
  carried neither. `k` collapses the eight hook types into the three things a
  temporal view distinguishes:

    * `user_prompt_submit` → `"attention"` — a human typed.
    * `notification` → `"notify"` — the agent asked for a human, **and this
      was the onset of the ask** (see below).
    * everything else (`pre_tool_use`, `post_tool_use`, `stop`,
      `subagent_stop`, `session_start`, `session_end`, …) → `"agent"` — the
      agent worked on its own.

  The three-way split is the whole point: attention marks are where a person
  was present, notify marks are where the agent wanted one, and the agent band
  is the machine's own time. Any hook type invented later lands in `"agent"`
  rather than disappearing.

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
      because something genuinely new is being asked.

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

  @doc """
  Buckets for the inclusive window `from_ms..to_ms`, sorted by
  `{m, s, cwd, k}`.

  Returns `{:error, :inverted_range}` when `to_ms < from_ms` and
  `{:error, :range_too_wide}` past #{@max_range_days} days. A missing events
  file is not an error — it yields `{:ok, []}`.

  Opts (for tests): `:events_file`, the live stream path; its rotated sibling
  is that path plus `.1`, exactly as the writer names it.
  """
  @spec buckets(integer(), integer(), keyword()) ::
          {:ok, [bucket()]} | {:error, :inverted_range | :range_too_wide}
  def buckets(from_ms, to_ms, opts \\ []) when is_integer(from_ms) and is_integer(to_ms) do
    case check_range(from_ms, to_ms) do
      :ok -> {:ok, scan(from_ms, to_ms, opts)}
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
    |> Enum.reduce({%{}, %{}}, &tally_file(&1, from_ms, to_ms, &2))
    |> emit()
  end

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

  # Two folds in one pass: `tally` counts buckets, `spells` remembers which
  # identities are currently inside an unanswered waiting spell. Lines before
  # `from_ms` advance `spells` only — that is what makes a window opening
  # mid-spell honest.
  defp tally_line(line, from_ms, to_ms, {tally, spells} = acc) do
    case Jason.decode(line) do
      {:ok, %{"timestamp" => ts, "type" => type} = event}
      when is_integer(ts) and is_binary(type) and ts <= to_ms ->
        identity = {presence(event["tmuxSession"]), presence(event["cwd"])}
        {kind, spells} = classify(type, identity, spells)

        cond do
          kind == nil -> {tally, spells}
          ts < from_ms -> {tally, spells}
          true -> {bump(tally, div(ts, @minute_ms) * @minute_ms, identity, kind), spells}
        end

      _ ->
        acc
    end
  end

  defp bump(tally, minute, {session, cwd}, kind) do
    Map.update(tally, {minute, session, cwd, kind}, 1, &(&1 + 1))
  end

  # The spell state machine. Returns the bucket kind this event contributes —
  # `nil` for a notification swallowed by an open spell — and the spell map
  # after the event. See the moduledoc for why a repeat notification is not a
  # second demand.
  defp classify("notification", identity, spells) do
    if Map.has_key?(spells, identity) do
      {nil, spells}
    else
      {"notify", Map.put(spells, identity, true)}
    end
  end

  defp classify("user_prompt_submit", identity, spells) do
    {"attention", Map.delete(spells, identity)}
  end

  defp classify(_type, identity, spells) do
    {"agent", Map.delete(spells, identity)}
  end

  defp presence(value) when is_binary(value) and value != "", do: value
  defp presence(_), do: nil

  # Sorted so a polling client can diff two responses positionally. `nil` is an
  # atom and atoms precede binaries in Erlang term order, so unattributed
  # buckets lead their minute — arbitrary, but stable.
  defp emit({tally, _spells}) do
    tally
    |> Enum.map(fn {{m, s, cwd, k}, n} -> %{m: m, s: s, cwd: cwd, k: k, n: n} end)
    |> Enum.sort_by(&{&1.m, &1.s, &1.cwd, &1.k})
  end
end
