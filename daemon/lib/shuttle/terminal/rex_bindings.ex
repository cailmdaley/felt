defmodule Shuttle.Terminal.RexBindings do
  @moduledoc "Daemon-owned Rex addresses, atomically persisted under a shared terminal lock."

  def path, do: Path.join([Shuttle.data_dir(), "terminals", "rex.json"])

  def read, do: load(Shuttle.RuntimeDocuments.read(path()))

  defp read_fresh, do: load(Shuttle.FS.read(path()))

  defp load(result) do
    case result do
      {:ok, json} -> decode(json)
      {:error, :enoent} -> {:ok, %{"version" => 1, "server" => nil, "bindings" => %{}}}
      {:error, reason} -> {:error, reason}
    end
  end

  def set_instance(instance) do
    update(&Map.put(&1, "instance", instance))
  end

  def put(name, binding, server) when is_binary(server) do
    update(fn doc ->
      bindings = if doc["server"] in [nil, server], do: doc["bindings"], else: %{}

      bindings =
        Map.reject(bindings, fn {old_name, old} ->
          old_name != name and old["session_id"] == binding["session_id"] and
            old["block_id"] == binding["block_id"]
        end)

      viewers = if doc["server"] in [nil, server], do: doc["viewers"] || %{}, else: %{}
      places = if doc["server"] in [nil, server], do: doc["places"] || %{}, else: %{}
      views = if doc["server"] in [nil, server], do: doc["views"] || %{}, else: %{}

      Map.merge(doc, %{
        "server" => server,
        "bindings" => Map.put(bindings, name, binding),
        "viewers" => viewers,
        "families" => if(doc["server"] in [nil, server], do: doc["families"] || %{}, else: %{}),
        "places" => places,
        "views" => views
      })
      |> then(&if(doc["server"] in [nil, server], do: &1, else: Map.drop(&1, ["desk", "map"])))
    end)
  end

  def put_fiber(name, fiber, observed \\ nil)

  def put_fiber(_name, fiber, %{"fiber" => fiber}) when is_binary(fiber) and fiber != "",
    do: :ok

  def put_fiber(name, fiber, observed) when is_binary(fiber) and fiber != "" do
    update(fn doc ->
      case doc["bindings"][name] do
        nil ->
          doc

        b when observed != nil and b != observed ->
          doc

        b ->
          put_in(doc, ["bindings", name], b |> Map.put("fiber", fiber) |> Map.delete("page_uid"))
      end
    end)
  end

  def put_fiber(_, _, _), do: :ok

  @doc """
  Set a binding's page fields when it still equals `observed`: `page_block_id`
  is the page block beside the worker, `page_closed` records that the human
  closed it, and `page_uid` is the fiber uid its page shows when the worker's
  name carries none. A nil value removes the field.
  """
  def put_page(name, observed, fields) do
    update(fn doc ->
      if doc["bindings"][name] == observed do
        b =
          Enum.reduce(fields, observed, fn
            {key, nil}, b -> Map.delete(b, key)
            {key, value}, b -> Map.put(b, key, value)
          end)

        put_in(doc, ["bindings", name], b)
      else
        doc
      end
    end)
  end

  def put_viewer(key, binding, server) do
    update(fn doc ->
      viewers = if doc["server"] in [nil, server], do: doc["viewers"] || %{}, else: %{}

      Map.merge(doc, %{
        "server" => server,
        "bindings" => if(doc["server"] in [nil, server], do: doc["bindings"], else: %{}),
        "families" => if(doc["server"] in [nil, server], do: doc["families"] || %{}, else: %{}),
        "places" => if(doc["server"] in [nil, server], do: doc["places"] || %{}, else: %{}),
        "views" => if(doc["server"] in [nil, server], do: doc["views"] || %{}, else: %{}),
        "viewers" => Map.put(viewers, key, binding)
      })
      |> then(&if(doc["server"] in [nil, server], do: &1, else: Map.drop(&1, ["desk", "map"])))
    end)
  end

  def put_family(family, sid, server) do
    update(fn doc ->
      doc =
        if doc["server"] in [nil, server],
          do: doc,
          else: %{"version" => 1, "bindings" => %{}, "viewers" => %{}, "places" => %{}, "views" => %{}}

      Map.merge(doc, %{
        "server" => server,
        "families" => Map.put(doc["families"] || %{}, family, sid)
      })
    end)
  end

  def put_place(uid, place, server) when is_binary(uid) and is_map(place) and is_binary(server) do
    update(fn doc ->
      doc =
        if doc["server"] in [nil, server],
          do: doc,
          else: %{"version" => 1, "bindings" => %{}, "viewers" => %{}, "families" => %{}, "views" => %{}}

      Map.merge(doc, %{
        "server" => server,
        "places" => Map.put(doc["places"] || %{}, uid, place)
      })
    end)
  end

  @doc """
  Compare-and-set update on `places[uid]`: merges `fields` when the stored
  entry still equals `observed`. A nil value removes the field.
  """
  def update_place(uid, observed, fields) when is_binary(uid) and is_map(fields) do
    update(fn doc ->
      if get_in(doc, ["places", uid]) == observed and is_map(observed) do
        updated =
          Enum.reduce(fields, observed, fn
            {key, nil}, acc -> Map.delete(acc, key)
            {key, value}, acc -> Map.put(acc, key, value)
          end)

        Map.put(doc, "places", Map.put(doc["places"] || %{}, uid, updated))
      else
        doc
      end
    end)
  end

  def delete_place(uid, observed), do: delete_entry("places", uid, observed)

  def put_desk(desk, server) when is_map(desk) and is_binary(server) do
    update(fn doc ->
      doc =
        if doc["server"] in [nil, server],
          do: doc,
          else: %{"version" => 1, "bindings" => %{}, "viewers" => %{}, "families" => %{}, "places" => %{}, "views" => %{}}

      Map.merge(doc, %{
        "server" => server,
        "desk" => desk
      })
    end)
  end

  def delete_desk(observed) do
    update(fn doc ->
      if doc["desk"] == observed, do: Map.delete(doc, "desk"), else: doc
    end)
  end

  def put_map(map_entry, server) when is_map(map_entry) and is_binary(server) do
    update(fn doc ->
      doc =
        if doc["server"] in [nil, server],
          do: doc,
          else: %{"version" => 1, "bindings" => %{}, "viewers" => %{}, "families" => %{}, "places" => %{}, "views" => %{}}

      Map.merge(doc, %{
        "server" => server,
        "map" => map_entry
      })
    end)
  end

  def delete_map(observed) do
    update(fn doc ->
      if doc["map"] == observed, do: Map.delete(doc, "map"), else: doc
    end)
  end

  def put_view(family, view, server)
      when is_binary(family) and is_map(view) and is_binary(server) do
    update(fn doc ->
      doc =
        if doc["server"] in [nil, server],
          do: doc,
          else: %{"version" => 1, "bindings" => %{}, "viewers" => %{}, "families" => %{}, "places" => %{}}

      Map.merge(doc, %{
        "server" => server,
        "views" => Map.put(doc["views"] || %{}, family, view)
      })
    end)
  end

  @doc """
  Compare-and-set update on `views[family]`: merges `fields` when the stored
  entry still equals `observed`. A nil value removes the field.
  """
  def update_view(family, observed, fields) when is_binary(family) and is_map(fields) do
    update(fn doc ->
      if get_in(doc, ["views", family]) == observed and is_map(observed) do
        updated =
          Enum.reduce(fields, observed, fn
            {key, nil}, acc -> Map.delete(acc, key)
            {key, value}, acc -> Map.put(acc, key, value)
          end)

        Map.put(doc, "views", Map.put(doc["views"] || %{}, family, updated))
      else
        doc
      end
    end)
  end

  def delete_view(family, observed), do: delete_entry("views", family, observed)

  def put_chosen_roots(roots, server) when is_list(roots) and is_binary(server) do
    update(fn doc ->
      doc =
        if doc["server"] in [nil, server],
          do: doc,
          else: %{"version" => 1, "bindings" => %{}, "viewers" => %{}, "families" => %{}, "places" => %{}, "views" => %{}}

      Map.merge(doc, %{
        "server" => server,
        "chosen_roots" => roots
      })
    end)
  end

  def delete_family(family, sid) do
    update(fn doc ->
      if get_in(doc, ["families", family]) == sid,
        do: Map.put(doc, "families", Map.delete(doc["families"], family)),
        else: doc
    end)
  end

  def delete_viewer(key, observed), do: delete_entry("viewers", key, observed)

  defp delete_entry(kind, key, observed) do
    update(fn doc ->
      if get_in(doc, [kind, key]) == observed,
        do: Map.put(doc, kind, Map.delete(doc[kind], key)),
        else: doc
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
      doc =
        Enum.reduce(["bindings", "viewers", "places", "views"], doc, fn kind, acc ->
          Enum.reduce(snapshot[kind] || %{}, acc, fn {name, entry}, acc ->
            if entry["session_id"] not in live_ids and get_in(acc, [kind, name]) == entry,
              do: Map.put(acc, kind, Map.delete(acc[kind], name)),
              else: acc
          end)
        end)

      doc =
        case snapshot["desk"] do
          %{"session_id" => sid} = desk when is_binary(sid) ->
            if sid not in live_ids and doc["desk"] == desk, do: Map.delete(doc, "desk"), else: doc

          _ ->
            doc
        end

      case snapshot["map"] do
        %{"session_id" => sid} = map_entry when is_binary(sid) ->
          if sid not in live_ids and doc["map"] == map_entry, do: Map.delete(doc, "map"), else: doc

        _ ->
          doc
      end
    end)
  end

  defp update(fun) do
    Shuttle.Terminal.with_lock({__MODULE__, path()}, fn ->
      Shuttle.RuntimeDocuments.change(path(), fn ->
        with {:ok, doc} <- read_fresh() do
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
    end)
  end

  def pid_path(block),
    do: Path.join([Shuttle.data_dir(), "terminals", "rex-pids", block <> ".pid"])

  defp remove_receipts(before, after_doc) do
    removed = MapSet.difference(block_ids(before), block_ids(after_doc))
    Enum.each(removed, &Shuttle.FS.rm(pid_path(&1)))
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
      with :ok <- Shuttle.FS.mkdir_p(Path.dirname(target)),
           :ok <- Shuttle.FS.write(tmp, Jason.encode!(doc)),
           :ok <- Shuttle.FS.chmod(tmp, 0o600),
           :ok <- Shuttle.FS.rename(tmp, target) do
        :ok
      end
    after
      Shuttle.FS.rm(tmp)
    end
  end

  defp valid_viewers?(viewers) when is_map(viewers) do
    Enum.all?(viewers, fn {key, b} ->
      is_binary(key) and
        match?(%{"session_id" => "session:" <> _, "block_id" => "block:" <> _}, b)
    end)
  end

  defp valid_viewers?(_), do: false

  defp valid_families?(families) when is_map(families),
    do:
      Enum.all?(families, fn {root, sid} -> is_binary(root) and match?("session:" <> _, sid) end)

  defp valid_families?(_), do: false

  defp valid_places?(places) when is_map(places) do
    Enum.all?(places, fn {uid, place} ->
      is_binary(uid) and
        match?(
          %{
            "session_id" => "session:" <> _,
            "window_id" => "window:" <> _,
            "family" => family
          }
          when is_binary(family),
          place
        ) and
        match?("block:" <> _, Map.get(place, "page_block_id", "block:")) and
        is_boolean(Map.get(place, "page_closed", false)) and
        (is_nil(place["asked_at"]) or is_binary(place["asked_at"]))
    end)
  end

  defp valid_places?(_), do: false

  defp valid_desk?(nil), do: true

  defp valid_desk?(%{
         "session_id" => "session:" <> _,
         "window_id" => "window:" <> _,
         "page_block_id" => "block:" <> _
       }),
       do: true

  defp valid_desk?(_), do: false

  defp valid_map?(nil), do: true

  defp valid_map?(%{"session_id" => "session:" <> _, "map_closed" => true} = map_entry) do
    is_nil(map_entry["window_id"]) and is_nil(map_entry["page_block_id"]) and
      (is_nil(map_entry["url"]) or is_binary(map_entry["url"]))
  end

  defp valid_map?(%{
         "session_id" => "session:" <> _,
         "window_id" => "window:" <> _,
         "page_block_id" => "block:" <> _
       } = map_entry) do
    is_boolean(Map.get(map_entry, "map_closed", false)) and
      (is_nil(map_entry["url"]) or is_binary(map_entry["url"]))
  end

  defp valid_map?(_), do: false

  defp valid_views?(views) when is_map(views) do
    Enum.all?(views, fn {root, view} ->
      is_binary(root) and
        match?(
          %{
            "session_id" => "session:" <> _,
            "window_id" => "window:" <> _
          },
          view
        ) and
        match?("block:" <> _, Map.get(view, "page_block_id", "block:")) and
        is_boolean(Map.get(view, "page_closed", false))
    end)
  end

  defp valid_views?(_), do: false

  defp valid_chosen_roots?(nil), do: true
  defp valid_chosen_roots?(roots) when is_list(roots), do: Enum.all?(roots, &is_binary/1)
  defp valid_chosen_roots?(_), do: false

  defp decode(json) do
    with {:ok, %{"version" => 1, "server" => server, "bindings" => bindings} = doc} <-
           Jason.decode(json),
         true <- (is_binary(server) or is_nil(server)) and is_map(bindings),
         true <- valid_viewers?(Map.get(doc, "viewers", %{})),
         true <- valid_families?(Map.get(doc, "families", %{})),
         true <- valid_places?(Map.get(doc, "places", %{})),
         true <- valid_desk?(Map.get(doc, "desk")),
         true <- valid_map?(Map.get(doc, "map")),
         true <- valid_views?(Map.get(doc, "views", %{})),
         true <- valid_chosen_roots?(Map.get(doc, "chosen_roots")),
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
               ) and
               match?("block:" <> _, Map.get(binding, "page_block_id", "block:")) and
               is_boolean(Map.get(binding, "page_closed", false))
           end) do
      {:ok, doc}
    else
      _ -> {:error, :invalid_bindings}
    end
  end
end
