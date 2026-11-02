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

  test "unknown host and structured display failures stay legible" do
    Env.put_app_env(:remotes, [])

    assert %{"error" => message} =
             post(
               api_conn(),
               "/api/v1/attach",
               Jason.encode!(%{
                 session: "00000000-0000-4000-8000-000000000001",
                 shuttle_host: "absent"
               })
             )
             |> json_response(422)

    assert message =~ "unknown origin"
    refute message =~ "{:"
    Env.put_app_env(:attach_result, {:error, {:display_failed, :timeout}})

    assert %{"error" => message} =
             post(api_conn(), "/api/v1/attach", Jason.encode!(%{tmux_session: "worker"}))
             |> json_response(502)

    assert message =~ "could not prepare"
    refute message =~ "{:"
  end

  test "one attach log includes preparation and display durations" do
    log =
      ExUnit.CaptureLog.capture_log(fn ->
        post(api_conn(), "/api/v1/attach", Jason.encode!(%{tmux_session: "trace-probe-worker"}))
        |> json_response(200)
      end)

    assert [line] =
             log
             |> String.split("\n", trim: true)
             |> Enum.filter(&String.contains?(&1, ~s(Terminal open name="trace-probe-worker")))

    assert line =~ "display="
    assert line =~ "total="
  end

  test "malformed requests never call the opener" do
    for body <- [%{}, %{session: "bad"}, %{tmux_session: "worker", shuttle_host: 7}] do
      post(api_conn(), "/api/v1/attach", Jason.encode!(body)) |> json_response(400)
    end

    refute_received {:opened, _, _}
  end
end
