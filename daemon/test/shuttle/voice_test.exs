defmodule Shuttle.Test.MissingVoiceRunner do
  def cmd(_command, _args, _opts), do: {"terminal unavailable", 2}
end

defmodule Shuttle.Test.NoCaptureVoiceRunner do
  def cmd("tmux", _args, _opts), do: {"can't find session: hark-meeting", 1}
  def cmd(_command, _args, _opts), do: {"", 0}
end

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
    {:ok, _} = Voice.update(%{})
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

  test "persisted enable state stays visible through recorder failures and recovery", c do
    stop_supervised!(Voice)
    {:ok, result} = Agent.start_link(fn -> {:error, :unavailable} end)
    reconcile = fn _, _ -> Agent.get(result, & &1) end
    Env.start_scoped!({Voice, Keyword.put(c.opts, :reconcile, reconcile)})
    assert {:ok, %{enabled: true, state: "failed"}} = Voice.update(%{"enabled" => true})
    assert %{enabled: true, state: "failed"} = Voice.show()
    Agent.update(result, fn _ -> {:ok, %{available: true, meeting: nil}} end)
    assert {:ok, %{enabled: true, state: "starting"}} = Voice.update(%{})
    Agent.update(result, fn _ -> {:error, :stop_failed} end)
    assert {:ok, %{enabled: false, state: "failed"}} = Voice.update(%{"enabled" => false})
  end

  test "a failed mute after enabling still reports the persisted enabled switch", c do
    Env.put_app_env(:hark_path, false)
    File.mkdir_p!(Path.join(c.root, "hark"))
    # Mute can't inspect the terminal, but enabling has already persisted.
    Env.put_app_env(:meeting_runner, Shuttle.Test.MissingVoiceRunner)
    assert {:error, _} = Voice.update(%{"enabled" => true, "muted" => true})
    assert %{enabled: true, muted: true, state: "failed"} = Voice.show()
  end

  test "successful mute controls stay visible when subsequent reconciliation fails", c do
    stop_supervised!(Voice)
    Env.put_app_env(:meeting_runner, Shuttle.Test.NoCaptureVoiceRunner)
    Env.put_app_env(:hark_path, false)
    reconcile = fn _, _ -> {:error, :recorder_unavailable} end
    Env.start_scoped!({Voice, Keyword.put(c.opts, :reconcile, reconcile)})
    assert {:ok, %{muted: true, state: "failed"}} = Voice.update(%{"muted" => true})
    assert {:ok, %{muted: false, state: "failed"}} = Voice.update(%{"muted" => false})
    assert %{muted: false, state: "failed"} = Voice.show()
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

  test "slow recorder reconciliation cannot delay a target switch or its receipt timestamp", c do
    stop_supervised!(Voice)
    parent = self()

    reconcile = fn enabled, _ ->
      send(parent, {:blocked, self(), enabled})

      receive do
        :continue -> {:ok, %{available: true, meeting: nil}}
      end
    end

    Env.start_scoped!({Voice, Keyword.put(c.opts, :reconcile, reconcile)})
    assert_receive {:blocked, task, false}, 1_000
    before = DateTime.utc_now()

    assert {:ok, %{target: %{"fiber_id" => "project/new"}}} =
             Voice.target(%{"fiber_id" => "project/new"})

    assert %{target: %{"fiber_id" => "project/new"}} = Voice.show()

    [row] =
      File.read!(Voice.routes_path())
      |> String.split("\n", trim: true)
      |> Enum.map(&Jason.decode!/1)

    {:ok, stamp, _} = DateTime.from_iso8601(row["t"])
    assert DateTime.compare(stamp, before) != :lt
    assert DateTime.compare(stamp, DateTime.utc_now()) != :gt
    send(task, :continue)
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
