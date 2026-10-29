defmodule ShuttleWeb.AttachControllerTest do
  use ExUnit.Case, async: true
  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn
  alias Shuttle.Test.Env
  @endpoint ShuttleWeb.Endpoint

  defmodule Opener do
    def open(name, host) do
      send(Shuttle.Env.app(:attach_test), {:opened, name, host})
      Shuttle.Env.app(:attach_result, :ok)
    end
  end

  setup do
    Env.put_app_env(:attach_test, self())
    Env.put_app_env(:opener_impl, Opener)
    :ok
  end

  test "worker attach uses the opener seam and carries its host" do
    assert %{"attached" => true, "session" => "worker-shuttle"} =
             post(
               api_conn(),
               "/api/v1/attach",
               Jason.encode!(%{
                 tmux_session: "worker-shuttle",
                 shuttle_host: "remote-a"
               })
             )
             |> json_response(200)

    assert_received {:opened, "worker-shuttle", "remote-a"}
  end

  test "unsupported remote Rex errors reach the board as a 502" do
    message = "opening a worker on a remote Rex server is not supported yet"
    Env.put_app_env(:attach_result, {:error, message})

    assert %{"error" => ^message} =
             post(api_conn(), "/api/v1/attach", Jason.encode!(%{tmux_session: "worker"}))
             |> json_response(502)
  end

  test "malformed requests never call the opener" do
    for body <- [%{}, %{session: "bad"}, %{tmux_session: "worker", shuttle_host: 7}] do
      post(api_conn(), "/api/v1/attach", Jason.encode!(body)) |> json_response(400)
    end

    refute_received {:opened, _, _}
  end
end
