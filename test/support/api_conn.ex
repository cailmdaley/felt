defmodule Shuttle.Test.ApiConn do
  @moduledoc """
  The request conn every `:api` controller suite builds: JSON in, JSON out.
  """

  import Phoenix.ConnTest
  import Plug.Conn

  def api_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end
end
