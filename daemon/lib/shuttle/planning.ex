defmodule Shuttle.Planning do
  @moduledoc "Owner-away exits on synchronized copies; configuration and execution stay with the owner."
  alias Shuttle.{FeltStores, FiberDoc, OriginRouter, Poller, RemoteFiberRegistry, Remotes}
  @exit_fields ~w(status tempered closed_at closed-at horizon)

  def quiescent?(%{"status" => "active"}), do: false
  def quiescent?(%{"shuttle" => block}) when not is_map(block), do: false

  def quiescent?(fiber) do
    case get_in(fiber, ["shuttle", "runtime"]) || %{} do
      %{"dispatched_at" => start, "handed_off_at" => finish} -> after?(finish, start)
      %{"dispatched_at" => _} -> false
      %{"session_uuid" => session} when session not in [nil, ""] -> false
      %{} -> true
      _ -> false
    end
  end

  def action?(%{"action" => "close", "tempered" => true}), do: false
  def action?(%{"action" => action}), do: action in ~w(rest close pause)
  def action?(_), do: false

  def origin(identifier, supplied, hint \\ nil) do
    if supplied in [nil, "", "local", Poller.own_host_id()] do
      with {:ok, %{path: path}} <- FeltStores.resolve_request(identifier, hint),
           {:ok, _, _, %{"shuttle" => %{"host" => host}}, _} <- FiberDoc.read_path(path),
           true <- is_binary(host) && host != "",
           do: host,
           else: (_ -> supplied)
    else
      supplied
    end
  end

  # Failed or incomplete discovery cannot prove removal. A configured closed fleet can.
  def removed?(host) when host in [nil, ""], do: false

  def removed?(host) do
    report = Shuttle.TailnetPeers.status()

    complete =
      (report.state == "ok" && report.rejected == []) ||
        is_list(Shuttle.Env.app(:remotes)) ||
        match?(
          %{"defaults" => %{"discover" => false}, "remotes" => entries} when is_list(entries),
          Remotes.document()
        )

    complete && match?({:error, {:unknown_origin, _}}, OriginRouter.route(host))
  end

  def eligible?(%{"shuttle" => %{} = block} = fiber) do
    removed = removed?(block["host"])
    scheduled = block["kind"] == "standing" && !is_nil(block["schedule"])
    removed || (!scheduled && quiescent?(fiber))
  end

  def eligible?(_), do: false

  # The CLI rechecks the exact resolved document under its advisory lock.
  def local_copy(identifier, origin, hint \\ nil) do
    with {:ok, %{path: path} = resolved} <- FeltStores.resolve_request(identifier, hint),
         {:ok, _, _, %{"shuttle" => %{} = block} = fiber, _} <- FiberDoc.read_path(path),
         true <- is_nil(resolved.uid) || fiber["id"] == resolved.uid,
         true <- origin in [nil, "", "local", block["host"], Poller.own_host_id()],
         true <- eligible?(fiber),
         rows = (RemoteFiberRegistry.feeds()[block["host"]] || %{})[:fibers] || [],
         true <- Enum.all?(rows, &(uid(&1) != fiber["id"] || safe_owner?(&1))),
         do: resolved,
         else: (_ -> nil)
  end

  def exit(params, cause) do
    with true <- action?(params),
         true <- match?({:not_sent, _}, cause) || removed?(params["origin"]),
         %{} = copy <- local_copy(params["fiber"], params["origin"], params["fiber_path"]) do
      args =
        ["--mirror-owner", params["origin"] || ""] ++
          Enum.flat_map(~w(tempered quiet until actor), fn key ->
            case Map.fetch(params, key) do
              {:ok, value} when is_boolean(value) -> ["--#{key}=#{value}"]
              {:ok, value} when is_binary(value) -> ["--#{key}", value]
              _ -> []
            end
          end)

      case Shuttle.LifecycleService.transition(
             String.to_existing_atom(params["action"]),
             copy.uid || copy.fiber_id,
             args,
             copy.fiber_id
           ) do
        {:ok, output} -> {:ok, "Owner unavailable (#{inspect(cause)}).\n#{output}"}
        other -> other
      end
    else
      _ -> nil
    end
  end

  def pending?(identifier, origin, hint \\ nil) do
    with {:ok, %{path: path}} <- FeltStores.resolve_request(identifier, hint),
         {:ok, _, _, fiber, _} <- FiberDoc.read_path(path),
         true <- eligible?(fiber),
         %{stale: false, fibers: rows} <- RemoteFiberRegistry.feeds()[origin] do
      Enum.any?(
        rows,
        &(uid(&1) == fiber["id"] && host(&1) == origin && newer?(%{"fiber" => fiber}, &1))
      )
    else
      _ -> false
    end
  end

  def reconcile(owners, archives, stale, local) do
    copies =
      archives
      |> Enum.group_by(&uid/1)
      |> Map.filter(fn {id, rows} -> id != nil && length(rows) == 1 end)

    owners =
      Enum.map(owners, fn row ->
        copy =
          case copies[uid(row)] do
            [copy] -> if host(copy) == host(row), do: copy
            _ -> nil
          end

        capable = copy != nil && eligible?(copy["fiber"]) && safe_owner?(row)
        pending = copy != nil && eligible?(copy["fiber"]) && newer?(copy, row)

        fiber =
          if stale[row["origin"]] && pending && capable do
            Map.drop(row["fiber"], @exit_fields)
            |> Map.merge(Map.take(copy["fiber"], @exit_fields))
          else
            row["fiber"]
          end

        Map.merge(row, %{
          "fiber" => fiber,
          "local_planning" => capable,
          "planning_pending" => pending && !stale[row["origin"]]
        })
      end)

    seen = MapSet.new(owners, &uid/1)

    missing =
      Enum.filter(archives, fn row ->
        !MapSet.member?(seen, uid(row)) && is_map(row["fiber"]["shuttle"]) &&
          stale[host(row)] != false
      end)

    owners ++
      Enum.map(missing, fn row ->
        row
        |> Map.put("origin", if(host(row) in [nil, ""], do: local, else: host(row)))
        |> Map.put("local_planning", match?([_], copies[uid(row)]) && eligible?(row["fiber"]))
      end)
  end

  defp safe_owner?(row),
    do: removed?(host(row)) || (quiescent?(row["fiber"]) && is_nil(row["runtime"]))

  defp host(%{"fiber" => %{"shuttle" => %{} = block}}), do: block["host"]
  defp host(_), do: nil

  defp uid(row) do
    id = get_in(row, ["fiber", "uid"]) || get_in(row, ["fiber", "id"])
    if Shuttle.ULID.valid?(id), do: id
  end

  defp newer?(%{"fiber" => %{"shuttle" => %{"runtime" => %{"mirrored_at" => stamp}}}}, row),
    do: after?(stamp, row["fiber"]["modified_at"] || row["fiber"]["updated_at"])

  defp newer?(_, _), do: false

  defp after?(a, b) when is_binary(a) and is_binary(b) do
    with {:ok, a, _} <- DateTime.from_iso8601(a),
         {:ok, b, _} <- DateTime.from_iso8601(b),
         do: DateTime.compare(a, b) == :gt,
         else: (_ -> false)
  end

  defp after?(_, _), do: false
end
