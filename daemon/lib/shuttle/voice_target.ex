defmodule Shuttle.Voice.Target do
  @moduledoc "Classifies voice targets from the owner's published worker activity."

  def cold?(target) do
    minutes =
      case Shuttle.Voice.Config.read() do
        {:ok, config} -> config["cold_minutes"]
        _ -> 5
      end

    # Only the worker's own host publishes its runtime; other stores carry
    # the same fiber without one.
    runtime =
      Shuttle.Env.app(:voice_target_entries, &entries/0).()
      |> Enum.find_value(&(matches?(&1, target) && (&1[:runtime] || &1["runtime"])))

    cold_runtime?(runtime, minutes, System.system_time(:millisecond))
  end

  def cold_runtime?(nil, _minutes, _now), do: true

  def cold_runtime?(runtime, minutes, now) do
    phase = runtime[:phase] || runtime["phase"]
    at = runtime[:last_activity_at] || runtime["last_activity_at"]
    phase != "working" and (not is_number(at) or now - at >= minutes * 60_000)
  end

  defp entries do
    local =
      case Shuttle.Poller.cached_fiber_documents([]) do
        {:ok, %{fibers: entries}} -> entries
        _ -> []
      end

    local ++
      Enum.flat_map(Shuttle.RemoteFiberRegistry.cached_feeds(), fn {_host, feed} ->
        if feed.stale,
          do: Enum.map(feed.fibers, &(Map.delete(&1, :runtime) |> Map.delete("runtime"))),
          else: feed.fibers
      end)
  end

  defp matches?(entry, target) do
    fiber = entry[:fiber] || entry["fiber"]

    fiber && target["fiber_id"] in [fiber["uid"], fiber["id"], fiber["slug"]] &&
      target["origin"] in [nil, get_in(fiber, ["shuttle", "host"])]
  end
end
