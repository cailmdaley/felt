defmodule Shuttle.Pulse do
  @moduledoc "Interval turns in an existing conversation, with a host-owned durable clock."

  alias Shuttle.{Continuation, FS, Poller}
  require Logger

  def configured?(fiber), do: not is_nil(get_in(fiber, ["shuttle", "pulse"]))

  def config(fiber) do
    block = fiber["shuttle"] || %{}
    pulse = block["pulse"]
    interval = get_in(block, ["resolved", "pulse_interval_ms"])
    cli = get_in(block, ["resolved", "agent", "cli"])

    if Poller.block_kind(block) == "oneshot" and is_integer(interval) and
         interval >= 60_000 and interval <= 86_400_000 and cli in ["claude", "codex"] do
      case pulse do
        every when is_binary(every) -> %{every: every, interval: interval, window: nil}
        %{"every" => every} -> %{every: every, interval: interval, window: pulse["window"]}
        _ -> nil
      end
    end
  end

  def key(fiber), do: fiber["uid"] || fiber["id"]

  def reconcile(pulses, fibers, host, now) do
    for fiber <- fibers,
        get_in(fiber, ["shuttle", "host"]) == host,
        configured?(fiber),
        into: %{} do
      config = config(fiber)
      old = pulses[key(fiber)]
      active = fiber["status"] == "active" and not is_nil(config)
      same = not is_nil(old) and old["config"] == config_token(config)
      pending = if active and same, do: old["pending"]

      pending =
        if pending &&
             (pending["session"] != Continuation.resumable_session_id(fiber) or
                Continuation.clean_handoff_since_dispatch?(fiber)),
           do: nil,
           else: pending

      next =
        cond do
          not active -> nil
          same and is_binary(old["next_tick"]) -> old["next_tick"]
          true -> next_tick(config, DateTime.add(now, config.interval, :millisecond))
        end

      {key(fiber),
       %{
         "fiber_id" => Poller.fiber_address(fiber),
         "uid" => fiber["uid"],
         "config" => config_token(config),
         "every" => config && config.every,
         "window" => config && config.window,
         "next_tick" => next,
         "last_tick" => old && old["last_tick"],
         "pending" => pending,
         "state" =>
           if(is_nil(config),
             do: "unsupported",
             else: if(active, do: if(pending, do: "sending", else: "scheduled"), else: "paused")
           )
       }}
    end
  end

  defp config_token(nil), do: nil
  defp config_token(config), do: Jason.encode!(config)

  def due?(nil, _now), do: false

  def due?(%{"state" => "scheduled", "next_tick" => iso}, now) when is_binary(iso) do
    case DateTime.from_iso8601(iso) do
      {:ok, at, _} -> DateTime.compare(at, now) != :gt
      _ -> false
    end
  end

  def due?(_, _), do: false

  def advance(pulses, fiber, now) do
    update_in(pulses[key(fiber)], fn row ->
      %{
        row
        | "next_tick" =>
            next_tick(config(fiber), DateTime.add(now, config(fiber).interval, :millisecond))
      }
    end)
  end

  def delivered(pulses, key, now) do
    case pulses[key] do
      nil -> pulses
      row -> Map.put(pulses, key, Map.put(row, "last_tick", DateTime.to_iso8601(now)))
    end
  end

  def reserve(pulses, key, session, activity_session, now) do
    update_in(pulses[key], fn row ->
      row
      |> Map.put("state", "sending")
      |> Map.put("pending", %{
        "session" => session,
        "activity_session" => activity_session,
        "at" => DateTime.to_unix(now, :millisecond)
      })
    end)
  end

  def release(pulses, key) do
    case pulses[key] do
      nil ->
        pulses

      row ->
        Map.put(
          pulses,
          key,
          row
          |> Map.put("pending", nil)
          |> Map.put("state", if(row["state"] == "sending", do: "scheduled", else: row["state"]))
        )
    end
  end

  def observe(pulses, fibers, activity, sending_keys, now) do
    Enum.reduce(fibers, pulses, fn fiber, acc ->
      pulse_key = key(fiber)

      case acc[pulse_key] do
        %{"pending" => %{"activity_session" => session, "at" => sent}} ->
          case activity[session] do
            %{phase: "waiting", last_event_at: at} when at > sent ->
              if pulse_key in sending_keys,
                do: acc,
                else: acc |> release(pulse_key) |> advance(fiber, now)

            _ ->
              acc
          end

        _ ->
          acc
      end
    end)
  end

  def next_tick(%{window: nil}, at), do: DateTime.to_iso8601(at)

  def next_tick(%{window: window}, at) do
    if in_window?(window, at) do
      DateTime.to_iso8601(at)
    else
      # Search UTC minutes so gaps and repeated wall-clock hours follow IANA rules.
      start = at |> DateTime.truncate(:second) |> DateTime.add(60 - at.second, :second)

      Enum.find_value(0..(48 * 60), fn minute ->
        candidate = DateTime.add(start, minute * 60, :second)
        if in_window?(window, candidate), do: DateTime.to_iso8601(candidate)
      end)
    end
  end

  def in_window?(nil, _now), do: true

  def in_window?(%{"start" => first, "end" => last, "tz" => zone}, now) do
    with {:ok, local} <- DateTime.shift_zone(now, zone),
         {:ok, first} <- Time.from_iso8601(first <> ":00"),
         {:ok, last} <- Time.from_iso8601(last <> ":00") do
      time = DateTime.to_time(local)
      after_start = Time.compare(time, first) != :lt
      before_end = Time.compare(time, last) == :lt

      if Time.compare(first, last) == :lt,
        do: after_start and before_end,
        else: after_start or before_end
    else
      _ -> false
    end
  end

  def in_window?(_, _now), do: false

  def dormant_wait?(fiber, row, now) do
    not is_nil(config(fiber)) and is_map(row) and row["state"] == "scheduled" and
      is_binary(Continuation.resumable_session_id(fiber)) and
      not Continuation.clean_handoff_since_dispatch?(fiber) and not due?(row, now)
  end

  def message(row, now) do
    previous = row["last_tick"] || "none (first pulse)"

    "Shuttle pulse.\nTime: #{DateTime.to_iso8601(now)}\nPrevious pulse: #{previous}\n" <>
      "Check what changed since the previous pulse. A quiet check needs no post, notification, close or review; end the turn quietly."
  end

  def rows(pulses, held \\ false) do
    pulses
    |> Map.values()
    |> Enum.map(fn row ->
      row = Map.drop(row, ["config", "pending"])

      if held and row["state"] in ["scheduled", "sending"],
        do: %{row | "state" => "held", "next_tick" => nil},
        else: row
    end)
  end

  def stamp(entries, rows) do
    by_key = Map.new(rows, &{&1["uid"] || &1["fiber_id"], &1})

    Enum.map(entries, fn entry ->
      case by_key[key(entry.fiber)] do
        nil -> entry
        row -> Map.put(entry, :pulse, Map.take(row, ["next_tick", "last_tick", "state"]))
      end
    end)
  end

  def load do
    case FS.read(path()) do
      {:ok, bytes} ->
        case Jason.decode(bytes) do
          {:ok, rows} when is_map(rows) -> rows
          _ -> %{}
        end

      {:error, :enoent} ->
        %{}

      {:error, reason} ->
        Logger.warning("Pulse clock unavailable: #{inspect(reason)}")
        %{}
    end
  end

  def save(pulses) do
    with :ok <- FS.mkdir_p(Path.dirname(path())),
         :ok <- FS.write_atomic(path(), Jason.encode!(pulses)) do
      :ok
    else
      error ->
        Logger.warning("Could not persist pulse clock: #{inspect(error)}")
        error
    end
  end

  defp path, do: Path.join(Shuttle.data_dir(), "pulses.json")
end
