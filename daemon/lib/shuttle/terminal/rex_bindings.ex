defmodule Shuttle.Terminal.RexBindings do
  @moduledoc "Daemon-owned Rex addresses, atomically persisted under a shared terminal lock."

  def path, do: Path.join([Shuttle.data_dir(), "terminals", "rex.json"])

  def read do
    case File.read(path()) do
      {:ok, json} -> decode(json)
      {:error, :enoent} -> {:ok, %{"version" => 1, "server" => nil, "bindings" => %{}}}
      {:error, reason} -> {:error, reason}
    end
  end

  def put(name, binding, server) when is_binary(server) do
    update(fn doc ->
      bindings = if doc["server"] in [nil, server], do: doc["bindings"], else: %{}

      bindings =
        Map.reject(bindings, fn {old_name, old} ->
          old_name != name and old["session_id"] == binding["session_id"]
        end)

      viewers = if doc["server"] in [nil, server], do: doc["viewers"] || %{}, else: %{}

      Map.merge(doc, %{
        "server" => server,
        "bindings" => Map.put(bindings, name, binding),
        "viewers" => viewers
      })
    end)
  end

  def put_fiber(name, fiber, observed \\ nil)

  def put_fiber(name, fiber, observed) when is_binary(fiber) and fiber != "" do
    update(fn doc ->
      case doc["bindings"][name] do
        nil -> doc
        b when observed != nil and b != observed -> doc
        b -> put_in(doc, ["bindings", name], Map.put(b, "fiber", fiber))
      end
    end)
  end

  def put_fiber(_, _, _), do: :ok

  def put_viewer(key, binding, server) do
    update(fn doc ->
      viewers = if doc["server"] in [nil, server], do: doc["viewers"] || %{}, else: %{}
      Map.merge(doc, %{"server" => server, "viewers" => Map.put(viewers, key, binding)})
    end)
  end

  # Compare with the observed value: a stale session list must not erase a
  # concurrent launch or claim that has installed a different address.
  def delete(name, observed) do
    update(fn doc ->
      if doc["bindings"][name] == observed,
        do: put_in(doc, ["bindings"], Map.delete(doc["bindings"], name)),
        else: doc
    end)
  end

  def prune(snapshot, live_ids) do
    update(fn doc ->
      Enum.reduce(["bindings", "viewers"], doc, fn kind, acc ->
        Enum.reduce(snapshot[kind] || %{}, acc, fn {name, binding}, acc ->
          if binding["session_id"] not in live_ids and get_in(acc, [kind, name]) == binding,
            do: Map.put(acc, kind, Map.delete(acc[kind], name)),
            else: acc
        end)
      end)
    end)
  end

  defp update(fun) do
    Shuttle.Terminal.with_lock({__MODULE__, path()}, fn ->
      with {:ok, doc} <- read() do
        updated = fun.(doc)

        if updated == doc do
          :ok
        else
          with :ok <- write(updated) do
            remove_receipts(doc, updated)
            :ok
          end
        end
      end
    end)
  end

  def pid_path(block),
    do: Path.join([Shuttle.data_dir(), "terminals", "rex-pids", block <> ".pid"])

  defp remove_receipts(before, after_doc) do
    removed = MapSet.difference(block_ids(before), block_ids(after_doc))
    Enum.each(removed, &File.rm(pid_path(&1)))
  end

  defp block_ids(doc) do
    for kind <- ["bindings", "viewers"],
        {_, binding} <- doc[kind] || %{},
        into: MapSet.new(),
        do: binding["block_id"]
  end

  defp write(doc) do
    target = path()
    tmp = target <> ".#{System.unique_integer([:positive])}.tmp"

    try do
      with :ok <- File.mkdir_p(Path.dirname(target)),
           :ok <- File.write(tmp, Jason.encode!(doc)),
           :ok <- File.chmod(tmp, 0o600),
           :ok <- File.rename(tmp, target) do
        :ok
      end
    after
      File.rm(tmp)
    end
  end

  defp valid_viewers?(viewers) when is_map(viewers) do
    Enum.all?(viewers, fn {key, b} ->
      is_binary(key) and
        match?(%{"session_id" => "session:" <> _, "block_id" => "block:" <> _}, b)
    end)
  end

  defp valid_viewers?(_), do: false

  defp decode(json) do
    with {:ok, %{"version" => 1, "server" => server, "bindings" => bindings} = doc} <-
           Jason.decode(json),
         true <- (is_binary(server) or is_nil(server)) and is_map(bindings),
         true <- valid_viewers?(Map.get(doc, "viewers", %{})),
         true <-
           Enum.all?(bindings, fn {name, binding} ->
             is_binary(name) and
               match?(
                 %{
                   "session_id" => "session:" <> _,
                   "block_id" => "block:" <> _,
                   "created_at" => at
                 }
                 when is_binary(at),
                 binding
               )
           end) do
      {:ok, doc}
    else
      _ -> {:error, :invalid_bindings}
    end
  end
end
