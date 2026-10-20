defmodule ShuttleWeb.RemoteControlControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  alias Shuttle.Test.Env
  @endpoint ShuttleWeb.Endpoint

  defmodule GoneRunner do
    @behaviour Shuttle.Runner
    def cmd("tmux", ["has-session" | _], _) do
      if Shuttle.Env.app(:remote_control_pane), do: {"", 0}, else: {"can't find session", 1}
    end

    def cmd("tmux", ["display-message" | _], _), do: {Shuttle.Env.app(:remote_control_pane), 0}
    def cmd("ps", _, _), do: {"", 0}
  end

  test "GET returns the reconciler snapshot without launching or reconciling" do
    Env.start_scoped!(
      {Shuttle.RemoteControl,
       name: nil, runner: GoneRunner, config: fn -> nil end, interval_ms: :infinity}
    )

    conn = api_conn() |> get("/api/v1/remote_control")
    assert conn.status == 200

    assert %{
             "state" => "disabled",
             "dir" => nil,
             "args" => [],
             "pid" => nil,
             "started_at" => nil,
             "restarts" => 0,
             "last_exit" => nil,
             "next_attempt_at" => nil,
             "message" => nil
           } = Jason.decode!(conn.resp_body)
  end

  test "GET serializes an adopted running host's PID and UTC start time" do
    config = %{dir: "/path/to/projects", args: ["--verbose"]}

    digest =
      :crypto.hash(:sha256, Shuttle.RemoteControl.script(config)) |> Base.encode16(case: :lower)

    Env.put_app_env(:remote_control_pane, "#{digest}|0||123|1000|")

    Env.start_scoped!(
      {Shuttle.RemoteControl,
       name: nil, runner: GoneRunner, config: fn -> {:ok, config} end, interval_ms: :infinity}
    )

    conn = api_conn() |> get("/api/v1/remote_control")

    assert %{
             "state" => "running",
             "pid" => 123,
             "started_at" => "1970-01-01T00:16:40Z",
             "restarts" => 0,
             "dir" => "/path/to/projects",
             "args" => ["--verbose"]
           } = json_response(conn, 200)
  end

  test "Remote Control is an optional child, disabled during tests" do
    refute Enum.any?(Shuttle.Application.child_specs(), &(&1.id == Shuttle.RemoteControl))
    Env.put_app_env(:start_remote_control, true)
    assert Enum.any?(Shuttle.Application.child_specs(), &(&1.id == Shuttle.RemoteControl))
  end
end
