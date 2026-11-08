defmodule Shuttle.Lifecycle do
  @moduledoc """
  Where a constitution stands, as the board and the thread roster read it.

  `column/3` is the Desk column, the rule `internal/shuttle/column.go` owns for
  `shuttle status --json`; `test/fixtures/columns/cases.json` holds the two
  equal. `turn/5` is whose move a constitution is. Both need the owning
  host's runtime, so the daemon computes them once and serves them on every
  fiber row (`stamp/2`); the board renders the served `column` and `turn`.
  """

  # A live worker with no hook event this soon after launch is still starting.
  @starting_ms 5 * 60_000

  @doc """
  The Desk column: `drafts`, `in_flight`, `awaiting_review`, `tempered`,
  `discarded`, `resting` (a draft put down, or a standing constitution between
  firings) or `roles` (a seat at rest). `live?` is whether its worker runs;
  `today` is the civil day a `due:` is read against, this host's as
  `shuttle status` reads it.
  """
  def column(fiber, live?, today \\ local_day(DateTime.utc_now())) do
    shuttle = fiber["shuttle"] || %{}
    status = fiber["status"]

    cond do
      status == "closed" and fiber["tempered"] == true -> "tempered"
      status == "closed" and fiber["tempered"] == false -> "discarded"
      status == "closed" -> "awaiting_review"
      live? -> "in_flight"
      seat_at_rest?(shuttle, status) -> "roles"
      status == "active" and shuttle["kind"] == "standing" -> "resting"
      status == "active" -> "in_flight"
      stashed?(fiber, today) -> "resting"
      true -> "drafts"
    end
  end

  defp seat_at_rest?(shuttle, status) do
    shuttle["seat"] == true and is_binary(shuttle["role"]) and shuttle["role"] != "" and
      (status != "active" or shuttle["kind"] == "standing")
  end

  # Put down (`horizon: stashed`) unless a `due:` day that has come pulls it back.
  defp stashed?(fiber, today) do
    fiber["horizon"] == "stashed" and
      case fiber["due"] do
        due when is_binary(due) and byte_size(due) >= 10 ->
          case Date.from_iso8601(binary_part(due, 0, 10)) do
            {:ok, day} -> Date.compare(day, today) == :gt
            _ -> true
          end

        _ ->
          true
      end
  end

  @doc """
  Whose move a constitution is. The human's: `question` (an outstanding ask, or
  a harness stopped on a prompt), `blocked` (a launch error, a blocked worker,
  or a session that could not be attributed) and `idle` (the worker ended its
  turn). The worker's: `working`, `starting` (launched in the last five minutes
  or still acquiring its session, with no hook event yet) and `no-signal` (live
  with no hook event past its start). `none`: no live worker and nothing asked.

  `runtime` is the owner's worker record (nil without one), `error` a launch
  failure recorded before a worker registered. An ask counts only on an active
  constitution.
  """
  def turn(fiber, live?, runtime, error, now_ms) do
    ask? = asking?(fiber)
    phase = if field(runtime, :state) == "blocked", do: "blocked", else: field(runtime, :phase)

    cond do
      error || field(runtime, :launch_error) || phase == "blocked" -> "blocked"
      not live? -> if ask?, do: "question", else: "none"
      phase == "identity_failed" -> "blocked"
      phase == "attention" -> "question"
      ask? -> "question"
      phase == "waiting" -> "idle"
      phase == "working" -> "working"
      phase == "identity_pending" -> "starting"
      starting?(fiber, runtime, now_ms) -> "starting"
      true -> "no-signal"
    end
  end

  @doc "The turns that are the human's move."
  def yours?(turn), do: turn in ["question", "blocked", "idle"]

  defp asking?(fiber) do
    fiber["status"] == "active" and
      case get_in(fiber, ["shuttle", "ask"]) do
        %{"text" => text} when is_binary(text) -> String.trim(text) != ""
        _ -> false
      end
  end

  defp starting?(fiber, runtime, now_ms) do
    started =
      field(runtime, :started_at) ||
        Shuttle.Poller.iso_to_unix_ms(get_in(fiber, ["shuttle", "runtime", "dispatched_at"]))

    is_integer(started) and now_ms - started < @starting_ms
  end

  defp field(nil, _key), do: nil
  defp field(map, key), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))

  @doc """
  Stamp each served constitution (a row with a `shuttle:` block) with its
  `column` and `turn`, read against the row's own `runtime` (its presence is
  the worker's liveness) and `dispatch_error`, and against this host's civil
  day at `now`.
  """
  def stamp(entries, now \\ DateTime.utc_now()) do
    today = local_day(now)
    now_ms = DateTime.to_unix(now, :millisecond)

    Enum.map(entries, fn
      %{fiber: %{"shuttle" => shuttle} = fiber} = entry when is_map(shuttle) ->
        runtime = Map.get(entry, :runtime)
        live? = runtime != nil

        entry
        |> Map.put(:column, column(fiber, live?, today))
        |> Map.put(:turn, turn(fiber, live?, runtime, Map.get(entry, :dispatch_error), now_ms))

      entry ->
        entry
    end)
  end

  defp local_day(now) do
    {date, _time} = :calendar.system_time_to_local_time(DateTime.to_unix(now), :second)
    Date.from_erl!(date)
  end
end
