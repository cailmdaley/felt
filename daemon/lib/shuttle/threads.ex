defmodule Shuttle.Threads do
  @moduledoc "Constitution containment and owner-local result delivery."

  alias Shuttle.{Delivery, FiberDocuments, OriginRouter, Remote, ThreadOutbox}

  @doc """
  Nearest strict ancestor that orchestrates, in the same felt store: one
  carrying a shuttle block and not archived (a tempered or discarded verdict).
  """
  def orchestrator(entry, entries) when is_list(entries), do: orchestrator(entry, index(entries))

  def orchestrator(entry, index) when is_map(index) do
    nearest(Path.dirname(address(entry.fiber)), &Map.get(index, {store_key(entry), &1}))
  end

  defp index(entries), do: Map.new(entries, &{{store_key(&1), address(&1.fiber)}, &1})

  defp store_key(entry), do: Map.get(entry, :thread_store, entry.felt_store)

  @doc "Stamp each constitution with its orchestrator's wire id, or null."
  def put_orchestrators(entries), do: stamp(entries, & &1.felt_store)

  @doc """
  Stamp the cross-host board's constitutions with their orchestrators.

  `rows` mixes this host's atom-keyed entries with remote feeds' string-keyed
  rows. Containment is a property of the felt store, whose tree is the same on
  every host while its path is host-local, so rows are indexed by store
  identity: each `{origin, felt_store}` location resolves to the local store
  holding the most of its fibers' uids (`local_stores`, uid => felt_store). A
  location sharing no uid with a local store is a store of its own. The stamp
  replaces any `orchestrator` a remote daemon computed over its own feed.
  """
  def put_board_orchestrators(rows, local_stores) do
    identities =
      rows
      |> Enum.group_by(&location/1, &get_in(field(&1, :fiber), ["uid"]))
      |> Map.new(fn {location, uids} -> {location, identity(location, uids, local_stores)} end)

    stamp(rows, &Map.fetch!(identities, location(&1)))
  end

  defp identity(location, uids, local_stores) do
    uids
    |> Enum.flat_map(&List.wrap(Map.get(local_stores, &1)))
    |> Enum.frequencies()
    |> Enum.max_by(fn {_store, count} -> count end, fn -> {location, 0} end)
    |> elem(0)
  end

  defp location(row), do: {field(row, :origin), field(row, :felt_store)}

  defp stamp(rows, store_of) do
    index = Map.new(rows, &{{store_of.(&1), address(field(&1, :fiber))}, &1})

    Enum.map(rows, fn row ->
      fiber = field(row, :fiber)

      if is_map(fiber["shuttle"]) do
        store = store_of.(row)
        parent = nearest(Path.dirname(address(fiber)), &Map.get(index, {store, &1}))
        put_field(row, :orchestrator, if(parent, do: field(parent, :fiber)["id"]))
      else
        row
      end
    end)
  end

  # Local entries are atom-keyed; rows decoded from a remote feed are string-keyed.
  defp field(row, key), do: Map.get(row, key, Map.get(row, Atom.to_string(key)))

  defp put_field(row, key, value) when is_map_key(row, key), do: Map.put(row, key, value)
  defp put_field(%{fiber: _} = row, key, value), do: Map.put(row, key, value)
  defp put_field(row, key, value), do: Map.put(row, Atom.to_string(key), value)

  defp nearest(".", _lookup), do: nil
  defp nearest("/", _lookup), do: nil

  defp nearest(path, lookup) do
    entry = lookup.(path)

    if entry && orchestrates?(field(entry, :fiber)),
      do: entry,
      else: nearest(Path.dirname(path), lookup)
  end

  # An archived constitution's work is over: its threads report past it.
  defp orchestrates?(fiber),
    do:
      is_map(fiber["shuttle"]) and
        not (fiber["status"] == "closed" and is_boolean(fiber["tempered"]))

  def address(fiber), do: fiber["slug"] || fiber["id"]

  @doc "Reconcile thread rows with cached owner feeds without doing network I/O."
  def reconcile_owner_feeds(entries, own_host_id, local_store_by_uid, feeds)
      when is_list(entries) and is_map(local_store_by_uid) and is_map(feeds) do
    {local_entries, remote_mirrors} =
      Enum.split_with(entries, fn entry ->
        host = get_in(entry.fiber, ["shuttle", "host"])
        host in [nil, "", own_host_id]
      end)

    mirrored_by_host = Enum.group_by(remote_mirrors, &get_in(&1.fiber, ["shuttle", "host"]))

    hosts = Map.keys(mirrored_by_host) ++ Map.keys(feeds)

    owner_entries =
      hosts
      |> Enum.uniq()
      |> Enum.flat_map(fn host ->
        case Map.get(feeds, host) do
          feed when is_map(feed) ->
            case owner_feed_state(feed) do
              :fresh ->
                feed.fibers
                |> remote_entries(entries, local_store_by_uid, host)
                |> Enum.map(&Map.merge(&1, %{stale: false, host_unreachable: false}))

              {:incomplete, cache_state} ->
                owner_rows =
                  feed.fibers
                  |> remote_entries(entries, local_store_by_uid, host)
                  |> Enum.map(&unknown_owner_row(&1, cache_state))

                owner_ids = MapSet.new(owner_rows, &entry_identity/1)

                missing_mirrors =
                  (mirrored_by_host[host] || [])
                  |> Enum.reject(&MapSet.member?(owner_ids, entry_identity(&1)))
                  |> Enum.map(&unknown_owner_row(&1, cache_state))

                owner_rows ++ missing_mirrors

              :unavailable ->
                stale_mirrors(mirrored_by_host, host)
            end

          _unavailable ->
            stale_mirrors(mirrored_by_host, host)
        end
      end)

    local_entries ++ owner_entries
  end

  defp owner_feed_state(feed) do
    cache = Map.get(feed, :cache, Map.get(feed, "cache")) || %{}
    cache_state = Map.get(cache, :state, Map.get(cache, "state"))
    last_error = Map.get(feed, :last_error, Map.get(feed, "last_error"))
    stale? = Map.get(feed, :stale, Map.get(feed, "stale", true))

    case cache_state do
      state
      when state in ["cold", "partial"] and (stale? == false or is_nil(last_error)) ->
        {:incomplete, state}

      state when state in [nil, "fresh"] and stale? == false ->
        :fresh

      _ ->
        :unavailable
    end
  end

  defp unknown_owner_row(entry, cache_state) do
    Map.merge(entry, %{
      stale: true,
      host_unreachable: false,
      unknown_owner_state: true,
      owner_cache_state: cache_state
    })
  end

  defp entry_identity(entry), do: entry.fiber["uid"] || address(entry.fiber)

  defp stale_mirrors(mirrored_by_host, host) do
    Enum.map(mirrored_by_host[host] || [], &Map.merge(&1, %{stale: true, host_unreachable: true}))
  end

  defp remote_entries(rows, local_entries, local_store_by_uid, host) when is_list(rows) do
    Enum.flat_map(rows, fn row ->
      fiber = field(row, :fiber)

      if is_map(fiber) and get_in(fiber, ["shuttle", "host"]) == host do
        owner_store = field(row, :felt_store)
        store = local_store_for(fiber, owner_store, local_entries, local_store_by_uid)
        local? = is_binary(store)

        [
          Map.merge(
            %{
              fiber: fiber,
              felt_store: if(local?, do: store, else: owner_store),
              path: field(row, :path),
              pending_results: field(row, :pending_results) || 0
            },
            if(local?, do: %{}, else: %{thread_store: remote_store_key(host, owner_store)})
          )
        ]
      else
        []
      end
    end)
  end

  defp remote_store_key(host, owner_store), do: {:remote_owner, host, owner_store}

  defp local_store_for(fiber, owner_store, local_entries, local_store_by_uid) do
    case Map.get(local_store_by_uid, fiber["uid"]) do
      store when is_binary(store) -> store
      _ -> store_from_ancestor(fiber, owner_store, local_entries)
    end
  end

  defp store_from_ancestor(fiber, owner_store, local_entries) do
    local_entries
    |> Enum.filter(fn entry ->
      entry.felt_store == owner_store and ancestor?(address(entry.fiber), address(fiber))
    end)
    |> Enum.max_by(&path_depth(address(&1.fiber)), fn -> nil end)
    |> case do
      nil ->
        local_entries
        |> Enum.filter(&ancestor?(address(&1.fiber), address(fiber)))
        |> Enum.group_by(& &1.felt_store)
        |> choose_nearest_store()
        |> case do
          nil ->
            local_entries
            |> Enum.filter(&ancestor?(address(fiber), address(&1.fiber)))
            |> Enum.group_by(& &1.felt_store)
            |> choose_nearest_store()

          store ->
            store
        end

      entry ->
        entry.felt_store
    end
  end

  defp choose_nearest_store(by_store) do
    candidates =
      Enum.flat_map(by_store, fn {store, rows} ->
        depth = rows |> Enum.map(&path_depth(address(&1.fiber))) |> Enum.max(fn -> 0 end)
        [{store, depth}]
      end)

    case Enum.max_by(candidates, &elem(&1, 1), fn -> nil end) do
      {store, depth} when depth > 0 ->
        if Enum.count(candidates, &(elem(&1, 1) == depth)) == 1, do: store

      _ ->
        nil
    end
  end

  defp ancestor?(ancestor, child) when is_binary(ancestor) and is_binary(child) do
    String.starts_with?(child, ancestor <> "/")
  end

  defp ancestor?(_, _), do: false
  defp path_depth(path) when is_binary(path), do: length(String.split(path, "/", trim: true))
  defp path_depth(_), do: 0

  @doc "The current containment relation in fresh, resumed and standing dispatch prompts."
  def prompt(fiber_id, opts) do
    parent =
      nearest(Path.dirname(fiber_id), fn path ->
        with {:ok, output} <-
               Shuttle.CLI.run_in_store(
                 opts[:felt_store],
                 ["show", path, "--json"],
                 Keyword.take(opts, [:runner])
               ),
             {:ok, %{"shuttle" => block} = fiber} when is_map(block) <- Jason.decode(output) do
          %{fiber: fiber}
        else
          _ -> nil
        end
      end)

    lineage =
      case parent do
        %{fiber: fiber} ->
          "You are a thread of #{address(fiber)} (#{fiber["name"]}). " <>
            "Your outcome is delivered to that orchestrator when you close or ask; write it for that reader."

        nil ->
          ""
      end

    case opts[:threads] do
      {entries, live, reachable} ->
        [lineage, roster(fiber_id, opts[:felt_store], entries, live, reachable)]

      _ ->
        [lineage]
    end
    |> Enum.reject(&(&1 == ""))
    |> Enum.join("\n\n")
  end

  @roster_cap 40
  @state_order ["Unknown", "Waiting", "To review", "Working", "Armed", "Draft", "Resting"]

  @doc """
  The `## Threads` block for an orchestrator's launch prompt: counts for its
  direct threads in board order, then only the Waiting and To review inbox.
  `live` and `reachable` are as `tree/5` takes them.
  """
  def roster(fiber_id, felt_store, entries, live, reachable \\ nil) do
    case tree(fiber_id, felt_store, entries, live, reachable) do
      [] ->
        ""

      threads ->
        {archived, rows} = Enum.split_with(threads, &(&1["state"] == "Archived"))

        groups = Enum.group_by(rows, & &1["state"])

        count_items =
          Enum.flat_map(@state_order, fn state ->
            case Map.get(groups, state, []) do
              [] -> []
              members -> [{state, length(members)}]
            end
          end)

        count_items =
          count_items ++ if(archived == [], do: [], else: [{"Archived", length(archived)}])

        counts = Enum.map(count_items, &count_label(&1, groups))

        summary =
          "## Threads — " <>
            Enum.join(counts, " · ") <>
            " — `shuttle threads #{fiber_id}`"

        {inbox, {_remaining, omitted}} =
          Enum.map_reduce(["Waiting", "To review"], {@roster_cap, 0}, fn state,
                                                                         {remaining,
                                                                          omitted_total} ->
            members =
              rows
              |> Enum.filter(&(&1["state"] == state))
              |> Enum.sort_by(& &1["id"])

            if members == [] do
              {[], {remaining, omitted_total}}
            else
              shown = Enum.take(members, remaining)

              lines =
                Enum.map(shown, fn row ->
                  detail =
                    if state == "Waiting",
                      do: single_line(row["ask"] || "(no question)"),
                      else: first_sentence(row["outcome"])

                  "- #{relative_id(fiber_id, row["id"])} — #{truncate(detail, 160)}" <>
                    child_count(row)
                end)

              omitted = length(members) - length(shown)

              {["### #{state} (#{length(members)})" | lines],
               {max(remaining - length(shown), 0), omitted_total + omitted}}
            end
          end)

        inbox = List.flatten(inbox)
        inbox = inbox ++ if(omitted > 0, do: ["… and #{omitted} more"], else: [])

        Enum.join([summary | inbox], "\n")
    end
  end

  defp relative_id(parent, id), do: String.replace_prefix(id, parent <> "/", "")

  defp count_label({"Armed", count}, groups) do
    unreachable = Enum.count(Map.get(groups, "Armed", []), & &1["host_unreachable"])
    suffix = if unreachable > 0, do: " (#{unreachable} on an unreachable host)", else: ""
    "#{count} armed#{suffix}"
  end

  defp count_label({"Draft", 1}, _groups), do: "1 draft"
  defp count_label({"Draft", count}, _groups), do: "#{count} drafts"
  defp count_label({"To review", count}, _groups), do: "#{count} to review"

  defp count_label({"Unknown", count}, groups) do
    cache_states =
      groups
      |> Map.get("Unknown", [])
      |> Enum.map(& &1["owner_cache_state"])
      |> Enum.reject(&is_nil/1)
      |> Enum.uniq()
      |> Enum.join(", ")

    suffix = if cache_states == "", do: "", else: " (owner cache #{cache_states})"
    "#{count} unknown#{suffix}"
  end

  defp count_label({"Archived", count}, _groups), do: "#{count} archived"
  defp count_label({state, count}, _groups), do: "#{count} #{String.downcase(state)}"

  defp child_count(row) do
    n = unfinished(row["threads"])
    if n > 0, do: " (#{n} #{if(n == 1, do: "thread", else: "threads")})", else: ""
  end

  defp truncate(text, limit) when is_binary(text) do
    if String.length(text) > limit, do: String.slice(text, 0, limit - 1) <> "…", else: text
  end

  defp truncate(_, _), do: "(no outcome yet)"

  defp single_line(text), do: text |> String.replace(~r/\s+/, " ") |> String.trim()

  @doc """
  A thread's roster state as written: Armed says when its host is out of
  sight, and a rest says what it waits for.
  """
  def state_label(%{"host_unreachable" => true}), do: "Armed · host unreachable"

  def state_label(%{"state" => state, "until" => until}) when is_binary(until) and until != "",
    do: "#{state} · ⏸ until #{until}"

  def state_label(%{"state" => state}), do: state

  # The thread badge's count: unfinished threads anywhere below.
  defp unfinished(threads),
    do:
      Enum.sum(
        for t <- threads,
            do: if(t["state"] == "Archived", do: 0, else: 1) + unfinished(t["threads"])
      )

  @doc """
  An orchestrator's threads to every depth, in containment order: one map per
  thread with its `id`, `uid`, `name`, `host`, board `column`, roster `state`,
  `host_unreachable`, full `outcome`, what it rests until (`blocked_on` as
  stored and the `until` name it reads as, both nil when it waits for nothing),
  `pending_results` (`waiting/2`) and its own `threads`. `entries` are the
  reconciled local and owner-feed constitutions; `live` holds the running workers' runtime keys
  (uid, else id) across the fleet; `reachable` is the set of hosts whose
  workers `live` covers (`with_fleet/4`), or nil when the fleet is unknown. An
  Armed thread on a host outside `reachable` is `host_unreachable`.
  """
  def tree(fiber_id, felt_store, entries, live, reachable \\ nil) do
    index = index(entries)
    store = tree_store(fiber_id, felt_store, entries)

    children =
      entries
      |> Enum.filter(&is_map(&1.fiber["shuttle"]))
      |> Enum.group_by(fn entry ->
        case orchestrator(entry, index) do
          nil -> nil
          parent -> {store_key(parent), address(parent.fiber)}
        end
      end)

    grow(children, {store, fiber_id}, {live, reachable, by_uid(entries)})
  end

  defp tree_store(fiber_id, felt_store, entries) do
    case Enum.find(entries, &(address(&1.fiber) == fiber_id and &1.felt_store == felt_store)) do
      nil -> felt_store
      root -> store_key(root)
    end
  end

  defp grow(children, key, {live, reachable, by_uid} = seen) do
    children
    |> Map.get(key, [])
    |> Enum.sort_by(&address(&1.fiber))
    |> Enum.map(fn %{fiber: fiber} = entry ->
      live? = live?(fiber, live)
      host = get_in(fiber, ["shuttle", "host"])

      state =
        if Map.get(entry, :unknown_owner_state), do: "Unknown", else: thread_state(fiber, live?)

      column = if Map.get(entry, :unknown_owner_state), do: "unknown", else: column(fiber, live?)

      blocked = blocked_on(fiber)

      %{
        "id" => address(fiber),
        "uid" => fiber["uid"],
        "name" => fiber["name"],
        "host" => host,
        "column" => column,
        "state" => state,
        "stale" => Map.get(entry, :stale, false),
        "owner_cache_state" => Map.get(entry, :owner_cache_state),
        "host_unreachable" =>
          case Map.fetch(entry, :host_unreachable) do
            {:ok, unavailable?} ->
              unavailable?

            :error ->
              state == "Armed" and is_binary(host) and reachable != nil and
                not MapSet.member?(reachable, host)
          end,
        "outcome" => fiber["outcome"],
        "ask" => get_in(fiber, ["shuttle", "ask", "text"]),
        "blocked_on" => blocked,
        "until" => blocked && blocker_name(blocked, entry.felt_store, by_uid),
        "pending_results" => waiting(entry, live?),
        "threads" => grow(children, {store_key(entry), address(fiber)}, seen)
      }
    end)
  end

  @doc """
  What waits for a constitution's next worker: the `pending_results` count the
  poller stamps on its cached entry (`pending_results/2`), or 0 while a worker
  is live, whose mailbox drains at its next hook.
  """
  def waiting(entry, live?), do: if(live?, do: 0, else: Map.get(entry, :pending_results, 0))

  @doc "What a constitution rests until (`shuttle.blocked_on`), or nil."
  def blocked_on(fiber) do
    case get_in(fiber, ["shuttle", "blocked_on"]) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  @doc """
  The fiber a `blocked_on` value names, or nil when it is free text or names
  nothing this host can read. The poller's cached constitutions answer first;
  any other fiber is read from `felt_store` by its uid through the address
  the daemon last read it at, so a repeat costs one direct `felt show`.
  """
  def blocker(value, felt_store, by_uid) do
    cond do
      not fiber_ref?(value) ->
        nil

      fiber = Map.get(by_uid, String.upcase(value)) || Map.get(by_uid, value) ->
        fiber

      true ->
        case FiberDocuments.get(value,
               felt_stores: [felt_store],
               address: Shuttle.FiberAddresses.lookup(value)
             ) do
          {:ok, %{fibers: [%{fiber: fiber} | _]}} -> fiber
          _ -> nil
        end
    end
  end

  # A stored uid, or the id of a fiber felt gave none; anything else is text.
  defp fiber_ref?(value),
    do:
      Shuttle.ULID.valid?(String.upcase(value)) or
        (String.contains?(value, "/") and not Regex.match?(~r/\s/u, value))

  defp blocker_name(value, felt_store, by_uid) do
    case blocker(value, felt_store, by_uid) do
      %{} = fiber -> fiber["name"] || address(fiber)
      nil -> value
    end
  end

  defp by_uid(entries) do
    Enum.reduce(entries, %{}, fn %{fiber: fiber}, acc ->
      acc
      |> then(&if(is_binary(fiber["uid"]), do: Map.put(&1, fiber["uid"], fiber), else: &1))
      |> Map.put(address(fiber), fiber)
    end)
  end

  defp live?(fiber, live),
    do: MapSet.member?(live, fiber["uid"] || fiber["id"]) or MapSet.member?(live, address(fiber))

  @doc """
  Widen this host's liveness to the fleet's: `{live, reachable}`, where `live`
  adds the running workers of every remote polled within its staleness window
  and `reachable` is this host with those remotes. `fleet` is the remote
  registry's last report (`%{name => %{remote, last_polled_at, running}}`), or
  nil before its first, when no host but this one is known and `reachable` is
  nil.
  """
  def with_fleet(live, own_host, fleet, now \\ DateTime.utc_now())

  def with_fleet(live, _own_host, nil, _now), do: {live, nil}

  def with_fleet(live, own_host, fleet, now) do
    fresh =
      for {name, %{remote: remote, last_polled_at: at, running: running}} <- fleet,
          not Remote.stale?(remote, at, now),
          do: {name, running}

    {Enum.reduce(fresh, live, fn {_name, running}, acc -> MapSet.union(acc, running) end),
     MapSet.new([own_host | Enum.map(fresh, &elem(&1, 0))])}
  end

  @doc """
  The Desk column a constitution sits in, as the board files it
  (`ui/src/board/deskColumn.ts`): `drafts`, `in_flight`, `awaiting_review`,
  `tempered`, `discarded`, `resting` (a draft put down, or a standing
  constitution between firings) or `roles` (a seat at rest). `live?` is whether
  its worker is running. `shuttle status --json` reports the same column
  (`internal/shuttle/column.go`); `test/fixtures/columns/cases.json` holds them equal.
  """
  def column(fiber, live?) do
    shuttle = fiber["shuttle"] || %{}
    status = fiber["status"]

    cond do
      status == "closed" and fiber["tempered"] == true -> "tempered"
      status == "closed" and fiber["tempered"] == false -> "discarded"
      status == "closed" -> "awaiting_review"
      live? -> "in_flight"
      seat_at_rest?(shuttle, status) -> "roles"
      status == "active" and shuttle["kind"] == "standing" -> "resting"
      status == "active" -> "in_flight"
      stashed?(fiber) -> "resting"
      true -> "drafts"
    end
  end

  defp seat_at_rest?(shuttle, status) do
    shuttle["seat"] == true and is_binary(shuttle["role"]) and shuttle["role"] != "" and
      (status != "active" or shuttle["kind"] == "standing")
  end

  # Put down (`horizon: stashed`) unless a `due:` day that has come pulls it back.
  defp stashed?(fiber) do
    fiber["horizon"] == "stashed" and
      case fiber["due"] do
        due when is_binary(due) and byte_size(due) >= 10 ->
          case Date.from_iso8601(binary_part(due, 0, 10)) do
            {:ok, day} -> Date.compare(day, Date.utc_today()) == :gt
            _ -> true
          end

        _ ->
          true
      end
  end

  @doc """
  A thread's roster state: its column, with In flight split into Waiting (an
  outstanding ask), Working (a live worker) and Armed (active with no worker
  running), a verdict archived, and a rest or a seat Resting. The board's rails
  (`ui/src/board/threads.ts` `threadState`) file Armed as Working, and also
  read a harness stopped on a prompt as Waiting; the daemon's runtime record
  does not carry that turn.
  """
  def thread_state(fiber, live?) do
    case column(fiber, live?) do
      verdict when verdict in ["tempered", "discarded"] ->
        "Archived"

      "awaiting_review" ->
        "To review"

      "drafts" ->
        "Draft"

      "in_flight" ->
        cond do
          asking?(fiber) -> "Waiting"
          live? -> "Working"
          true -> "Armed"
        end

      _ ->
        "Resting"
    end
  end

  # An ask counts only on an active card, as the board's `turnOf` reads it.
  defp asking?(fiber),
    do: fiber["status"] == "active" and is_map(get_in(fiber, ["shuttle", "ask"]))

  defp first_sentence(text) when is_binary(text) and text != "" do
    sentence = text |> String.split(~r/(?<=[.!?])\s|\n/, parts: 2) |> hd() |> String.trim()
    if String.length(sentence) > 160, do: String.slice(sentence, 0, 159) <> "…", else: sentence
  end

  defp first_sentence(_), do: "(no outcome yet)"

  @doc "Reconcile durable lifecycle signals. Only a child's owner publishes its results."
  def deliver_results(entries, own_host) do
    capture_results(entries, own_host)
    capture_unblocks(entries, own_host)
    retry_results(own_host)

    # A parent can receive remote results while dormant. Its next live worker
    # drains the same mailbox, even when no child changes during this poll.
    Enum.each(entries, fn entry ->
      if get_in(entry.fiber, ["shuttle", "host"]) == own_host,
        do: Delivery.flush_context(entry)
    end)
  end

  @doc "Persist immutable publications before any asynchronous network attempt."
  def capture_results(entries, own_host) do
    index = index(entries)
    {:ok, baseline, _} = DateTime.from_iso8601(ThreadOutbox.baseline())

    records =
      for entry <- entries,
          get_in(entry.fiber, ["shuttle", "host"]) == own_host,
          parent = orchestrator(entry, index),
          parent != nil,
          {verb, stamp, text, wake} <- signals(entry.fiber),
          after_baseline?(stamp, baseline) do
        id =
          "thread-" <>
            digest({entry.felt_store, entry.fiber["uid"] || entry.fiber["id"], verb, stamp})

        {id,
         %{
           "owner" => own_host,
           "store" => parent.felt_store,
           "parent_uid" => Map.fetch!(parent.fiber, "uid"),
           "text" => "thread #{address(entry.fiber)} #{verb}: #{text}",
           "wake" => wake,
           "signal" => %{
             "uid" => entry.fiber["uid"] || entry.fiber["id"],
             "verb" => verb,
             "stamp" => stamp,
             "owner" => own_host
           }
         }}
      end

    ThreadOutbox.capture(records)
  end

  @doc """
  Persist one context note for each owned thread whose `blocked_on` names a
  fiber that has closed (any verdict), addressed to the thread's orchestrator:
  `thread <id> unblocked: <name> closed`. It never wakes and arms nothing. A
  cleared wait, free text, or a close at or before the outbox baseline
  publishes nothing; each close of the blocker publishes once. Reading a
  blocker outside the poller's cache shells felt, so this runs on the delivery
  task, not the poll.
  """
  def capture_unblocks(entries, own_host) do
    index = index(entries)
    by_uid = by_uid(entries)
    {:ok, baseline, _} = DateTime.from_iso8601(ThreadOutbox.baseline())

    records =
      for entry <- entries,
          get_in(entry.fiber, ["shuttle", "host"]) == own_host,
          blocked = blocked_on(entry.fiber),
          blocked != nil and fiber_ref?(blocked),
          parent = orchestrator(entry, index),
          parent != nil,
          blocker = blocker(blocked, entry.felt_store, by_uid),
          is_map(blocker) and blocker["status"] == "closed",
          stamp = blocker["closed_at"],
          is_binary(stamp) and after_baseline?(stamp, baseline) do
        thread = entry.fiber["uid"] || entry.fiber["id"]
        blocker_id = blocker["uid"] || address(blocker)

        text = "#{blocker["name"] || address(blocker)} closed"

        {"thread-" <> digest({entry.felt_store, thread, "unblocked", blocker_id, stamp}),
         %{
           "owner" => own_host,
           "store" => parent.felt_store,
           "parent_uid" => Map.fetch!(parent.fiber, "uid"),
           "text" => "thread #{address(entry.fiber)} unblocked: #{text}",
           "wake" => false
         }, %{"kind" => "unblocked", "fiber" => thread, "text" => text}}
      end

    created =
      records
      |> Enum.map(fn {id, record, _board} -> {id, record} end)
      |> ThreadOutbox.capture_new()
      |> MapSet.new()

    Enum.each(records, fn {id, _record, board} ->
      if MapSet.member?(created, id) do
        result =
          try do
            Shuttle.CLI.run(["board", "append"],
              input: Jason.encode!(board) <> "\n",
              input_eof: true
            )
          rescue
            error -> {:error, Exception.message(error)}
          catch
            :exit, reason -> {:error, {:exit, reason}}
          end

        case result do
          {:ok, _} ->
            :ok

          error ->
            require Logger
            Logger.warning("Recording unblock on board failed: #{inspect(error)}")
        end
      end
    end)

    :ok
  end

  @doc "Retry persisted publications; acknowledgment means recipient mailbox enqueue, not worker consumption."
  def retry_results(own_host) do
    for {id, record} <- ThreadOutbox.pending(own_host) do
      # Placement is mutable; the intended orchestrator is not. Never infer a
      # new recipient from the child's current ancestry or an old slug.
      with uid when is_binary(uid) <- record["parent_uid"],
           stores = Enum.uniq([record["store"] | Shuttle.FeltStores.configured_stores()]),
           {:ok, %{fibers: [parent]}} <-
             Shuttle.FiberDocuments.get_shuttle(uid, felt_stores: stores),
           ^uid <- parent.fiber["uid"],
           {:ok, current} <- current_signal(record, id),
           true <- not current or acknowledged?(deliver(parent, record, id)) do
        ThreadOutbox.acknowledge(id)
      end
    end

    :ok
  end

  @doc """
  What waits for each constitution this host owns, `%{uid_or_id => count}` with
  zero counts left out: the context its mailbox holds that no worker has taken
  (thread results and messages queued for its next worker), plus the results
  addressed to it still in this host's outbox. One `shuttle context-mailbox
  pending` call answers every mailbox; a failed call counts the outbox alone.
  """
  def pending_results(entries, own_host) do
    owned =
      for entry <- entries,
          is_map(entry.fiber["shuttle"]),
          get_in(entry.fiber, ["shuttle", "host"]) == own_host,
          do: {Delivery.context_key(entry), entry.fiber["uid"] || entry.fiber["id"]}

    mailbox =
      with [_ | _] <- owned,
           {:ok, output} <-
             Shuttle.CLI.run(["context-mailbox", "pending" | Enum.map(owned, &elem(&1, 0))],
               stderr_to_stdout: false
             ),
           {:ok, counts} when is_map(counts) <- Jason.decode(output) do
        for {key, id} <- owned, n = counts[key], is_integer(n), n > 0, into: %{}, do: {id, n}
      else
        _ -> %{}
      end

    ids = MapSet.new(owned, &elem(&1, 1))

    ThreadOutbox.pending(own_host)
    |> Enum.map(fn {_id, record} -> record["parent_uid"] end)
    |> Enum.filter(&MapSet.member?(ids, &1))
    |> Enum.frequencies()
    |> Map.merge(mailbox, fn _id, outbox, queued -> outbox + queued end)
  end

  defp acknowledged?({:ok, :queued}), do: true

  defp acknowledged?({:forwarded, 202, body}) do
    case Jason.decode(body) do
      {:ok, %{"delivery" => "context", "queued" => true}} -> true
      _ -> false
    end
  end

  defp acknowledged?(_), do: false

  defp deliver(parent, record, id) do
    case OriginRouter.route_host(get_in(parent.fiber, ["shuttle", "host"])) do
      :local ->
        Delivery.context(parent, record["text"], id,
          wake: record["wake"],
          thread_signal: record["signal"]
        )

      {:remote, remote} ->
        OriginRouter.forward(remote, "/api/v1/deliver", %{
          "fiber_id" => Map.fetch!(parent.fiber, "uid"),
          "text" => record["text"],
          "context_only" => true,
          "wake" => record["wake"],
          "message_id" => id,
          "thread_signal" => record["signal"]
        })

      {:error, _} = error ->
        error
    end
  end

  defp current_signal(record, id) do
    # Unblock notes have their own dependency semantics; they are not exits.
    if not String.starts_with?(id, "thread-") or
         String.match?(record["text"] || "", ~r/^thread \S+ unblocked: /) do
      {:ok, true}
    else
      signal_current(
        %{"signal" => record["signal"], "message_id" => id, "text" => record["text"]},
        felt_stores: Enum.uniq([record["store"] | Shuttle.FeltStores.configured_stores()])
      )
    end
  end

  @doc "Validate a queued lifecycle notice against its owner's fresh document, never the poll cache."
  def signal_current(params, opts \\ []) do
    signal = params["signal"]
    modern? = is_map(signal) and is_binary(signal["owner"])
    reference = if is_map(signal), do: signal["uid"], else: legacy_reference(params["text"])
    lookup_opts = if modern?, do: opts, else: Keyword.put(opts, :all_matches, true)

    with ref when is_binary(ref) and ref != "" <- reference,
         {:ok, %{fibers: entries}} <-
           FiberDocuments.get_shuttle(ref, lookup_opts) do
      case entries do
        [] -> missing_signal(params)
        [entry] -> validate_on_owner(entry, params, opts)
        # A legacy slug can name different fibers in different stores. With no
        # unique owner document, deliver the queued notice without validation.
        _ when not modern? -> {:ok, true}
        _ -> {:error, :ambiguous_thread}
      end
    else
      nil -> {:error, :invalid_signal}
      {:error, _} = error -> error
      _ -> {:error, :invalid_signal}
    end
  end

  defp missing_signal(params) do
    # A newly created remote thread need not have reached this mirror yet.
    owner = get_in(params, ["signal", "owner"])
    modern? = is_map(params["signal"]) and is_binary(owner)

    case {modern?, owner, params["forwarded"], OriginRouter.route_host(owner)} do
      {_, host, forwarded, {:remote, remote}} when is_binary(host) and forwarded != true ->
        forward_validation(remote, params)

      {false, _, _, _} ->
        {:ok, true}

      {true, _, true, _} ->
        {:ok, false}

      # A structured signal with a pinned local owner is stale when that
      # owner's authoritative document is missing. Legacy notices without an
      # owner are delivered unvalidated above.
      {true, _, _, :local} ->
        {:ok, false}

      {true, _, _, {:error, _} = error} ->
        error

      {true, _, _, {:remote, _}} ->
        {:error, :owner_changed}
    end
  end

  defp legacy_reference(text) when is_binary(text) do
    case Regex.run(~r/^thread (\S+) (?:asked|closed|handed off|rested): /, text) do
      [_, ref] -> ref
      _ -> nil
    end
  end

  defp legacy_reference(_), do: nil

  defp validate_on_owner(entry, params, _opts) do
    owner = get_in(entry.fiber, ["shuttle", "host"])

    case OriginRouter.route_host(owner) do
      :local ->
        {:ok, matches_signal?(entry, params)}

      {:remote, remote} ->
        # One forwarding hop; a stale mirror must not create a routing loop.
        if params["forwarded"] == true do
          {:error, :owner_changed}
        else
          forward_validation(remote, params)
        end

      {:error, _} = error ->
        error
    end
  end

  defp forward_validation(remote, params) do
    with {:forwarded, 200, body} <-
           OriginRouter.forward(
             remote,
             "/api/v1/thread-signals/current",
             Map.put(params, "forwarded", true),
             forward_timeout_ms: 5_000
           ),
         {:ok, %{"current" => current}} when is_boolean(current) <- Jason.decode(body) do
      {:ok, current}
    else
      {:forwarded, 404, _body} -> {:ok, true}
      error -> {:error, {:validation_unavailable, error}}
    end
  end

  defp matches_signal?(entry, params) do
    fiber = entry.fiber
    archived = fiber["status"] == "closed" and is_boolean(fiber["tempered"])

    not archived and
      Enum.any?(signals(fiber), fn {verb, stamp, _, _} ->
        case params["signal"] do
          %{"uid" => uid, "verb" => ^verb, "stamp" => ^stamp} ->
            uid == (fiber["uid"] || fiber["id"])

          nil ->
            params["message_id"] ==
              "thread-" <>
                digest({entry.felt_store, fiber["uid"] || fiber["id"], verb, stamp})

          _ ->
            false
        end
      end)
  end

  defp after_baseline?(stamp, baseline) do
    case DateTime.from_iso8601(stamp) do
      {:ok, time, _} -> DateTime.compare(time, baseline) == :gt
      _ -> false
    end
  end

  defp signals(fiber) do
    status = fiber["status"]

    ask =
      case get_in(fiber, ["shuttle", "ask"]) do
        %{"text" => text, "at" => at}
        when is_binary(text) and is_binary(at) and status != "closed" ->
          [{"asked", at, text, true}]

        _ ->
          []
      end

    runtime = get_in(fiber, ["shuttle", "runtime"]) || %{}
    handed = runtime["handed_off_at"]
    exit_verb = runtime["thread_exit_verb"]
    handoff_current? = is_binary(handed) and exit_verb in [nil, "handed off"]

    exit =
      cond do
        fiber["status"] == "closed" && fiber["closed_at"] ->
          [
            {"closed", fiber["closed_at"], fiber["outcome"] || "",
             runtime["quiet_closed_at"] != fiber["closed_at"]}
          ]

        fiber["status"] == "open" && fiber["horizon"] == "stashed" && handed ->
          [{"rested", handed, fiber["outcome"] || "", false}]

        fiber["status"] == "active" && handoff_current? ->
          [{"handed off", handed, fiber["outcome"] || "", false}]

        true ->
          []
      end

    # The publication the orchestrator's own session made (`shuttle rest`,
    # `close` or `ask` on its thread) is not delivered back to it.
    Enum.reject(ask ++ exit, fn {_verb, stamp, _text, _wake} ->
      stamp == runtime["orchestrator_acted_at"]
    end)
  end

  defp digest(term),
    do: :crypto.hash(:sha256, :erlang.term_to_binary(term)) |> Base.encode16(case: :lower)
end
