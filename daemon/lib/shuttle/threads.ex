defmodule Shuttle.Threads do
  @moduledoc "Constitution containment and owner-local result delivery."

  alias Shuttle.{Delivery, OriginRouter}

  @doc "Nearest strict ancestor carrying a shuttle block, in the same felt store."
  def orchestrator(entry, entries) do
    slug = address(entry.fiber)
    index = Map.new(entries, &{{&1.felt_store, address(&1.fiber)}, &1})
    nearest(Path.dirname(slug), fn path -> Map.get(index, {entry.felt_store, path}) end)
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
    Enum.each(entries, fn entry ->
      if get_in(entry.fiber, ["shuttle", "host"]) == own_host do
        if parent = orchestrator(entry, entries) do
          Enum.each(signals(entry.fiber), fn {verb, stamp, text} ->
            id = "thread-" <> digest({entry.fiber["uid"] || entry.fiber["id"], verb, stamp})
            message = "thread #{address(entry.fiber)} #{verb}: #{text}"
            deliver(parent, message, id, verb in ["closed", "asked"])
          end)
        end
      end
    end)

    # A parent can receive remote results while dormant. Its next live worker
    # drains the same mailbox, even when no child changes during this poll.
    Enum.each(entries, fn entry ->
      if get_in(entry.fiber, ["shuttle", "host"]) == own_host,
        do: Delivery.flush_context(entry)
    end)
  end

  defp deliver(parent, text, id, wake) do
    case OriginRouter.route_host(get_in(parent.fiber, ["shuttle", "host"])) do
      :local ->
        Delivery.context(parent, text, id, wake: wake)

      {:remote, remote} ->
        OriginRouter.forward(remote, "/api/v1/deliver", %{
          "fiber_id" => address(parent.fiber),
          "text" => text,
          "context_only" => true,
          "wake" => wake,
          "message_id" => id
        })

      {:error, _} ->
        :ok
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
