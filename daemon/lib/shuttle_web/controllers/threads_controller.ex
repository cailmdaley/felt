defmodule ShuttleWeb.ThreadsController do
  @moduledoc """
  Agent-API endpoint: GET /api/v1/threads/*id

  A constitution's threads to every depth, as `Shuttle.Threads.tree/5` builds
  them from this daemon's cached constitutions, local and synced, with the
  workers running on this host and on every remote it polls fresh as the live
  ones. `id` is a uid or a fiber address;
  `shuttle threads` renders the response.

  Returns: 200  %{fiber_id, uid, name, felt_store, threads: [...]}
           404  %{error: "not_found"} when no cached constitution has that id
           503  %{error: "cold" | "poller_unavailable"} before the first poll
                warms the cache, or when no Poller runs
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.Threads

  def show(conn, %{"id" => segments}) do
    id = segments |> List.wrap() |> Enum.join("/")

    with {:ok, {entries, live, reachable}} <- inputs(),
         %{fiber: fiber, felt_store: store} <- Enum.find(entries, &names?(&1.fiber, id)) do
      json(conn, %{
        fiber_id: Threads.address(fiber),
        uid: fiber["uid"],
        name: fiber["name"],
        felt_store: store,
        threads: Threads.tree(Threads.address(fiber), store, entries, live, reachable)
      })
    else
      nil -> conn |> put_status(:not_found) |> json(%{error: "not_found", id: id})
      {:error, reason} -> conn |> put_status(:service_unavailable) |> json(%{error: reason})
    end
  end

  defp names?(fiber, id),
    do: is_map(fiber["shuttle"]) and id in [fiber["uid"], fiber["slug"], fiber["id"]]

  defp inputs do
    case Shuttle.Poller.thread_inputs() do
      {:ok, _} = ok -> ok
      {:error, :cold} -> {:error, "cold"}
    end
  catch
    :exit, _ -> {:error, "poller_unavailable"}
  end
end
