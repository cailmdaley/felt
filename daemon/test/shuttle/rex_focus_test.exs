defmodule Shuttle.Test.RexTitleRunner do
  def cmd(command, args, opts) do
    send(Shuttle.Env.app(:rex_title_observer), {:title_command, command, args, opts})
    Shuttle.Env.app(:rex_title_result)
  end
end

defmodule Shuttle.RexFocusTest do
  use ExUnit.Case, async: true
  alias Shuttle.RexFocus
  @moduletag :tmp_dir

  defp event(sid \\ "session:a", wid \\ "window:a") do
    %{
      "type" => "session_event",
      "payload" => %{
        "session_id" => sid,
        "event" => %{"type" => "active_window_changed", "payload" => %{"window_id" => wid}}
      }
    }
  end

  defp bindings do
    %{
      "bindings" => %{
        "worker" => %{
          "session_id" => "session:a",
          "window_id" => "window:a",
          "fiber" => "project/task",
          "family" => "project/task",
          "depth" => 0
        }
      }
    }
  end

  defp fibers do
    [%{"id" => "project/task", "name" => "Task", "shuttle" => %{"host" => "test-host"}}]
  end

  test "a worker window selects its constitution through the shared voice target" do
    assert %{"fiber_id" => "project/task", "origin" => "test-host", "name" => "Task"} =
             RexFocus.target(event(), bindings(), fibers())
  end

  test "non-worker windows, another session's window and plain fibers leave the target alone" do
    assert nil == RexFocus.target(event("session:a", "window:other"), bindings(), fibers())
    assert nil == RexFocus.target(event("session:other", "window:a"), bindings(), fibers())
    assert nil == RexFocus.target(event(), bindings(), [%{"id" => "project/task"}])

    assert nil ==
             RexFocus.target(event(), bindings(), [%{"id" => "project/task", "shuttle" => %{}}])

    assert nil == RexFocus.target(%{"type" => "client_changed"}, bindings(), fibers())
  end

  test "title mapping uses worker and session labels, rejects program titles and ambiguity" do
    bindings = bindings()

    assert %{"fiber_id" => "project/task"} =
             RexFocus.title_target("task - project/task", bindings, fibers())

    assert nil == RexFocus.title_target("", bindings, fibers())
    assert nil == RexFocus.title_target("zsh ~ - project/task", bindings, fibers())
    assert nil == RexFocus.title_target("task - another/session", bindings, fibers())

    assert nil ==
             RexFocus.title_target("task - project/task", bindings, [%{"id" => "project/task"}])

    child = put_in(bindings, ["bindings", "worker", "depth"], 2)
    child = put_in(child, ["bindings", "worker", "family"], "project/root")

    assert %{"fiber_id" => "project/task"} =
             RexFocus.title_target("\u2060\u2003└ task - project/root", child, fibers())

    ambiguous = put_in(bindings, ["bindings", "another"], bindings["bindings"]["worker"])
    assert nil == RexFocus.title_target("task - project/task", ambiguous, fibers())
  end

  test "a remote worker's window resolves through the served fiber tree to its origin" do
    hub = %{
      "id" => "01HUB",
      "uid" => "01HUB",
      "slug" => "science/unions/unions-hub",
      "name" => "UNIONS hub",
      "shuttle" => %{"host" => "fir"}
    }

    child = %{
      "id" => "01CHILD",
      "uid" => "01CHILD",
      "slug" => "science/unions/unions-hub/onecov",
      "name" => "OneCov",
      "shuttle" => %{"host" => "fir"}
    }

    # The loom's local copy of the same fiber, as the Mac serves it.
    local_copy = %{child | "id" => "science/unions/unions-hub/onecov"}
    fibers = fibers() ++ [hub, local_copy, child]

    assert %{"fiber_id" => "01CHILD", "origin" => "fir", "name" => "OneCov"} ==
             RexFocus.title_target(
               "\u2060└ onecov - unions/unions-hub",
               bindings(),
               fibers,
               "mac"
             )

    assert %{"fiber_id" => "01HUB", "origin" => "fir"} =
             RexFocus.title_target("unions-hub - unions/unions-hub", bindings(), fibers, "mac")

    # Wrong depth or session label, or the worker's own host, names nothing.
    assert nil == RexFocus.title_target("onecov - unions/unions-hub", bindings(), fibers, "mac")
    assert nil == RexFocus.title_target("└ onecov - unions/other", bindings(), fibers, "mac")
    assert nil == RexFocus.title_target("└ onecov - unions/unions-hub", bindings(), fibers, "fir")

    # The same labels on two hosts are ambiguous.
    twin = %{child | "uid" => "01TWIN", "id" => "01TWIN", "shuttle" => %{"host" => "nibi"}}

    assert nil ==
             RexFocus.title_target(
               "└ onecov - unions/unions-hub",
               bindings(),
               fibers ++ [twin],
               "mac"
             )

    # A local binding wins over a remote fiber with the same labels.
    remote_task = %{"id" => "01R", "slug" => "project/task", "shuttle" => %{"host" => "fir"}}

    assert %{"origin" => "test-host"} =
             RexFocus.title_target(
               "task - project/task",
               bindings(),
               fibers() ++ [remote_task],
               "mac"
             )
  end

  test "accessibility polling routes across sessions, ignores blanks, and never overwrites later board selection",
       c do
    title = start_supervised!({Agent, fn -> {:ok, "task - project/task"} end})
    other = %{"fiber" => "other/work", "family" => "other/work", "depth" => 0}
    all_bindings = put_in(bindings(), ["bindings", "other"], other)

    all_fibers =
      fibers() ++
        [%{"id" => "other/work", "name" => "Work", "shuttle" => %{"host" => "test-host"}}]

    {watcher, active, pids} =
      watcher(c.tmp_dir, true,
        poll_ms: 60_000,
        title: fn -> Agent.get(title, & &1) end,
        bindings: fn -> {:ok, all_bindings} end,
        fibers: fn -> all_fibers end
      )

    assert_receive {:selected, %{"fiber_id" => "project/task"}}
    refute File.exists?(pids)
    send(watcher, :tick)
    :sys.get_state(watcher)
    refute_receive {:selected, _}

    Agent.update(title, fn _ -> {:ok, ""} end)
    send(watcher, :tick)
    :sys.get_state(watcher)
    refute_receive {:selected, _}
    Agent.update(title, fn _ -> {:ok, "work - other/work"} end)
    send(watcher, :tick)
    assert_receive {:selected, %{"fiber_id" => "other/work"}}

    Agent.update(title, fn _ -> {:ok, "zsh ~ - project/task"} end)
    send(watcher, :tick)
    :sys.get_state(watcher)
    refute_receive {:selected, _}
    Agent.update(active, fn _ -> false end)
    Agent.update(title, fn _ -> {:ok, "task - project/task"} end)
    send(watcher, :tick)
    :sys.get_state(watcher)
    refute_receive {:selected, _}
    Agent.update(active, fn _ -> true end)
    send(watcher, :tick)
    assert_receive {:selected, %{"fiber_id" => "project/task"}}
  end

  test "late bindings are retried but unrelated binding writes cannot override the board", c do
    observed = start_supervised!({Agent, fn -> %{"bindings" => %{}} end})

    {watcher, _, _} =
      watcher(c.tmp_dir, true,
        title: fn -> {:ok, "task - project/task"} end,
        bindings: fn -> {:ok, Agent.get(observed, & &1)} end
      )

    :sys.get_state(watcher)
    refute_receive {:selected, _}
    Agent.update(observed, fn _ -> bindings() end)
    send(watcher, :tick)
    assert_receive {:selected, %{"fiber_id" => "project/task"}}

    Agent.update(observed, &Map.put(&1, "viewers", %{"new-viewer" => %{}}))
    send(watcher, :tick)
    :sys.get_state(watcher)
    refute_receive {:selected, _}
  end

  test "cold fiber inventory is retried without a title or binding change", c do
    inventory = start_supervised!({Agent, fn -> [] end})

    {watcher, _, _} =
      watcher(c.tmp_dir, true,
        poll_ms: 60_000,
        title: fn -> {:ok, "task - project/task"} end,
        fibers: fn -> Agent.get(inventory, & &1) end
      )

    :sys.get_state(watcher)
    refute_receive {:selected, _}
    Agent.update(inventory, fn _ -> fibers() end)
    send(watcher, :tick)
    assert_receive {:selected, %{"fiber_id" => "project/task"}}
    send(watcher, :tick)
    :sys.get_state(watcher)
    refute_receive {:selected, _}
  end

  test "missing AX access warns once, falls back to events, and recovers without retaining the stream",
       c do
    parent = self()
    title = start_supervised!({Agent, fn -> {:error, :accessibility} end})

    {watcher, _, pids} =
      watcher(c.tmp_dir, true,
        title: fn -> Agent.get(title, & &1) end,
        warn: fn message -> send(parent, {:warning, message}) end
      )

    assert_receive {:warning, nil}
    assert_receive {:warning, message}
    assert message =~ "Accessibility"
    assert_receive {:selected, %{"fiber_id" => "project/task"}}
    [pid] = read_pids(pids)
    send(watcher, :tick)
    :sys.get_state(watcher)
    refute_receive {:warning, _}
    Agent.update(title, fn _ -> {:ok, "task - project/task"} end)
    send(watcher, :tick)
    assert_receive {:warning, nil}
    assert_receive {:selected, %{"fiber_id" => "project/task"}}
    assert :sys.get_state(watcher).port == nil
    eventually(fn -> not alive?(pid) end)
    refute_receive {:warning, _}
  end

  test "AX recovery cannot reselect an unchanged worker over a later board choice", c do
    title = start_supervised!({Agent, fn -> {:ok, "task - project/task"} end})

    {watcher, _, _} =
      watcher(c.tmp_dir, true,
        poll_ms: 60_000,
        title: fn -> Agent.get(title, & &1) end,
        command: fn -> nil end
      )

    assert_receive {:selected, %{"fiber_id" => "project/task"}}
    Agent.update(title, fn _ -> {:error, :unavailable} end)
    send(watcher, :tick)
    :sys.get_state(watcher)
    Agent.update(title, fn _ -> {:ok, "task - project/task"} end)
    send(watcher, :tick)
    :sys.get_state(watcher)
    refute_receive {:selected, _}
  end

  test "Rex coming to the front re-asserts its worker; titles behind another app never route",
       c do
    front = start_supervised!({Agent, fn -> true end}, id: :front)
    title = start_supervised!({Agent, fn -> {:ok, "task - project/task"} end}, id: :title)
    other = %{"fiber" => "other/work", "family" => "other/work", "depth" => 0}

    {watcher, _, _} =
      watcher(c.tmp_dir, true,
        poll_ms: 60_000,
        front?: fn -> Agent.get(front, & &1) end,
        title: fn -> Agent.get(title, & &1) end,
        bindings: fn -> {:ok, put_in(bindings(), ["bindings", "other"], other)} end,
        fibers: fn ->
          fibers() ++
            [%{"id" => "other/work", "name" => "Work", "shuttle" => %{"host" => "test-host"}}]
        end
      )

    tick = fn ->
      send(watcher, :tick)
      :sys.get_state(watcher)
    end

    assert_receive {:selected, %{"fiber_id" => "project/task"}}
    tick.()
    refute_receive {:selected, _}

    Agent.update(front, fn _ -> false end)
    tick.()
    Agent.update(title, fn _ -> {:ok, "work - other/work"} end)
    tick.()
    refute_receive {:selected, _}

    Agent.update(front, fn _ -> true end)
    tick.()
    assert_receive {:selected, %{"fiber_id" => "other/work"}}
    tick.()
    refute_receive {:selected, _}

    Agent.update(front, fn _ -> false end)
    tick.()
    Agent.update(front, fn _ -> true end)
    tick.()
    assert_receive {:selected, %{"fiber_id" => "other/work"}}
  end

  test "Rex's moves reach a watching board with voice off, and voice stays out of it", c do
    front = start_supervised!({Agent, fn -> true end}, id: :front)
    title = start_supervised!({Agent, fn -> {:ok, "task - project/task"} end}, id: :title)
    other = %{"fiber" => "other/work", "family" => "other/work", "depth" => 0}

    {watcher, _, _} =
      watcher(c.tmp_dir, false,
        poll_ms: 60_000,
        watched?: fn -> true end,
        front?: fn -> Agent.get(front, & &1) end,
        title: fn -> Agent.get(title, & &1) end,
        bindings: fn -> {:ok, put_in(bindings(), ["bindings", "other"], other)} end,
        fibers: fn ->
          fibers() ++
            [%{"id" => "other/work", "name" => "Work", "shuttle" => %{"host" => "test-host"}}]
        end
      )

    tick = fn ->
      send(watcher, :tick)
      :sys.get_state(watcher)
    end

    # Where Rex already stands when the watch begins is not a move.
    tick.()
    refute_receive {:published, _}, 30

    Agent.update(title, fn _ -> {:ok, "work - other/work"} end)
    tick.()
    assert_receive {:published, %{"fiber_id" => "other/work", "origin" => "test-host"}}
    tick.()
    refute_receive {:published, _}, 30

    # A selection the board makes behind its own window does not come back,
    # and Rex coming forward on it moves nothing.
    Agent.update(front, fn _ -> false end)
    tick.()
    Agent.update(title, fn _ -> {:ok, "task - project/task"} end)
    tick.()
    refute_receive {:published, _}, 30
    Agent.update(front, fn _ -> true end)
    tick.()
    refute_receive {:published, _}, 30

    # A click on Rex's sidebar from behind changes the worker as it comes forward.
    Agent.update(front, fn _ -> false end)
    tick.()
    Agent.update(front, fn _ -> true end)
    Agent.update(title, fn _ -> {:ok, "work - other/work"} end)
    tick.()
    assert_receive {:published, %{"fiber_id" => "other/work"}}

    # The bare app name, as a locked screen shows, is no worker.
    Agent.update(front, fn _ -> false end)
    Agent.update(title, fn _ -> {:ok, "Rex Beta"} end)
    tick.()
    Agent.update(front, fn _ -> true end)
    Agent.update(title, fn _ -> {:ok, "work - other/work"} end)
    tick.()
    refute_receive {:published, _}, 30
    refute_receive {:selected, _}, 30
  end

  test "following that starts with Rex in front routes its worker to voice at once", c do
    following = start_supervised!({Agent, fn -> false end}, id: :following)

    {watcher, _, _} =
      watcher(c.tmp_dir, false,
        poll_ms: 60_000,
        watched?: fn -> true end,
        active?: fn -> Agent.get(following, & &1) end,
        title: fn -> {:ok, "task - project/task"} end
      )

    tick = fn ->
      send(watcher, :tick)
      :sys.get_state(watcher)
    end

    tick.()
    refute_receive {:selected, _}, 30
    Agent.update(following, fn _ -> true end)
    tick.()
    assert_receive {:selected, %{"fiber_id" => "project/task"}}
    refute_receive {:published, _}, 30
    tick.()
    refute_receive {:selected, _}, 30
  end

  test "behind, the title is read only now and then, and an unmatched one retries slowly", c do
    parent = self()
    front = start_supervised!({Agent, fn -> false end}, id: :front)

    {watcher, _, _} =
      watcher(c.tmp_dir, false,
        poll_ms: 60_000,
        slow_every: 4,
        watched?: fn -> true end,
        front?: fn -> Agent.get(front, & &1) end,
        title: fn ->
          send(parent, :title_read)
          {:ok, "nobody - nowhere"}
        end,
        fibers: fn ->
          send(parent, :fibers_read)
          []
        end
      )

    ticks = fn n ->
      for _ <- 1..n, do: send(watcher, :tick)
      :sys.get_state(watcher)
    end

    drain = fn drain, tag, n ->
      receive do
        ^tag -> drain.(drain, tag, n + 1)
      after
        0 -> n
      end
    end

    ticks.(1)
    assert drain.(drain, :title_read, 0) >= 1
    ticks.(8)
    assert drain.(drain, :title_read, 0) == 2

    Agent.update(front, fn _ -> true end)
    ticks.(1)
    drain.(drain, :fibers_read, 0)
    ticks.(8)
    assert drain.(drain, :fibers_read, 0) == 2
  end

  test "a watch with no title source starts no event stream", c do
    {watcher, _, _} =
      watcher(c.tmp_dir, false, poll_ms: 60_000, title: nil, watched?: fn -> true end)

    send(watcher, :tick)
    assert %{port: nil} = :sys.get_state(watcher)
  end

  test "a missing grant warns voice, not a board watching with voice off", c do
    parent = self()

    {watcher, _, _} =
      watcher(c.tmp_dir, false,
        poll_ms: 60_000,
        watched?: fn -> true end,
        title: fn -> {:error, :accessibility} end,
        warn: fn message -> send(parent, {:warned, message}) end
      )

    send(watcher, :tick)
    assert %{port: nil, title_ready: false} = :sys.get_state(watcher)
    refute_receive {:warned, "Rex" <> _}, 30
  end

  test "nobody watching and voice off polls nothing", c do
    parent = self()

    {watcher, _, _} =
      watcher(c.tmp_dir, false,
        poll_ms: 60_000,
        title: fn ->
          send(parent, :title_read)
          {:ok, "task - project/task"}
        end
      )

    send(watcher, :tick)
    :sys.get_state(watcher)
    refute_receive :title_read, 30
  end

  test "subscribers receive each published move" do
    {:ok, _} = RexFocus.subscribe()
    RexFocus.publish(%{"fiber_id" => "uid", "origin" => "fir"})
    assert_receive {:rex_focus, %{"fiber_id" => "uid", "origin" => "fir"}}
  end

  test "a fiber copied on two hosts resolves to its live copy" do
    copy = fn host, status ->
      %{
        "id" => "project/hub/leg",
        "uid" => "01LEG",
        "slug" => "project/hub/leg",
        "status" => status,
        "shuttle" => %{"host" => host}
      }
    end

    hub = %{"id" => "project/hub", "slug" => "project/hub", "shuttle" => %{"host" => "fir"}}
    {window, session} = {"\u2514 leg", "project/hub"}
    title = window <> " - " <> session
    empty = %{"bindings" => %{}}

    assert %{"origin" => "fir", "fiber_id" => "01LEG"} =
             RexFocus.title_target(
               title,
               empty,
               [hub, copy.("fir", "active"), copy.("nibi", "open")],
               "mac"
             )

    assert nil ==
             RexFocus.title_target(
               title,
               empty,
               [hub, copy.("fir", "active"), copy.("nibi", "active")],
               "mac"
             )
  end

  test "reveal selects the opened card's local worker unless Rex already shows it" do
    parent = self()

    reveal = fn params, overrides ->
      RexFocus.reveal(
        params,
        Keyword.merge(
          [
            active?: fn -> true end,
            bindings: fn -> {:ok, bindings()} end,
            fibers: fn ->
              [
                %{
                  "id" => "project/task",
                  "uid" => "01TASK",
                  "name" => "Task",
                  "shuttle" => %{"host" => "test-host"}
                }
              ]
            end,
            title: fn -> {:ok, "zsh ~ - other/session"} end,
            select: fn host, sid, wid -> send(parent, {:select, host, sid, wid}) end,
            locate: fn _, _, _ -> flunk("a local reveal never looks on another host") end
          ],
          overrides
        )
      )
    end

    task = %{"fiber_id" => "01TASK", "origin" => "test-host"}
    assert :ok = reveal.(task, [])
    assert_receive {:select, nil, "session:a", "window:a"}
    assert :ok = reveal.(task, title: fn -> {:error, :unavailable} end)
    assert_receive {:select, nil, "session:a", "window:a"}

    assert {:skip, :shown} = reveal.(task, title: fn -> {:ok, "task - project/task"} end)
    assert {:skip, :off} = reveal.(task, active?: fn -> false end)
    assert {:skip, :unbound} = reveal.(%{task | "origin" => "elsewhere"}, [])
    assert {:skip, :unbound} = reveal.(%{"fiber_id" => "unbound", "origin" => "test-host"}, [])
    assert {:skip, :unbound} = reveal.(%{}, [])
    refute_receive {:select, _, _, _}
  end

  test "reveal moves Rex's selection and never activates the app", %{tmp_dir: dir} do
    alias Shuttle.Test.{Env, FakeRex}
    Env.put_env("SHUTTLE_DATA_DIR", dir)
    Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
    Env.put_app_env(:fake_rex, start_supervised!({FakeRex, []}))
    Env.put_app_env(:rex_runner, FakeRex)
    Env.put_app_env(:os_type, {:unix, :darwin})
    FakeRex.clients([%{"client_id" => "client:app", "info" => %{"kind" => "app"}}])

    assert :ok =
             RexFocus.reveal(%{"fiber_id" => "01TASK", "origin" => "test-host"},
               own_host: "test-host",
               active?: fn -> true end,
               bindings: fn -> {:ok, bindings()} end,
               title: fn -> {:error, :unavailable} end,
               fibers: fn ->
                 [
                   %{
                     "id" => "project/task",
                     "uid" => "01TASK",
                     "shuttle" => %{"host" => "test-host"}
                   }
                 ]
               end
             )

    calls = FakeRex.calls()
    assert Enum.any?(calls, fn {_, argv, _} -> "client.perform" in argv end)
    refute Enum.any?(calls, &match?({"open", _, _}, &1))
  end

  test "reveal finds a remote worker's window on its host's Rex server by its labels" do
    parent = self()

    fibers = [
      %{
        "id" => "01HUB",
        "uid" => "01HUB",
        "slug" => "science/unions/unions-hub",
        "shuttle" => %{"host" => "fir"}
      },
      %{
        "id" => "01CHILD",
        "uid" => "01CHILD",
        "slug" => "science/unions/unions-hub/onecov",
        "shuttle" => %{"host" => "fir"}
      }
    ]

    reveal = fn params, overrides ->
      RexFocus.reveal(
        params,
        Keyword.merge(
          [
            active?: fn -> true end,
            own_host: "mac",
            fibers: fn -> fibers end,
            title: fn -> {:ok, "task - project/task"} end,
            locate: fn host, session, window ->
              send(parent, {:locate, host, session, window})
              {:ok, "session:f", "window:c"}
            end,
            select: fn host, sid, wid -> send(parent, {:select, host, sid, wid}) end
          ],
          overrides
        )
      )
    end

    child = %{"fiber_id" => "01CHILD", "origin" => "fir"}
    assert :ok = reveal.(child, [])
    assert_receive {:locate, "fir", "unions/unions-hub", "└ onecov"}
    assert_receive {:select, "fir", "session:f", "window:c"}

    assert {:skip, :shown} =
             reveal.(child, title: fn -> {:ok, "\u2060└ onecov - unions/unions-hub"} end)

    assert {:skip, :unbound} = reveal.(child, locate: fn _, _, _ -> nil end)
    assert {:skip, :unbound} = reveal.(%{child | "origin" => "nibi"}, [])
    assert {:skip, :off} = reveal.(child, active?: fn -> false end)
    refute_receive {:select, _, _, _}
  end

  test "the frontmost listener replaces per-tick reads and closes with the watch", c do
    parent = self()
    listener = Path.join(c.tmp_dir, "listener.sh")
    listener_pids = Path.join(c.tmp_dir, "listener-pids")
    File.write!(listener, "#!/bin/sh\necho $$ >> \"$1\"\nexec sleep 300\n")
    File.chmod!(listener, 0o700)
    title = start_supervised!({Agent, fn -> {:ok, "task - project/task"} end}, id: :title)
    other = %{"fiber" => "other/work", "family" => "other/work", "depth" => 0}

    {watcher, active, _} =
      watcher(c.tmp_dir, true,
        poll_ms: 60_000,
        front?: fn ->
          send(parent, :front_read)
          true
        end,
        front_events: fn -> {listener, [listener_pids]} end,
        title: fn -> Agent.get(title, & &1) end,
        bindings: fn -> {:ok, put_in(bindings(), ["bindings", "other"], other)} end,
        fibers: fn ->
          fibers() ++
            [%{"id" => "other/work", "name" => "Work", "shuttle" => %{"host" => "test-host"}}]
        end
      )

    tick = fn ->
      send(watcher, :tick)
      :sys.get_state(watcher)
    end

    became = fn bundle ->
      port = :sys.get_state(watcher).front_port

      line =
        ~s(Notification: kLSNotifyBecameFrontmost time=+0.0s  dataRef={ "ApplicationType"="Foreground", "CFBundleIdentifier"="#{bundle}", "LSASN"=ASN:0x0-0x1: })

      send(watcher, {port, {:data, {:eol, line}}})
      tick.()
    end

    assert_receive {:selected, %{"fiber_id" => "project/task"}}
    assert_receive :front_read
    tick.()
    tick.()
    refute_receive :front_read, 30

    became.("com.apple.Safari")
    Agent.update(title, fn _ -> {:ok, "work - other/work"} end)
    tick.()
    refute_receive {:selected, _}, 30

    became.("com.superlogical.rex")
    assert_receive {:selected, %{"fiber_id" => "other/work"}}
    refute_receive :front_read, 30

    eventually(fn -> File.exists?(listener_pids) end)
    [pid] = read_pids(listener_pids)
    Agent.update(active, fn _ -> false end)
    tick.()
    assert :sys.get_state(watcher).front_port == nil
    eventually(fn -> not alive?(pid) end)
  end

  test "the frontmost read recognises Rex by bundle and counts a failed read as Rex" do
    Shuttle.Test.Env.put_app_env(:rex_title_observer, self())

    Shuttle.Test.Env.put_app_env(
      :rex_title_result,
      {~s([ NULL ]  ASN:0x0-0x19019: \n    bundleID="com.superlogical.rex"\n), 0}
    )

    assert RexFocus.rex_front?(Shuttle.Test.RexTitleRunner)
    assert_receive {:title_command, "/usr/bin/lsappinfo", ["front"], _}
    assert_receive {:title_command, "/usr/bin/lsappinfo", ["info", "-only", "bundleid", _], _}
    Shuttle.Test.Env.put_app_env(:rex_title_result, {~s(    bundleID="com.apple.Safari"\n), 0})
    refute RexFocus.rex_front?(Shuttle.Test.RexTitleRunner)
    Shuttle.Test.Env.put_app_env(:rex_title_result, {"timed out", :timeout})
    assert RexFocus.rex_front?(Shuttle.Test.RexTitleRunner)
  end

  test "the bounded title read classifies a missing grant and a missing helper", %{
    tmp_dir: tmp_dir
  } do
    Shuttle.Test.Env.put_app_env(:rex_title_observer, self())
    Shuttle.Test.Env.put_app_env(:rex_title_result, {"└ task - project/root\n", 0})
    helper = Path.join(tmp_dir, "shuttle-rex-title")
    File.write!(helper, "")
    File.chmod!(helper, 0o755)

    assert {:ok, "└ task - project/root"} =
             RexFocus.read_title(Shuttle.Test.RexTitleRunner, helper)

    assert_receive {:title_command, ^helper, [], opts}
    assert opts[:timeout_ms] == 1_500
    assert opts[:max_output_bytes] == 4_096
    Shuttle.Test.Env.put_app_env(:rex_title_result, {"", 3})
    assert {:error, :accessibility} = RexFocus.read_title(Shuttle.Test.RexTitleRunner, helper)
    Shuttle.Test.Env.put_app_env(:rex_title_result, {"timed out", :timeout})
    assert {:error, :unavailable} = RexFocus.read_title(Shuttle.Test.RexTitleRunner, helper)
    File.rm!(helper)
    assert {:error, :no_helper} = RexFocus.read_title(Shuttle.Test.RexTitleRunner, helper)
  end

  test "tmux hosts neither consult voice nor start a Rex stream" do
    Shuttle.Test.Env.put_app_env(:terminal_backend, Shuttle.Terminal.Tmux)
    parent = self()

    watcher =
      start_supervised!(
        {RexFocus,
         name: nil,
         command: fn ->
           send(parent, :stream_started)
           nil
         end}
      )

    assert :sys.get_state(watcher).port == nil
    refute_receive :stream_started
  end

  test "watcher reconnects after a stream exit and closes its CLI when following stops", c do
    {watcher, active, pids} = watcher(c.tmp_dir)
    assert_receive {:selected, %{"fiber_id" => "project/task"}}
    [first] = read_pids(pids)
    System.cmd("kill", ["-TERM", to_string(first)])
    assert_receive {:selected, %{"fiber_id" => "project/task"}}
    [^first, second] = read_pids(pids)
    assert second != first

    Agent.update(active, fn _ -> false end)
    send(watcher, :tick)
    assert :sys.get_state(watcher).port == nil
    eventually(fn -> not alive?(second) end)
    refute_receive {:selected, _}
  end

  test "supervisor restart reaps the old stream, including an untrappable owner exit", c do
    {watcher, _active, pids} = watcher(c.tmp_dir)
    assert_receive {:selected, _}
    [first] = read_pids(pids)
    monitor = Process.monitor(watcher)
    Process.exit(watcher, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^watcher, :killed}
    assert_receive {:selected, _}
    [^first, second] = read_pids(pids)
    eventually(fn -> not alive?(first) end)
    assert alive?(second)
    stop_supervised!(RexFocus)
    eventually(fn -> not alive?(second) end)
  end

  test "off does not launch a stream and an in-flight event after off cannot change the target",
       c do
    {watcher, active, pids} = watcher(c.tmp_dir, false)
    assert :sys.get_state(watcher).port == nil
    refute File.exists?(pids)
    Agent.update(active, fn _ -> true end)
    send(watcher, :tick)
    assert_receive {:selected, _}
    port = :sys.get_state(watcher).port
    Agent.update(active, fn _ -> false end)
    send(watcher, {port, {:data, {:eol, Jason.encode!(event())}}})
    assert :sys.get_state(watcher).port == port
    refute_receive {:selected, _}
    send(watcher, :tick)
    assert :sys.get_state(watcher).port == nil
  end

  test "unrelated events do not inventory fibers or bindings", c do
    parent = self()
    {watcher, _active, _pids} = watcher(c.tmp_dir)
    assert_receive {:selected, _}
    port = :sys.get_state(watcher).port
    state = :sys.get_state(watcher)

    :sys.replace_state(watcher, fn s ->
      %{
        s
        | fibers: fn ->
            send(parent, :inventoried)
            state.fibers.()
          end
      }
    end)

    send(watcher, {port, {:data, {:eol, ~s({"type":"client_joined"})}}})
    :sys.get_state(watcher)
    refute_receive :inventoried
  end

  defp watcher(root, enabled \\ true, overrides \\ []) do
    pids = Path.join(root, "pids")
    script = Path.join(root, "events.sh")
    event_file = Path.join(root, "event.json")
    File.write!(event_file, Jason.encode!(event()) <> "\n")

    File.write!(script, """
    #!/bin/sh
    echo $$ >> "$1"
    cat "$2"
    exec sleep 300
    """)

    File.chmod!(script, 0o700)
    active = start_supervised!({Agent, fn -> enabled end}, id: :active)
    parent = self()

    watcher =
      start_supervised!(
        {RexFocus,
         Keyword.merge(
           [
             name: nil,
             title: nil,
             front?: fn -> true end,
             front_events: fn -> nil end,
             poll_ms: 25,
             active?: fn -> Agent.get(active, & &1) end,
             watched?: fn -> false end,
             slow_every: 1,
             publish: fn target -> send(parent, {:published, target}) end,
             command: fn -> {script, [pids, event_file]} end,
             bindings: fn -> {:ok, bindings()} end,
             fibers: &fibers/0,
             target: fn target ->
               send(parent, {:selected, target})
               {:ok, %{}}
             end
           ],
           overrides
         )}
      )

    {watcher, active, pids}
  end

  defp read_pids(path),
    do: path |> File.read!() |> String.split() |> Enum.map(&String.to_integer/1)

  defp alive?(pid) do
    {_, status} = System.cmd("kill", ["-0", to_string(pid)], stderr_to_stdout: true)
    status == 0
  end

  defp eventually(check, attempts \\ 200)
  defp eventually(check, 0), do: assert(check.())

  defp eventually(check, attempts) do
    unless check.() do
      receive do
      after
        10 -> eventually(check, attempts - 1)
      end
    end
  end
end
