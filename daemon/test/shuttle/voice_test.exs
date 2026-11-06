defmodule Shuttle.Test.MissingVoiceRunner do
  def cmd(command, args, _opts) do
    if observer = Shuttle.Env.app(:voice_command_observer),
      do: send(observer, {:voice_command, command, args})

    {"terminal unavailable", 2}
  end
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
      held: fn -> [] end,
      recovery: fn -> nil end,
      cold: fn _ -> false end,
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
              "cold_minutes" => 5,
              "words" => 200,
              "quiet_seconds" => 15
            }} = Config.read()

    for invalid <- [
          %{"enabled" => "yes"},
          %{"cold_minutes" => 0},
          %{"cold_minutes" => -1},
          %{"cold_minutes" => "5"},
          %{"words" => 0},
          %{"voice" => %{"words" => 0, "quiet_seconds" => 4}},
          %{"meeting" => %{"words" => 5, "quiet_seconds" => -1}},
          []
        ] do
      assert {:error, _} = Config.validate(invalid)
    end

    assert {:ok, %{enabled: true, state: "starting"}} = Voice.update(%{"enabled" => true})
    assert {:ok, %{"enabled" => true, "words" => 200}} = Config.read()
    assert {:error, _} = Voice.update(%{"muted" => "true"})
    assert File.exists?(Path.join(c.root, "voice.json"))
  end

  test "both modes share thresholds, including old nested files", c do
    path = Path.join(c.root, "voice.json")

    File.write!(
      path,
      ~s({"voice":{"words":42,"quiet_seconds":3},"meeting":{"words":75,"quiet_seconds":8}})
    )

    assert Config.thresholds("voice") == %{"words" => 42, "quiet_seconds" => 3}
    assert Config.thresholds("meeting") == Config.thresholds("voice")

    File.write!(path, ~s({"meeting":{"words":75,"quiet_seconds":8},"words":99}))
    assert Config.thresholds("voice") == %{"words" => 99, "quiet_seconds" => 8}
    assert Config.thresholds("meeting") == Config.thresholds("voice")
  end

  test "partial words are a display-only preview pinned to the target they began under",
       c do
    transcript = Path.join(c.root, "voice.txt")
    partial = Path.rootname(transcript) <> ".partial"

    Agent.update(c.observed, fn _ ->
      %{
        available: true,
        meeting: %{kind: "voice", launch: "voice", state: "live", transcript: transcript}
      }
    end)

    assert {:ok, _} = Voice.target(%{"fiber_id" => "a"})
    assert {:ok, %{preview: nil}} = Voice.update(%{"enabled" => true})
    File.write!(partial, "S1: Claude these are provisional\n")

    assert {:ok,
            %{
              preview: %{"fiber_id" => "a", "text" => "S1: Claude these are provisional"},
              pending: nil,
              held: []
            }} = Voice.update(%{})

    assert {:ok, %{preview: %{"fiber_id" => "a"}}} = Voice.target(%{"fiber_id" => "b"})
    assert {:ok, %{preview: nil}} = Voice.update(%{"muted" => true})

    assert {:ok, %{preview: %{"text" => "S1: Claude these are provisional"}}} =
             Voice.update(%{"muted" => false})

    File.write!(partial, "")
    assert {:ok, %{preview: nil}} = Voice.update(%{})
    File.write!(partial, "S1: next line")
    assert {:ok, %{preview: %{"fiber_id" => "b"}}} = Voice.update(%{})
    assert {:ok, %{preview: %{"fiber_id" => "b"}}} = Voice.target(%{"fiber_id" => "c"})
    File.write!(transcript, "13:00:00-13:00:02 me a finished line\n")
    File.write!(partial, "S1: speech that never paused")
    assert {:ok, %{preview: %{"fiber_id" => "c"}}} = Voice.update(%{})
    File.write!(partial, "S1: stale")
    assert {:ok, %{preview: nil}} = Voice.update(%{"enabled" => false})
    assert {:ok, %{preview: %{"text" => "S1: stale"}}} = Voice.update(%{"enabled" => true})
    Agent.update(c.observed, fn _ -> %{available: true, meeting: nil} end)
    assert {:ok, %{preview: nil}} = Voice.update(%{})
  end

  test "the mic level is shown only while hark's level file is under a second old", c do
    level = Path.join([c.root, "hark", "level.json"])
    File.mkdir_p!(Path.dirname(level))
    assert {:ok, %{level: nil}} = Voice.update(%{})

    now = System.os_time(:millisecond) / 1000
    File.write!(level, Jason.encode!(%{mic: -23.4, t: now}))
    assert %{level: %{mic: -23.4, at: at}} = Voice.show()
    assert {:ok, at_time, 0} = DateTime.from_iso8601(at)
    assert_in_delta DateTime.to_unix(at_time, :millisecond), now * 1000, 1

    assert %{"level" => %{"mic" => -23.4}} =
             json_response(get(api_conn(), "/api/v1/voice"), 200)

    File.write!(level, Jason.encode!(%{mic: -23.4, t: now - 5}))
    assert %{level: nil} = Voice.show()
  end

  test "coldness follows owner runtime activity, with dormant and unknown targets held" do
    alias Shuttle.Voice.Target
    now = 1_000_000
    assert Target.cold_runtime?(nil, 5, now)
    assert Target.cold_runtime?(%{}, 5, now)
    refute Target.cold_runtime?(%{phase: "working", last_activity_at: 0}, 5, now)
    refute Target.cold_runtime?(%{phase: "waiting", last_activity_at: now - 299_999}, 5, now)
    assert Target.cold_runtime?(%{phase: "waiting", last_activity_at: now - 300_000}, 5, now)
    assert Target.cold_runtime?(%{"phase" => "attention", "last_activity_at" => 0}, 5, now)
    refute Target.cold_runtime?(%{phase: "waiting", last_activity_at: now - 60_000}, 2, now)

    entries = [
      %{
        fiber: %{"id" => "a", "uid" => "uid-a", "shuttle" => %{"host" => "owner"}},
        runtime: %{phase: "working"}
      }
    ]

    Env.put_app_env(:voice_target_entries, fn -> entries end)
    refute Target.cold?(%{"fiber_id" => "uid-a", "origin" => "owner"})
    assert Target.cold?(%{"fiber_id" => "a", "origin" => "other"})
    assert Target.cold?(%{"fiber_id" => "dormant", "origin" => "owner"})
  end

  test "resolved edited-payload recovery is exposed instead of a generic failed delivery", c do
    recovery = %{
      "fiber_id" => "a",
      "status" => "unconfirmed",
      "at" => "2026-11-06T10:00:01Z",
      "detail" => "Copy retained correction"
    }

    :sys.replace_state(c.pid, fn state ->
      %{
        state
        | recovery: fn -> recovery end,
          snapshot: %{
            state.snapshot
            | last: %{
                "fiber_id" => "a",
                "status" => "failed",
                "at" => "2026-11-06T10:00:02Z",
                "detail" => "generic"
              }
          }
      }
    end)

    assert %{last: ^recovery} = Voice.show()
    delivered = %{"fiber_id" => "a", "status" => "delivered", "at" => "2026-11-06T10:00:03Z"}

    :sys.replace_state(c.pid, fn state ->
      %{state | snapshot: %{state.snapshot | last: delivered}}
    end)

    assert %{last: ^delivered} = Voice.show()
  end

  test "corrupt held metadata fails visibly instead of losing drafts", c do
    alias Shuttle.Voice.Held
    file = Path.join(c.root, "held.json")

    {state, _} =
      Held.append(Held.load(file), "launch", 42, %{"fiber_id" => "a", "origin" => "owner"}, [
        %{"speaker" => "S1", "text" => "words"}
      ])

    for offset <- [nil, -1, "42"] do
      assert_raise ArgumentError, "invalid held source offset", fn ->
        Held.append(state, "launch", offset, %{"fiber_id" => "a"}, [])
      end

      assert {:error, "invalid held source offset"} =
               Held.lookup(state, "launch", offset, %{"fiber_id" => "a"})
    end

    for invalid <- [
          put_in(state, ["cards", Access.at(0), "segments", Access.at(0), "speaker"], nil),
          put_in(state, ["cards", Access.at(0), "checkpoints"], []),
          put_in(state, ["cards", Access.at(0), "after"], 99),
          Map.put(state, "attempts", %{"id" => %{"status" => "failed", "text" => "edits"}})
        ] do
      File.write!(file, Jason.encode!(invalid))
      assert {:error, "invalid held voice state"} = Held.list(Held.load(file))
    end
  end

  test "public held segments distinguish repeated speech from an edited prefix", c do
    alias Shuttle.Voice.Held
    target = %{"fiber_id" => "a", "origin" => "owner"}
    state = Held.load(Path.join(c.root, "segments.json"))

    {state, first} =
      Held.append(state, "launch", 42, target, [%{"speaker" => "S1", "text" => "hello world"}])

    assert first["segments"] == [%{"through" => 1, "text" => "S1: hello world"}]
    assert {:ok, state} = Held.edit(state, first["id"], 1, "S1: hello")

    {state, grown} =
      Held.append(state, "launch", 84, target, [%{"speaker" => "S1", "text" => "world"}])

    assert grown["segments"] == [
             %{"through" => 1, "text" => "S1: hello"},
             %{"through" => 2, "text" => " world"}
           ]

    assert grown["text"] == "S1: hello world"
    assert {:ok, state} = Held.edit(state, first["id"], 2, "S1: replacement")
    assert [%{"segments" => [%{"through" => 2, "text" => "S1: replacement"}]}] = Held.list(state)

    {state, _} =
      Held.append(state, "launch", 126, target, [%{"speaker" => "S1", "text" => "suffix"}])

    assert {:ok, state, "S1: replacement"} = Held.take(state, first["id"], 2)

    assert [
             %{
               "after" => 2,
               "through" => 3,
               "text" => "S1: suffix",
               "segments" => [%{"through" => 3, "text" => "S1: suffix"}]
             }
           ] = Held.list(state)
  end

  test "held draft APIs consume once and report claim conflicts without launching", c do
    alias Shuttle.Meeting.TranscriptRelay
    name = Module.concat(__MODULE__, "Relay#{System.unique_integer([:positive])}")
    start_supervised!({TranscriptRelay, name: name, directory: Path.join(c.root, "relays")})
    Env.put_server(TranscriptRelay, name)
    :sys.replace_state(c.pid, fn state -> %{state | held: fn -> TranscriptRelay.held() end} end)
    coordinator = Module.concat(name, Coordinator)

    held =
      GenServer.call(
        coordinator,
        {:hold, "launch", 42, %{"fiber_id" => "a", "origin" => "owner"},
         [%{"speaker" => "me", "text" => "first words"}]}
      )

    assert %{"held" => [^held]} = json_response(get(api_conn(), "/api/v1/voice"), 200)
    edited = Map.put(held, "text", "me: edited")

    assert %{"held" => [%{"text" => "me: edited"}]} =
             json_response(post(api_conn(), "/api/v1/voice/draft", edited), 200)

    assert %{"held" => []} = json_response(post(api_conn(), "/api/v1/voice/release", held), 200)
    assert %{"error" => _} = json_response(post(api_conn(), "/api/v1/voice/release", held), 409)
    assert %{"error" => _} = json_response(post(api_conn(), "/api/v1/voice/draft", %{}), 422)

    assert %{"error" => _} =
             json_response(
               post(api_conn(), "/api/v1/voice/draft", Map.put(held, "text", nil)),
               422
             )
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

  test "a relay status timeout preserves the last listening snapshot", c do
    stop_supervised!(Voice)

    {:ok, status} =
      Agent.start_link(fn -> %{pending: %{text: "pending"}, last: %{status: "unconfirmed"}} end)

    monitor = fn _ -> Agent.get(status, & &1) end

    Agent.update(c.observed, fn _ ->
      %{
        available: true,
        meeting: %{kind: "voice", launch: "voice", state: "live", error: nil, transcript: "file"}
      }
    end)

    Env.start_scoped!({Voice, Keyword.put(c.opts, :monitor, monitor)})

    assert {:ok,
            %{state: "listening", pending: %{text: "pending"}, last: %{status: "unconfirmed"}}} =
             Voice.update(%{"enabled" => true})

    Agent.update(status, fn _ -> :timeout end)

    assert {:ok,
            %{
              state: "listening",
              pending: %{text: "pending"},
              last: %{status: "unconfirmed"},
              error: nil
            }} = Voice.update(%{})
  end

  test "persisted enable state stays visible through recorder failures and recovery", c do
    stop_supervised!(Voice)
    {:ok, result} = Agent.start_link(fn -> {:error, :unavailable} end)
    reconcile = fn _, _ -> Agent.get(result, & &1) end
    Env.start_scoped!({Voice, Keyword.put(c.opts, :reconcile, reconcile)})
    assert {:ok, %{enabled: true, state: "failed"}} = Voice.update(%{"enabled" => true})
    assert %{enabled: true, state: "failed"} = Voice.show()

    Agent.update(result, fn _ ->
      {:ok,
       %{
         available: true,
         meeting: %{kind: "voice", launch: "voice-recovered", state: "starting", error: nil}
       }}
    end)

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

  test "disabled voice without lifecycle evidence probes an unavailable terminal only once", c do
    stop_supervised!(Voice)
    Env.put_app_env(:voice_command_observer, self())

    opts =
      Keyword.merge(c.opts,
        reconcile: &Shuttle.Meeting.reconcile_voice/2,
        capture_opts: [runner: Shuttle.Test.MissingVoiceRunner, hark_path: false]
      )

    pid = Env.start_scoped!({Voice, opts})
    assert {:ok, %{state: "failed", enabled: false, error: error}} = Voice.update(%{})
    assert error =~ "terminal unavailable"
    assert_receive {:voice_command, "tmux", _}

    for _ <- 1..3 do
      send(pid, :tick)
      assert {:ok, %{state: "failed", enabled: false}} = Voice.update(%{})
    end

    refute_receive {:voice_command, _, _}
  end

  test "idle off snapshots retain explicit mute changes" do
    Env.put_app_env(:meeting_runner, Shuttle.Test.NoCaptureVoiceRunner)
    Env.put_app_env(:hark_path, false)
    assert {:ok, %{state: "off", muted: true}} = Voice.update(%{"muted" => true})
    assert {:ok, %{state: "off", muted: true}} = Voice.update(%{})
    assert {:ok, %{state: "off", muted: false}} = Voice.update(%{"muted" => false})
  end

  test "Rex focus warnings appear in status, clear on recovery, and do not hide recorder failures",
       c do
    Voice.focus_error("Rex needs Accessibility access")
    assert %{error: "Rex needs Accessibility access"} = Voice.show()
    assert {:ok, _} = Voice.update(%{})
    assert %{error: "Rex needs Accessibility access"} = Voice.show()
    Voice.focus_error(nil)
    assert %{error: nil} = Voice.show()

    stop_supervised!(Voice)

    Env.start_scoped!(
      {Voice, Keyword.put(c.opts, :reconcile, fn _, _ -> {:error, :capture_failed} end)}
    )

    assert {:ok, %{error: capture_error}} = Voice.update(%{})
    Voice.focus_error("Rex needs Accessibility access")
    assert %{error: ^capture_error} = Voice.show()
  end

  test "a Voice-only restart restores the active Rex fallback warning", c do
    watcher =
      Env.start_scoped!(
        {Shuttle.RexFocus,
         name: nil,
         poll_ms: 60_000,
         active?: fn -> true end,
         title: fn -> {:error, :accessibility} end,
         command: fn -> nil end}
      )

    :sys.get_state(watcher)
    assert %{error: warning} = Voice.show()
    assert warning =~ "Accessibility"
    stop_supervised!(Voice)
    replacement = Env.start_scoped!({Voice, c.opts})
    assert replacement != c.pid
    assert {:ok, %{enabled: true}} = Voice.update(%{"enabled" => true})
    assert %{error: nil} = Voice.show()
    send(watcher, :tick)
    :sys.get_state(watcher)
    assert %{enabled: true, error: ^warning} = Voice.show()
  end

  test "Rex focus selects only while following and cannot move a fixed recording", c do
    params = %{"fiber_id" => "project/rex", "source" => "rex"}
    assert {:ok, %{target: nil}} = Voice.target(params)
    refute File.exists?(Voice.routes_path())

    assert {:ok, _} = Voice.update(%{"enabled" => true})
    assert {:ok, %{target: %{"fiber_id" => "project/rex"}}} = Voice.target(params)
    bytes = File.read!(Voice.routes_path())

    # Persisted off wins even before recorder reconciliation updates the snapshot.
    assert :ok = Config.enable(false)
    assert {:ok, _} = Voice.target(%{params | "fiber_id" => "project/off"})
    assert bytes == File.read!(Voice.routes_path())

    Agent.update(c.observed, fn _ ->
      %{available: true, meeting: %{kind: "meeting", launch: "fixed", state: "live"}}
    end)

    assert {:ok, %{enabled: true, state: "yielded"}} = Voice.update(%{"enabled" => true})
    assert {:ok, _} = Voice.target(%{params | "fiber_id" => "project/fixed"})
    assert bytes == File.read!(Voice.routes_path())

    # Board selection still uses the same route journal while following is off.
    assert {:ok, %{target: %{"fiber_id" => "project/board"}}} =
             Voice.target(%{"fiber_id" => "project/board"})
  end

  test "a target is named from served fibers, even when the lookup missed at the switch" do
    {:ok, served} = Agent.start_link(fn -> [] end)
    Env.put_app_env(:meeting_fibers, fn -> Agent.get(served, & &1) end)

    assert {:ok, %{target: %{"name" => "01CARD", "origin" => host}}} =
             Voice.target(%{"fiber_id" => "01CARD"})

    card = %{"uid" => "01CARD", "name" => "The card", "shuttle" => %{"host" => host}}
    Agent.update(served, fn _ -> [card] end)
    assert %{target: %{"name" => "The card"}} = Voice.show()

    Agent.update(served, fn _ -> [] end)
    assert {:ok, %{target: %{"name" => "The card"}}} = Voice.target(%{"fiber_id" => "01CARD"})
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

  test "invalid settings fail off, stop reconciliation and the off switch repairs invalid JSON",
       c do
    assert {:ok, %{enabled: true}} = Voice.update(%{"enabled" => true})

    for invalid <- ["{not-json", ~s({"enabled":true,"voice":{"words":0,"quiet_seconds":1}})] do
      File.write!(Config.path(), invalid)
      assert {:ok, %{enabled: false, state: "failed", error: error}} = Voice.update(%{})
      assert error =~ "invalid voice settings"
      assert_receive {:reconciled, false}
      assert Process.alive?(c.pid)
      assert {:ok, %{enabled: false, state: "off"}} = Voice.update(%{"enabled" => false})
      assert {:ok, %{"enabled" => false}} = Config.read()
      assert {:ok, %{enabled: true}} = Voice.update(%{"enabled" => true})
    end
  end

  test "route decode and truncation failures stay visible without crashing Voice", c do
    for bad <- [:decode, :truncate] do
      stop_supervised!(Voice)
      path = Path.join(c.root, "routes-#{bad}")

      if bad == :decode do
        File.write!(path, "not-json\n")
      else
        File.write!(path, Jason.encode!(%{fiber_id: "project/target"}) <> "\npartial")
        File.chmod!(path, 0o444)
        assert {:ok, _} = File.read(path)
      end

      pid = Env.start_scoped!({Voice, Keyword.put(c.opts, :routes_path, path)})
      assert {:ok, %{enabled: false, state: "failed", error: error}} = Voice.update(%{})
      assert error =~ "voice route recovery failed"
      assert Process.alive?(pid)
      assert {:error, ^error} = Voice.target(%{"fiber_id" => "project/target"})

      if bad == :decode do
        assert File.read!(path) == "not-json\n"
      else
        assert error =~ "eacces"
        assert File.read!(path) =~ "partial"
      end
    end
  end

  test "relay startup and monitor errors are visible without restarting the recorder", c do
    stop_supervised!(Voice)

    Agent.update(c.observed, fn _ ->
      %{
        available: true,
        meeting: %{
          kind: "voice",
          launch: "voice-live",
          state: "live",
          transcript: "/tmp/voice.txt",
          error: nil
        }
      }
    end)

    opts =
      Keyword.merge(c.opts,
        relay: fn _, _ -> {:error, :relay_write_failed} end,
        monitor: fn _ -> flunk("a failed relay start must not be queried") end
      )

    pid = Env.start_scoped!({Voice, opts})
    assert {:ok, %{state: "failed", error: error}} = Voice.update(%{"enabled" => true})
    assert error =~ "relay_write_failed"
    assert Process.alive?(pid)
    stop_supervised!(Voice)

    opts =
      Keyword.merge(c.opts,
        monitor: fn _ -> %{pending: nil, last: nil, error: "delivery unavailable"} end
      )

    Env.start_scoped!({Voice, opts})
    assert {:ok, %{state: "failed", error: "delivery unavailable"}} = Voice.update(%{})
  end

  test "crashes back off exponentially, keep one failed row and latch until an enabled toggle",
       c do
    stop_supervised!(Voice)
    {:ok, clock} = Agent.start_link(fn -> 0 end)
    {:ok, recorder} = Agent.start_link(fn -> %{row: nil, launches: 0} end)

    reconcile = fn enabled, opts ->
      Agent.get_and_update(recorder, fn recorder ->
        recorder =
          cond do
            not enabled ->
              %{recorder | row: nil}

            (is_nil(recorder.row) and opts[:voice_start]) or opts[:restart_voice] ->
              launch = "voice-#{recorder.launches + 1}"

              %{
                row: %{kind: "voice", state: "live", launch: launch, error: nil},
                launches: recorder.launches + 1
              }

            true ->
              recorder
          end

        {{:ok, %{available: true, meeting: recorder.row}}, recorder}
      end)
    end

    opts = Keyword.merge(c.opts, reconcile: reconcile, clock: fn -> Agent.get(clock, & &1) end)
    Env.start_scoped!({Voice, opts})
    assert {:ok, %{state: "listening"}} = Voice.update(%{"enabled" => true})

    for failure <- 1..5 do
      Agent.update(recorder, fn r -> %{r | row: %{r.row | state: "failed", error: "crashed"}} end)
      assert {:ok, %{state: "failed"}} = Voice.update(%{})
      for _ <- 1..3, do: assert({:ok, %{state: "failed"}} = Voice.update(%{}))
      assert Agent.get(recorder, & &1.launches) == failure

      if failure < 5 do
        delay = 1_000 * Integer.pow(2, failure - 1)
        Agent.update(clock, &(&1 + delay - 1))
        assert {:ok, %{state: "failed"}} = Voice.update(%{})
        assert Agent.get(recorder, & &1.launches) == failure
        Agent.update(clock, &(&1 + 1))
        assert {:ok, %{state: "listening"}} = Voice.update(%{})
        assert Agent.get(recorder, & &1.launches) == failure + 1
      end
    end

    Agent.update(clock, &(&1 + 1_000_000))
    assert {:ok, %{state: "failed", error: error}} = Voice.update(%{})
    assert error =~ "toggle enabled"
    assert Agent.get(recorder, & &1.launches) == 5
    Agent.update(recorder, fn r -> %{r | row: %{r.row | state: "live", error: nil}} end)
    assert {:ok, %{state: "failed"}} = Voice.update(%{"enabled" => true})
    assert {:ok, %{state: "off"}} = Voice.update(%{"enabled" => false})
    assert {:ok, %{state: "listening"}} = Voice.update(%{"enabled" => true})
    assert Agent.get(recorder, & &1.launches) == 6
  end

  test "startup failures use the same bounded retry budget", c do
    stop_supervised!(Voice)
    {:ok, clock} = Agent.start_link(fn -> 0 end)
    {:ok, attempts} = Agent.start_link(fn -> 0 end)

    reconcile = fn enabled, opts ->
      if enabled and opts[:voice_start] do
        Agent.update(attempts, &(&1 + 1))
        {:error, :launch_failed}
      else
        {:ok, %{available: true, meeting: nil}}
      end
    end

    opts = Keyword.merge(c.opts, reconcile: reconcile, clock: fn -> Agent.get(clock, & &1) end)
    Env.start_scoped!({Voice, opts})
    assert {:ok, %{state: "failed"}} = Voice.update(%{"enabled" => true})
    assert Agent.get(attempts, & &1) == 1

    for failure <- 1..4 do
      for _ <- 1..3, do: Voice.update(%{})
      assert Agent.get(attempts, & &1) == failure
      Agent.update(clock, &(&1 + 1_000 * Integer.pow(2, failure - 1)))
      assert {:ok, %{state: "failed"}} = Voice.update(%{})
    end

    Agent.update(clock, &(&1 + 1_000_000))
    assert {:ok, %{state: "failed", error: error}} = Voice.update(%{})
    assert error =~ "toggle enabled"
    assert Agent.get(attempts, & &1) == 5
  end

  test "a stable recorder resets its fast-crash budget", c do
    stop_supervised!(Voice)
    {:ok, clock} = Agent.start_link(fn -> 0 end)
    opts = Keyword.put(c.opts, :clock, fn -> Agent.get(clock, & &1) end)
    Env.start_scoped!({Voice, opts})
    row = %{kind: "voice", state: "failed", launch: "voice-first", error: "crashed"}
    Agent.update(c.observed, &%{&1 | meeting: row})
    assert {:ok, %{state: "failed"}} = Voice.update(%{"enabled" => true})

    Agent.update(
      c.observed,
      &%{&1 | meeting: %{row | launch: "voice-stable", state: "live", error: nil}}
    )

    assert {:ok, %{state: "listening"}} = Voice.update(%{})
    Agent.update(clock, &(&1 + 30_000))
    assert {:ok, %{state: "listening"}} = Voice.update(%{})
    assert :sys.get_state(Env.server!(Voice)).retry.failures == 0
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
