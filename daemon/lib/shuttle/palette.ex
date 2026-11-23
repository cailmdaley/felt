defmodule Shuttle.Palette do
  @moduledoc """
  Builds the fleet-wide palette for Rex's native `rex.ui.pick` (`GET /api/v1/palette`).

  Combines Desk (when `pages.desk` is enabled), lifecycle actions for the
  currently focused thread (resolved from `fiber_id` or Rex `session_id` /
  `window_id` / `block_id`), and channels and threads ordered by attention:
  waiting on the human first, then live workers, then channels, then recent
  threads, then tempered and discarded threads.
  """

  alias Shuttle.{FeltStores, Host, Lifecycle, Poller, RemoteFiberRegistry}
  alias Shuttle.Terminal.RexBindings

  @max_items 2000
  @ulid_re ~r/([0-9A-HJKMNP-TV-Z]{26})/

  @doc """
  Gather live composite fibers, host pages config, and Rex bindings, then
  build the palette payload `%{focused: map() | nil, default_project_dir: String.t() | nil, items: [map()]}`.
  """
  @spec fetch(map()) :: %{
          focused: map() | nil,
          default_project_dir: String.t() | nil,
          items: [map()]
        }
  def fetch(params \\ %{}) when is_map(params) do
    fibers = composite_entries()
    desk? = match?({:ok, %{desk: true}}, Host.pages())
    bindings_doc = read_bindings()

    build(fibers,
      desk?: desk?,
      bindings: bindings_doc,
      default_project_dir: default_project_dir(),
      fiber_id: non_empty(params["fiber_id"]),
      session_id: non_empty(params["session_id"]),
      window_id: non_empty(params["window_id"]),
      block_id: non_empty(params["block_id"])
    )
  end

  @doc """
  Pure builder: given composite fiber entries and options, returns
  `%{focused: map() | nil, default_project_dir: String.t() | nil, items: [map()]}`.
  """
  @spec build([map()], keyword()) :: %{
          focused: map() | nil,
          default_project_dir: String.t() | nil,
          items: [map()]
        }
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

    desk_items = if desk?, do: [desk_item(), map_item()], else: []
    action_items = focused_actions(focused_entry)

    thread_items =
      normalized
      |> Enum.sort_by(&sort_key(&1, chosen_roots))
      |> Enum.map(&entry_item(&1, chosen_roots))

    items = Enum.take(desk_items ++ [new_thread_item()] ++ action_items ++ thread_items, @max_items)

    %{
      focused: focused_summary(focused_entry),
      default_project_dir: non_empty(Keyword.get(opts, :default_project_dir)),
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

  @doc "First existing configured felt store directory, falling back to `Shuttle.Env.home/0`."
  @spec default_project_dir() :: String.t() | nil
  def default_project_dir do
    FeltStores.configured_stores()
    |> Enum.find_value(fn dir ->
      with trimmed when is_binary(trimmed) <- non_empty(dir),
           true <- Shuttle.FS.dir?(trimmed) do
        trimmed
      else
        _ -> nil
      end
    end) || Shuttle.Env.home()
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

  defp resolve_focused(entries, doc, nil, sid, wid, bid)
       when is_binary(sid) or is_binary(wid) or is_binary(bid) do
    with ident when is_binary(ident) <- lookup_rex_identifier(doc, sid, wid, bid) do
      find_entry(entries, ident)
    end
  end

  defp resolve_focused(_entries, _doc, _fid, _sid, _wid, _bid), do: nil

  # What Rex names most exactly is looked for first, everywhere: the block, then
  # its window. A session alone, with neither, names any of its threads.
  defp lookup_rex_identifier(doc, sid, wid, bid) do
    targets =
      case Enum.filter([block: bid, window: wid], fn {_kind, id} -> is_binary(id) end) do
        [] -> [session: sid]
        targets -> targets
      end

    Enum.find_value(targets, fn target ->
      lookup_place(doc["places"] || %{}, sid, target) ||
        lookup_binding(doc["bindings"] || %{}, sid, target) ||
        lookup_view(doc["views"] || %{}, sid, target)
    end)
  end

  defp lookup_place(places, sid, target) do
    Enum.find_value(places, fn {uid, place} ->
      if matches_rex_target?(place, sid, target), do: uid
    end)
  end

  defp lookup_binding(bindings, sid, target) do
    Enum.find_value(bindings, fn {name, binding} ->
      if matches_rex_target?(binding, sid, target) do
        non_empty(binding["page_uid"]) || non_empty(binding["fiber"]) || extract_uid(name)
      end
    end)
  end

  defp lookup_view(views, sid, target) do
    Enum.find_value(views, fn {root, view} ->
      if matches_rex_target?(view, sid, target) do
        non_empty(view["uid"]) || non_empty(view["fiber"]) || non_empty(root)
      end
    end)
  end

  # Within Rex's session, when it gives one.
  defp matches_rex_target?(entry, sid, target) when is_map(entry) do
    (is_nil(sid) or entry["session_id"] == sid) and
      case target do
        {:block, bid} -> bid in [entry["block_id"], entry["page_block_id"]]
        {:window, wid} -> entry["window_id"] == wid
        {:session, sid} -> entry["session_id"] == sid
      end
  end

  defp matches_rex_target?(_, _, _), do: false

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

  defp map_item do
    %{
      id: "map",
      kind: "map",
      title: "Fleet Map",
      subtitle: "Interactive archipelago of the fleet",
      detail: "map",
      icon: "map",
      fiber_id: nil,
      origin: nil
    }
  end

  defp new_thread_item do
    %{
      id: "new_thread",
      kind: "new_thread",
      title: "New thread…",
      subtitle: "Start a capture session from a prompt",
      detail: "capture",
      icon: "plus",
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
      column: entry.column,
      standing: get_in(entry.fiber, ["shuttle", "kind"]) == "standing",
      project_dir: local_project_dir(entry.fiber)
    }
  end

  defp local_project_dir(fiber) do
    case non_empty(get_in(fiber, ["shuttle", "project_dir"])) do
      nil -> nil
      dir -> if Shuttle.FS.dir?(dir), do: dir, else: nil
    end
  end

  defp focused_actions(nil), do: []

  defp focused_actions(%{column: col} = entry) when col in ["tempered", "discarded"] do
    standing? = get_in(entry.fiber, ["shuttle", "kind"]) == "standing"
    [action_item(entry, "new_session", "New session", "plus", standing?)]
  end

  defp focused_actions(entry) do
    standing? = get_in(entry.fiber, ["shuttle", "kind"]) == "standing"
    active? = entry.fiber["status"] == "active"

    [
      if(not standing? or active?, do: action_item(entry, "temper", "Temper", "star", standing?)),
      if(not standing? and entry.column != "awaiting_review",
        do: action_item(entry, "review", "To review", "clock", standing?)
      ),
      if(entry.column != "resting", do: action_item(entry, "rest", "Rest", "document", standing?)),
      action_item(entry, "discard", "Discard", "gear", standing?),
      action_item(entry, "new_session", "New session", "plus", standing?)
    ]
    |> Enum.reject(&is_nil/1)
  end

  defp action_item(entry, action, label, icon, standing?) do
    %{
      id: "action:#{action}:#{entry.fiber_id}",
      kind: "action",
      title: "#{label} — #{entry.title}",
      subtitle: subtitle_for(entry.slug, entry.origin),
      detail: "action",
      icon: icon,
      fiber_id: entry.fiber_id,
      origin: entry.origin,
      action: action,
      standing: standing?
    }
  end

  defp entry_item(entry, chosen_roots) do
    ch? = entry.column not in ["tempered", "discarded"] and channel?(entry, chosen_roots)
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
    ch? = entry.column not in ["tempered", "discarded"] and channel?(entry, chosen_roots)
    tier = attention_tier(entry, ch?)
    {tier, -entry.recency_ms, entry.slug}
  end

  defp attention_tier(entry, ch?) do
    cond do
      entry.column == "tempered" -> 4
      entry.column == "discarded" -> 5
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
