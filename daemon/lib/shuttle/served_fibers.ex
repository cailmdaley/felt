defmodule Shuttle.ServedFibers do
  @moduledoc "Local and cached remote fiber documents for voice and spoken output."
  @doc false
  @spec all((-> map())) :: [map()]
  def all(feeds \\ &Shuttle.RemoteFiberRegistry.feeds/0) do
    local =
      try do
        case Shuttle.Poller.cached_fiber_documents(
               felt_stores: Shuttle.FeltStores.configured_stores()
             ) do
          {:ok, %{fibers: entries}} -> entries
          _ -> []
        end
      catch
        :exit, _ -> []
      end

    fiber = &(Map.get(&1, :fiber) || Map.get(&1, "fiber"))

    remote =
      Enum.flat_map(feeds.(), fn {host, feed} ->
        for entry <- feed.fibers, f = fiber.(entry), is_map(f), do: Map.put(f, "origin", host)
      end)

    Enum.map(local, fiber) ++ remote
  end
end
