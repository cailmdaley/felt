defmodule ShuttleWeb.MessagingController do
  use Phoenix.Controller, formats: [:json]
  alias Shuttle.Messaging

  def peers(conn, params) do
    case Map.get(params, "local", "false") do
      "true" -> json(conn, Messaging.peers(true))
      "false" -> json(conn, Messaging.peers(false))
      _ -> conn |> put_status(400) |> json(%{error: "local must be true or false"})
    end
  end

  def create(conn, params) do
    reply(conn, Messaging.send_message(params))
  end

  def create_files(conn, params) do
    reply(conn, Messaging.send_message_with_files(params))
  end

  defp reply(conn, result) do
    case result do
      {:ok, status, receipt} -> conn |> put_status(status) |> json(receipt)
      {:error, status, error} -> conn |> put_status(status) |> json(%{error: error})
    end
  end
end
