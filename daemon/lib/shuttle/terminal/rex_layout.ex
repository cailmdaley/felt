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
  alias Shuttle.{FiberDocuments, Lifecycle, Poller, Rex, RetainedTerminal}
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
    family_fibers_input = Map.get(inputs, :family_fibers)
    bindings = Map.get(inputs, :bindings, %{})
    places = Map.get(inputs, :places, %{})
    sessions = Map.get(inputs, :sessions)
    now = Map.get(inputs, :now, DateTime.utc_now())
    grace = Map.get(inputs, :grace_seconds, @default_grace_seconds)
    base = Map.get(inputs, :pages_base, "http://127.0.0.1:4000")
    own_host_id = Map.get(inputs, :own_host_id, "local")
    fibers_loaded? = Map.get(inputs, :fibers_loaded?, true)

    rows = normalize_fiber_rows(fibers_input)
    family_rows = if family_fibers_input, do: normalize_fiber_rows(family_fibers_input), else: rows
    rows_by_path = fiber_uid_by_path(rows, family_rows)
    live_by_uid = live_family_bindings(bindings, rows_by_path, places, sessions)

    closed_verdict_uids =
      for fiber <- rows,
          uid = fiber["uid"] || fiber["id"],
          is_binary(uid) and uid != "",
          live? = Map.has_key?(live_by_uid, uid),
          Lifecycle.column(fiber, live?) in ["tempered", "discarded"],
          into: MapSet.new(),
          do: uid

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
            fam = Tree.family(path, family_rows)
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

    # Every live family worker always keeps a place even if the fiber feed hasn't
    # listed it yet — unless the fiber is tempered or discarded.
    with_live =
      Enum.reduce(live_by_uid, from_fibers, fn {uid, {_name, b}}, acc ->
        cond do
          Map.has_key?(acc, uid) ->
            acc

          MapSet.member?(closed_verdict_uids, uid) ->
            acc

          true ->
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

          MapSet.member?(closed_verdict_uids, uid) ->
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

  defp normalize_fiber_rows(list) do
    Enum.map(list || [], fn
      %{fiber: fiber} -> fiber
      fiber when is_map(fiber) -> fiber
    end)
  end

  defp fiber_uid_by_path(rows, family_rows) do
    for fiber <- family_rows ++ rows,
        path = fiber["slug"] || fiber["id"],
        uid = fiber["uid"] || fiber["id"],
        is_binary(path) and path != "" and is_binary(uid) and uid != "",
        into: %{},
        do: {path, uid}
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

  defp live_family_bindings(bindings, rows_by_path, places, sessions) do
    places_by_win =
      for {uid, p} <- places || %{},
          is_binary(p["session_id"]) and is_binary(p["window_id"]),
          into: %{},
          do: {{p["session_id"], p["window_id"]}, uid}

    places_by_fiber =
      for {uid, p} <- places || %{},
          is_binary(p["fiber"]),
          into: %{},
          do: {p["fiber"], uid}

    Enum.reduce(bindings || %{}, %{}, fn {name, b}, acc ->
      uid = binding_uid(name, b, rows_by_path, places_by_win, places_by_fiber)

      if is_binary(b["family"]) and is_binary(uid) and binding_alive?(b, sessions) do
        Map.put(acc, uid, {name, b})
      else
        acc
      end
    end)
  end

  defp binding_alive?(_b, nil), do: true

  defp binding_alive?(b, sessions) when is_map(sessions) do
    case sessions[b["session_id"]] do
      nil -> false
      session -> Enum.any?(session.blocks, &(&1.block_id == b["block_id"]))
    end
  end

  defp binding_uid(name, b, rows_by_path, places_by_win, places_by_fiber) do
    Shuttle.ULID.from_tmux(name) ||
      b["page_uid"] ||
      (is_binary(b["fiber"]) and rows_by_path[b["fiber"]]) ||
      places_by_win[{b["session_id"], b["window_id"]}] ||
      (is_binary(b["fiber"]) and places_by_fiber[b["fiber"]]) ||
      nil
  end

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

    desired_uid_by_path =
      for {uid, dp} <- desired.places_by_uid,
          is_binary(dp.fiber),
          into: %{},
          do: {dp.fiber, uid}

    live_bindings = live_family_bindings(bindings, desired_uid_by_path, places, sessions)

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

    # 5. Close stray/unrecorded `rexweb shuttle` page blocks in Shuttle family sessions,
    #    tracking remaining blocks per window so a protected active window is never emptied.
    {close_block_actions, closing_blocks_by_sid} =
      live_families
      |> Enum.sort()
      |> Enum.reduce({[], %{}}, fn {root, sid}, {acts, closing_b} ->
        session = sessions[sid]

        keep =
          MapSet.union(
            keep_pages_by_sid[sid] || MapSet.new(),
            protected_pages_by_sid[sid] || MapSet.new()
          )

        closing_wins = closing_windows_by_sid[sid] || MapSet.new()

        {strays, _planned} =
          Enum.reduce(session.blocks, {[], MapSet.new()}, fn block, {acc, planned} ->
            if page_block?(block) and
                 not MapSet.member?(keep, block.block_id) and
                 not MapSet.member?(closing_wins, block.window_id) and
                 not sole_block_in_protected_window?(focused, session, block, planned) do
              {acc ++ [block.block_id], MapSet.put(planned, block.block_id)}
            else
              {acc, planned}
            end
          end)

        new_acts =
          Enum.map(strays, fn bid ->
            {:close_block, %{session_id: sid, family: root, block_id: bid, reason: :stray_page}}
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
          plan_window_page(
            dp,
            root,
            sid,
            session,
            wid,
            place,
            binding_entry,
            chat_bid,
            binding_name,
            keep_ids
          )

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

  defp plan_window_page(
         dp,
         root,
         sid,
         session,
         wid,
         place,
         binding_entry,
         chat_bid,
         binding_name,
         keep_ids
       ) do
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

  defp sole_block_in_protected_window?(focused, session, block, planned_closed) do
    is_binary(block.window_id) and
      protected_active_window?(focused, session, block.window_id) and
      Enum.count(session.blocks, fn b ->
        b.window_id == block.window_id and not MapSet.member?(planned_closed, b.block_id)
      end) <= 1
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

  defp observe_family(runner, root, focused) do
    with {:ok, doc} <- Bindings.read(),
         {:ok, raw_sessions} <- Rex.sessions(runner) do
      sid = get_in(doc, ["families", root])
      raw = sid && Enum.find(raw_sessions, &(&1["session_id"] == sid))

      sessions_result =
        if raw do
          case observe_session(runner, sid, raw["label"] || "") do
            {:ok, observed_session} -> {:ok, %{sid => observed_session}}
            {:error, :not_found} -> {:ok, %{}}
            error -> error
          end
        else
          {:ok, %{}}
        end

      with {:ok, sessions} <- sessions_result do
        families = if sid, do: %{root => sid}, else: %{}

        bindings =
          Map.filter(doc["bindings"] || %{}, fn {_k, b} ->
            b["family"] == root or (sid != nil and b["session_id"] == sid)
          end)

        places =
          Map.filter(doc["places"] || %{}, fn {_uid, p} ->
            p["family"] == root or (sid != nil and p["session_id"] == sid)
          end)

        {:ok,
         %{
           server: doc["server"],
           sessions: sessions,
           focused_sessions: focused,
           families: families,
           bindings: bindings,
           viewers: doc["viewers"] || %{},
           places: places
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
    locked? = Keyword.get(opts, :locked?, false)

    result =
      Enum.reduce_while(actions, {:ok, %{created: %{}, server: server, any_created?: false}}, fn action,
                                                                                                 {:ok, state} ->
        case apply_one(runner, action, state, locked?) do
          {:ok, next_state} -> {:cont, {:ok, next_state}}
          error -> {:halt, error}
        end
      end)

    case result do
      {:ok, %{any_created?: true}} ->
        unless locked?, do: RetainedTerminal.keep_last(runner)
        if locked?, do: {:ok, :created}, else: :ok

      {:ok, _} ->
        if locked?, do: {:ok, :unchanged}, else: :ok

      error ->
        error
    end
  end

  defp maybe_lock(true, _root, fun), do: fun.()
  defp maybe_lock(false, nil, fun), do: fun.()
  defp maybe_lock(false, root, fun), do: Backend.family_lock(root, fun)

  defp apply_one(_runner, {:delete_family, %{family: root, session_id: sid}}, state, _locked?) do
    with :ok <- Bindings.delete_family(root, sid), do: {:ok, state}
  end

  defp apply_one(_runner, {:delete_place, %{uid: uid, observed: observed}}, state, _locked?) do
    with :ok <- Bindings.delete_place(uid, observed), do: {:ok, state}
  end

  defp apply_one(runner, {:record_place, %{uid: uid, place: place}}, state, _locked?) do
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
         state,
         _locked?
       ) do
    with :ok <- if(obs_place, do: Bindings.update_place(uid, obs_place, fields), else: :ok),
         :ok <- if(bname && obs_binding, do: Bindings.put_page(bname, obs_binding, fields), else: :ok) do
      {:ok, state}
    end
  end

  defp apply_one(
         runner,
         {:create_session, %{family: root, label: label, place: dp}},
         state,
         locked?
       ) do
    maybe_lock(locked?, root, fn ->
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
        {:ok, %{state | created: Map.put(state.created, root, sid), any_created?: true}}
      else
        {:ok, reply} -> {:error, {:unknown, "invalid Rex session.create reply: #{inspect(reply)}"}}
        error -> error
      end
    end)
  end

  defp apply_one(
         runner,
         {:new_window, %{session_id: sid_ref, family: root, place: dp}},
         state,
         locked?
       ) do
    sid = resolve_sid(sid_ref, state.created)

    maybe_lock(locked?, root, fn ->
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
         state,
         locked?
       ) do
    maybe_lock(locked?, root, fn ->
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

  defp apply_one(runner, {:close_block, %{session_id: sid, block_id: bid} = args}, state, locked?) do
    maybe_lock(locked?, args[:family], fn ->
      case Rex.call(runner, "block.close", %{"block_id" => bid}, session: sid) do
        {:ok, _} -> {:ok, state}
        {:error, :not_found} -> {:ok, state}
        error -> error
      end
    end)
  end

  defp apply_one(
         runner,
         {:close_window, %{session_id: sid, window_id: wid, uid: uid, family: root, observed: obs}},
         state,
         locked?
       ) do
    maybe_lock(locked?, root, fn ->
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

  defp apply_one(runner, {:close_session, %{session_id: sid, family: root}}, state, locked?) do
    maybe_lock(locked?, root, fn ->
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

  defp apply_one(
         runner,
         {:set_label, %{target: :session, session_id: sid, label: label}},
         state,
         _locked?
       ) do
    case Rex.call(runner, "session.set_label", %{"label" => label}, session: sid) do
      {:ok, _} -> {:ok, state}
      {:error, :not_found} -> {:ok, state}
      error -> error
    end
  end

  defp apply_one(
         runner,
         {:set_label, %{target: :window, session_id: sid, window_id: wid, label: label}},
         state,
         _locked?
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
  Each family is observed, planned, and mutated atomically under its
  `family_lock/2`, eliminating TOCTOU races with concurrent launches.
  """
  def reconcile(runner, opts \\ []) do
    case Shuttle.Host.pages() do
      {:ok, %{base: base}} ->
        {fibers, fibers_loaded?} = load_fibers(opts)
        family_fibers = load_family_fibers(opts, fibers)
        now = Keyword.get(opts, :now, DateTime.utc_now())
        grace = Keyword.get(opts, :grace_seconds, @default_grace_seconds)
        own_host_id = Keyword.get(opts, :own_host_id, Poller.own_host_id())

        with {:ok, %{"host_id" => server} = identity} <- Rex.whoami(runner),
             :ok <- Backend.reconcile(runner, identity),
             {:ok, doc} <- Bindings.read(),
             {:ok, raw_sessions} <- Rex.sessions(runner) do
          focused = observe_focused_sessions(runner, raw_sessions)

          # Discover all candidate family roots across rex.json and desired fibers.
          seed_desired =
            desired(%{
              fibers: fibers,
              family_fibers: family_fibers,
              fibers_loaded?: fibers_loaded?,
              bindings: doc["bindings"] || %{},
              places: doc["places"] || %{},
              now: now,
              grace_seconds: grace,
              pages_base: base,
              own_host_id: own_host_id
            })

          roots =
            (Map.keys(doc["families"] || %{}) ++
               Enum.map(Map.values(doc["places"] || %{}), & &1["family"]) ++
               Map.keys(seed_desired.families))
            |> Enum.filter(&is_binary/1)
            |> Enum.uniq()
            |> Enum.sort()

          result =
            Enum.reduce_while(roots, {:ok, false}, fn root, {:ok, any_created?} ->
              fam_result =
                Backend.family_lock(root, fn ->
                  with {:ok, observed} <- observe_family(runner, root, focused) do
                    des_all =
                      desired(%{
                        fibers: fibers,
                        family_fibers: family_fibers,
                        fibers_loaded?: fibers_loaded?,
                        bindings: observed.bindings,
                        places: observed.places,
                        sessions: observed.sessions,
                        now: now,
                        grace_seconds: grace,
                        pages_base: base,
                        own_host_id: own_host_id
                      })

                    des_root = scope_desired(des_all, root)
                    actions = plan(observed, des_root)

                    apply(runner, actions,
                      server: observed.server || server,
                      locked?: true
                    )
                  end
                end)

              case fam_result do
                {:ok, :created} -> {:cont, {:ok, true}}
                {:ok, :unchanged} -> {:cont, {:ok, any_created?}}
                error -> {:halt, error}
              end
            end)

          case result do
            {:ok, true} ->
              RetainedTerminal.keep_last(runner)
              :ok

            {:ok, false} ->
              :ok

            error ->
              error
          end
        end

      nil ->
        Pages.reconcile(runner)

      {:error, message} ->
        {:error, [message]}
    end
  end

  defp scope_desired(desired, root) do
    case Map.fetch(desired.families, root) do
      {:ok, fam} ->
        %{
          families: %{root => fam},
          places_by_uid: Map.new(fam.places, &{&1.uid, &1})
        }

      :error ->
        %{families: %{}, places_by_uid: %{}}
    end
  end

  defp load_fibers(opts) do
    case Keyword.fetch(opts, :fibers) do
      {:ok, list} ->
        {list, Keyword.get(opts, :fibers_loaded?, true)}

      :error ->
        case Poller.cached_fiber_documents(felt_stores: Shuttle.FeltStores.configured_stores()) do
          {:ok, %{fibers: entries} = result} ->
            cache_state =
              get_in(result, [:cache, :state]) ||
                get_in(result, [:cache, "state"]) ||
                Map.get(result, :state)

            if cache_state in ["cold", :cold], do: {[], false}, else: {entries, true}

          _ ->
            {[], false}
        end
    end
  end

  defp load_family_fibers(opts, fallback_fibers) do
    case Keyword.fetch(opts, :family_fibers) do
      {:ok, list} ->
        list

      :error ->
        case FiberDocuments.list(felt_stores: Shuttle.FeltStores.configured_stores()) do
          {:ok, %{fibers: entries}} -> entries
          _ -> fallback_fibers
        end
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
  window if needed, restoring a closed page block if the window is still open,
  and stamping `asked_at`. Used by `Shuttle.Go` when a quiet thread is opened.
  """
  def ensure_place(runner, fiber, opts \\ []) when is_map(fiber) do
    uid = fiber["uid"] || fiber["id"]
    path = fiber["slug"] || fiber["id"]

    with {:ok, %{base: base}} <- Shuttle.Host.pages(),
         true <- is_binary(uid) and uid != "" and is_binary(path) and path != "",
         {:ok, family} <- Tree.resolve(path, opts),
         {:ok, %{"host_id" => server} = identity} <- Rex.whoami(runner),
         :ok <- Backend.reconcile(runner, identity) do
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
              {:ok, place, :page_live} ->
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

              {:ok, place, {:restore_page, anchor_bid}} ->
                restore_page_in_place(
                  runner,
                  doc,
                  server,
                  identity,
                  uid,
                  place,
                  anchor_bid,
                  path,
                  depth,
                  url,
                  now_iso
                )

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
      with {:ok, windows} <- Rex.windows(runner, sid),
           true <- Enum.any?(windows, &(&1["window_id"] == wid)),
           {:ok, blocks} <- Rex.blocks(runner, sid) do
        win_blocks = Enum.filter(blocks, &(&1["window_id"] == wid))
        page_bid = place["page_block_id"]

        cond do
          is_binary(page_bid) and Enum.any?(win_blocks, &(&1["block_id"] == page_bid)) ->
            {:ok, place, :page_live}

          anchor = Enum.find(win_blocks, &is_binary(&1["block_id"])) ->
            {:ok, place, {:restore_page, anchor["block_id"]}}

          true ->
            :none
        end
      else
        _ -> :none
      end
    else
      :none
    end
  end

  defp restore_page_in_place(
         runner,
         doc,
         server,
         identity,
         uid,
         place,
         anchor_bid,
         path,
         depth,
         url,
         now_iso
       ) do
    sid = place["session_id"]
    wid = place["window_id"]

    with {:ok, page_blk} <- Pages.page_block(url),
         {:ok, %{"block_ids" => ["block:" <> _ = page_id]}} <-
           Rex.call(
             runner,
             "session.new_split",
             %{
               "anchor_id" => anchor_bid,
               "direction" => "horizontal",
               "side" => "after",
               "ratio" => 0.5,
               "layout" => %{"block" => page_blk},
               "focus" => false
             },
             session: sid,
             timeout_ms: Pages.split_timeout_ms()
           ) do
      updated =
        place
        |> Map.put("page_block_id", page_id)
        |> Map.put("page_closed", false)
        |> Map.put("asked_at", now_iso)
        |> Map.put("fiber", path)
        |> Map.put("depth", depth)

      matching_binding =
        Enum.find(doc["bindings"] || %{}, fn {_, b} ->
          b["session_id"] == sid and b["window_id"] == wid
        end)

      with :ok <- Bindings.put_place(uid, updated, server),
           :ok <- restore_binding_page(matching_binding, page_id),
           :ok <- Bindings.set_instance(identity["instance_id"]) do
        {:ok, updated, false}
      end
    else
      {:ok, reply} -> {:error, {:unknown, "invalid Rex split reply: #{inspect(reply)}"}}
      error -> error
    end
  end

  defp restore_binding_page({bname, b}, page_id),
    do: Bindings.put_page(bname, b, %{"page_block_id" => page_id, "page_closed" => false})

  defp restore_binding_page(nil, _page_id), do: :ok

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
