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
    * `notification` → `"notify"` — the agent asked for a human.
    * everything else (`pre_tool_use`, `post_tool_use`, `stop`,
      `subagent_stop`, `session_start`, `session_end`, …) → `"agent"` — the
      agent worked on its own.

  The three-way split is the whole point: attention marks are where a person
  was present, notify marks are where the agent wanted one, and the agent band
  is the machine's own time. Any hook type invented later lands in `"agent"`
  rather than disappearing.

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
    cond do
      to_ms < from_ms -> {:error, :inverted_range}
      to_ms - from_ms > @max_range_ms -> {:error, :range_too_wide}
      true -> {:ok, scan(from_ms, to_ms, opts)}
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
    |> Enum.reduce(%{}, &tally_file(&1, from_ms, to_ms, &2))
    |> emit()
  end

  # Rotated (older) first, live second. Order is irrelevant to the tally — it
  # is a count into a map — but reading oldest-first keeps the page cache warm
  # in the direction the files were written.
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

  defp tally_line(line, from_ms, to_ms, acc) do
    case Jason.decode(line) do
      {:ok, %{"timestamp" => ts, "type" => type} = event}
      when is_integer(ts) and is_binary(type) and ts >= from_ms and ts <= to_ms ->
        key = {
          div(ts, @minute_ms) * @minute_ms,
          presence(event["tmuxSession"]),
          presence(event["cwd"]),
          kind(type)
        }

        Map.update(acc, key, 1, &(&1 + 1))

      _ ->
        acc
    end
  end

  defp kind("user_prompt_submit"), do: "attention"
  defp kind("notification"), do: "notify"
  defp kind(_), do: "agent"

  defp presence(value) when is_binary(value) and value != "", do: value
  defp presence(_), do: nil

  # Sorted so a polling client can diff two responses positionally. `nil` is an
  # atom and atoms precede binaries in Erlang term order, so unattributed
  # buckets lead their minute — arbitrary, but stable.
  defp emit(tally) do
    tally
    |> Enum.map(fn {{m, s, cwd, k}, n} -> %{m: m, s: s, cwd: cwd, k: k, n: n} end)
    |> Enum.sort_by(&{&1.m, &1.s, &1.cwd, &1.k})
  end
end
