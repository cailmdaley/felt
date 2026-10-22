defmodule Shuttle.Threads do
  @moduledoc "Constitution containment and owner-local result delivery."

  alias Shuttle.{Delivery, OriginRouter, ThreadOutbox}

  @doc "Nearest strict ancestor carrying a shuttle block, in the same felt store."
  def orchestrator(entry, entries) when is_list(entries), do: orchestrator(entry, index(entries))

  def orchestrator(entry, index) when is_map(index) do
    nearest(Path.dirname(address(entry.fiber)), fn path ->
      Map.get(index, {entry.felt_store, path})
    end)
  end

  defp index(entries), do: Map.new(entries, &{{&1.felt_store, address(&1.fiber)}, &1})

  @doc "Stamp each constitution with its nearest orchestrator's wire id, or null."
  def put_orchestrators(entries) do
    index = index(entries)

    Enum.map(entries, fn entry ->
      if is_map(entry.fiber["shuttle"]) do
        parent = orchestrator(entry, index)
        Map.put(entry, :orchestrator, if(parent, do: parent.fiber["id"]))
      else
        entry
      end
    end)
  end

  defp nearest(".", _lookup), do: nil
  defp nearest("/", _lookup), do: nil

  defp nearest(path, lookup) do
    case lookup.(path) do
      %{fiber: %{"shuttle" => block}} = entry when is_map(block) -> entry
      _ -> nearest(Path.dirname(path), lookup)
    end
  end

  def address(fiber), do: fiber["slug"] || fiber["id"]

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

    case parent do
      %{fiber: fiber} ->
        "You are a thread of #{address(fiber)} (#{fiber["name"]}). " <>
          "Your outcome is delivered to that orchestrator when you close or ask; write it for that reader."

      nil ->
        ""
    end
  end

  @doc "Reconcile durable lifecycle signals. Only a child's owner publishes its results."
  def deliver_results(entries, own_host) do
    capture_results(entries, own_host)
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
          {verb, stamp, text} <- signals(entry.fiber),
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
           "wake" => verb in ["closed", "asked"]
         }}
      end

    ThreadOutbox.capture(records)
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
           true <- acknowledged?(deliver(parent, record["text"], id, record["wake"])) do
        ThreadOutbox.acknowledge(id)
      end
    end

    :ok
  end

  defp acknowledged?({:ok, :queued}), do: true

  defp acknowledged?({:forwarded, 202, body}) do
    case Jason.decode(body) do
      {:ok, %{"delivery" => "context", "queued" => true}} -> true
      _ -> false
    end
  end

  defp acknowledged?(_), do: false

  defp deliver(parent, text, id, wake) do
    case OriginRouter.route_host(get_in(parent.fiber, ["shuttle", "host"])) do
      :local ->
        Delivery.context(parent, text, id, wake: wake)

      {:remote, remote} ->
        OriginRouter.forward(remote, "/api/v1/deliver", %{
          "fiber_id" => Map.fetch!(parent.fiber, "uid"),
          "text" => text,
          "context_only" => true,
          "wake" => wake,
          "message_id" => id
        })

      {:error, _} = error ->
        error
    end
  end

  defp after_baseline?(stamp, baseline) do
    case DateTime.from_iso8601(stamp) do
      {:ok, time, _} -> DateTime.compare(time, baseline) == :gt
      _ -> false
    end
  end

  defp signals(fiber) do
    ask =
      case get_in(fiber, ["shuttle", "ask"]) do
        %{"text" => text, "at" => at} when is_binary(text) and is_binary(at) ->
          [{"asked", at, text}]

        _ ->
          []
      end

    runtime = get_in(fiber, ["shuttle", "runtime"]) || %{}
    handed = runtime["handed_off_at"]
    dispatched = runtime["dispatched_at"]

    exit =
      cond do
        fiber["status"] == "closed" && fiber["closed_at"] ->
          [{"closed", fiber["closed_at"], fiber["outcome"] || ""}]

        fiber["status"] == "open" && fiber["horizon"] == "stashed" && handed ->
          [{"rested", handed, fiber["outcome"] || ""}]

        fiber["status"] == "active" && is_binary(handed) &&
            (is_nil(dispatched) || handed >= dispatched) ->
          [{"handed off", handed, fiber["outcome"] || ""}]

        true ->
          []
      end

    ask ++ exit
  end

  defp digest(term),
    do: :crypto.hash(:sha256, :erlang.term_to_binary(term)) |> Base.encode16(case: :lower)
end
