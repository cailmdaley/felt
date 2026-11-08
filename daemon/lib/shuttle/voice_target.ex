defmodule Shuttle.Voice.Target do
  @moduledoc "Classifies voice targets from the owner's published worker activity."

  @doc """
  A target is cold when it has no live conversation: no worker, and not the
  fiber's own session reopened here by the human. A live worker idle at its
  prompt is warm.
  """
  def cold?(target) do
    # Only the worker's own host publishes its runtime; other stores carry
    # the same fiber without one.
    worker =
      Shuttle.Env.app(:voice_target_entries, &entries/0).()
      |> Enum.find_value(&(matches?(&1, target) && (&1[:runtime] || &1["runtime"])))

    is_nil(worker) and not reopened?(target)
  end

  defp reopened?(%{"fiber_id" => fiber_id} = target) when is_binary(fiber_id) do
    Shuttle.OriginRouter.local?(target["origin"]) and
      Shuttle.SessionResume.reopened(fiber_id) != nil
  end

  defp reopened?(_target), do: false

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
