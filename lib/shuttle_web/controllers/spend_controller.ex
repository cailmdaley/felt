defmodule ShuttleWeb.SpendController do
  @moduledoc """
  What this host's sessions cost, and what each fiber cost:
  `GET /api/v1/spend?since_ms=<int>`.

      {"host": "hub-mac",
       "sessions": [{"fiber": "work/paper/edits", "session": "0883ade1-…",
                     "harness": "claude-code", "host": "hub-mac",
                     "at": 1786203000000, "kind": "dispatch", "found": true,
                     "input": 812, "output": 41203, "cache_read": 8104233,
                     "cache_write": 391044, "messages": 327,
                     "first_at_ms": …, "last_at_ms": …,
                     "models": {"claude-fable-5": {…}}}],
       "fibers": [{"fiber": "work/paper/edits", "sessions": 3, "input": …,
                   "output": …, "cache_read": …, "cache_write": …,
                   "messages": …, "first_at_ms": …, "last_at_ms": …}]}

  Two joins, both structural. `Shuttle.SessionLedger` says which fiber a session
  belonged to; `Shuttle.TokenSpend` says what that session's transcript
  recorded. Neither step estimates: a session whose transcript this host cannot
  read is listed with `found: false` and zeroed counters, and still counts as
  one session in its fiber's rollup, so "3 sessions, 2 measured" is legible
  rather than silently averaged away. The rollup deduplicates repeated ledger
  rows for the same session: dispatch/resume records are provenance events,
  while a transcript's spend is a lifetime observation and must be added once.

  Sessions with no ledger row — an interactive terminal that never claimed a
  fiber — are out of scope by construction: this endpoint walks the ledger, so
  such a session simply is not in it. That is a scoping decision, not a gap to
  paper over; a fiber rollup can only count what belongs to a fiber.

  `since_ms` is optional (default: the whole ledger) and capped at
  #{90} days into the past, because unlike `/sessions` this endpoint reads a
  multi-MB transcript per row. `TokenSpend`'s mtime-keyed cache makes the
  repeat cost small, but the first call over an unbounded ledger should not be
  unbounded.

  **Host-scoped, not owner-routed**, like the other temporal feeds: spend is a
  property of the machine that ran the session, since the transcript lives on
  its disk. `/spend/composite` fans out and merges.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [integer_param: 3, bad_param: 2]

  alias Shuttle.{Poller, SessionLedger, TokenSpend}
  alias ShuttleWeb.TemporalComposite, as: Composite

  @max_window_ms 90 * 24 * 60 * 60 * 1_000

  def show(conn, params) do
    case integer_param(params, "since_ms", default: 0) do
      {:ok, since_ms} ->
        %{sessions: sessions, fibers: fibers} = local(since_ms)
        json(conn, %{host: Poller.own_host_id(), sessions: sessions, fibers: fibers})

      {:error, {:bad_param, key}} ->
        bad_param(conn, key)
    end
  end

  @doc """
  `GET /api/v1/spend/composite?since_ms=…` — every host's spend, merged.

  Each host resolves its own transcripts, so the composite concatenates rows
  (already carrying `host`) and re-rolls the per-fiber totals across origins: a
  fiber worked from the laptop and from a-remote reports one line with both
  hosts' sessions in it. Remote rows come from `Shuttle.RemoteTemporalRegistry`
  and stay on screen, marked stale, while a remote is unreachable.
  """
  def composite(conn, params) do
    case integer_param(params, "since_ms", default: 0) do
      {:ok, since_ms} ->
        entries = Composite.remote_entries()
        %{sessions: local_sessions} = local(since_ms)

        remote_sessions =
          Enum.flat_map(entries, fn {name, entry} ->
            entry
            |> Map.get(:spend, [])
            |> Composite.in_window(:at, since_ms, nil)
            |> Enum.map(&Composite.stamp(&1, name))
          end)

        sessions =
          Enum.sort_by(local_sessions ++ remote_sessions, &(Composite.item_ms(&1, :at) || 0))

        json(conn, %{
          host: Composite.own_host(),
          sessions: sessions,
          fibers: roll_up(sessions),
          origins: Composite.origins(entries)
        })

      {:error, {:bad_param, key}} ->
        bad_param(conn, key)
    end
  end

  # This host's ledger rows in the window, each resolved to its transcript's
  # spend, plus the per-fiber rollup over them.
  defp local(since_ms) do
    since_ms = max(since_ms, System.system_time(:millisecond) - @max_window_ms)

    sessions =
      since_ms
      |> SessionLedger.read_since()
      |> Enum.map(&row/1)

    %{sessions: sessions, fibers: roll_up(sessions)}
  end

  defp row(record) do
    spend = TokenSpend.for_session(record["session"])

    %{
      fiber: record["fiber"],
      uid: record["uid"],
      session: record["session"],
      harness: record["harness"],
      host: record["host"],
      at: record["at"],
      kind: record["kind"],
      found: spend.found,
      input: spend.input,
      output: spend.output,
      cache_read: spend.cache_read,
      cache_write: spend.cache_write,
      messages: spend.messages,
      first_at_ms: spend.first_at_ms,
      last_at_ms: spend.last_at_ms,
      models: spend.models
    }
  end

  # The rollup, over local atom-keyed rows and decoded remote string-keyed rows
  # alike — `field/2` reads either, so one implementation serves both planes.
  defp roll_up(rows) do
    rows
    |> Enum.group_by(&field(&1, :fiber))
    |> Enum.reject(fn {fiber, _rows} -> is_nil(fiber) end)
    |> Enum.map(fn {fiber, rows} ->
      spend_rows = unique_session_rows(rows)

      spend_rows
      |> Enum.map(&as_spend/1)
      |> TokenSpend.total()
      |> Map.put(:fiber, fiber)
      |> Map.put(:measured, Enum.count(spend_rows, &(field(&1, :found) == true)))
    end)
    |> Enum.sort_by(&(-(&1.input + &1.output + &1.cache_read + &1.cache_write)))
  end

  # A session can have several structural ledger rows (dispatch, claim, and
  # resume). Each row points at the same append-only transcript, so summing
  # them would multiply lifetime spend by the number of times the worker was
  # observed. Keep every row in the session feed for provenance, but count one
  # spend observation per session in the fiber rollup. Malformed rows without a
  # session remain distinct rather than collapsing into one invented session.
  defp unique_session_rows(rows) do
    rows
    |> Enum.with_index()
    |> Enum.uniq_by(fn {row, index} ->
      case field(row, :session) do
        session when is_binary(session) and session != "" -> {:session, session}
        _ -> {:row, index}
      end
    end)
    |> Enum.map(&elem(&1, 0))
  end

  defp as_spend(row) do
    %{
      TokenSpend.empty(field(row, :session))
      | found: field(row, :found) == true,
        input: number(row, :input),
        output: number(row, :output),
        cache_read: number(row, :cache_read),
        cache_write: number(row, :cache_write),
        messages: number(row, :messages),
        first_at_ms: field(row, :first_at_ms),
        last_at_ms: field(row, :last_at_ms)
    }
  end

  defp field(row, key) when is_map(row), do: Map.get(row, key) || Map.get(row, to_string(key))
  defp field(_row, _key), do: nil

  defp number(row, key) do
    case field(row, key) do
      n when is_integer(n) -> n
      _ -> 0
    end
  end
end
