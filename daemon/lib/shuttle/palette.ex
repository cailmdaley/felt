defmodule Shuttle.Palette do
  @moduledoc """
  Builds the fleet-wide palette for Rex's native `rex.ui.pick` (`GET /api/v1/palette`).

  Combines Desk (when `pages.desk` is enabled), lifecycle actions for the
  currently focused thread (resolved from `fiber_id` or Rex `session_id` /
  `window_id` / `block_id`), and non-tempered, non-discarded channels and
  threads ordered by attention: waiting on the human first, then live workers,
  then channels, then recent threads.
  """

  alias Shuttle.{FeltStores, Host, Lifecycle, Poller, RemoteFiberRegistry}
  alias Shuttle.Terminal.RexBindings

  @max_items 500
  @ulid_re ~r/([0-9A-HJKMNP-TV-Z]{26})/

  @doc """
  Gather live composite fibers, host pages config, and Rex bindings, then
  build the palette payload `%{focused: map() | nil, items: [map()]}`.
  """
  @spec fetch(map()) :: %{focused: map() | nil, items: [map()]}
  def fetch(params \\ %{}) when is_map(params) do
    fibers = composite_entries()
    desk? = match?({:ok, %{desk: true}}, Host.pages())
    bindings_doc = read_bindings()

    build(fibers,
      desk?: desk?,
      bindings: bindings_doc,
      fiber_id: non_empty(params["fiber_id"]),
      session_id: non_empty(params["session_id"]),
      window_id: non_empty(params["window_id"]),
      block_id: non_empty(params["block_id"])
    )
  end

  @doc """
  Pure builder: given composite fiber entries and options, returns
  `%{focused: map() | nil, items: [map()]}`.
  """
  @spec build([map()], keyword()) :: %{focused: map() | nil, items: [map()]}
  def build(entries, opts \\ []) when is_list(entries) do
    desk? = Keyword.get(opts, :desk?, false)
    bindings_doc = Keyword.get(opts, :bindings, %{})
    chosen_roots = MapSet.new(bindings_doc["chosen_roots"] || [])

    normalized = Enum.map(entries, &normalize_entry/1)

    focused_entry =
      resolve_focused(
        normalized,
        bindings_doc,
        Keyword.get(opts, :fiber_id),
        Keyword.get(opts, :session_id),
        Keyword.get(opts, :window_id),
        Keyword.get(opts, :block_id)
      )

    desk_items = if desk?, do: [desk_item()], else: []
    action_items = focused_actions(focused_entry)

    thread_items =
      normalized
      |> Enum.reject(&(&1.column in ["tempered", "discarded"]))
      |> Enum.sort_by(&sort_key(&1, chosen_roots))
      |> Enum.map(&entry_item(&1, chosen_roots))

    items = Enum.take(desk_items ++ action_items ++ thread_items, @max_items)

    %{
      focused: focused_summary(focused_entry),
      items: items
    }
  end

  # ── Data gathering ──

  defp composite_entries do
    local = local_entries()

    remotes =
      RemoteFiberRegistry.feeds()
      |> Enum.flat_map(fn {name, feed} ->
        (feed.fibers || [])
        |> Enum.map(&Map.put(&1, "origin", name))
        |> Lifecycle.stamp()
      end)

    local ++ remotes
  end

  defp local_entries do
    case Poller.cached_fiber_documents(felt_stores: FeltStores.configured_stores()) do
      {:ok, %{host: host, fibers: entries}} ->
        Enum.map(entries, &Map.put(&1, :origin, host))

      _ ->
        []
    end
  catch
    :exit, _ -> []
  end

  defp read_bindings do
    case RexBindings.read() do
      {:ok, doc} -> doc
      _ -> %{}
    end
  end

  # ── Entry normalization ──

  defp normalize_entry(entry) do
    fiber = field(entry, :fiber) || %{}
    runtime = field(entry, :runtime)
    live? = runtime != nil
    column = field(entry, :column) || Lifecycle.column(fiber, live?)
    turn = field(entry, :turn) || Lifecycle.turn(fiber, live?, runtime, field(entry, :dispatch_error), System.system_time(:millisecond))
    origin = field(entry, :origin) || get_in(fiber, ["shuttle", "host"])
    uid = non_empty(fiber["uid"])
    slug = non_empty(fiber["slug"]) || non_empty(fiber["id"]) || uid || ""
    fiber_id = uid || slug
    title = non_empty(fiber["name"]) || slug

    %{
      fiber: fiber,
      uid: uid,
      slug: slug,
      fiber_id: fiber_id,
      title: title,
      origin: origin,
      column: column,
      turn: turn,
      runtime: runtime,
      live?: live?,
      recency_ms: recency_ms(fiber, runtime)
    }
  end

  defp recency_ms(fiber, runtime) do
    [
      field(runtime, :last_activity_at),
      field(runtime, :started_at),
      Poller.iso_to_unix_ms(get_in(fiber, ["shuttle", "runtime", "dispatched_at"])),
      Poller.iso_to_unix_ms(fiber["modified_at"]),
      Poller.iso_to_unix_ms(fiber["closed_at"]),
      Poller.iso_to_unix_ms(fiber["created_at"])
    ]
    |> Enum.map(&to_unix_ms/1)
    |> Enum.filter(&is_integer/1)
    |> Enum.max(fn -> 0 end)
  end

  defp to_unix_ms(%DateTime{} = dt), do: DateTime.to_unix(dt, :millisecond)
  defp to_unix_ms(ms) when is_integer(ms), do: ms
  defp to_unix_ms(iso) when is_binary(iso), do: Poller.iso_to_unix_ms(iso)
  defp to_unix_ms(_), do: nil

  # ── Focused thread resolution ──

  defp resolve_focused(entries, _doc, fiber_id, _sid, _wid, _bid) when is_binary(fiber_id) do
    find_entry(entries, fiber_id)
  end

  defp resolve_focused(entries, doc, nil, sid, wid, bid) when is_binary(sid) do
    with ident when is_binary(ident) <- lookup_rex_identifier(doc, sid, wid, bid) do
      find_entry(entries, ident)
    end
  end

  defp resolve_focused(_entries, _doc, _fid, _sid, _wid, _bid), do: nil

  defp lookup_rex_identifier(doc, sid, wid, bid) do
    lookup_place(doc["places"] || %{}, sid, wid, bid) ||
      lookup_binding(doc["bindings"] || %{}, sid, wid, bid) ||
      lookup_view(doc["views"] || %{}, sid, wid, bid)
  end

  defp lookup_place(places, sid, wid, bid) do
    Enum.find_value(places, fn {uid, place} ->
      if matches_rex_target?(place, sid, wid, bid), do: uid
    end)
  end

  defp lookup_binding(bindings, sid, wid, bid) do
    Enum.find_value(bindings, fn {name, binding} ->
      if matches_rex_target?(binding, sid, wid, bid) do
        non_empty(binding["page_uid"]) || non_empty(binding["fiber"]) || extract_uid(name)
      end
    end)
  end

  defp lookup_view(views, sid, wid, bid) do
    Enum.find_value(views, fn {root, view} ->
      if matches_rex_target?(view, sid, wid, bid) do
        non_empty(view["uid"]) || non_empty(view["fiber"]) || non_empty(root)
      end
    end)
  end

  defp matches_rex_target?(entry, sid, wid, bid) when is_map(entry) do
    entry["session_id"] == sid and
      cond do
        is_binary(wid) ->
          entry["window_id"] == wid

        is_binary(bid) ->
          entry["block_id"] == bid or entry["page_block_id"] == bid

        true ->
          true
      end
  end

  defp matches_rex_target?(_, _, _, _), do: false

  defp extract_uid(name) when is_binary(name) do
    case Regex.run(@ulid_re, name) do
      [_, uid] -> uid
      _ -> nil
    end
  end

  defp find_entry(entries, ident) do
    Enum.find(entries, fn e ->
      e.uid == ident or e.fiber["id"] == ident or e.slug == ident or e.fiber_id == ident
    end)
  end

  # ── Item builders ──

  defp desk_item do
    %{
      id: "desk",
      kind: "desk",
      title: "Desk",
      subtitle: "All threads across the fleet",
      detail: "desk",
      icon: "globe",
      fiber_id: nil,
      origin: nil
    }
  end

  defp focused_summary(nil), do: nil

  defp focused_summary(entry) do
    %{
      fiber_id: entry.fiber_id,
      slug: entry.slug,
      title: entry.title,
      origin: entry.origin,
      column: entry.column
    }
  end

  defp focused_actions(nil), do: []
  defp focused_actions(%{column: col}) when col in ["tempered", "discarded"], do: []

  defp focused_actions(entry) do
    standing? = get_in(entry.fiber, ["shuttle", "kind"]) == "standing"
    active? = entry.fiber["status"] == "active"

    [
      if(not standing? or active?, do: action_item(entry, "temper", "Temper", "star")),
      if(not standing? and entry.column != "awaiting_review",
        do: action_item(entry, "review", "To review", "clock")
      ),
      if(entry.column != "resting", do: action_item(entry, "rest", "Rest", "document")),
      action_item(entry, "discard", "Discard", "gear"),
      action_item(entry, "new_session", "New session", "plus")
    ]
    |> Enum.reject(&is_nil/1)
  end

  defp action_item(entry, action, label, icon) do
    %{
      id: "action:#{action}:#{entry.fiber_id}",
      kind: "action",
      title: "#{label} — #{entry.title}",
      subtitle: subtitle_for(entry.slug, entry.origin),
      detail: "action",
      icon: icon,
      fiber_id: entry.fiber_id,
      origin: entry.origin,
      action: action
    }
  end

  defp entry_item(entry, chosen_roots) do
    ch? = channel?(entry, chosen_roots)
    kind = if ch?, do: "channel", else: "thread"
    tier = attention_tier(entry, ch?)

    %{
      id: "#{kind}:#{entry.origin || "local"}:#{entry.fiber_id}",
      kind: kind,
      title: entry.title,
      subtitle: entry_subtitle(entry),
      detail: entry_detail(entry, tier, ch?),
      icon: entry_icon(tier, ch?),
      fiber_id: entry.fiber_id,
      origin: entry.origin
    }
  end

  defp sort_key(entry, chosen_roots) do
    tier = attention_tier(entry, channel?(entry, chosen_roots))
    {tier, -entry.recency_ms, entry.slug}
  end

  defp attention_tier(entry, ch?) do
    cond do
      Lifecycle.yours?(entry.turn) or entry.column == "awaiting_review" -> 0
      entry.live? -> 1
      ch? -> 2
      true -> 3
    end
  end

  defp channel?(entry, chosen_roots) do
    shuttle = entry.fiber["shuttle"] || %{}
    declared = non_empty(shuttle["channel"])

    MapSet.member?(chosen_roots, entry.slug) or
      shuttle["seat"] == true or
      (is_binary(declared) and not String.contains?(entry.slug, "/"))
  end

  defp entry_detail(entry, 0, _ch?) do
    cond do
      entry.turn == "question" -> "needs you"
      entry.turn == "blocked" -> "blocked"
      entry.column == "awaiting_review" -> "review"
      entry.turn == "idle" -> "idle"
      true -> "needs you"
    end
  end

  defp entry_detail(_entry, 1, _ch?), do: "live"
  defp entry_detail(_entry, 2, true), do: "channel"

  defp entry_detail(entry, _tier, _ch?) do
    case entry.column do
      "in_flight" -> "in flight"
      "orchestrator_review" -> "review"
      "drafts" -> "draft"
      "resting" -> "resting"
      "roles" -> "role"
      other -> other
    end
  end

  defp entry_icon(_tier, true), do: "folder"
  defp entry_icon(0, false), do: "clock"
  defp entry_icon(1, false), do: "terminal"
  defp entry_icon(_, false), do: "document"

  defp entry_subtitle(entry) do
    if entry.title == entry.slug do
      entry.origin || ""
    else
      subtitle_for(entry.slug, entry.origin)
    end
  end

  defp subtitle_for(slug, nil), do: slug
  defp subtitle_for(slug, ""), do: slug
  defp subtitle_for("", origin), do: origin
  defp subtitle_for(slug, origin), do: "#{slug} · #{origin}"

  defp field(nil, _key), do: nil
  defp field(map, key), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))

  defp non_empty(val) when is_binary(val) do
    case String.trim(val) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp non_empty(_), do: nil
end
