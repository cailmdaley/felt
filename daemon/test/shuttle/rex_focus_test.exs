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

  test "title mapping uses worker and session labels, rejects program titles, and two windows on one fiber name it" do
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

    # A second window on the same fiber, as a reopened conversation beside its worker.
    twice = put_in(bindings, ["bindings", "another"], bindings["bindings"]["worker"])

    assert %{"fiber_id" => "project/task"} =
             RexFocus.title_target("task - project/task", twice, fibers())

    # A waiting family session's leading "● " mark is stripped during normalization.
    assert %{"fiber_id" => "project/task"} =
             RexFocus.title_target("task - ● project/task", bindings, fibers())

    assert %{"fiber_id" => "project/task"} =
             RexFocus.title_target("\u2060\u2003└ task - ● project/root", child, fibers())
  end

  test "places, family views and Desk map cleanly through rex.json for events and titles" do
    root = %{
      "id" => "01ROOT",
      "uid" => "01ROOT",
      "slug" => "project/root",
      "name" => "Root",
      "shuttle" => %{"host" => "test-host"}
    }

    child = %{
      "id" => "01CHILD",
      "uid" => "01CHILD",
      "slug" => "project/root/sub",
      "name" => "Sub",
      "shuttle" => %{"host" => "test-host"}
    }

    doc = %{
      "bindings" => %{},
      "places" => %{
        "01CHILD" => %{
          "session_id" => "session:fam",
          "window_id" => "window:place",
          "family" => "project/root",
          "fiber" => "project/root/sub",
          "depth" => 1
        }
      },
      "views" => %{
        "project/root" => %{
          "session_id" => "session:fam",
          "window_id" => "window:view",
          "family" => "project/root",
          "fiber" => "project/root",
          "uid" => "01ROOT"
        }
      },
      "desk" => %{
        "session_id" => "session:desk",
        "window_id" => "window:desk",
        "page_block_id" => "block:desk"
      }
    }

    fibers = [root, child]

    # active_window_changed events
    assert %{"fiber_id" => "01CHILD", "origin" => "test-host", "name" => "Sub"} =
             RexFocus.target(event("session:fam", "window:place"), doc, fibers)

    assert %{"fiber_id" => "01ROOT", "origin" => "test-host", "name" => "Root"} =
             RexFocus.target(event("session:fam", "window:view"), doc, fibers)

    assert nil == RexFocus.target(event("session:desk", "window:desk"), doc, fibers)

    # macOS window titles
    assert %{"fiber_id" => "01CHILD", "origin" => "test-host", "name" => "Sub"} =
             RexFocus.title_target("\u2060└ sub - project/root", doc, fibers)

    assert %{"fiber_id" => "01CHILD", "origin" => "test-host", "name" => "Sub"} =
             RexFocus.title_target("\u2060└ sub - ● project/root", doc, fibers)

    assert %{"fiber_id" => "01ROOT", "origin" => "test-host", "name" => "Root"} =
             RexFocus.title_target("root - project/root", doc, fibers)

    assert %{"fiber_id" => "01ROOT", "origin" => "test-host", "name" => "Root"} =
             RexFocus.title_target("root - ● project/root", doc, fibers)

    assert nil == RexFocus.title_target("Desk - Desk", doc, fibers)
  end

  test "switching to the Desk session leaves the voice target unchanged", c do
    title = start_supervised!({Agent, fn -> {:ok, "task - project/task"} end}, id: :desk_title)

    {watcher, _, _} =
      watcher(c.tmp_dir, true,
        poll_ms: 60_000,
        title: fn -> Agent.get(title, & &1) end
      )

    assert_receive {:selected, %{"fiber_id" => "project/task"}}

    Agent.update(title, fn _ -> {:ok, "Desk - Desk"} end)
    send(watcher, :tick)
    :sys.get_state(watcher)
    refute_receive {:selected, _}, 30
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

    assert %{"fiber_id" => "01CHILD", "origin" => "fir", "name" => "OneCov"} ==
             RexFocus.title_target(
               "\u2060└ onecov - ● unions/unions-hub",
               bindings(),
               fibers,
               "mac"
             )

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

  test "following that starts with Rex in front routes its worker to voice at once", c do
    following = start_supervised!({Agent, fn -> false end}, id: :following)

    {watcher, _, _} =
      watcher(c.tmp_dir, false,
        poll_ms: 60_000,
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
    tick.()
    refute_receive {:selected, _}, 30
  end

  test "behind, the title is not polled once ready, and an unmatched one retries slowly", c do
    parent = self()
    front = start_supervised!({Agent, fn -> false end}, id: :front)

    {watcher, _, _} =
      watcher(c.tmp_dir, true,
        poll_ms: 60_000,
        slow_every: 4,
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
    assert drain.(drain, :title_read, 0) == 0

    Agent.update(front, fn _ -> true end)
    ticks.(1)
    drain.(drain, :fibers_read, 0)
    ticks.(8)
    assert drain.(drain, :fibers_read, 0) == 2
  end

  test "voice off polls nothing", c do
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

    became.("dev.coey.rexweb")
    assert_receive {:selected, %{"fiber_id" => "other/work"}}
    refute_receive :front_read, 30

    # Clicking from RexWeb back into Rex keeps following uninterrupted.
    became.("com.superlogical.rex")
    Agent.update(title, fn _ -> {:ok, "task - project/task"} end)
    tick.()
    assert_receive {:selected, %{"fiber_id" => "project/task"}}

    eventually(fn -> File.exists?(listener_pids) end)
    [pid] = read_pids(listener_pids)
    Agent.update(active, fn _ -> false end)
    tick.()
    assert :sys.get_state(watcher).front_port == nil
    eventually(fn -> not alive?(pid) end)
  end

  test "the frontmost read recognises Rex and RexWeb by bundle and counts a failed read as Rex" do
    Shuttle.Test.Env.put_app_env(:rex_title_observer, self())

    Shuttle.Test.Env.put_app_env(
      :rex_title_result,
      {~s([ NULL ]  ASN:0x0-0x19019: \n    bundleID="com.superlogical.rex"\n), 0}
    )

    assert RexFocus.rex_front?(Shuttle.Test.RexTitleRunner)
    assert_receive {:title_command, "/usr/bin/lsappinfo", ["front"], _}
    assert_receive {:title_command, "/usr/bin/lsappinfo", ["info", "-only", "bundleid", _], _}

    Shuttle.Test.Env.put_app_env(
      :rex_title_result,
      {~s([ NULL ]  ASN:0x0-0x19020: \n    bundleID="dev.coey.rexweb"\n), 0}
    )

    assert RexFocus.rex_front?(Shuttle.Test.RexTitleRunner)
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
    # Only the test's ticks run, so none closes the stream before the late event.
    {watcher, active, pids} = watcher(c.tmp_dir, false, poll_ms: 60_000)
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
             slow_every: 1,
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

  defp eventually(check, attempts \\ 3_000)
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
