defmodule Shuttle.Test.ApiConn do
  @moduledoc """
  The request conn every `:api` controller suite builds: JSON in, JSON out.
  """

  import Phoenix.ConnTest
  import Plug.Conn

  def local_conn(method \\ :get, path \\ "/", body \\ nil) do
    %{build_conn(method, path, body) | host: "127.0.0.1", port: 4000}
  end

  def api_conn do
    local_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end
end
