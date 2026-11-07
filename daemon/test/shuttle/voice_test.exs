defmodule Shuttle.Test.MissingVoiceRunner do
  def cmd(command, args, _opts) do
    if observer = Shuttle.Env.app(:voice_command_observer),
      do: send(observer, {:voice_command, command, args})

    {"terminal unavailable", 2}
  end
end

defmodule Shuttle.Test.NoCaptureVoiceRunner do
  def cmd("tmux", _args, _opts), do: {"can't find session: hark-voice", 1}
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
    {:ok, observed} = Agent.start_link(fn -> %{available: true, capture: nil} end)
    parent = self()

    reconcile = fn enabled, _opts ->
      send(parent, {:reconciled, enabled})
      {:ok, Agent.get(observed, & &1)}
    end

    opts = [
      name: Module.concat(__MODULE__, "S#{System.unique_integer([:positive])}"),
      poll_ms: 60_000,
      reconcile: reconcile,
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
              "words" => 200,
              "quiet_seconds" => 15
            }} = Config.read()

    for invalid <- [
          %{"enabled" => "yes"},
          %{"words" => 0},
          %{"pinned_quiet_seconds" => 0},
          %{"follow" => "no"},
          []
        ] do
      assert {:error, _} = Config.validate(invalid)
    end

    assert {:ok, %{enabled: true, state: "starting"}} = Voice.update(%{"enabled" => true})
    assert {:ok, %{"enabled" => true, "words" => 200}} = Config.read()
    assert {:error, _} = Voice.update(%{"muted" => "true"})
    assert File.exists?(Path.join(c.root, "voice.json"))
  end

  test "one quiet setting: a separate run quiet is dropped on read and on save", c do
    path = Path.join(c.root, "voice.json")
    File.write!(path, ~s({"quiet_seconds":4,"run_quiet_seconds":2}))

    assert {:ok, config} = Config.read()
    assert config["quiet_seconds"] == 4
    refute Map.has_key?(config, "run_quiet_seconds")

    assert :ok = Config.enable(false)
    refute path |> File.read!() |> Jason.decode!() |> Map.has_key?("run_quiet_seconds")
  end

  test "pin sets the target and follow together, ignores views, restores the view on follow, and survives restart",
       c do
    assert {:ok, %{enabled: true, follow: true, system_audio: false}} =
             Voice.update(%{"enabled" => true})

    assert {:ok, _} = Voice.target(%{"fiber_id" => "view/first"})

    pin = %{
      follow: false,
      target: %{fiber_id: "pinned/card", name: "Pinned", origin: Shuttle.Poller.own_host_id()}
    }

    assert %{"follow" => false, "target" => %{"fiber_id" => "pinned/card"}} =
             api_conn() |> post("/api/v1/voice", Jason.encode!(pin)) |> json_response(200)

    assert {:ok, %{target: %{"fiber_id" => "pinned/card"}, mode: "pinned"}} =
             Voice.target(%{"fiber_id" => "view/second"})

    assert {:ok, %{"follow" => false}} = Config.read()
    stop_supervised!(Voice)
    Env.start_scoped!({Voice, c.opts})
    assert {:ok, %{follow: false, target: %{"fiber_id" => "pinned/card"}}} = Voice.update(%{})
    assert {:ok, _} = Voice.target(%{"fiber_id" => "view/third"})

    assert {:ok, %{follow: true, target: %{"fiber_id" => "view/third"}}} =
             Voice.update(%{"follow" => true})

    assert {:ok, %{target: %{"fiber_id" => "view/fourth"}}} =
             Voice.target(%{"fiber_id" => "view/fourth"})

    assert {:error, _} = Voice.update(%{"target" => %{"fiber_id" => "unintended"}})
    assert {:error, _} = Voice.update(%{"follow" => false, "target" => %{}})
  end

  test "settings persist before the pin route is published", c do
    {:ok, _} = Voice.update(%{"enabled" => true})
    {:ok, _} = Voice.subscribe()
    parent = self()
    stop_supervised!(Voice)

    reconcile = fn _, _ ->
      send(parent, {:settings_at_reconcile, Config.read(), File.read(Voice.routes_path())})
      {:ok, Agent.get(c.observed, & &1)}
    end

    Env.start_scoped!({Voice, Keyword.put(c.opts, :reconcile, reconcile)})
    {:ok, _} = Voice.update(%{"follow" => false, "target" => %{"fiber_id" => "pinned/card"}})
    assert_received {:settings_at_reconcile, {:ok, %{"follow" => false}}, {:ok, bytes}}

    assert %{"fiber_id" => "pinned/card", "pinned" => true} =
             bytes |> String.trim() |> Jason.decode!()
  end

  test "follow chooses its own quiet threshold and discarded nested keys do not affect it", c do
    File.write!(Config.path(), ~s({"voice":{"quiet_seconds":2},"meeting":{"words":8}}))
    assert Config.thresholds() == %{"words" => 200, "quiet_seconds" => 15}
    assert :ok = Config.update(%{"follow" => false, "pinned_quiet_seconds" => 44})
    assert Config.thresholds() == %{"words" => 200, "quiet_seconds" => 44}
    refute File.read!(Path.join(c.root, "voice.json")) =~ "meeting"
  end

  test "toggle starts Listen and flips mute in both follow and pin states" do
    assert {:ok, %{enabled: true, muted: false}} = Voice.toggle()
    assert {:ok, %{muted: true}} = Voice.toggle()
    assert {:ok, _} = Voice.update(%{"follow" => false})
    assert {:ok, %{mode: "pinned", muted: false}} = Voice.toggle()
  end

  test "subscribers receive each new route as it is appended" do
    assert {:ok, _} = Voice.update(%{"enabled" => true})
    {:ok, _} = Voice.subscribe()
    assert {:ok, _} = Voice.target(%{"fiber_id" => "pushed/one", "origin" => nil})
    assert_receive {:voice_target, %{"fiber_id" => "pushed/one"}}
    assert {:ok, _} = Voice.target(%{"fiber_id" => "pushed/two"})
    assert_receive {:voice_target, %{"fiber_id" => "pushed/two"}}
    assert %{target: %{"fiber_id" => "pushed/two"}} = Voice.snapshot()
  end

  test "coldness follows owner runtime activity, with dormant and unknown targets cold" do
    alias Shuttle.Voice.Target

    entries = [
      %{fiber: %{"id" => "path/a", "uid" => "uid-a", "shuttle" => %{"host" => "owner"}}},
      %{
        fiber: %{"id" => "a", "uid" => "uid-a", "shuttle" => %{"host" => "owner"}},
        runtime: %{phase: "working"}
      }
    ]

    Env.put_app_env(:voice_target_entries, fn -> entries end)
    refute Target.cold?(%{"fiber_id" => "uid-a", "origin" => "owner"})
    assert Target.cold?(%{"fiber_id" => "a", "origin" => "other"})
    assert Target.cold?(%{"fiber_id" => "dormant", "origin" => "owner"})
    # A live worker waiting at its prompt for hours is warm.
    idle = %{
      fiber: %{"id" => "idle", "shuttle" => %{"host" => "owner"}},
      runtime: %{phase: "waiting", last_activity_at: 0}
    }

    Env.put_app_env(:voice_target_entries, fn -> [idle] end)
    refute Target.cold?(%{"fiber_id" => "idle", "origin" => "owner"})
  end

  test "partial words are a display-only preview pinned to the target they began under",
       c do
    transcript = Path.join(c.root, "voice.txt")
    partial = Path.rootname(transcript) <> ".partial"

    Agent.update(c.observed, fn _ ->
      %{
        available: true,
        capture: %{kind: "voice", launch: "voice", state: "live", transcript: transcript}
      }
    end)

    assert {:ok, %{preview: nil}} = Voice.update(%{"enabled" => true})
    assert {:ok, _} = Voice.target(%{"fiber_id" => "a"})
    File.write!(partial, "S1: Claude these are provisional\n")

    assert {:ok,
            %{
              preview: %{"fiber_id" => "a", "text" => "S1: Claude these are provisional"},
              pending: nil
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
    Agent.update(c.observed, fn _ -> %{available: true, capture: nil} end)
    assert {:ok, %{preview: nil}} = Voice.update(%{})
  end

  test "discard drops the live recording's unsent words and reports how many", c do
    stop_supervised!(Voice)
    {:ok, words} = Agent.start_link(fn -> 7 end)
    parent = self()

    opts =
      Keyword.merge(c.opts,
        monitor: fn "meeting" ->
          %{pending: nil, last: nil, pending_words: Agent.get(words, & &1)}
        end,
        discard: fn launch ->
          send(parent, {:discard, launch})
          {:ok, Agent.get_and_update(words, &{&1, 0})}
        end
      )

    Env.start_scoped!({Voice, opts})
    discard = fn -> api_conn() |> post("/api/v1/voice/discard", "{}") |> json_response(200) end

    assert %{"discarded" => 0, "pending_words" => 0} = discard.()
    refute_received {:discard, _}

    start_voice(c)
    assert {:ok, %{mode: "following", pending_words: 7}} = Voice.update(%{"enabled" => true})
    assert %{pending_words: 7} = Voice.snapshot()

    assert %{"discarded" => 7, "pending_words" => 0, "mode" => "following"} = discard.()
    assert_received {:discard, "meeting"}
    assert %{"discarded" => 0} = discard.()
  end

  test "a relay status timeout preserves the last listening snapshot", c do
    stop_supervised!(Voice)

    {:ok, status} =
      Agent.start_link(fn -> %{pending: %{text: "pending"}, last: %{status: "unconfirmed"}} end)

    monitor = fn _ -> Agent.get(status, & &1) end

    Agent.update(c.observed, fn _ ->
      %{
        available: true,
        capture: %{kind: "voice", launch: "voice", state: "live", error: nil, transcript: "file"}
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
         capture: %{kind: "voice", launch: "voice-recovered", state: "starting", error: nil}
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
    Env.put_app_env(:recorder_runner, Shuttle.Test.MissingVoiceRunner)
    assert {:error, _} = Voice.update(%{"enabled" => true, "muted" => true})
    assert %{enabled: true, muted: true, state: "failed"} = Voice.show()
  end

  test "successful mute controls stay visible when subsequent reconciliation fails", c do
    stop_supervised!(Voice)
    Env.put_app_env(:recorder_runner, Shuttle.Test.NoCaptureVoiceRunner)
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
        reconcile: &Shuttle.Recorder.reconcile_voice/2,
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
    Env.put_app_env(:recorder_runner, Shuttle.Test.NoCaptureVoiceRunner)
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

  test "a route and the target record the source that moved it" do
    assert {:ok, _} = Voice.update(%{"enabled" => true})

    assert {:ok, %{target: %{"fiber_id" => "a/card", "source" => "inbox"}}} =
             Voice.target(%{"fiber_id" => "a/card", "source" => "inbox"})

    assert [%{"fiber_id" => "a/card", "source" => "inbox"}] =
             Voice.routes_path()
             |> File.read!()
             |> String.split("\n", trim: true)
             |> Enum.map(&Jason.decode!/1)
  end

  test "Rex focus selects only while following and cannot move a fixed recording", c do
    params = %{"fiber_id" => "project/rex"}
    assert {:ok, %{target: nil}} = Voice.target(params)
    refute File.exists?(Voice.routes_path())

    assert {:ok, _} = Voice.update(%{"enabled" => true})
    assert {:ok, %{target: %{"fiber_id" => "project/rex"}}} = Voice.target(params)
    bytes = File.read!(Voice.routes_path())

    assert {:ok, _} = Voice.update(%{"enabled" => false})
    assert {:ok, _} = Voice.target(%{params | "fiber_id" => "project/off"})
    assert bytes == File.read!(Voice.routes_path())

    Agent.update(c.observed, fn _ ->
      %{available: true, capture: %{kind: "voice", launch: "fixed", state: "live"}}
    end)

    assert {:ok, %{enabled: true, state: "listening"}} =
             Voice.update(%{"enabled" => true, "follow" => false})

    pinned = File.read!(Voice.routes_path())
    assert {:ok, _} = Voice.target(%{params | "fiber_id" => "project/fixed"})
    assert pinned == File.read!(Voice.routes_path())
  end

  test "a target is named from served fibers, even when the lookup missed at the switch" do
    {:ok, served} = Agent.start_link(fn -> [] end)
    Env.put_app_env(:voice_fibers, fn -> Agent.get(served, & &1) end)
    assert {:ok, _} = Voice.update(%{"enabled" => true})

    assert {:ok, %{target: %{"name" => "01CARD", "origin" => host}}} =
             Voice.target(%{"fiber_id" => "01CARD"})

    card = %{"uid" => "01CARD", "name" => "The card", "shuttle" => %{"host" => host}}
    Agent.update(served, fn _ -> [card] end)
    assert %{target: %{"name" => "The card"}} = Voice.show()

    Agent.update(served, fn _ -> [] end)
    assert {:ok, %{target: %{"name" => "The card"}}} = Voice.target(%{"fiber_id" => "01CARD"})
  end

  test "target receipt time is durable and restored by a fresh supervisor", c do
    assert {:ok, _} = Voice.update(%{"enabled" => true})

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
    assert {:ok, _} = Voice.update(%{"enabled" => true})
    assert {:ok, _} = Voice.target(%{"fiber_id" => "project/first"})
    stop_supervised!(Voice)
    File.write!(Voice.routes_path(), ~s({"t":"partial), [:append])
    Env.start_scoped!({Voice, c.opts})
    assert %{target: %{"fiber_id" => "project/first"}} = Voice.show()
    assert {:ok, %{enabled: true}} = Voice.update(%{})
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

    for invalid <- ["{not-json", ~s({"enabled":true,"words":0})] do
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
        capture: %{
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

        {{:ok, %{available: true, capture: recorder.row}}, recorder}
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
        {:ok, %{available: true, capture: nil}}
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
    Agent.update(c.observed, &%{&1 | capture: row})
    assert {:ok, %{state: "failed"}} = Voice.update(%{"enabled" => true})

    Agent.update(
      c.observed,
      &%{&1 | capture: %{row | launch: "voice-stable", state: "live", error: nil}}
    )

    assert {:ok, %{state: "listening"}} = Voice.update(%{})
    Agent.update(clock, &(&1 + 30_000))
    assert {:ok, %{state: "listening"}} = Voice.update(%{})
    assert :sys.get_state(Env.server!(Voice)).retry.failures == 0
  end

  test "the board sets the target over HTTP only while following" do
    target = Jason.encode!(%{fiber_id: "project/seen", origin: "test-host", name: "Seen"})
    response = api_conn() |> post("/api/v1/voice/target", target)
    assert %{"target" => nil} = json_response(response, 200)

    assert {:ok, _} = Voice.update(%{"enabled" => true})
    response = api_conn() |> post("/api/v1/voice/target", target)
    assert %{"target" => %{"fiber_id" => "project/seen"}} = json_response(response, 200)

    assert %{"source" => "board", "fiber_id" => "project/seen"} =
             Voice.routes_path() |> File.read!() |> String.trim() |> Jason.decode!()

    assert (api_conn() |> post("/api/v1/voice/target", "{}")).status == 422
  end

  test "voice API answers from the local recorder" do
    response = api_conn() |> post("/api/v1/voice", Jason.encode!(%{enabled: true}))
    assert response.status == 200
    assert %{"enabled" => true, "state" => "starting"} = Jason.decode!(response.resp_body)

    assert %{"enabled" => true, "pending" => nil, "last" => nil} =
             api_conn() |> get("/api/v1/voice") |> Map.get(:resp_body) |> Jason.decode!()

    assert (api_conn() |> post("/api/v1/voice", ~s({"muted":3}))).status == 422
  end

  # A meeting start writes hark's lifecycle file, which wakes idle voice.
  defp start_voice(c) do
    Agent.update(c.observed, fn _ -> %{available: true, capture: voice_row()} end)
    write_lifecycle(c, "loading")
  end

  defp write_lifecycle(c, phase) do
    File.mkdir_p!(Path.join(c.root, "hark"))

    File.write!(
      Path.join([c.root, "hark", "meeting.json"]),
      ~s({"phase":"#{phase}","launch":"meeting"})
    )
  end

  defp voice_row,
    do: %{kind: "voice", launch: "meeting", state: "live", fiber: "project/sync", paused: false}
end
