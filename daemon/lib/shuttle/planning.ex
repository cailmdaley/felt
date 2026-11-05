defmodule Shuttle.Planning do
  @moduledoc "Owner-away exits on synchronized copies; configuration and execution stay with the owner."
  alias Shuttle.{FeltStores, FiberDoc, OriginRouter, Poller, RemoteFiberRegistry, Remotes}
  @exit_fields ~w(status tempered closed_at closed-at horizon)

  def mutate(path, params, opts \\ []) do
    subject = params["fiber"] || params["fiber_id"]
    origin = origin(subject, params["origin"], params["fiber_path"])
    opts = Keyword.put_new(opts, :routed, params["routed"] in [true, "1", "true"])

    result =
      case OriginRouter.route(origin, opts) do
        {:remote, remote} ->
          if (action?(params) || params["target"] in ~w(drafts awaitingReview composted)) &&
               pending?(subject, origin, params["fiber_path"]) do
            {:error, :planning_pending}
          else
            result = OriginRouter.forward(remote, path, params, opts)
            RemoteFiberRegistry.refresh_after_forward(remote.name, result)
            result
          end

        result ->
          result
      end

    params = Map.merge(params, %{"fiber" => subject, "origin" => origin})

    case result do
      {:error, {:unknown_origin, _} = cause} -> mirror(params, cause, result)
      {:error, {:forward_failed, _, {:not_sent, _} = cause}} -> mirror(params, cause, result)
      result -> result
    end
  end

  defp mirror(params, cause, refusal) do
    {id, invocation} =
      case params do
        %{"target" => target} ->
          case Shuttle.ActionQueries.resolve_action(params["fiber"], target) do
            {:ok, %{id: id, invocation: call}} ->
              {id,
               call
               |> Map.new(fn {key, value} -> {to_string(key), value} end)
               |> Map.put("action", call.verb)}

            _ ->
              {nil, %{}}
          end

        _ ->
          {nil, params}
      end

    case exit(Map.merge(params, invocation), cause) do
      nil -> refusal
      {:ok, output} -> {:mirrored, id, output}
      result -> result
    end
  end

  def quiescent?(%{"status" => "active"}), do: false
  def quiescent?(%{"shuttle" => block}) when not is_map(block), do: false

  def quiescent?(fiber) do
    case Map.get(Map.get(fiber, "shuttle", %{}), "runtime", %{}) do
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
    complete =
      is_list(Shuttle.Env.app(:remotes)) ||
        match?(
          %{"defaults" => %{"discover" => false}, "remotes" => entries} when is_list(entries),
          Remotes.fresh_document()
        )

    complete && match?({:error, {:unknown_origin, _}}, OriginRouter.route(host))
  end

  def eligible?(%{"shuttle" => %{} = block} = fiber) do
    removed = removed?(block["host"])
    scheduled = block["kind"] == "standing" && !is_nil(block["schedule"])
    is_map(Map.get(block, "runtime", %{})) && (removed || (!scheduled && quiescent?(fiber)))
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

      Shuttle.LifecycleService.transition(
        String.to_existing_atom(params["action"]),
        copy.uid || copy.fiber_id,
        args,
        copy.fiber_id
      )
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

  defp mirror_stamp(%{"fiber" => %{"shuttle" => %{"runtime" => %{"mirrored_at" => stamp}}}}),
    do: stamp

  defp mirror_stamp(_), do: nil

  defp newer?(copy, row) do
    stamp = mirror_stamp(copy)

    after?(stamp, row["fiber"]["modified_at"] || row["fiber"]["updated_at"]) &&
      (is_nil(mirror_stamp(row)) || after?(stamp, mirror_stamp(row)))
  end

  defp after?(a, b) when is_binary(a) and is_binary(b) do
    with {:ok, a, _} <- DateTime.from_iso8601(a),
         {:ok, b, _} <- DateTime.from_iso8601(b),
         do: DateTime.compare(a, b) == :gt,
         else: (_ -> false)
  end

  defp after?(_, _), do: false
end
