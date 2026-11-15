defmodule Shuttle.InboxSchedule do
  @moduledoc "Reads pending delayed publications from this owner's inboxes."
  alias Shuttle.{CLI, Delivery, Poller}

  def entries(entries) do
    owned = Enum.filter(entries, &(get_in(&1.fiber, ["shuttle", "host"]) == Poller.own_host_id()))
    keys = Enum.map(owned, &Delivery.context_key/1)

    if keys == [] do
      %{}
    else
      with {:ok, output} <- CLI.run(["inbox", "scheduled" | keys]),
           {:ok, by_key} <- Jason.decode(output) do
        Map.new(owned, fn entry ->
          id = entry.fiber["uid"] || entry.fiber["id"]
          {id, Map.get(by_key, Delivery.context_key(entry), [])}
        end)
      else
        _ -> %{}
      end
    end
  end

  def waiting(entry, publication) do
    cond do
      publication["turn"] == "none" -> "context only; waits for a worker's hook"
      publication["attempt"] -> "delivery in flight; awaits its outcome"
      true -> waiting_for_worker(entry)
    end
  end

  defp admission_wait(id) do
    snapshot = Poller.snapshot()
    blocked = Enum.find(snapshot.blocked, &(&1.fiber_id == id or &1[:uid] == id))

    cond do
      not snapshot.contract.ok ->
        "contract skew: #{snapshot.contract.reason}"

      snapshot.boot_quarantine ->
        "boot quarantine; waits for shuttle daemon release"

      blocked ->
        "launch blocked: #{blocked.reason}"

      snapshot.max_concurrent && snapshot.claimed_count >= snapshot.max_concurrent ->
        "host worker capacity is full"

      true ->
        "awaiting next poll and launch admission"
    end
  end

  defp waiting_for_worker(entry) do
    id = entry.fiber["uid"] || entry.fiber["id"]

    case Poller.context_receiver(Shuttle.Env.server(Poller), id) do
      {:error, :no_worker} ->
        case Delivery.inbox_gate(entry.fiber, Poller.own_host_id()) do
          {:error, reason} ->
            Atom.to_string(reason)

          :ok ->
            admission_wait(id)
        end

      _ ->
        "awaiting worker consumption or hook (busy Claude has a 30-second hook window)"
    end
  end
end
