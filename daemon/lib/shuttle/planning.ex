defmodule Shuttle.Planning do
  @moduledoc "Planning belongs to synchronized documents; execution belongs to its host."

  alias Shuttle.{FeltStores, FiberDoc, Poller}

  def quiescent?(%{"status" => "active"}), do: false

  def quiescent?(fiber) do
    runtime = get_in(fiber, ["shuttle", "runtime"]) || %{}

    case runtime do
      %{"dispatched_at" => start, "handed_off_at" => finish}
      when is_binary(start) and is_binary(finish) ->
        with {:ok, start, _} <- DateTime.from_iso8601(start),
             {:ok, finish, _} <- DateTime.from_iso8601(finish) do
          DateTime.compare(finish, start) == :gt
        else
          _ -> false
        end

      %{"dispatched_at" => _} ->
        false

      %{"session_uuid" => session} when session not in [nil, ""] ->
        false

      runtime when is_map(runtime) ->
        true

      _ ->
        false
    end
  end

  def action?(%{"action" => "reopen", "as_draft" => true}), do: true

  def action?(%{"action" => action}),
    do: action in ~w(pause rest close set-agent set-model set-outcome role seat reshape)

  def action?(_), do: false

  def patch?(params) do
    not Map.has_key?(params, "name") && not Map.has_key?(params, "body") &&
      is_map(Map.get(params, "set", %{})) && is_list(Map.get(params, "unset", [])) &&
      Enum.all?(
        Map.keys(Map.get(params, "set", %{})) ++ Map.get(params, "unset", []),
        &(&1 in ~w(horizon cold))
      )
  end

  # An unaddressed request still belongs to its document's execution owner.
  def origin(identifier, supplied, hint \\ nil) do
    if supplied in [nil, "", "local", Poller.own_host_id()] do
      with {:ok, %{path: path}} <- FeltStores.resolve_request(identifier, hint),
           {:ok, _, _, fiber, _} <- FiberDoc.read_path(path),
           host when is_binary(host) and host != "" <- get_in(fiber, ["shuttle", "host"]) do
        host
      else
        _ -> supplied
      end
    else
      supplied
    end
  end

  # Called only after a definite pre-send failure or an unknown owner.
  # The CLI rechecks under the document lock; the feed must be stale or absent.
  def local?(identifier, origin, hint \\ nil, action \\ %{}),
    do: !is_nil(local_copy(identifier, origin, hint, action))

  def local_copy(identifier, origin, hint \\ nil, action \\ %{}) do
    with {:ok, %{path: path} = resolved} <- FeltStores.resolve_request(identifier, hint),
         {:ok, _, raw, fiber, body} <- FiberDoc.read_path(path),
         true <- is_nil(resolved.uid) || fiber["id"] == resolved.uid,
         true <- is_map(fiber["shuttle"]),
         host = get_in(fiber, ["shuttle", "host"]),
         true <- origin in [nil, "", "local", host, Poller.own_host_id()] do
      offline =
        case Shuttle.RemoteFiberRegistry.feeds()[host] do
          %{stale: false} -> false
          _ -> true
        end

      removed =
        host in [nil, ""] ||
          match?({:error, {:unknown_origin, _}}, Shuttle.OriginRouter.route(host))

      retiring = removed && action["action"] in ~w(close rest)

      rearming =
        action["action"] == "close" && action["tempered"] == true &&
          get_in(fiber, ["shuttle", "kind"]) == "standing"

      if offline && !rearming && (quiescent?(fiber) || retiring) do
        revision =
          :crypto.hash(:sha256, "---\n" <> raw <> "\n---" <> body) |> Base.encode16(case: :lower)

        %{resolved: resolved, revision: revision}
      end
    else
      _ -> nil
    end
  end

  # Keep owner addresses and execution observations, including unknown liveness.
  # Only a strictly newer archive document may replace stale planning fields.
  def reconcile(owners, archives, stale, local) do
    unique_archives =
      archives
      |> Enum.group_by(&identity/1)
      |> Enum.flat_map(fn
        {key, [row]} -> [{key, row}]
        _ -> []
      end)
      |> Map.new()

    owners =
      Enum.map(owners, fn row ->
        origin = row["origin"]
        candidate = if uid(row), do: unique_archives[uid(row)]

        archive =
          if candidate &&
               get_in(candidate, ["fiber", "shuttle", "host"]) ==
                 get_in(row, ["fiber", "shuttle", "host"]),
             do: candidate

        available =
          if origin == local,
            do: quiescent?(row["fiber"]),
            else: archive != nil && quiescent?(archive["fiber"])

        projected =
          if archive && stale[origin] && newer?(archive["fiber"], row["fiber"]),
            do: project(row, archive),
            else: row

        Map.put(
          projected,
          "local_planning",
          available && quiescent?(row["fiber"]) && is_nil(row["runtime"])
        )
      end)

    seen = MapSet.new(owners, &identity/1)

    missing =
      Enum.filter(archives, fn row ->
        fiber = row["fiber"]
        is_map(fiber["shuttle"]) && !MapSet.member?(seen, identity(row))
      end)

    owners ++
      Enum.map(missing, fn row ->
        host = get_in(row, ["fiber", "shuttle", "host"])

        row
        |> Map.put("origin", if(host in [nil, ""], do: local, else: host))
        |> Map.put(
          "local_planning",
          Map.has_key?(unique_archives, identity(row)) && quiescent?(row["fiber"])
        )
      end)
  end

  @planning_fields ~w(status tempered closed_at closed-at horizon cold due tags outcome role seat updated_at)
  @planning_shuttle ~w(kind project_dir agent effort chrome schedule pulse role seat blocked_on)

  defp project(owner, archive) do
    original = owner["fiber"]

    planned =
      Map.merge(
        Map.drop(original, @planning_fields),
        Map.take(archive["fiber"], @planning_fields)
      )

    # An armed or possibly live owner wins over an offline status edit.
    planned =
      if quiescent?(original) && is_nil(owner["runtime"]),
        do: planned,
        else:
          Map.merge(
            Map.drop(planned, ~w(status tempered closed_at closed-at)),
            Map.take(original, ~w(status tempered closed_at closed-at))
          )

    shuttle =
      Map.merge(
        Map.drop(original["shuttle"] || %{}, @planning_shuttle),
        Map.take(archive["fiber"]["shuttle"] || %{}, @planning_shuttle)
      )

    fiber =
      planned
      |> Map.put("shuttle", shuttle)
      |> Map.merge(Map.take(original, ["id", "uid", "slug", "path"]))

    Map.put(owner, "fiber", fiber)
  end

  defp uid(row) do
    value = get_in(row, ["fiber", "uid"]) || get_in(row, ["fiber", "id"])
    if Shuttle.ULID.valid?(value), do: value
  end

  defp identity(row),
    do: uid(row) || {get_in(row, ["fiber", "shuttle", "host"]), get_in(row, ["fiber", "id"])}

  defp newer?(a, b) do
    with {:ok, a, _} <- DateTime.from_iso8601(a["updated_at"] || a["updated-at"] || ""),
         {:ok, b, _} <-
           DateTime.from_iso8601(b["updated_at"] || b["updated-at"] || b["modified_at"] || "") do
      DateTime.compare(a, b) == :gt
    else
      _ -> false
    end
  end
end
