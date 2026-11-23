defmodule ShuttleWeb.InboxController do
  use Phoenix.Controller, formats: [:json]
  alias Shuttle.{CLI, Delivery, FiberDocuments, OriginRouter, Poller}

  def create(conn, params) do
    case OriginRouter.route(params["origin"]) do
      {:remote, remote} ->
        ShuttleWeb.RelayHelpers.relay_json(
          conn,
          OriginRouter.forward(remote, "/api/v1/inbox", params),
          fn host, reason -> %{error: "owner #{host} unreachable: #{inspect(reason)}"} end
        )

      {:error, reason} ->
        conn |> put_status(502) |> json(%{error: inspect(reason)})

      :local ->
        local(conn, params)
    end
  end

  defp local(conn, params) do
    with {:ok, %{fibers: [entry]}} <- FiberDocuments.get_shuttle(params["fiber_id"]),
         true <- get_in(entry.fiber, ["shuttle", "host"]) == Poller.own_host_id() do
      key = Delivery.context_key(entry)

      result =
        case params["action"] do
          "list" -> CLI.run(["inbox", "ls", key, "--json"])
          "cancel" -> CLI.run(["inbox", "cancel", key, params["message_id"]])
          _ -> {:error, :invalid_action}
        end

      case {params["action"], result} do
        {"list", {:ok, output}} ->
          publications = Jason.decode!(output)

          publications =
            Enum.map(publications, fn p ->
              case DateTime.from_iso8601(p["not_before"] || "") do
                {:ok, time, _} ->
                  if DateTime.compare(time, DateTime.utc_now()) != :gt,
                    do: Map.put(p, "waiting", waiting(entry, p)),
                    else: p

                _ ->
                  p
              end
            end)

          json(conn, %{entries: publications})

        {_, {:ok, _}} ->
          json(conn, %{cancelled: params["message_id"]})

        error ->
          conn |> put_status(409) |> json(%{error: inspect(error)})
      end
    else
      _ ->
        case find_unreadable(params["fiber_id"]) do
          %{error: error} = entry ->
            conn
            |> put_status(422)
            |> json(%{
              error: "fiber #{entry[:path] || params["fiber_id"]} is unreadable: #{error}"
            })

          nil ->
            conn
            |> put_status(404)
            |> json(%{error: "no owned fiber #{params["fiber_id"]} on #{Poller.own_host_id()}"})
        end
    end
  end

  defp find_unreadable(fiber_id) when is_binary(fiber_id) and fiber_id != "" do
    upper = String.upcase(fiber_id)

    Enum.find(Poller.unreadable_fibers(), fn entry ->
      entry[:id] == fiber_id or entry[:path] == fiber_id or
        (is_binary(entry[:uid]) and String.upcase(entry[:uid]) == upper)
    end)
  end

  defp find_unreadable(_), do: nil

  # Why an overdue entry is still pending.
  defp waiting(entry, publication) do
    id = entry.fiber["uid"] || entry.fiber["id"]

    cond do
      publication["turn"] == "none" ->
        "context only; waits for a worker's hook"

      publication["attempt"] ->
        "delivery in flight; awaits its outcome"

      Poller.context_receiver(Shuttle.Env.server(Poller), id) != {:error, :no_worker} ->
        "awaiting its worker's next hook or consume"

      detail = Delivery.inbox_wait(entry) ->
        detail

      true ->
        "awaiting the next poll, which starts a session for it"
    end
  end
end
