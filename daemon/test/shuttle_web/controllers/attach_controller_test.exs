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

  defmodule ForwardClient do
    def post(url, body, _content_type, timeout) do
      send(Shuttle.Env.app(:attach_test), {:forward, url, Jason.decode!(body), timeout})
      Shuttle.Env.app(:attach_forward_result)
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

  test "remote Codex preparation uses the owner budget plus a transit margin" do
    remote_setup()
    Env.put_app_env(:terminal_prepare_timeout_ms, 1000)

    Env.put_app_env(
      :attach_forward_result,
      {:ok, 200, ~s({"tmux_session":"codex-terminal-probe"})}
    )

    assert %{"attached" => true} = remote_attach() |> json_response(200)

    assert_received {:forward, "http://127.0.0.1:4001/api/v1/sessions/prepare-terminal",
                     %{"tmux_session" => "codex-terminal-probe"}, 3000}

    assert_received {:opened, "codex-terminal-probe", "remote-a"}
  end

  test "remote Codex preparation errors are sentences and never open a display" do
    remote_setup()

    for {result, message} <- [
          {{:error, :timeout}, "remote-a's daemon did not answer in time"},
          {{:error, :econnrefused}, "remote-a could not be reached"},
          {{:ok, 422, ~s({"error":"The Codex App Server did not answer for this conversation."})},
           "remote-a: The Codex App Server did not answer for this conversation."},
          {{:ok, 404, ~s({"error":"no owned terminal Codex conversation"})},
           "remote-a: no owned terminal Codex conversation"},
          {{:ok, 404, "not found"}, "deploy the current build there if the route is unavailable"},
          {{:ok, 500, "broken"}, "remote-a could not prepare the terminal."},
          {{:ok, 200, ~s({"tmux_session":"wrong"})},
           "remote-a answered with a different or missing terminal"},
          {{:ok, 200, "invalid"}, "remote-a answered with a different or missing terminal"}
        ] do
      Env.put_app_env(:attach_forward_result, result)
      assert %{"error" => error} = remote_attach() |> json_response(422)
      assert error =~ message
      refute error =~ "{:"
      refute_received {:opened, _, _}
    end
  end

  test "unknown Codex host and structured display failures stay legible" do
    Env.put_app_env(:remotes, [])
    assert %{"error" => message} = remote_attach() |> json_response(422)
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

    assert line =~ "prepare_terminal="
    assert line =~ "display="
    assert line =~ "total="
  end

  defp remote_setup do
    Env.put_app_env(:remotes, [%{name: "remote-a", port: 4001}])
    Env.put_app_env(:write_forward_client, ForwardClient)
  end

  defp remote_attach do
    post(
      api_conn(),
      "/api/v1/attach",
      Jason.encode!(%{tmux_session: "codex-terminal-probe", shuttle_host: "remote-a"})
    )
  end

  test "malformed requests never call the opener" do
    for body <- [%{}, %{session: "bad"}, %{tmux_session: "worker", shuttle_host: 7}] do
      post(api_conn(), "/api/v1/attach", Jason.encode!(body)) |> json_response(400)
    end

    refute_received {:opened, _, _}
  end
end
