defmodule Shuttle.OwnerExit do
  @moduledoc "Owner-away exits on synchronized copies; configuration and execution stay with the owner."
  alias Shuttle.{FeltStores, FiberDoc, OriginRouter, Poller, RemoteFiberRegistry, Remotes}
  @exit_fields ~w(status tempered closed_at closed-at horizon)

  def mutate(path, params, opts \\ []) do
    subject = params["fiber"] || params["fiber_id"]
    origin = origin(subject, params["origin"], params["fiber_path"])
    stale_before_request = get_in(policy(), [origin, :stale]) == true

    result =
      case OriginRouter.route(origin, opts) do
        {:remote, remote} ->
          result = OriginRouter.forward(remote, path, params, opts)
          RemoteFiberRegistry.refresh_after_forward(remote.name, result)

          case result do
            {:forwarded, status, body} -> {:forwarded, status, body, remote.name}
            error -> error
          end

        result ->
          result
      end

    params = Map.merge(params, %{"fiber" => subject, "origin" => origin})

    case result do
      {:error, {:forward_failed, _, {:not_sent, _} = cause}} when stale_before_request ->
        mirror(params, cause, result)
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

  def action?(%{"action" => "rest"} = params), do: !Map.has_key?(params, "until")
  def action?(%{"action" => "close"} = params), do: params["tempered"] != true
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

  # One immutable fleet snapshot per view or exit authorization.
  def policy do
    Map.take(RemoteFiberRegistry.feeds(), Enum.map(Remotes.configured(), & &1.name))
  end

  def eligible?(fiber, policy \\ policy())

  def eligible?(%{"shuttle" => %{} = block} = fiber, policy) do
    Map.has_key?(policy, block["host"]) && block["kind"] != "standing" && quiescent?(fiber)
  end

  def eligible?(_, _), do: false

  # The CLI rechecks the exact resolved document under its advisory lock.
  def local_copy(identifier, origin, hint \\ nil) do
    policy = policy()

    with {:ok, %{path: path} = resolved} <- FeltStores.resolve_request(identifier, hint),
         {:ok, _, _, %{"shuttle" => %{} = block} = fiber, _} <- FiberDoc.read_path(path),
         true <- is_nil(resolved.uid) || fiber["id"] == resolved.uid,
         true <- origin in [nil, "", "local", block["host"], Poller.own_host_id()],
         true <- eligible?(fiber, policy),
         true <- get_in(policy, [block["host"], :stale]) == true,
         rows = policy[block["host"]][:fibers] || [],
         true <- Enum.all?(rows, &(uid(&1) != fiber["id"] || safe_owner?(&1, policy))),
         do: resolved,
         else: (_ -> nil)
  end

  def exit(params, cause) do
    with true <- action?(params),
         true <- match?({:not_sent, _}, cause),
         %{} = copy <- local_copy(params["fiber"], params["origin"], params["fiber_path"]) do
      args =
        ["--mirror-owner", params["origin"] || ""] ++
          Enum.flat_map(~w(tempered quiet actor), fn key ->
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

  def reconcile(owners, archives, stale, local) do
    policy = policy()

    copies =
      archives
      |> Enum.group_by(&uid/1)
      |> Map.filter(fn {id, rows} -> id != nil && length(rows) == 1 end)

    owners =
      Enum.map(owners, fn
        %{"origin" => ^local} = row ->
          row

        row ->
          copy =
            case copies[uid(row)] do
              [copy] -> if host(copy) == host(row), do: copy
              _ -> nil
            end

          capable = stale[row["origin"]] == true && copy != nil && eligible?(copy["fiber"], policy) && safe_owner?(row, policy)
          pending = copy != nil && eligible?(copy["fiber"], policy) && newer?(copy, row)

          fiber =
            if stale[row["origin"]] && pending && capable do
              Map.drop(row["fiber"], @exit_fields)
              |> Map.merge(Map.take(copy["fiber"], @exit_fields))
            else
              row["fiber"]
            end

          Map.merge(row, %{
            "fiber" => fiber,
            "local_exit" => capable,
            "exit_copy_pending" =>
              pending && !stale[row["origin"]] && quiescent?(row["fiber"]) &&
                is_nil(row["runtime"])
          })
      end)

    seen = MapSet.new(owners, &uid/1)

    missing =
      Enum.filter(archives, fn row ->
        owner = host(row)
        !MapSet.member?(seen, uid(row)) && is_binary(owner) && owner not in ["", local] &&
          stale[owner] == true
      end)

    owners ++
      Enum.map(missing, fn row ->
        row
        |> Map.put("origin", if(host(row) in [nil, ""], do: local, else: host(row)))
        |> Map.put("local_exit", match?([_], copies[uid(row)]) && eligible?(row["fiber"], policy))
      end)
  end

  defp safe_owner?(row, _policy), do: quiescent?(row["fiber"]) && is_nil(row["runtime"])

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

    owner_time = row["fiber"]["modified_at"] || row["fiber"]["updated_at"]

    after?(stamp, owner_time) && after?(owner_time, "0001-01-01T00:00:00Z") &&
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
