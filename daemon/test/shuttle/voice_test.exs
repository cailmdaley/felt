defmodule Shuttle.VoiceTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  alias Shuttle.Test.Env
  alias Shuttle.{Voice, Voice.Config}
  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir

  setup %{tmp_dir: root} do
    Env.put_env("SHUTTLE_VOICE_FILE", Path.join(root, "voice.json"))
    Env.put_env("SHUTTLE_DATA_DIR", root)
    Env.put_app_env(:hark_dir, Path.join(root, "hark"))
    Env.put_app_env(:remotes, [])
    {:ok, observed} = Agent.start_link(fn -> %{available: true, meeting: nil} end)
    parent = self()

    reconcile = fn enabled, _opts ->
      send(parent, {:reconciled, enabled})
      {:ok, Agent.get(observed, & &1)}
    end

    opts = [
      name: Module.concat(__MODULE__, "S#{System.unique_integer([:positive])}"),
      poll_ms: 60_000,
      reconcile: reconcile,
      relay: fn _, _ -> :ok end,
      monitor: fn _ -> %{pending: nil, last: nil} end
    ]

    pid = Env.start_scoped!({Voice, opts})
    Voice.show()
    {:ok, pid: pid, opts: opts, root: root, observed: observed}
  end

  test "off by default, settings validate, and enabling persists without changing monitor thresholds",
       c do
    assert %{enabled: false, state: "off", available: true, target: nil} = Voice.show()

    assert {:ok,
            %{
              "voice" => %{"words" => 60, "quiet_seconds" => 4},
              "meeting" => %{"quiet_seconds" => 30}
            }} = Config.read()

    for invalid <- [
          %{"enabled" => "yes"},
          %{"voice" => %{"words" => 0, "quiet_seconds" => 4}},
          %{"meeting" => %{"words" => 5, "quiet_seconds" => -1}},
          []
        ] do
      assert {:error, _} = Config.validate(invalid)
    end

    assert {:ok, %{enabled: true, state: "starting"}} = Voice.update(%{"enabled" => true})
    assert {:ok, %{"enabled" => true, "voice" => %{"words" => 60}}} = Config.read()
    assert {:error, _} = Voice.update(%{"muted" => "true"})
    assert File.exists?(Path.join(c.root, "voice.json"))
  end

  test "meeting ownership yields voice and it returns once the meeting ends", c do
    Agent.update(c.observed, fn _ ->
      %{available: true, meeting: %{kind: "meeting", launch: "meeting", state: "live"}}
    end)

    assert {:ok, %{state: "yielded", enabled: true}} = Voice.update(%{"enabled" => true})

    Agent.update(c.observed, fn _ ->
      %{available: true, meeting: %{kind: "voice", launch: "voice", state: "live", error: nil}}
    end)

    assert {:ok, %{state: "listening"}} = Voice.update(%{})
  end

  test "target receipt time is durable and restored by a fresh supervisor", c do
    assert {:ok, %{target: %{"fiber_id" => "project/first"}}} =
             Voice.target(%{"fiber_id" => "project/first"})

    assert {:ok, %{target: %{"fiber_id" => "project/second"}}} =
             Voice.target(%{"fiber_id" => "project/second"})

    [first, second] =
      File.read!(Voice.routes_path())
      |> String.split("\n", trim: true)
      |> Enum.map(&Jason.decode!/1)

    assert first["fiber_id"] == "project/first"
    assert second["fiber_id"] == "project/second"
    assert {:ok, at, 0} = DateTime.from_iso8601(second["t"])
    assert DateTime.diff(DateTime.utc_now(), at) in 0..1
    stop_supervised!(Voice)
    Env.start_scoped!({Voice, c.opts})
    assert %{target: %{"fiber_id" => "project/second"}} = Voice.show()
  end

  test "an interrupted route append is truncated without damaging complete routes", c do
    assert {:ok, _} = Voice.target(%{"fiber_id" => "project/first"})
    stop_supervised!(Voice)
    File.write!(Voice.routes_path(), ~s({"t":"partial), [:append])
    Env.start_scoped!({Voice, c.opts})
    assert %{target: %{"fiber_id" => "project/first"}} = Voice.show()
    assert {:ok, _} = Voice.target(%{"fiber_id" => "project/second"})

    rows =
      File.read!(Voice.routes_path())
      |> String.split("\n", trim: true)
      |> Enum.map(&Jason.decode!/1)

    assert [%{"fiber_id" => "project/first"}, %{"fiber_id" => "project/second"}] = rows
  end

  test "voice API targets the local recorder even when origin is the receiving worker's host" do
    response =
      api_conn() |> post("/api/v1/voice/target", Jason.encode!(%{fiber_id: "project/target"}))

    assert response.status == 200

    assert %{"target" => %{"fiber_id" => "project/target"}, "recorder" => recorder} =
             Jason.decode!(response.resp_body)

    assert recorder == Shuttle.MeetingRouter.own_host()
    response = api_conn() |> post("/api/v1/voice", Jason.encode!(%{enabled: true}))
    assert response.status == 200
    assert %{"enabled" => true, "state" => "starting"} = Jason.decode!(response.resp_body)

    assert %{"enabled" => true, "pending" => nil, "last" => nil} =
             api_conn() |> get("/api/v1/voice") |> Map.get(:resp_body) |> Jason.decode!()

    assert (api_conn() |> post("/api/v1/voice", ~s({"muted":3}))).status == 422
    assert (api_conn() |> post("/api/v1/voice/target", ~s({"fiber_id":""}))).status == 422
  end
end
