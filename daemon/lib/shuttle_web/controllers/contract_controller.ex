defmodule ShuttleWeb.ContractController do
  @moduledoc """
  Agent-API endpoint: GET /api/v1/contract

  Serves the OpenAPI document for the stable routes (`Shuttle.ApiContract`), so
  a client reads the contract of the daemon it is talking to.
  """

  use Phoenix.Controller, formats: [:json]

  def show(conn, _params) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Shuttle.ApiContract.json())
  end
end
