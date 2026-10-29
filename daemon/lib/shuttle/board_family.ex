defmodule Shuttle.BoardFamily do
  @moduledoc "Resolve board records against the current constitution tree."

  alias Shuttle.{EventStream, Messaging, SessionBinding, Threads}

  @doc "Build a session index from cached worker identities and receiver succession."
  def session_index(entries, own_host, bindings \\ EventStream.session_bindings()) do
    runtime =
      Enum.reduce(entries, %{}, fn entry, acc ->
        fiber = entry.fiber
        host = get_in(fiber, ["shuttle", "host"])
        session = get_in(fiber, ["shuttle", "runtime", "session_uuid"])
        uid = fiber["uid"] || Threads.address(fiber)
        harness = normalize_harness(get_in(fiber, ["shuttle", "resolved", "agent", "cli"]))

        if is_binary(host) and is_binary(session) and session != "" and is_binary(harness) do
          current =
            if host == own_host, do: SessionBinding.current(bindings, session), else: session

          acc |> Map.put({host, harness, session}, uid) |> Map.put({host, harness, current}, uid)
        else
          acc
        end
      end)

    local = Messaging.cached_session_fiber_index(own_host).fibers_by_session

    refs = index(entries)

    Enum.reduce(local, runtime, fn {session, pairing}, acc ->
      uid = pairing["fiber_uid"] || pairing["fiber"]
      entry = find(refs, uid)

      harness =
        normalize_harness(
          pairing["harness"] ||
            if(entry, do: get_in(entry.fiber, ["shuttle", "resolved", "agent", "cli"]))
        )

      current = SessionBinding.current(bindings, session)

      if harness do
        acc
        |> Map.put({own_host, harness, session}, uid)
        |> Map.put({own_host, harness, current}, uid)
      else
        acc
      end
    end)
  end

  @doc "Resolve the viewer before reading board records."
  def prepare(entries, sessions, own_host, params) do
    by_ref = index(entries)
    all? = params["all"] == "true"

    named =
      if params["fiber"] not in [nil, ""],
        do: params["fiber"],
        else: resolve_session(params["session"], own_host, sessions)

    viewer = find(by_ref, named)

    if not all? and is_nil(viewer) do
      nil
    else
      tree = Map.new(entries, &{key(&1), &1})
      roots = Enum.reduce(entries, %{}, fn entry, acc -> elem(root(entry, tree, acc), 1) end)
      root = if viewer, do: Map.fetch!(roots, key(viewer))

      %{
        by_ref: by_ref,
        tree: tree,
        roots: roots,
        root: root,
        viewer: viewer,
        requested_viewer: find(by_ref, params["viewer"]) || viewer,
        all?: all?,
        sessions: sessions,
        host: own_host
      }
    end
  end

  @doc "Compose a family view from cached entries, records and session bindings."
  def compose(entries, records, sessions, own_host, params) do
    case prepare(entries, sessions, own_host, params) do
      nil -> %{family: nil, viewer: nil, records: []}
      context -> compose_prepared(context, records)
    end
  end

  @doc "Compose records against a prepared family and its memoized ancestry."
  def compose_prepared(context, records) do
    %{
      by_ref: by_ref,
      tree: tree,
      roots: roots,
      root: root,
      viewer: viewer,
      requested_viewer: requested_viewer,
      all?: all?,
      sessions: sessions,
      host: own_host
    } = context

    rows =
      records
      |> Enum.reduce(%{}, fn record, acc ->
        case record do
          %{"id" => id, "timestamp" => ts} when is_binary(id) and is_integer(ts) ->
            Map.put_new(acc, id, record)

          _ ->
            acc
        end
      end)
      |> Map.values()
      |> Enum.map(&resolve_record(&1, own_host, sessions))
      |> Enum.filter(fn record ->
        all? or
          Enum.any?(
            [record["fiber"], get_in(record, ["by", "fiber"]), get_in(record, ["to", "fiber"])],
            fn ref ->
              case find(by_ref, ref) do
                nil -> false
                entry -> same?(Map.fetch!(roots, key(entry)), root)
              end
            end
          )
      end)
      |> Enum.map(&decorate(&1, by_ref, tree, roots, requested_viewer))
      |> Enum.sort_by(&{&1["timestamp"], &1["id"]})

    %{family: family(root), viewer: if(viewer, do: viewer.fiber["uid"]), records: rows}
  end

  defp index(entries) do
    Enum.reduce(entries, %{}, fn entry, acc ->
      fiber = entry.fiber
      refs = [fiber["uid"], fiber["id"], fiber["slug"], Threads.address(fiber)]

      Enum.reduce(refs, acc, fn ref, m ->
        if is_binary(ref) and ref != "", do: Map.put(m, ref, entry), else: m
      end)
    end)
  end

  defp find(index, ref), do: Map.get(index, ref)

  defp same?(a, b),
    do: a.felt_store == b.felt_store and Threads.address(a.fiber) == Threads.address(b.fiber)

  defp key(entry), do: {entry.felt_store, Threads.address(entry.fiber)}

  defp root(entry, tree, roots) do
    case Map.fetch(roots, key(entry)) do
      {:ok, root} ->
        {root, roots}

      :error ->
        {root, roots} =
          case Threads.orchestrator(entry, tree) do
            nil -> {entry, roots}
            parent -> root(parent, tree, roots)
          end

        {root, Map.put(roots, key(entry), root)}
    end
  end

  defp family(nil), do: nil

  defp family(entry) do
    fiber = entry.fiber
    id = Threads.address(fiber)
    %{root_uid: fiber["uid"], root_id: id, name: fiber["name"], label: Path.basename(id)}
  end

  defp resolve_record(record, own_host, sessions) do
    record =
      Enum.reduce(["by", "to"], record, fn key, acc ->
        case acc[key] do
          %{} = party -> Map.put(acc, key, resolve_party(party, own_host, sessions))
          nil -> acc
          _ -> Map.delete(acc, key)
        end
      end)

    if record["fiber"] in [nil, ""] do
      fiber =
        nonempty(get_in(record, ["to", "fiber"])) || nonempty(get_in(record, ["by", "fiber"]))

      if fiber in [nil, ""], do: record, else: Map.put(record, "fiber", fiber)
    else
      record
    end
  end

  defp resolve_party(party, own_host, sessions) do
    if party["fiber"] in [nil, ""] do
      case resolve_session(party["session"], own_host, sessions) do
        nil -> party
        uid -> Map.put(party, "fiber", uid)
      end
    else
      party
    end
  end

  defp resolve_session("shuttle://" <> _ = address, _host, sessions) do
    case URI.parse(address) do
      %URI{host: host, path: path} when is_binary(host) and is_binary(path) ->
        case String.split(String.trim_leading(path, "/"), "/", parts: 2) do
          [harness, native] when harness != "" and native != "" ->
            Map.get(sessions, {host, normalize_harness(harness), URI.decode(native)})

          _ ->
            nil
        end

      _ ->
        nil
    end
  end

  defp resolve_session(session, host, sessions) when is_binary(session) do
    case String.split(session, ":", parts: 2) do
      [harness, native] when harness != "" and native != "" ->
        Map.get(sessions, {host, normalize_harness(harness), native})

      _ ->
        nil
    end
  end

  defp resolve_session(_, _, _), do: nil

  defp normalize_harness("claude-code"), do: "claude"
  defp normalize_harness(value) when value in ["claude", "codex", "pi"], do: value
  defp normalize_harness(_), do: nil

  defp member(index, roots, ref) do
    case find(index, ref) do
      nil ->
        nil

      entry ->
        root = Map.fetch!(roots, key(entry))
        parent = Path.dirname(Threads.address(root.fiber))
        id = Threads.address(entry.fiber)
        if parent == ".", do: id, else: String.replace_prefix(id, parent <> "/", "")
    end
  end

  defp decorate(record, index, tree, roots, viewer) do
    by = record["by"] || %{}
    to = record["to"] || %{}
    subject = find(index, record["fiber"])
    viewer_uid = if viewer, do: viewer.fiber["uid"]
    by_entry = find(index, by["fiber"])
    to_entry = find(index, to["fiber"])

    actor =
      nonempty(by["label"]) || member(index, roots, by["fiber"]) || short_session(by["session"]) ||
        "someone"

    parent = if subject, do: Threads.orchestrator(subject, tree)

    subject_viewer = viewer_uid != nil and subject != nil and subject.fiber["uid"] == viewer_uid
    actor_viewer = viewer_uid != nil and by_entry != nil and by_entry.fiber["uid"] == viewer_uid

    recipient_viewer =
      viewer_uid != nil and to_entry != nil and to_entry.fiber["uid"] == viewer_uid

    silent_clear = record["kind"] == "cleared" and subject_viewer and not actor_viewer

    delivered =
      not silent_clear and viewer_uid != nil and
        (subject_viewer or actor_viewer or recipient_viewer or
           (record["kind"] in ~w(asked closed handed_off rested unblocked) and parent != nil and
              parent.fiber["uid"] == viewer_uid))

    record
    |> Map.put("member", member(index, roots, record["fiber"]))
    |> Map.put("to_member", member(index, roots, to["fiber"]))
    |> Map.put("actor", actor)
    |> Map.put("delivered", delivered)
  end

  defp nonempty(value) when is_binary(value) and value != "", do: value
  defp nonempty(_), do: nil

  defp short_session(value) when is_binary(value) and value != "" do
    case URI.parse(value) do
      %URI{scheme: "shuttle", path: path} when is_binary(path) -> String.trim_leading(path, "/")
      _ -> value
    end
  end

  defp short_session(_), do: nil
end
