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

  test "title observed before its binding is installed is retried when bindings change", c do
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

  test "the bounded accessibility read classifies permission failure without exposing raw stderr" do
    Shuttle.Test.Env.put_app_env(:rex_title_observer, self())
    Shuttle.Test.Env.put_app_env(:rex_title_result, {"└ task - project/root\n", 0})
    assert {:ok, "└ task - project/root"} = RexFocus.read_title(Shuttle.Test.RexTitleRunner)
    assert_receive {:title_command, "/usr/bin/osascript", ["-e", _], opts}
    assert opts[:timeout_ms] == 1_500
    assert opts[:max_output_bytes] == 4_096
    Shuttle.Test.Env.put_app_env(:rex_title_result, {"not allowed assistive access (-1719)", 1})
    assert {:error, :accessibility} = RexFocus.read_title(Shuttle.Test.RexTitleRunner)
    Shuttle.Test.Env.put_app_env(:rex_title_result, {"timed out", :timeout})
    assert {:error, :unavailable} = RexFocus.read_title(Shuttle.Test.RexTitleRunner)
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
    assert_receive {:selected, %{"fiber_id" => "project/task", "source" => "rex"}}
    [first] = read_pids(pids)
    System.cmd("kill", ["-TERM", to_string(first)])
    assert_receive {:selected, %{"fiber_id" => "project/task", "source" => "rex"}}
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
             poll_ms: 25,
             active?: fn -> Agent.get(active, & &1) end,
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
