defmodule Shuttle.Poller.Discovery do
  @moduledoc """
  Candidate discovery for the poll: each configured store's Shuttle listing,
  full or limited to its hot ids, kept to the fibers physically rooted in that
  store, with each store's scan cadence carried as plain data.

  Everything here runs in the poll task or at boot and returns values; the
  Poller installs them. `run_shuttle/4` is the store-scoped Shuttle runner the
  Poller's document reads share.
  """

  require Logger

  # Discovers candidate fibers by asking Shuttle for a narrow fiber projection
  # per configured store and keeping the ones physically rooted in that store.
  # No tag predicate — the shuttle: block is the source of truth, matching the
  # same contract every other surface reads.
  #
  # Returns {fibers, store_map, store_listings, full_listings, discovery} where:
  #   fibers        — [%{"id" => id, "uid" => uid, "status" => status, "path" => …}] across all stores
  #   store_map     — %{fiber_id => felt_store} for store resolution
  #   store_listings — %{store => rows} for stores successfully listed this poll.
  #                   Hot listings are merged with retained rows; full listings
  #                   replace them. A failed store is absent.
  #   full_listings — %{store => rows} only for successful full scans; this is
  #                   the fixed source for future hot-set ids.
  #   discovery     — updated per-store mode and full-scan cadence, returned as
  #                   plain data for `apply_poll_cycle/2` to install.
  #
  # Each fiber row carries its own "uid", so callers that need the intrinsic
  # identity read it off the candidate directly — no separate uid map.
  #
  # ## Symlink discipline
  #
  # The same physical fiber file is often reachable from multiple felt stores via
  # symlinks. Two cases that occur in practice:
  #
  # 1. A project store (`~/work/project-a`) whose `.felt/` is a symlink into
  #    `~/loom/.felt/work/project-a/`. The same `task-board.md` is reachable as
  #    `task-board` (project view) and `work/project-a/task-board` (loom view).
  #
  # 2. A project-canonical felt store (lightcone) whose own `.felt/` is a real
  #    directory, with loom symlinking *into* it at
  #    `~/loom/.felt/ai-futures/lightcone -> ~/lightcone/.felt`. The same fiber
  #    is reachable as `lightcone-ui/...` (lightcone view) and
  #    `ai-futures/lightcone/lightcone-ui/...` (loom view).
  #
  # If both views were enumerated, dispatch would race: each "different" id
  # passes `tmux has-session` independently → multiple workers on one file.
  #
  # **Rule: a fiber is enumerated only by the store where it is physically
  # rooted.** `list/5` enforces this by reading felt's carried
  # `path` (absolute, symlink-resolved) and keeping a fiber iff that path lives
  # under `realpath(store)/.felt/` — so case 2's loom view drops the fiber (its
  # realpath roots in lightcone) and the lightcone store claims it. A store
  # whose own `.felt/` is a symlink (case 1) owns nothing; the target store
  # enumerates it. Ownership is read from felt's path, never reverse-derived.
  @doc "One poll's discovery over every configured store, as described above."
  def discover(state, discovery_plan) do
    {all_fibers, store_map, store_listings, full_listings, discovery} =
      Enum.reduce(state.felt_stores, {[], %{}, %{}, %{}, %{}}, fn store,
                                                                  {all, stores, listings, fulls,
                                                                   modes} ->
        previous = Map.get(state.discovery, store, %{})
        now = System.system_time(:millisecond)
        scan = Map.fetch!(discovery_plan, store)
        full? = scan != :hot
        started = System.monotonic_time(:millisecond)
        hot_ids = hot_ids_for_store(store, previous, state)

        result =
          case scan do
            :full -> list(store, state, nil, nil)
            :full_slow -> list(store, state, nil, state.full_scan_timeout_ms, true)
            :hot -> list(store, state, hot_ids, nil)
          end

        duration = System.monotonic_time(:millisecond) - started
        retained = Map.get(state.last_known_listings, store, [])

        {rows, next_listings, next_fulls, info} =
          case result do
            {:ok, %{rows: listed, foreign_ids: foreign_ids}} ->
              merged = if full?, do: listed, else: merge_hot_rows(retained, listed, foreign_ids)

              next_info =
                if full? do
                  due = full_scan_due_at(now, duration, state)

                  %{
                    mode: if(is_nil(due), do: :full, else: :hot),
                    last_full_duration_ms: duration,
                    last_full_completed_at: now + duration,
                    next_full_due_at: due,
                    last_full_timed_out: false
                  }
                else
                  previous
                  |> Map.delete(:boot_seeded)
                  |> Map.put(
                    :mode,
                    if(Map.get(previous, :boot_seeded, false),
                      do: Map.get(previous, :mode, :full),
                      else: :hot
                    )
                  )
                end

              next_info =
                if not full? and missing_hot_rows?(retained, listed, foreign_ids) do
                  Map.put(next_info, :next_full_due_at, now)
                else
                  next_info
                end

              next_fulls = if full?, do: Map.put(fulls, store, listed), else: fulls
              {merged, Map.put(listings, store, merged), next_fulls, next_info}

            {:error, reason} ->
              Logger.warning(
                "fiber discovery failed for #{store} (#{inspect(reason)}); " <>
                  "carrying #{length(retained)} last-known fiber(s) for this tick"
              )

              next_info =
                if full? and reason == :timeout do
                  %{
                    mode: :hot,
                    last_full_duration_ms: duration,
                    last_full_completed_at: Map.get(previous, :last_full_completed_at),
                    next_full_due_at:
                      if(is_nil(Map.get(previous, :last_full_completed_at)),
                        do: now,
                        else: now + max(state.full_scan_min_interval_ms, 5 * max(duration, 1))
                      ),
                    last_full_timed_out: true
                  }
                else
                  Map.delete(previous, :boot_seeded)
                end

              {retained, listings, fulls, next_info}
          end

        baseline = Map.get(next_fulls, store, Map.get(state.last_full_listings, store, []))
        info = Map.put(info, :hot_size, length(baseline))
        stores = Map.merge(Map.new(rows, &{&1["id"], store}), stores)
        {all ++ rows, stores, next_listings, next_fulls, Map.put(modes, store, info)}
      end)

    {all_fibers, store_map, store_listings, full_listings, discovery}
  end

  @doc "Seed each unlisted store from one full listing before the first poll."
  def boot_seed(state) do
    Enum.reduce(state.felt_stores, state, fn store, acc ->
      if Map.has_key?(acc.last_full_listings, store) do
        acc
      else
        now = System.system_time(:millisecond)
        started = System.monotonic_time(:millisecond)
        result = list(store, acc, nil, nil)
        duration = System.monotonic_time(:millisecond) - started

        case result do
          {:ok, %{rows: rows}} ->
            due = full_scan_due_at(now, duration, acc)

            info = %{
              mode: if(is_nil(due), do: :full, else: :hot),
              last_full_duration_ms: duration,
              last_full_completed_at: now + duration,
              next_full_due_at: due,
              last_full_timed_out: false,
              hot_size: length(rows),
              boot_seeded: true
            }

            %{
              acc
              | last_known_listings: Map.put(acc.last_known_listings, store, rows),
                last_full_listings: Map.put(acc.last_full_listings, store, rows),
                fiber_store_cache:
                  Map.merge(Map.new(rows, &{&1["id"], store}), acc.fiber_store_cache),
                discovery: Map.put(acc.discovery, store, info)
            }

          {:error, :timeout} ->
            info = %{
              mode: :hot,
              last_full_duration_ms: duration,
              last_full_completed_at: nil,
              next_full_due_at: now,
              last_full_timed_out: true,
              hot_size: length(Map.get(acc.last_known_listings, store, []))
            }

            %{acc | discovery: Map.put(acc.discovery, store, info)}

          {:error, _reason} ->
            acc
        end
      end
    end)
  end

  @doc "Log each store whose discovery mode changed."
  def log_mode_changes(previous, current) do
    Enum.each(current, fn {store, info} ->
      old_mode = get_in(previous, [store, :mode]) || :full
      new_mode = Map.get(info, :mode, :full)

      if old_mode != new_mode do
        Logger.info("fiber discovery mode for #{store}: #{new_mode}")
      end
    end)
  end

  @doc "Each store's scan for this poll: `:full`, `:full_slow` or `:hot`."
  def plan(state, stores, now_ms) do
    Map.new(stores, fn store ->
      previous = Map.get(state.discovery, store, %{})

      mode =
        if full_scan_due?(previous, state, now_ms) do
          if slow_full_scan?(previous, state), do: :full_slow, else: :full
        else
          :hot
        end

      {store, mode}
    end)
  end

  defp slow_full_scan?(previous, state) do
    Map.get(previous, :mode) == :hot or
      Map.get(previous, :last_full_timed_out, false) or
      full_scan_slow?(Map.get(previous, :last_full_duration_ms, 0), state)
  end

  defp full_scan_due?(previous, state, now) do
    due = Map.get(previous, :next_full_due_at)

    cond do
      Map.get(previous, :boot_seeded, false) -> false
      is_nil(Map.get(previous, :last_full_duration_ms)) -> true
      Map.get(previous, :last_full_timed_out, false) -> is_nil(due) or now >= due
      not full_scan_slow?(Map.get(previous, :last_full_duration_ms), state) -> true
      true -> is_nil(due) or now >= due
    end
  end

  defp full_scan_slow?(duration, state),
    do: state.full_scan_budget_ms == 0 or duration > state.full_scan_budget_ms

  defp full_scan_due_at(now, duration, state) do
    delay =
      cond do
        state.full_scan_budget_ms == 0 -> state.full_scan_min_interval_ms
        duration > state.full_scan_budget_ms -> max(state.full_scan_min_interval_ms, 5 * duration)
        true -> nil
      end

    if delay, do: now + delay
  end

  defp hot_ids_for_store(store, _previous, state) do
    announced = state.announced_ids |> Map.get(store, %{}) |> Map.keys()

    state.last_full_listings
    |> Map.get(store, [])
    |> Enum.map(&Map.get(&1, "id"))
    |> Enum.concat(announced)
    |> Enum.filter(&is_binary/1)
    |> Enum.uniq()
  end

  # A full listing that began at or after an announcement saw the document on
  # disk, so its baseline now carries the id (or its absence is real).
  @doc false
  def retire_announced_ids(announced, full_listings, discovery) do
    announced
    |> Map.new(fn {store, ids} ->
      case {Map.has_key?(full_listings, store), Map.get(discovery, store, %{})} do
        {true, %{last_full_completed_at: done, last_full_duration_ms: duration}}
        when is_integer(done) and is_integer(duration) ->
          started = done - duration
          {store, Map.filter(ids, fn {_id, at} -> at > started end)}

        {true, _info} ->
          {store, %{}}

        {false, _info} ->
          {store, ids}
      end
    end)
    |> Map.reject(fn {_store, ids} -> ids == %{} end)
  end

  defp missing_hot_rows?(previous, listed, foreign_ids) do
    seen = MapSet.new(Enum.map(listed, & &1["id"]) ++ foreign_ids)
    Enum.any?(previous, &(not MapSet.member?(seen, &1["id"])))
  end

  defp merge_hot_rows(previous, listed, foreign_ids) do
    returned_ids = MapSet.new(listed, &Map.get(&1, "id"))

    returned_uids =
      listed |> Enum.map(&Map.get(&1, "uid")) |> Enum.reject(&is_nil/1) |> MapSet.new()

    foreign_ids = MapSet.new(foreign_ids)

    retained =
      Enum.reject(previous, fn row ->
        MapSet.member?(returned_ids, Map.get(row, "id")) or
          MapSet.member?(foreign_ids, Map.get(row, "id")) or
          (not is_nil(Map.get(row, "uid")) and
             MapSet.member?(returned_uids, Map.get(row, "uid")))
      end)

    Map.new(retained ++ listed, &{Map.get(&1, "id"), &1}) |> Map.values()
  end

  # Read one store's shuttle fibers via Shuttle's JSON, keeping only those
  # PHYSICALLY ROOTED in this store. Ownership is read from felt's carried
  # `path` (absolute, symlink-resolved) — a fiber belongs to `store` iff its
  # path lives under `realpath(store)/.felt/`. felt enumerates symlink-traversed
  # fibers too (loom listing a project whose `.felt` is symlinked in), so the
  # path-prefix check is what keeps each fiber owned by exactly the store that
  # physically roots it, read from the CLI response, never reverse-derived. A store
  # whose own `.felt/` is a symlink owns nothing here: the target store
  # enumerates it canonically.
  defp list(store, state, ids_from, timeout_ms, slow_scan? \\ false) do
    felt_dir = Path.join(store, ".felt")

    if Shuttle.FS.protected?(felt_dir) or
         Shuttle.FS.protected?(Shuttle.FeltStores.store_felt_realpath(store)) do
      {:ok, %{rows: [], foreign_ids: []}}
    else
      list_unprotected_shuttle_fibers(store, felt_dir, state, ids_from, timeout_ms, slow_scan?)
    end
  end

  @doc "The listing of `ids` alone in `store`."
  def list_changed(_store, _state, []), do: {:ok, %{rows: []}}
  def list_changed(store, state, ids), do: list(store, state, ids, nil)

  defp list_unprotected_shuttle_fibers(store, felt_dir, state, ids_from, timeout_ms, slow_scan?) do
    case Shuttle.FS.lstat(felt_dir) do
      {:ok, %File.Stat{type: :symlink}} ->
        {:ok, %{rows: [], foreign_ids: []}}

      {:ok, %File.Stat{type: :directory}} ->
        # An empty store has nothing to enumerate; skip the Shuttle shell-out so a
        # store with no fibers costs nothing (and so a daemon polling an empty
        # configured store doesn't shell Shuttle every tick).
        if empty_dir?(felt_dir) do
          {:ok, %{rows: [], foreign_ids: []}}
        else
          run_shuttle_listing(store, state, ids_from, timeout_ms, slow_scan?)
        end

      _ ->
        {:ok, %{rows: [], foreign_ids: []}}
    end
  end

  defp empty_dir?(dir) do
    case Shuttle.FS.ls(dir) do
      {:ok, entries} -> entries == []
      _ -> true
    end
  end

  defp run_shuttle_listing(store, state, ids_from, timeout_ms, slow_scan?) do
    case run_shuttle_ls_for_shuttle(store, state, ids_from, timeout_ms, slow_scan?) do
      {:ok, output} ->
        with {:ok, fibers} when is_list(fibers) <- Shuttle.FiberDocuments.decode(output) do
          owned_prefix = Shuttle.FeltStores.store_felt_realpath(store) <> "/"

          rows = Enum.filter(fibers, &is_map/1)
          kept = Enum.filter(rows, &owned_by_store?(&1, owned_prefix))

          foreign_ids =
            rows
            |> Enum.filter(fn row ->
              is_binary(Map.get(row, "path")) and not owned_by_store?(row, owned_prefix)
            end)
            |> Enum.map(&Map.get(&1, "id"))
            |> Enum.filter(&is_binary/1)

          {:ok, %{rows: kept, foreign_ids: foreign_ids}}
        else
          _ -> {:error, :invalid_json}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  # A fiber is owned by this store iff the carried physical `path` lives under
  # `realpath(store)/.felt/`. Without a path, ownership cannot be confirmed, so
  # the fiber is conservatively dropped.
  defp owned_by_store?(%{"path" => path}, owned_prefix) when is_binary(path) and path != "" do
    String.starts_with?(path, owned_prefix)
  end

  defp owned_by_store?(_, _), do: false

  defp run_shuttle_ls_for_shuttle(store, state, ids_from, timeout_ms, slow_scan?) do
    # Widened projection: shuttle filters by raw top-level frontmatter first,
    # then emits the FULL kanban field set (`FiberDocuments.kanban_fields/0` — a
    # superset of the fields the poller needs for eligibility, ownership, and
    # identity). Widening it lets the document cache build each entry DIRECTLY
    # from its candidate row (no per-miss `show`, no stat), so a poll tick costs
    # one `shuttle ls` per store. A failure degrades `discover/2` to
    # the store's last-known rows; the boot contract probe checks CLI parity.
    # Status scope is explicit: awaiting standing runs must remain visible for
    # conditional scheduled re-arming. Eligibility still requires active.
    args = [
      "ls",
      "--status",
      "all",
      "--json",
      "--any",
      "field:shuttle",
      "--any",
      "field:due",
      "--any",
      "tag:cycle",
      "--json-field",
      Enum.join(Shuttle.FiberDocuments.kanban_fields(), ",")
    ]

    with_ids_file(ids_from, fn ids_path ->
      args = if ids_path, do: args ++ ["--ids-from", ids_path], else: args
      opts = if timeout_ms, do: [timeout_ms: timeout_ms], else: []
      opts = if slow_scan?, do: Keyword.put(opts, :env, [{"FELT_READ_WORKERS", "8"}]), else: opts
      run_shuttle(store, state.runner, args, opts)
    end)
  end

  # Run Shuttle against an explicit store through its root `-C` flag. JSON
  # consumers keep stderr separate because a successful listing can warn about
  # an unreadable fiber.
  @doc false
  def run_shuttle(store, runner, args, opts \\ [])

  def run_shuttle(nil, _runner, _args, _opts), do: {:error, :no_felt_store}

  def run_shuttle(store, runner, args, opts) when is_binary(store) do
    command = "shuttle #{Enum.join(args, " ")} (-C #{store})"

    case Shuttle.CLI.run_in_store(
           store,
           args,
           Keyword.merge([runner: runner, stderr_to_stdout: false], opts)
         ) do
      {:ok, output} ->
        {:ok, output}

      {:command_error, :timeout, _output} ->
        # A timeout says nothing about the store's fibers: callers treat the
        # result as "world unknown", never as "fiber gone".
        {:error, :timeout}

      {:command_error, status, output} ->
        trimmed = String.trim(to_string(output))
        detail = if trimmed == "", do: "(no output)", else: trimmed
        {:error, "#{command} exited #{status}: #{detail}"}

      {:error, reason} ->
        {:error, "could not run #{command}: #{reason}"}
    end
  end

  defp with_ids_file(nil, fun), do: fun.(nil)

  defp with_ids_file(ids, fun) do
    dir =
      Path.join(
        System.tmp_dir!(),
        "shuttle-ids-#{Base.encode16(:crypto.strong_rand_bytes(16), case: :lower)}"
      )

    case Shuttle.FS.mkdir(dir) do
      :ok ->
        try do
          :ok = Shuttle.FS.chmod(dir, 0o700)
          path = Path.join(dir, "ids")

          case Shuttle.FS.write(path, Enum.join(ids, "\n") <> if(ids == [], do: "", else: "\n"), [
                 :exclusive
               ]) do
            :ok -> fun.(path)
            {:error, reason} -> {:error, {:ids_file, reason}}
          end
        after
          Shuttle.FS.rm_rf(dir)
        end

      {:error, reason} ->
        {:error, {:ids_directory, reason}}
    end
  end

  @doc "Remove ids directories an earlier daemon left behind for over an hour."
  def sweep_stale_ids_dirs do
    tmp_dir = System.tmp_dir!()
    cutoff = :calendar.system_time_to_universal_time(System.os_time(:second) - 3_600, :second)

    case Shuttle.FS.ls(tmp_dir) do
      {:ok, names} ->
        Enum.each(names, fn name ->
          if String.starts_with?(name, "shuttle-ids-") do
            path = Path.join(tmp_dir, name)

            case Shuttle.FS.lstat(path) do
              {:ok, %File.Stat{type: :directory, mtime: mtime}} when mtime < cutoff ->
                Shuttle.FS.rm_rf(path)

              _ ->
                :ok
            end
          end
        end)

      {:error, _} ->
        :ok
    end
  end
end
