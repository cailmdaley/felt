defmodule Shuttle.Terminal.RexLayout do
  @moduledoc """
  Desired-state layout planner and executor for Shuttle's Rex sessions,
  windows, and thread page places.

  When `pages.enabled` is on, each thread gets a **place** — one Rex window
  holding its thread page pane, with a live worker's chat block split on the
  left (`[chat | page]`). A thread has a desired place while it has a live
  worker, waits on the human (ask or review), or was gone to (`asked_at`)
  within the grace window (24 h), unless tempered or discarded.

  `desired/1` and `plan/2` are pure functions. `plan/2` never closes a chat
  block, never touches non-Shuttle sessions or human blocks, and never closes
  the active window of a focused session.
  """

  import Kernel, except: [apply: 2, apply: 3]

  require Logger
  alias Shuttle.{Lifecycle, Poller, Rex, RetainedTerminal}
  alias Shuttle.Terminal.Rex, as: Backend
  alias Shuttle.Terminal.RexBindings, as: Bindings
  alias Shuttle.Terminal.RexPages, as: Pages
  alias Shuttle.Terminal.RexTree, as: Tree

  @default_grace_seconds 86_400

  @doc """
  Compute desired family sessions and thread places from fibers, bindings,
  and existing places. Pure function.
  """
  def desired(inputs) when is_map(inputs) do
    fibers_input = Map.get(inputs, :fibers, [])
    bindings = Map.get(inputs, :bindings, %{})
    places = Map.get(inputs, :places, %{})
    now = Map.get(inputs, :now, DateTime.utc_now())
    grace = Map.get(inputs, :grace_seconds, @default_grace_seconds)
    base = Map.get(inputs, :pages_base, "http://127.0.0.1:4000")
    own_host_id = Map.get(inputs, :own_host_id, "local")
    fibers_loaded? = Map.get(inputs, :fibers_loaded?, true)

    rows =
      Enum.map(fibers_input, fn
        %{fiber: fiber} -> fiber
        fiber when is_map(fiber) -> fiber
      end)

    live_by_uid = live_family_bindings(bindings)

    from_fibers =
      rows
      |> Enum.reduce(%{}, fn fiber, acc ->
        uid = fiber["uid"] || fiber["id"]
        path = fiber["slug"] || fiber["id"]

        if is_binary(uid) and uid != "" and is_binary(path) and path != "" and
             owned_or_tracked?(fiber, uid, own_host_id, live_by_uid, places) do
          live? = Map.has_key?(live_by_uid, uid)
          column = Lifecycle.column(fiber, live?)

          if column not in ["tempered", "discarded"] and
               wants_place?(fiber, column, live?, places[uid], now, grace) do
            fam = Tree.family(path, rows)
            place = places[uid] || %{}

            Map.put(acc, uid, %{
              uid: uid,
              fiber: path,
              family: fam.family,
              depth: fam.depth,
              url: Pages.url(base, uid, own_host_id),
              asked_at: place["asked_at"]
            })
          else
            acc
          end
        else
          acc
        end
      end)

    # Every live family worker always keeps a place even if the fiber feed hasn't listed it yet.
    with_live =
      Enum.reduce(live_by_uid, from_fibers, fn {uid, {_name, b}}, acc ->
        if Map.has_key?(acc, uid) do
          acc
        else
          fiber_path = b["fiber"] || b["family"]
          place = places[uid] || %{}

          Map.put(acc, uid, %{
            uid: uid,
            fiber: fiber_path,
            family: b["family"],
            depth: b["depth"] || 0,
            url: Pages.url(base, uid, own_host_id),
            asked_at: place["asked_at"]
          })
        end
      end)

    # Keep existing places when the fiber feed is cold, or when recently asked
    # and the fiber wasn't present in the feed (and thus not tempered/discarded).
    fiber_uids = MapSet.new(rows, &(&1["uid"] || &1["id"]))

    places_by_uid =
      Enum.reduce(places, with_live, fn {uid, place}, acc ->
        cond do
          Map.has_key?(acc, uid) ->
            acc

          not fibers_loaded? ->
            keep_existing_place(acc, uid, place, base, own_host_id)

          not MapSet.member?(fiber_uids, uid) and recently_asked?(place, now, grace) ->
            keep_existing_place(acc, uid, place, base, own_host_id)

          true ->
            acc
        end
      end)

    families =
      places_by_uid
      |> Map.values()
      |> Enum.group_by(& &1.family)
      |> Map.new(fn {root, entries} ->
        ordered =
          entries
          |> Tree.layout()
          |> Enum.map(fn entry ->
            entry
            |> Map.put(:window_label, Tree.display_label(entry.label))
            |> Map.delete(:label)
          end)

        {root,
         %{
           family: root,
           label: Tree.display_label(Tree.session_label(root)),
           places: ordered
         }}
      end)

    places_by_uid =
      for {_root, fam} <- families, dp <- fam.places, into: %{}, do: {dp.uid, dp}

    %{families: families, places_by_uid: places_by_uid}
  end

  defp keep_existing_place(acc, uid, place, base, own_host_id) do
    family = place["family"]
    fiber = place["fiber"] || family

    if is_binary(family) and family != "" do
      Map.put(acc, uid, %{
        uid: uid,
        fiber: fiber,
        family: family,
        depth: place["depth"] || 0,
        url: Pages.url(base, uid, own_host_id),
        asked_at: place["asked_at"]
      })
    else
      acc
    end
  end

  defp owned_or_tracked?(fiber, uid, own_host_id, live_by_uid, places) do
    own_host_id == nil or
      get_in(fiber, ["shuttle", "host"]) == own_host_id or
      Map.has_key?(live_by_uid, uid) or
      Map.has_key?(places, uid)
  end

  defp wants_place?(fiber, column, live?, place, now, grace) do
    live? or
      column == "awaiting_review" or
      (fiber["status"] == "active" and is_map(get_in(fiber, ["shuttle", "ask"]))) or
      recently_asked?(place, now, grace)
  end

  defp recently_asked?(%{"asked_at" => at}, now, grace) when is_binary(at) do
    case DateTime.from_iso8601(at) do
      {:ok, dt, _} -> DateTime.diff(now, dt, :second) < grace
      _ -> false
    end
  end

  defp recently_asked?(_, _, _), do: false

  defp live_family_bindings(bindings) do
    Enum.reduce(bindings || %{}, %{}, fn {name, b}, acc ->
      uid = binding_uid(name, b)

      if is_binary(b["family"]) and is_binary(uid) do
        Map.put(acc, uid, {name, b})
      else
        acc
      end
    end)
  end

  defp binding_uid(name, b), do: Shuttle.ULID.from_tmux(name) || b["page_uid"]

  @doc """
  Compute the minimal list of actions to bring `observed` to `desired`. Pure function.

  Invariants:
  - Never touches sessions not in `observed.families`.
  - Never closes a chat block, viewer block, or non-page block.
  - Never closes a window containing any non-page block.
  - Never closes the active window of a focused session.
  - Idempotent: `plan(apply_pure(obs, plan(obs, des)), des) == []`.
  """
  def plan(observed, desired) do
    sessions = Map.get(observed, :sessions, %{})
    focused = Map.get(observed, :focused_sessions, MapSet.new())
    families = Map.get(observed, :families, %{})
    bindings = Map.get(observed, :bindings, %{})
    places = Map.get(observed, :places, %{})

    live_bindings = live_family_bindings(bindings)

    # 1. Stale family entries (session no longer exists in Rex).
    stale_family_actions =
      for {root, sid} <- Enum.sort(families),
          not Map.has_key?(sessions, sid),
          do: {:delete_family, %{family: root, session_id: sid}}

    live_families = Map.filter(families, fn {_root, sid} -> Map.has_key?(sessions, sid) end)

    # 2. Stale place entries (session or window no longer exists in Rex).
    {stale_place_actions, live_places} =
      places
      |> Enum.sort()
      |> Enum.reduce({[], %{}}, fn {uid, place}, {acts, live} ->
        sid = place["session_id"]
        wid = place["window_id"]
        session = sessions[sid]

        if session != nil and Enum.any?(session.windows, &(&1.window_id == wid)) do
          {acts, Map.put(live, uid, place)}
        else
          {acts ++ [{:delete_place, %{uid: uid, observed: place}}], live}
        end
      end)

    # 3. Desired families & places: create sessions/windows, split missing pages,
    #    record human-closed pages, update labels.
    {desired_actions, keep_pages_by_sid} =
      desired.families
      |> Enum.sort()
      |> Enum.reduce({[], %{}}, fn {root, fam}, {acts, keep_map} ->
        sid = live_families[root]
        session = sid && sessions[sid]

        {fam_acts, keep_ids, _created?} =
          Enum.reduce(fam.places, {[], MapSet.new(), false}, fn dp, {f_acts, k_ids, created?} ->
            plan_desired_place(
              dp,
              root,
              fam.label,
              sid,
              session,
              live_places[dp.uid],
              live_bindings[dp.uid],
              created?,
              f_acts,
              k_ids
            )
          end)

        label_act =
          if session != nil and session.label != fam.label do
            [{:set_label, %{target: :session, session_id: sid, label: fam.label}}]
          else
            []
          end

        keep_map =
          if sid,
            do: Map.update(keep_map, sid, keep_ids, &MapSet.union(&1, keep_ids)),
            else: keep_map

        {acts ++ fam_acts ++ label_act, keep_map}
      end)

    # 4. Close expired place windows (only in Shuttle family sessions, never
    #    protected active windows, never windows holding non-page blocks).
    shuttle_sids = MapSet.new(Map.values(live_families))

    {close_window_actions, closing_windows_by_sid, protected_pages_by_sid} =
      live_places
      |> Enum.sort()
      |> Enum.reduce({[], %{}, %{}}, fn {uid, place}, {acts, closing, protected} ->
        sid = place["session_id"]
        wid = place["window_id"]

        cond do
          Map.has_key?(desired.places_by_uid, uid) ->
            {acts, closing, protected}

          not MapSet.member?(shuttle_sids, sid) ->
            {acts, closing, protected}

          true ->
            session = sessions[sid]
            win_blocks = Enum.filter(session.blocks, &(&1.window_id == wid))

            cond do
              protected_active_window?(focused, session, wid) ->
                page_ids =
                  win_blocks
                  |> Enum.filter(&page_block?/1)
                  |> MapSet.new(& &1.block_id)

                {acts, closing,
                 Map.update(protected, sid, page_ids, &MapSet.union(&1, page_ids))}

              Enum.any?(win_blocks, &(not page_block?(&1))) ->
                # Window holds a chat block, viewer, or human shell — never close the window.
                {acts, closing, protected}

              true ->
                act =
                  {:close_window,
                   %{
                     session_id: sid,
                     window_id: wid,
                     uid: uid,
                     family: place["family"],
                     observed: place
                   }}

                closing = Map.update(closing, sid, MapSet.new([wid]), &MapSet.put(&1, wid))
                {acts ++ [act], closing, protected}
            end
        end
      end)

    # 5. Close stray/unrecorded `rexweb shuttle` page blocks in Shuttle family sessions.
    {close_block_actions, closing_blocks_by_sid} =
      live_families
      |> Enum.sort()
      |> Enum.reduce({[], %{}}, fn {_root, sid}, {acts, closing_b} ->
        session = sessions[sid]
        keep = MapSet.union(keep_pages_by_sid[sid] || MapSet.new(), protected_pages_by_sid[sid] || MapSet.new())
        closing_wins = closing_windows_by_sid[sid] || MapSet.new()

        strays =
          for block <- session.blocks,
              page_block?(block),
              not MapSet.member?(keep, block.block_id),
              not MapSet.member?(closing_wins, block.window_id),
              not sole_block_in_protected_window?(focused, session, block) do
            block.block_id
          end

        new_acts =
          Enum.map(strays, fn bid ->
            {:close_block, %{session_id: sid, block_id: bid, reason: :stray_page}}
          end)

        closing_b = Map.put(closing_b, sid, MapSet.new(strays))
        {acts ++ new_acts, closing_b}
      end)

    # 6. Close empty Shuttle family sessions (no desired places, no remaining
    #    windows, no remaining blocks).
    close_session_actions =
      for {root, sid} <- Enum.sort(live_families),
          not Map.has_key?(desired.families, root) do
        session = sessions[sid]
        closing_wins = closing_windows_by_sid[sid] || MapSet.new()
        closing_blks = closing_blocks_by_sid[sid] || MapSet.new()

        remaining_blocks =
          Enum.reject(session.blocks, fn b ->
            MapSet.member?(closing_wins, b.window_id) or MapSet.member?(closing_blks, b.block_id)
          end)

        remaining_windows =
          Enum.filter(session.windows, fn w ->
            not MapSet.member?(closing_wins, w.window_id) and
              Enum.any?(remaining_blocks, &(&1.window_id == w.window_id))
          end)

        if remaining_windows == [] and remaining_blocks == [] do
          {:close_session, %{session_id: sid, family: root}}
        end
      end
      |> Enum.reject(&is_nil/1)

    stale_family_actions ++
      stale_place_actions ++
      desired_actions ++
      close_window_actions ++
      close_block_actions ++
      close_session_actions
  end

  defp plan_desired_place(
         dp,
         root,
         session_label,
         sid,
         session,
         place,
         binding_entry,
         created?,
         acts,
         keep_ids
       ) do
    existing = find_live_window(session, place, binding_entry)

    case existing do
      {:ok, wid, win, chat_bid, binding_name} ->
        {page_acts, keep_ids} =
          plan_window_page(dp, root, sid, session, wid, place, binding_entry, chat_bid, binding_name, keep_ids)

        label_act =
          if win.label != dp.window_label do
            [{:set_label, %{target: :window, session_id: sid, window_id: wid, label: dp.window_label}}]
          else
            []
          end

        {acts ++ page_acts ++ label_act, keep_ids, created?}

      :none ->
        cond do
          session != nil ->
            act = {:new_window, %{session_id: sid, family: root, place: dp}}
            {acts ++ [act], keep_ids, created?}

          created? ->
            act = {:new_window, %{session_id: {:new, root}, family: root, place: dp}}
            {acts ++ [act], keep_ids, true}

          true ->
            act = {:create_session, %{family: root, label: session_label, place: dp}}
            {acts ++ [act], keep_ids, true}
        end
    end
  end

  defp find_live_window(nil, _place, _binding_entry), do: :none

  defp find_live_window(session, place, binding_entry) do
    {binding_name, binding} = binding_entry || {nil, nil}

    placed_chat =
      if binding && binding["session_id"] == session.session_id do
        Enum.find(session.blocks, &(&1.block_id == binding["block_id"] and is_binary(&1.window_id)))
      end

    wid =
      cond do
        place && place["session_id"] == session.session_id &&
            Enum.any?(session.windows, &(&1.window_id == place["window_id"])) ->
          place["window_id"]

        placed_chat != nil ->
          placed_chat.window_id

        true ->
          nil
      end

    case wid && Enum.find(session.windows, &(&1.window_id == wid)) do
      nil -> :none
      win -> {:ok, wid, win, placed_chat && placed_chat.block_id, binding_name}
    end
  end

  defp plan_window_page(dp, root, sid, session, wid, place, binding_entry, chat_bid, binding_name, keep_ids) do
    binding = binding_entry && elem(binding_entry, 1)
    recorded_page_id = (place && place["page_block_id"]) || (binding && binding["page_block_id"])
    page_closed? = (place && place["page_closed"] == true) or (binding && binding["page_closed"] == true)

    live_page =
      recorded_page_id &&
        Enum.find(session.blocks, &(&1.block_id == recorded_page_id and &1.window_id == wid))

    cond do
      live_page != nil ->
        keep_ids = MapSet.put(keep_ids, live_page.block_id)

        record_act =
          if place == nil do
            [
              {:record_place,
               %{
                 uid: dp.uid,
                 place: %{
                   "session_id" => sid,
                   "window_id" => wid,
                   "page_block_id" => live_page.block_id,
                   "family" => root,
                   "fiber" => dp.fiber,
                   "depth" => dp.depth,
                   "asked_at" => dp.asked_at,
                   "page_closed" => false
                 }
               }}
            ]
          else
            []
          end

        {record_act, keep_ids}

      recorded_page_id != nil ->
        # The human closed the page block; record `page_closed: true` and do not re-add it.
        act =
          {:update_place,
           %{
             uid: dp.uid,
             observed_place: place,
             observed_binding: binding,
             binding_name: binding_name,
             fields: %{"page_block_id" => nil, "page_closed" => true}
           }}

        {[act], keep_ids}

      page_closed? ->
        {[], keep_ids}

      is_binary(chat_bid) ->
        act =
          {:new_split,
           %{
             session_id: sid,
             window_id: wid,
             anchor_id: chat_bid,
             uid: dp.uid,
             url: dp.url,
             family: root,
             fiber: dp.fiber,
             depth: dp.depth,
             asked_at: dp.asked_at,
             binding_name: binding_name,
             observed_binding: binding
           }}

        {[act], keep_ids}

      true ->
        {[], keep_ids}
    end
  end

  defp protected_active_window?(focused, session, wid) do
    MapSet.member?(focused, session.session_id) and session.active_window_id == wid
  end

  defp sole_block_in_protected_window?(focused, session, block) do
    is_binary(block.window_id) and
      protected_active_window?(focused, session, block.window_id) and
      Enum.count(session.blocks, &(&1.window_id == block.window_id)) <= 1
  end

  defp page_block?(%{label: label}), do: label == Pages.label()
  defp page_block?(%{"label" => label}), do: label == Pages.label()
  defp page_block?(_), do: false

  @doc """
  Purely apply `actions` to an `observed` state. Used to test planner
  properties (idempotence and safety invariants) without I/O.
  """
  def apply_pure(observed, actions) do
    {result, _meta} =
      Enum.reduce(actions, {observed, %{next_id: 1, created: %{}}}, fn action, {obs, meta} ->
        apply_pure_one(action, obs, meta)
      end)

    result
  end

  defp apply_pure_one({:delete_family, %{family: root}}, obs, meta) do
    {update_in(obs, [:families], &Map.delete(&1 || %{}, root)), meta}
  end

  defp apply_pure_one({:delete_place, %{uid: uid}}, obs, meta) do
    {update_in(obs, [:places], &Map.delete(&1 || %{}, uid)), meta}
  end

  defp apply_pure_one({:record_place, %{uid: uid, place: place}}, obs, meta) do
    {put_in(obs, [:places, uid], place), meta}
  end

  defp apply_pure_one(
         {:update_place, %{uid: uid, binding_name: bname, fields: fields}},
         obs,
         meta
       ) do
    obs =
      if get_in(obs, [:places, uid]) do
        update_in(obs, [:places, uid], &merge_fields(&1, fields))
      else
        obs
      end

    obs =
      if bname && get_in(obs, [:bindings, bname]) do
        update_in(obs, [:bindings, bname], &merge_fields(&1, fields))
      else
        obs
      end

    {obs, meta}
  end

  defp apply_pure_one({:create_session, %{family: root, label: label, place: dp}}, obs, meta) do
    n = meta.next_id
    sid = "session:sim-#{n}"
    wid = "window:sim-#{n}"
    bid = "block:sim-page-#{n}"

    session = %{
      session_id: sid,
      label: label,
      active_window_id: wid,
      windows: [%{window_id: wid, label: dp.window_label, block_ids: [bid]}],
      blocks: [%{block_id: bid, label: Pages.label(), window_id: wid, placement: "placed"}]
    }

    place = %{
      "session_id" => sid,
      "window_id" => wid,
      "page_block_id" => bid,
      "family" => root,
      "fiber" => dp.fiber,
      "depth" => dp.depth,
      "asked_at" => dp.asked_at,
      "page_closed" => false
    }

    obs =
      obs
      |> put_in([:sessions, sid], session)
      |> put_in([:families, root], sid)
      |> put_in([:places, dp.uid], place)

    {obs, %{meta | next_id: n + 1, created: Map.put(meta.created, root, sid)}}
  end

  defp apply_pure_one({:new_window, %{session_id: sid_ref, family: root, place: dp}}, obs, meta) do
    sid = resolve_sid(sid_ref, meta.created)
    n = meta.next_id
    wid = "window:sim-#{n}"
    bid = "block:sim-page-#{n}"

    win = %{window_id: wid, label: dp.window_label, block_ids: [bid]}
    blk = %{block_id: bid, label: Pages.label(), window_id: wid, placement: "placed"}

    place = %{
      "session_id" => sid,
      "window_id" => wid,
      "page_block_id" => bid,
      "family" => root,
      "fiber" => dp.fiber,
      "depth" => dp.depth,
      "asked_at" => dp.asked_at,
      "page_closed" => false
    }

    obs =
      obs
      |> update_in([:sessions, sid, :windows], &(&1 ++ [win]))
      |> update_in([:sessions, sid, :blocks], &(&1 ++ [blk]))
      |> put_in([:places, dp.uid], place)

    {obs, %{meta | next_id: n + 1}}
  end

  defp apply_pure_one(
         {:new_split,
          %{
            session_id: sid,
            window_id: wid,
            uid: uid,
            family: root,
            fiber: fiber,
            depth: depth,
            asked_at: asked_at,
            binding_name: bname
          }},
         obs,
         meta
       ) do
    n = meta.next_id
    bid = "block:sim-page-#{n}"
    blk = %{block_id: bid, label: Pages.label(), window_id: wid, placement: "placed"}

    place = %{
      "session_id" => sid,
      "window_id" => wid,
      "page_block_id" => bid,
      "family" => root,
      "fiber" => fiber,
      "depth" => depth,
      "asked_at" => asked_at,
      "page_closed" => false
    }

    obs =
      obs
      |> update_in([:sessions, sid, :blocks], &(&1 ++ [blk]))
      |> update_in([:sessions, sid, :windows], fn wins ->
        Enum.map(wins, fn w ->
          if w.window_id == wid, do: %{w | block_ids: w.block_ids ++ [bid]}, else: w
        end)
      end)
      |> put_in([:places, uid], place)

    obs =
      if bname && get_in(obs, [:bindings, bname]) do
        put_in(obs, [:bindings, bname, "page_block_id"], bid)
      else
        obs
      end

    {obs, %{meta | next_id: n + 1}}
  end

  defp apply_pure_one({:close_block, %{session_id: sid, block_id: bid}}, obs, meta) do
    obs =
      obs
      |> update_in([:sessions, sid, :blocks], &Enum.reject(&1, fn b -> b.block_id == bid end))
      |> update_in([:sessions, sid, :windows], fn wins ->
        wins
        |> Enum.map(&%{&1 | block_ids: List.delete(&1.block_ids, bid)})
        |> Enum.reject(&(&1.block_ids == []))
      end)

    {obs, meta}
  end

  defp apply_pure_one({:close_window, %{session_id: sid, window_id: wid, uid: uid}}, obs, meta) do
    obs =
      obs
      |> update_in([:sessions, sid, :windows], &Enum.reject(&1, fn w -> w.window_id == wid end))
      |> update_in([:sessions, sid, :blocks], &Enum.reject(&1, fn b -> b.window_id == wid end))
      |> update_in([:places], &Map.delete(&1 || %{}, uid))

    {obs, meta}
  end

  defp apply_pure_one({:close_session, %{session_id: sid, family: root}}, obs, meta) do
    obs =
      obs
      |> update_in([:sessions], &Map.delete(&1, sid))
      |> update_in([:families], &Map.delete(&1 || %{}, root))

    {obs, meta}
  end

  defp apply_pure_one({:set_label, %{target: :session, session_id: sid, label: label}}, obs, meta) do
    {put_in(obs, [:sessions, sid, :label], label), meta}
  end

  defp apply_pure_one(
         {:set_label, %{target: :window, session_id: sid, window_id: wid, label: label}},
         obs,
         meta
       ) do
    obs =
      update_in(obs, [:sessions, sid, :windows], fn wins ->
        Enum.map(wins, fn w -> if w.window_id == wid, do: %{w | label: label}, else: w end)
      end)

    {obs, meta}
  end

  defp resolve_sid({:new, root}, created), do: Map.fetch!(created, root)
  defp resolve_sid(sid, _created), do: sid

  defp merge_fields(map, fields) do
    Enum.reduce(fields, map, fn
      {k, nil}, acc -> Map.delete(acc, k)
      {k, v}, acc -> Map.put(acc, k, v)
    end)
  end

  # --- Effectful observation, execution, and entry points ---

  @doc "Observe Rex sessions, Shuttle family windows/blocks, focused sessions, and rex.json."
  def observe(runner) do
    with {:ok, doc} <- Bindings.read(),
         {:ok, raw_sessions} <- Rex.sessions(runner) do
      families = doc["families"] || %{}
      shuttle_sids = MapSet.new(Map.values(families))
      focused = observe_focused_sessions(runner, raw_sessions)

      sessions_result =
        Enum.reduce_while(raw_sessions, {:ok, %{}}, fn s, {:ok, acc} ->
          sid = s["session_id"]

          if MapSet.member?(shuttle_sids, sid) do
            case observe_session(runner, sid, s["label"] || "") do
              {:ok, observed_session} -> {:cont, {:ok, Map.put(acc, sid, observed_session)}}
              {:error, :not_found} -> {:cont, {:ok, acc}}
              error -> {:halt, error}
            end
          else
            # Non-Shuttle sessions are recorded minimally and never inspected or mutated.
            {:cont,
             {:ok,
              Map.put(acc, sid, %{
                session_id: sid,
                label: s["label"] || "",
                active_window_id: nil,
                windows: [],
                blocks: []
              })}}
          end
        end)

      with {:ok, sessions} <- sessions_result do
        {:ok,
         %{
           server: doc["server"],
           sessions: sessions,
           focused_sessions: focused,
           families: families,
           bindings: doc["bindings"] || %{},
           viewers: doc["viewers"] || %{},
           places: doc["places"] || %{}
         }}
      end
    end
  end

  defp observe_session(runner, sid, label) do
    with {:ok, view} <- Rex.call(runner, "session.view", %{}, session: sid),
         {:ok, blocks} <- Rex.blocks(runner, sid) do
      norm_blocks =
        Enum.map(blocks, fn b ->
          %{
            block_id: b["block_id"],
            label: b["label"],
            window_id: b["window_id"],
            placement: b["placement"] || if(b["window_id"], do: "placed", else: "detached")
          }
        end)

      norm_windows =
        Enum.map(view["windows"] || [], fn w ->
          wid = w["window_id"]
          bids = for b <- norm_blocks, b.window_id == wid, do: b.block_id
          %{window_id: wid, label: w["label"] || "", block_ids: bids}
        end)

      {:ok,
       %{
         session_id: sid,
         label: label,
         active_window_id: view["active_window_id"],
         windows: norm_windows,
         blocks: norm_blocks
       }}
    end
  end

  defp observe_focused_sessions(runner, raw_sessions) do
    from_sessions =
      for s <- raw_sessions,
          s["attached"] == true or (is_integer(s["attached_clients"]) and s["attached_clients"] > 0),
          into: MapSet.new(),
          do: s["session_id"]

    from_clients =
      case Rex.command(runner, ["client", "ls", "--json"]) do
        {:ok, output} ->
          case Jason.decode(output) do
            {:ok, %{"clients" => clients}} when is_list(clients) ->
              for c <- clients,
                  match?(%{"info" => %{"kind" => "app"}}, c),
                  sid <- client_sessions(c),
                  into: MapSet.new(),
                  do: sid

            _ ->
              MapSet.new()
          end

        _ ->
          MapSet.new()
      end

    MapSet.union(from_sessions, from_clients)
  end

  defp client_sessions(client) do
    direct =
      [client["focused_session_id"], client["session_id"]]
      |> Enum.filter(&is_binary/1)

    attached =
      case client["attached_sessions"] do
        list when is_list(list) -> Enum.filter(list, &is_binary/1)
        _ -> []
      end

    direct ++ attached
  end

  @doc "Execute a list of planned actions against `runner`."
  def apply(runner, actions, opts \\ []) do
    server = Keyword.get(opts, :server)

    result =
      Enum.reduce_while(actions, {:ok, %{created: %{}, server: server, any_created?: false}}, fn action,
                                                                                                 {:ok, state} ->
        case apply_one(runner, action, state) do
          {:ok, next_state} -> {:cont, {:ok, next_state}}
          error -> {:halt, error}
        end
      end)

    case result do
      {:ok, %{any_created?: true}} ->
        RetainedTerminal.keep_last(runner)
        :ok

      {:ok, _} ->
        :ok

      error ->
        error
    end
  end

  defp apply_one(_runner, {:delete_family, %{family: root, session_id: sid}}, state) do
    with :ok <- Bindings.delete_family(root, sid), do: {:ok, state}
  end

  defp apply_one(_runner, {:delete_place, %{uid: uid, observed: observed}}, state) do
    with :ok <- Bindings.delete_place(uid, observed), do: {:ok, state}
  end

  defp apply_one(runner, {:record_place, %{uid: uid, place: place}}, state) do
    with {:ok, server, state} <- ensure_server_id(runner, state),
         :ok <- Bindings.put_place(uid, place, server) do
      {:ok, state}
    end
  end

  defp apply_one(
         _runner,
         {:update_place,
          %{
            uid: uid,
            observed_place: obs_place,
            observed_binding: obs_binding,
            binding_name: bname,
            fields: fields
          }},
         state
       ) do
    with :ok <- if(obs_place, do: Bindings.update_place(uid, obs_place, fields), else: :ok),
         :ok <- if(bname && obs_binding, do: Bindings.put_page(bname, obs_binding, fields), else: :ok) do
      {:ok, state}
    end
  end

  defp apply_one(runner, {:create_session, %{family: root, label: label, place: dp}}, state) do
    Backend.family_lock(root, fn ->
      with {:ok, server, state} <- ensure_server_id(runner, state),
           {:ok, page_blk} <- Pages.page_block(dp.url),
           spec = %{
             "label" => label,
             "initial_windows" => [
               %{
                 "window_label" => dp.window_label,
                 "layout" => %{"block" => page_blk}
               }
             ]
           },
           {:ok,
            %{
              "session_id" => "session:" <> _ = sid,
              "initial_windows" => [%{"window_id" => "window:" <> _ = wid, "block_ids" => ["block:" <> _ = bid]}]
            }} <- Rex.create(runner, spec, timeout_ms: Pages.launch_timeout_ms()),
           :ok <- Bindings.put_family(root, sid, server),
           place = place_record(sid, wid, bid, dp),
           :ok <- Bindings.put_place(dp.uid, place, server) do
        {:ok,
         %{state | created: Map.put(state.created, root, sid), any_created?: true}}
      else
        {:ok, reply} -> {:error, {:unknown, "invalid Rex session.create reply: #{inspect(reply)}"}}
        error -> error
      end
    end)
  end

  defp apply_one(runner, {:new_window, %{session_id: sid_ref, family: root, place: dp}}, state) do
    sid = resolve_sid(sid_ref, state.created)

    Backend.family_lock(root, fn ->
      with {:ok, server, state} <- ensure_server_id(runner, state),
           {:ok, page_blk} <- Pages.page_block(dp.url),
           spec = %{"window_label" => dp.window_label, "layout" => %{"block" => page_blk}},
           {:ok, %{"window_id" => "window:" <> _ = wid, "block_ids" => ["block:" <> _ = bid]}} <-
             Rex.new_window(runner, sid, spec, timeout_ms: Pages.launch_timeout_ms()),
           place = place_record(sid, wid, bid, dp),
           :ok <- Bindings.put_place(dp.uid, place, server) do
        {:ok, state}
      else
        {:ok, reply} -> {:error, {:unknown, "invalid Rex new_window reply: #{inspect(reply)}"}}
        error -> error
      end
    end)
  end

  defp apply_one(
         runner,
         {:new_split,
          %{
            session_id: sid,
            window_id: wid,
            anchor_id: anchor_id,
            uid: uid,
            url: url,
            family: root,
            fiber: fiber,
            depth: depth,
            asked_at: asked_at,
            binding_name: bname,
            observed_binding: obs_binding
          }},
         state
       ) do
    Backend.family_lock(root, fn ->
      with {:ok, server, state} <- ensure_server_id(runner, state),
           {:ok, page_blk} <- Pages.page_block(url),
           {:ok, %{"block_ids" => ["block:" <> _ = page_id]}} <-
             Rex.call(
               runner,
               "session.new_split",
               %{
                 "anchor_id" => anchor_id,
                 "direction" => "horizontal",
                 "side" => "after",
                 "ratio" => 0.5,
                 "layout" => %{"block" => page_blk},
                 "focus" => false
               },
               session: sid,
               timeout_ms: Pages.split_timeout_ms()
             ),
           place = %{
             "session_id" => sid,
             "window_id" => wid,
             "page_block_id" => page_id,
             "family" => root,
             "fiber" => fiber,
             "depth" => depth,
             "asked_at" => asked_at,
             "page_closed" => false
           },
           :ok <- Bindings.put_place(uid, place, server),
           :ok <-
             if(bname && obs_binding,
               do: Bindings.put_page(bname, obs_binding, %{"page_block_id" => page_id}),
               else: :ok
             ) do
        {:ok, state}
      else
        {:ok, reply} -> {:error, {:unknown, "invalid Rex split reply: #{inspect(reply)}"}}
        error -> error
      end
    end)
  end

  defp apply_one(runner, {:close_block, %{session_id: sid, block_id: bid}}, state) do
    case Rex.call(runner, "block.close", %{"block_id" => bid}, session: sid) do
      {:ok, _} -> {:ok, state}
      {:error, :not_found} -> {:ok, state}
      error -> error
    end
  end

  defp apply_one(
         runner,
         {:close_window, %{session_id: sid, window_id: wid, uid: uid, family: root, observed: obs}},
         state
       ) do
    Backend.family_lock(root, fn ->
      result =
        case Rex.close_window(runner, sid, wid) do
          {:ok, _} -> :ok
          {:error, :not_found} -> :ok
          error -> error
        end

      with :ok <- result,
           :ok <- Bindings.delete_place(uid, obs) do
        {:ok, state}
      end
    end)
  end

  defp apply_one(runner, {:close_session, %{session_id: sid, family: root}}, state) do
    Backend.family_lock(root, fn ->
      result =
        case Rex.destroy(runner, sid) do
          {:ok, _} -> :ok
          {:error, :not_found} -> :ok
          error -> error
        end

      with :ok <- result,
           :ok <- Bindings.delete_family(root, sid) do
        {:ok, state}
      end
    end)
  end

  defp apply_one(runner, {:set_label, %{target: :session, session_id: sid, label: label}}, state) do
    case Rex.call(runner, "session.set_label", %{"label" => label}, session: sid) do
      {:ok, _} -> {:ok, state}
      {:error, :not_found} -> {:ok, state}
      error -> error
    end
  end

  defp apply_one(
         runner,
         {:set_label, %{target: :window, session_id: sid, window_id: wid, label: label}},
         state
       ) do
    case Rex.call(runner, "session.set_window_label", %{"window_id" => wid, "label" => label},
           session: sid
         ) do
      {:ok, _} -> {:ok, state}
      {:error, :not_found} -> {:ok, state}
      error -> error
    end
  end

  defp ensure_server_id(_runner, %{server: server} = state) when is_binary(server),
    do: {:ok, server, state}

  defp ensure_server_id(runner, state) do
    with {:ok, %{"host_id" => server}} <- Rex.whoami(runner) do
      {:ok, server, %{state | server: server}}
    end
  end

  defp place_record(sid, wid, bid, dp) do
    %{
      "session_id" => sid,
      "window_id" => wid,
      "page_block_id" => bid,
      "family" => dp.family,
      "fiber" => dp.fiber,
      "depth" => dp.depth,
      "asked_at" => dp.asked_at,
      "page_closed" => false
    }
  end

  @doc """
  Reconcile Rex's Shuttle family sessions and thread places with desired state.
  """
  def reconcile(runner, opts \\ []) do
    case Shuttle.Host.pages() do
      {:ok, %{base: base}} ->
        {fibers, fibers_loaded?} =
          case Keyword.fetch(opts, :fibers) do
            {:ok, list} ->
              {list, true}

            :error ->
              case Poller.cached_fiber_documents(
                     felt_stores: Shuttle.FeltStores.configured_stores()
                   ) do
                {:ok, %{fibers: entries}} -> {entries, true}
                _ -> {[], false}
              end
          end

        with {:ok, observed} <- observe(runner) do
          des =
            desired(%{
              fibers: fibers,
              fibers_loaded?: fibers_loaded?,
              bindings: observed.bindings,
              places: observed.places,
              now: Keyword.get(opts, :now, DateTime.utc_now()),
              grace_seconds: Keyword.get(opts, :grace_seconds, @default_grace_seconds),
              pages_base: base,
              own_host_id: Keyword.get(opts, :own_host_id, Poller.own_host_id())
            })

          actions = plan(observed, des)
          apply(runner, actions, server: observed.server)
        end

      nil ->
        Pages.reconcile(runner)

      {:error, message} ->
        {:error, [message]}
    end
  end

  @doc """
  Find an existing live place for `uid` whose session, window, and page block
  are all still alive in Rex, so a worker launch can split its chat block
  into the left of that window (`side: "before"`).

  Called under `family_lock/2` by `Shuttle.Terminal.Rex`.
  """
  def place_for(runner, opts) when is_map(opts) or is_list(opts) do
    uid = opts[:uid]
    doc = opts[:doc]
    sessions = opts[:sessions]
    server = opts[:server]

    with true <- is_binary(uid),
         true <- doc["server"] in [nil, server],
         %{"session_id" => sid, "window_id" => wid, "page_block_id" => page_bid} = place <-
           get_in(doc, ["places", uid]),
         true <- is_binary(page_bid),
         true <- Enum.any?(sessions, &(&1["session_id"] == sid)),
         {:ok, blocks} <- Rex.blocks(runner, sid),
         true <-
           Enum.any?(blocks, &(&1["block_id"] == page_bid and &1["window_id"] == wid)) do
      {:ok, place}
    else
      _ -> :none
    end
  end

  @doc """
  Ensure a `[page]` place exists for `fiber`, creating its family session or
  window if needed, and stamp `asked_at`. Used by `Shuttle.Go` when a quiet
  thread is opened.
  """
  def ensure_place(runner, fiber, opts \\ []) when is_map(fiber) do
    uid = fiber["uid"] || fiber["id"]
    path = fiber["slug"] || fiber["id"]

    with {:ok, %{base: base}} <- Shuttle.Host.pages(),
         true <- is_binary(uid) and uid != "" and is_binary(path) and path != "",
         {:ok, family} <- Tree.resolve(path, opts),
         {:ok, %{"host_id" => server} = identity} <- Rex.whoami(runner) do
      root = (family && family.family) || path
      depth = (family && family.depth) || 0
      [entry] = Tree.layout([%{fiber: path, depth: depth}])
      window_label = Tree.display_label(entry.label)
      session_label = Tree.display_label(Tree.session_label(root))
      url = Pages.url(base, uid, Keyword.get(opts, :own_host_id, Poller.own_host_id()))
      now_iso = Keyword.get(opts, :now, DateTime.utc_now()) |> DateTime.to_iso8601()

      result =
        Backend.family_lock(root, fn ->
          with {:ok, doc} <- Bindings.read(),
               {:ok, sessions} <- Rex.sessions(runner) do
            existing_place =
              if doc["server"] in [nil, server], do: get_in(doc, ["places", uid]), else: nil

            case live_existing_place(runner, sessions, existing_place) do
              {:ok, place} ->
                updated =
                  place
                  |> Map.put("asked_at", now_iso)
                  |> Map.put("page_closed", false)
                  |> Map.put("fiber", path)
                  |> Map.put("depth", depth)

                with :ok <- Bindings.put_place(uid, updated, server),
                     :ok <- Bindings.set_instance(identity["instance_id"]) do
                  {:ok, updated, false}
                end

              :none ->
                create_page_place(
                  runner,
                  doc,
                  sessions,
                  server,
                  identity,
                  uid,
                  root,
                  path,
                  depth,
                  session_label,
                  window_label,
                  url,
                  now_iso
                )
            end
          end
        end)

      case result do
        {:ok, place, true} ->
          RetainedTerminal.keep_last(runner)
          {:ok, place}

        {:ok, place, false} ->
          {:ok, place}

        error ->
          error
      end
    else
      nil -> {:error, :pages_disabled}
      false -> {:error, :invalid_fiber}
      error -> error
    end
  end

  defp live_existing_place(_runner, _sessions, nil), do: :none

  defp live_existing_place(runner, sessions, %{"session_id" => sid, "window_id" => wid} = place) do
    if Enum.any?(sessions, &(&1["session_id"] == sid)) do
      case Rex.windows(runner, sid) do
        {:ok, windows} ->
          if Enum.any?(windows, &(&1["window_id"] == wid)), do: {:ok, place}, else: :none

        _ ->
          :none
      end
    else
      :none
    end
  end

  defp create_page_place(
         runner,
         doc,
         sessions,
         server,
         identity,
         uid,
         root,
         path,
         depth,
         session_label,
         window_label,
         url,
         now_iso
       ) do
    sid = if doc["server"] == server, do: get_in(doc, ["families", root])
    existing_session? = sid != nil and Enum.any?(sessions, &(&1["session_id"] == sid))

    with {:ok, page_blk} <- Pages.page_block(url) do
      window_spec = %{"window_label" => window_label, "layout" => %{"block" => page_blk}}

      created =
        if existing_session? do
          with {:ok, %{"window_id" => "window:" <> _ = wid, "block_ids" => ["block:" <> _ = bid]}} <-
                 Rex.new_window(runner, sid, window_spec, timeout_ms: Pages.launch_timeout_ms()) do
            {:ok, sid, wid, bid, false}
          else
            {:ok, reply} -> {:error, {:unknown, "invalid Rex new_window reply: #{inspect(reply)}"}}
            error -> error
          end
        else
          spec = %{"label" => session_label, "initial_windows" => [window_spec]}

          with {:ok,
                %{
                  "session_id" => "session:" <> _ = new_sid,
                  "initial_windows" => [
                    %{"window_id" => "window:" <> _ = wid, "block_ids" => ["block:" <> _ = bid]}
                  ]
                }} <- Rex.create(runner, spec, timeout_ms: Pages.launch_timeout_ms()),
               :ok <- Bindings.put_family(root, new_sid, server) do
            {:ok, new_sid, wid, bid, true}
          else
            {:ok, reply} -> {:error, {:unknown, "invalid Rex create reply: #{inspect(reply)}"}}
            error -> error
          end
        end

      with {:ok, place_sid, wid, bid, new_session?} <- created do
        place = %{
          "session_id" => place_sid,
          "window_id" => wid,
          "page_block_id" => bid,
          "family" => root,
          "fiber" => path,
          "depth" => depth,
          "asked_at" => now_iso,
          "page_closed" => false
        }

        with :ok <- Bindings.put_place(uid, place, server),
             :ok <- Bindings.set_instance(identity["instance_id"]) do
          {:ok, place, new_session?}
        end
      end
    end
  end
end
