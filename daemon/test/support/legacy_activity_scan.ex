defmodule Shuttle.Test.LegacyActivityScan do
  @moduledoc """
  A verbatim copy of `Shuttle.Activity`'s windowed per-request scan, as it
  stood before the fold moved into `Shuttle.Activity.Follower`. The
  characterization tests pin the fold-then-slice reader against it: for any
  window, the two agree except where the moduledoc of `Shuttle.Activity`
  names a difference.
  """

  require Logger

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

  @doc """
  The buckets for the minutes in the inclusive window `from_ms..to_ms`, sorted
  by `{m, s, cwd, k}`. The window is read through `canonical_window/2` (see the
  moduledoc's whole-minutes rule).

  Returns `{:error, :inverted_range}` when `to_ms < from_ms` and
  `{:error, :range_too_wide}` past #{@max_range_days} days. A missing events
  file is not an error — it yields an empty list.

  Opts (for tests): `:events_file`, the live stream path (its rotated sibling
  is that path plus `.1`, exactly as the writer names it).
  """
  @spec window(integer(), integer(), keyword()) ::
          {:ok, [bucket()]} | {:error, :inverted_range | :range_too_wide}
  def window(from_ms, to_ms, opts \\ []) when is_integer(from_ms) and is_integer(to_ms) do
    case check_range(from_ms, to_ms) do
      :ok ->
        {from_ms, to_ms} = canonical_window(from_ms, to_ms)
        {:ok, scan(from_ms, to_ms, opts)}

      error ->
        error
    end
  end

  @doc """
  The event-time bounds that serve exactly the minutes whose start lies in
  `from_ms..to_ms`: `from_ms` ceiled to a minute, `to_ms` floored to one and
  widened to its last millisecond. Idempotent. A window narrower than one whole
  minute comes back inverted, and scanning it yields nothing.
  """
  @spec canonical_window(integer(), integer()) :: {integer(), integer()}
  def canonical_window(from_ms, to_ms) when is_integer(from_ms) and is_integer(to_ms) do
    {ceil_minute(from_ms), floor_minute(to_ms) + @minute_ms - 1}
  end

  @doc """
  Validates a window without reading anything.

  Split out of `window/3` so the endpoint can refuse a bad window — and settle
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

  @doc "The widest window `window/3` will serve, in milliseconds."
  @spec max_range_ms() :: pos_integer()
  def max_range_ms, do: @max_range_ms

  @doc "The widest window `window/3` will serve, in days — for error copy."
  @spec max_range_days() :: pos_integer()
  def max_range_days, do: @max_range_days

  defp scan(from_ms, to_ms, opts) do
    live = Keyword.get(opts, :events_file, Shuttle.WaitingTracker.default_events_file())

    live
    |> files_to_scan(from_ms)
    |> Enum.reduce(new_acc(), &tally_file(&1, from_ms, to_ms, &2))
    |> emit()
  end

  # `tally` counts buckets; `spells` remembers which identities sit inside an
  # unanswered waiting spell; `pending` holds each session's open tool call;
  # `filled` names the buckets that exist only because an interval was drawn.
  defp new_acc, do: %{tally: %{}, spells: %{}, pending: %{}, filled: MapSet.new()}

  # Rotated (older) first, live second. Oldest-first is load-bearing, not
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
        track_span(acc, type, event, ts, from_ms, to_ms)

      {:ok, %{"timestamp" => ts, "type" => type} = event}
      when is_integer(ts) and is_binary(type) ->
        identity = {presence(event["tmuxSession"]), presence(event["cwd"])}
        {kinds, spells} = classify(type, event, identity, acc.spells)
        acc = %{acc | spells: spells}

        acc =
          track_span(acc, type, event, ts, from_ms, to_ms)

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

  defp floor_minute(ts), do: Integer.floor_div(ts, @minute_ms) * @minute_ms
  defp ceil_minute(ts), do: -floor_minute(-ts)

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
  defp classify("file_sent", _event, _identity, spells), do: {[], spells}

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
  defp emit(%{tally: tally}) do
    tally
    |> Enum.map(fn {{m, s, cwd, k}, n} -> %{m: m, s: s, cwd: cwd, k: k, n: n} end)
    |> Enum.sort_by(&{&1.m, &1.s, &1.cwd, &1.k})
  end
end
