defmodule ShuttleWeb.InboxController do
  use Phoenix.Controller, formats: [:json]
  alias Shuttle.{CLI, Delivery, FiberDocuments, InboxSchedule, OriginRouter, Poller}

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
                    do: Map.put(p, "waiting", InboxSchedule.waiting(entry, p)),
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
        conn
        |> put_status(404)
        |> json(%{error: "no owned fiber #{params["fiber_id"]} on #{Poller.own_host_id()}"})
    end
  end
end
