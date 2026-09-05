defmodule ShuttleWeb.ActivityControllerTest do
  @moduledoc """
  Reader + wiring for `GET /api/v1/activity` — the per-minute activity
  histogram the temporal view polls.

  The reader (`Shuttle.Activity`) is exercised against fixture `events.jsonl`
  files covering bucket aggregation, the three-way kind mapping, waiting-spell
  collapse (a `"notify"` mark is the onset of an ask, not a repeat of it),
  window bounds, nil session/cwd, malformed-line tolerance, and the mtime gate
  that decides whether the rotated `events.jsonl.1` is read at all. The
  controller's tests point `$SHUTTLE_EVENTS_FILE` at those fixtures and cover
  the 400s.
  """
  use ExUnit.Case
  import Shuttle.Test.ApiConn
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  # An exact minute boundary (2026-02-02T02:40:00Z), so `@t0 + 59_999` is the
  # last millisecond of the same bucket and `@t0 + 60_000` opens the next one.
  @t0 1_770_000_000_000
  @minute 60_000

  @session "morning-post-01KTS261GJMMRDRHS2QDMEFV3K-shuttle"
  @other_session "review-01KTCA2CY6X6P126ZMBK9686SH-shuttle"
  @cwd "/Users/x/dev/felt"

  defp event(overrides) do
    %{
      "id" => "sess-1-#{System.unique_integer([:positive])}",
      "timestamp" => @t0,
      "type" => "pre_tool_use",
      "sessionId" => "sess-1",
      "cwd" => @cwd,
      "tmuxSession" => @session,
      "harness" => "claude",
      "originName" => "test-host"
    }
    |> Map.merge(overrides)
    |> Jason.encode!()
  end

  # Write a fixture stream and return its path; cleaned up (with its rotated
  # sibling) on exit.
  defp write_fixture(lines) do
    path =
      Path.join(
        System.tmp_dir!(),
        "shuttle_activity_#{System.unique_integer([:positive])}.jsonl"
      )

    File.write!(path, Enum.join(lines, "\n") <> "\n")
    on_exit(fn -> File.rm(path) && File.rm(path <> ".1") end)
    path
  end

  # Write the rotated sibling of `path` and stamp its mtime, which is what the
  # reader's overlap gate consults.
  defp write_rotated(path, lines, mtime_s) do
    File.write!(path <> ".1", Enum.join(lines, "\n") <> "\n")
    File.touch!(path <> ".1", mtime_s)
  end

  defp buckets!(path, from_ms, to_ms) do
    {:ok, %{buckets: buckets}} = Shuttle.Activity.window(from_ms, to_ms, events_file: path)
    buckets
  end

  defp spawns!(path, from_ms, to_ms, opts \\ []) do
    {:ok, %{spawns: spawns}} =
      Shuttle.Activity.window(from_ms, to_ms, [events_file: path] ++ opts)

    spawns
  end

  # One end of a delegation, on `sid`'s queue.
  defp spawn_event(type, tool, ts, overrides \\ %{}) do
    event(
      Map.merge(
        %{"type" => type, "tool" => tool, "timestamp" => ts},
        overrides
      )
    )
  end

  describe "Shuttle.Activity.window/3 — delegations as intervals" do
    test "a closed pre/post pair on a spawn tool is one interval at its true length" do
      path =
        write_fixture([
          spawn_event("pre_tool_use", "Agent", @t0 + 1_000),
          spawn_event("post_tool_use", "Agent", @t0 + 8 * @minute)
        ])

      assert spawns!(path, @t0, @t0 + 20 * @minute) == [
               %{
                 s: @session,
                 cwd: @cwd,
                 tool: "Agent",
                 start_ms: @t0 + 1_000,
                 end_ms: @t0 + 8 * @minute,
                 open: false,
                 # Nothing named this delegation and nothing counted it: only a
                 # workflow carries either, and both keys travel as `nil` so the
                 # wire shape is one shape rather than two.
                 label: nil,
                 agents: nil
               }
             ]
    end

    test "an ordinary tool's pair is not a delegation" do
      path =
        write_fixture([
          spawn_event("pre_tool_use", "Bash", @t0),
          spawn_event("post_tool_use", "Bash", @t0 + @minute)
        ])

      assert spawns!(path, @t0, @t0 + 20 * @minute) == []
    end

    test "a fan-out holds every delegation aloft at once, oldest closing first" do
      path =
        write_fixture([
          spawn_event("pre_tool_use", "Agent", @t0),
          spawn_event("pre_tool_use", "Task", @t0 + 1_000),
          spawn_event("pre_tool_use", "Agent", @t0 + 2_000),
          spawn_event("post_tool_use", "Agent", @t0 + 5 * @minute),
          spawn_event("post_tool_use", "Agent", @t0 + 9 * @minute)
        ])

      spawns = spawns!(path, @t0, @t0 + 60 * @minute)

      assert Enum.map(spawns, &{&1.start_ms - @t0, &1.end_ms - @t0, &1.open}) == [
               {0, 5 * @minute, false},
               {1_000, 9 * @minute, false},
               {2_000, 2_000 + 5 * @minute, true}
             ]
    end

    test "two sessions hold independent queues" do
      path =
        write_fixture([
          spawn_event("pre_tool_use", "Agent", @t0),
          spawn_event("pre_tool_use", "Agent", @t0 + 1_000, %{
            "sessionId" => "sess-2",
            "tmuxSession" => @other_session
          }),
          spawn_event("post_tool_use", "Agent", @t0 + 3 * @minute, %{
            "sessionId" => "sess-2",
            "tmuxSession" => @other_session
          })
        ])

      assert [first, second] = spawns!(path, @t0, @t0 + 60 * @minute)
      assert %{s: @session, open: true} = first
      assert %{s: @other_session, open: false, end_ms: end_ms} = second
      assert end_ms == @t0 + 3 * @minute
    end

    test "an unclosed delegation is a stub, not a claim about how long it ran" do
      path = write_fixture([spawn_event("pre_tool_use", "Agent", @t0)])

      assert [%{open: true, start_ms: start_ms, end_ms: end_ms}] =
               spawns!(path, @t0, @t0 + 6 * 60 * @minute)

      assert start_ms == @t0
      assert end_ms == @t0 + 5 * @minute
    end

    test "a session restart ends every delegation it was holding" do
      path =
        write_fixture([
          spawn_event("pre_tool_use", "Agent", @t0),
          spawn_event("pre_tool_use", "Agent", @t0 + 1_000),
          spawn_event("session_start", nil, @t0 + 4 * @minute)
        ])

      spawns = spawns!(path, @t0, @t0 + 60 * @minute)
      assert Enum.map(spawns, & &1.open) == [false, false]
      assert Enum.map(spawns, & &1.end_ms) == [@t0 + 4 * @minute, @t0 + 4 * @minute]
    end

    test "an interval spanning the window is clipped to it, and one outside is dropped" do
      path =
        write_fixture([
          spawn_event("pre_tool_use", "Agent", @t0 - 30 * @minute),
          spawn_event("post_tool_use", "Agent", @t0 + 30 * @minute),
          spawn_event("pre_tool_use", "Agent", @t0 + 300 * @minute, %{"sessionId" => "sess-3"}),
          spawn_event("post_tool_use", "Agent", @t0 + 310 * @minute, %{"sessionId" => "sess-3"})
        ])

      assert [%{start_ms: start_ms, end_ms: end_ms}] = spawns!(path, @t0, @t0 + 60 * @minute)
      assert start_ms == @t0
      assert end_ms == @t0 + 30 * @minute
    end

    test "a delegation contributes no buckets of its own" do
      path =
        write_fixture([
          spawn_event("pre_tool_use", "Agent", @t0),
          spawn_event("post_tool_use", "Agent", @t0 + 3 * @minute)
        ])

      assert Enum.map(buckets!(path, @t0, @t0 + 60 * @minute), & &1.k) ==
               ["agent", "agent", "agent", "agent"]
    end
  end

  describe "Shuttle.Activity.window/3 — workflows, named and measured" do
    # A workflow's own launch script, as the tool received it. The name is the
    # first thing in the meta block and the only place the caller wrote it down.
    defp workflow_event(ts, name, overrides \\ %{}) do
      script = """
      export const meta = {
        name: '#{name}',
        description: 'a fan-out',
        phases: [{ title: 'sweep' }],
      }
      """

      spawn_event(
        "pre_tool_use",
        "Workflow",
        ts,
        Map.merge(%{"toolInput" => %{"script" => script}}, overrides)
      )
    end

    # A tmp stand-in for `~/.claude/projects`, cleaned up with the test.
    defp tmp_projects do
      root =
        Path.join(System.tmp_dir!(), "shuttle_projects_#{System.unique_integer([:positive])}")

      File.mkdir_p!(root)
      on_exit(fn -> File.rm_rf(root) end)
      root
    end

    # One `wf_*` directory as the harness leaves it: `agents` meta files stamped
    # at the launch second, and one transcript each stamped at the fleet's last
    # movement. Those two mtimes are the whole of what the reader consults.
    defp write_workflow_dir(root, cwd, wf, opts) do
      dir =
        Path.join([root, String.replace(cwd, "/", "-"), "sess-1", "subagents", "workflows", wf])

      File.mkdir_p!(dir)

      for i <- 1..opts[:agents] do
        meta = Path.join(dir, "agent-#{i}.meta.json")
        File.write!(meta, "{}")
        File.touch!(meta, opts[:launch_s])

        log = Path.join(dir, "agent-#{i}.jsonl")
        File.write!(log, "{}\n")
        File.touch!(log, opts[:last_s])
      end

      dir
    end

    test "reads the workflow's name out of the script it was launched with" do
      path = write_fixture([workflow_event(@t0 + 1_000, "felt-cleanup-audit")])

      assert [%{tool: "Workflow", label: "felt-cleanup-audit"}] =
               spawns!(path, @t0, @t0 + 60 * @minute, claude_projects_dir: tmp_projects())
    end

    test "a script with no meta block names nothing, and the interval survives" do
      path =
        write_fixture([
          spawn_event("pre_tool_use", "Workflow", @t0 + 1_000, %{
            "toolInput" => %{"truncated" => true}
          })
        ])

      assert [%{tool: "Workflow", label: nil, agents: nil}] =
               spawns!(path, @t0, @t0 + 60 * @minute, claude_projects_dir: tmp_projects())
    end

    test "counts the fleet and redraws the interval at the extent its transcripts show" do
      root = tmp_projects()

      write_workflow_dir(root, @cwd, "wf_abc",
        agents: 12,
        launch_s: div(@t0, 1_000) + 3,
        last_s: div(@t0, 1_000) + 56 * 60
      )

      path = write_fixture([workflow_event(@t0 + 1_000, "felt-cleanup-audit")])

      # The events alone would have drawn a five-minute stub, still open. The
      # directory says twelve agents worked for fifty-six minutes and stopped.
      assert [span] = spawns!(path, @t0, @t0 + 120 * @minute, claude_projects_dir: root)
      assert span.agents == 12
      assert span.end_ms == @t0 + 56 * @minute
      assert span.open == false
    end

    test "a fleet that moved a minute ago is still aloft" do
      now = System.system_time(:millisecond)
      start_ms = now - 60 * @minute
      root = tmp_projects()

      write_workflow_dir(root, @cwd, "wf_live",
        agents: 3,
        launch_s: div(start_ms, 1_000) + 2,
        last_s: div(now, 1_000) - 60
      )

      path = write_fixture([workflow_event(start_ms, "still-going")])

      assert [%{agents: 3, open: true}] =
               spawns!(path, start_ms - @minute, now, claude_projects_dir: root)
    end

    test "matches each of a session's workflows to the directory launched with it" do
      root = tmp_projects()

      write_workflow_dir(root, @cwd, "wf_second",
        agents: 31,
        launch_s: div(@t0, 1_000) + 40 * 60 + 2,
        last_s: div(@t0, 1_000) + 55 * 60
      )

      write_workflow_dir(root, @cwd, "wf_first",
        agents: 122,
        launch_s: div(@t0, 1_000) + 3,
        last_s: div(@t0, 1_000) + 30 * 60
      )

      path =
        write_fixture([
          workflow_event(@t0 + 1_000, "felt-cleanup-audit"),
          workflow_event(@t0 + 40 * @minute, "cleanup-review")
        ])

      # Proximity, not readdir order — `wf_second` is listed first above and
      # still belongs to the later spawn.
      assert [first, second] = spawns!(path, @t0, @t0 + 120 * @minute, claude_projects_dir: root)
      assert {first.label, first.agents} == {"felt-cleanup-audit", 122}
      assert {second.label, second.agents} == {"cleanup-review", 31}
    end

    test "a directory whose launch is nowhere near the spawn is not claimed" do
      root = tmp_projects()

      write_workflow_dir(root, @cwd, "wf_yesterday",
        agents: 9,
        launch_s: div(@t0, 1_000) - 24 * 60 * 60,
        last_s: div(@t0, 1_000) - 23 * 60 * 60
      )

      path = write_fixture([workflow_event(@t0 + 1_000, "unrelated")])

      assert [%{agents: nil, open: true, end_ms: end_ms}] =
               spawns!(path, @t0, @t0 + 120 * @minute, claude_projects_dir: root)

      # Unenriched is unchanged: the five-minute stub, exactly as before.
      assert end_ms == @t0 + 1_000 + 5 * @minute
    end

    test "no directory at all is today's behaviour, unchanged" do
      path = write_fixture([workflow_event(@t0 + 1_000, "on-some-other-host")])

      assert [%{label: "on-some-other-host", agents: nil, open: true, end_ms: end_ms}] =
               spawns!(path, @t0, @t0 + 60 * @minute,
                 claude_projects_dir: Path.join(System.tmp_dir!(), "shuttle_no_such_projects")
               )

      assert end_ms == @t0 + 1_000 + 5 * @minute
    end
  end

  describe "Shuttle.Activity.window/3 — aggregation" do
    test "counts events sharing a (minute, session, cwd, kind) key into one bucket" do
      path =
        write_fixture([
          event(%{"timestamp" => @t0}),
          event(%{"timestamp" => @t0 + 1_000}),
          event(%{"timestamp" => @t0 + 59_999})
        ])

      assert buckets!(path, @t0, @t0 + @minute) == [
               %{m: @t0, s: @session, cwd: @cwd, k: "agent", n: 3}
             ]
    end

    test "splits on the minute, on the session, and on the cwd" do
      path =
        write_fixture([
          event(%{"timestamp" => @t0}),
          event(%{"timestamp" => @t0 + @minute}),
          event(%{"timestamp" => @t0, "tmuxSession" => @other_session}),
          event(%{"timestamp" => @t0, "cwd" => "/other/repo"})
        ])

      buckets = buckets!(path, @t0, @t0 + 2 * @minute)

      assert length(buckets) == 4
      assert Enum.all?(buckets, &(&1.n == 1))

      # Sorted by {m, s, cwd, k}: the whole first minute before the second.
      assert Enum.map(buckets, & &1.m) == [@t0, @t0, @t0, @t0 + @minute]

      assert %{m: @t0, s: @other_session, cwd: @cwd, k: "agent", n: 1} in buckets
      assert %{m: @t0, s: @session, cwd: "/other/repo", k: "agent", n: 1} in buckets
    end

    test "nils an absent or empty session and cwd" do
      path =
        write_fixture([
          event(%{"tmuxSession" => "", "cwd" => ""}),
          event(%{}) |> Jason.decode!() |> Map.drop(["tmuxSession", "cwd"]) |> Jason.encode!()
        ])

      assert buckets!(path, @t0, @t0 + @minute) == [
               %{m: @t0, s: nil, cwd: nil, k: "agent", n: 2}
             ]
    end
  end

  describe "Shuttle.Activity.window/3 — kind mapping" do
    test "user_prompt_submit is attention, notification is notify, all else is agent" do
      path =
        write_fixture([
          event(%{"type" => "user_prompt_submit"}),
          event(%{"type" => "notification"}),
          event(%{"type" => "pre_tool_use"}),
          event(%{"type" => "post_tool_use"}),
          event(%{"type" => "stop"}),
          event(%{"type" => "subagent_stop"}),
          event(%{"type" => "session_start"}),
          event(%{"type" => "session_end"}),
          # A hook type invented after this endpoint shipped must still land in
          # the agent band rather than vanishing.
          event(%{"type" => "some_future_hook"})
        ])

      by_kind = Map.new(buckets!(path, @t0, @t0 + @minute), &{&1.k, &1.n})

      assert by_kind == %{"attention" => 1, "notify" => 1, "agent" => 7, "reply" => 1}
    end

    test "a machine-flagged prompt is agent activity, not attention" do
      # The harness injects prompts of its own — a task notification, another
      # session's message — through the same hook a person types into. Those
      # minutes are the machine talking to itself, and a spine over them would
      # claim someone was at the keyboard.
      path =
        write_fixture([
          event(%{"type" => "user_prompt_submit", "machine" => true}),
          event(%{"type" => "user_prompt_submit"})
        ])

      by_kind = Map.new(buckets!(path, @t0, @t0 + @minute), &{&1.k, &1.n})
      assert by_kind == %{"attention" => 1, "agent" => 1}
    end

    test "a machine-flagged prompt still closes an open waiting spell" do
      # It is not attention, but it IS the session moving again: whatever the
      # agent was blocked on, it is no longer sitting there. A later
      # notification therefore opens a fresh spell rather than being swallowed.
      path =
        write_fixture([
          event(%{"type" => "notification"}),
          event(%{
            "timestamp" => @t0 + @minute,
            "type" => "user_prompt_submit",
            "machine" => true
          }),
          event(%{"timestamp" => @t0 + 2 * @minute, "type" => "notification"})
        ])

      buckets = buckets!(path, @t0, @t0 + 3 * @minute)
      assert Enum.count(buckets, &(&1.k == "notify")) == 2
    end

    test "stop emits reply ALONGSIDE agent, leaving the agent stream untouched" do
      # The whole safety argument for adding a kind to a wire format several
      # views read: a consumer that never heard of "reply" sees exactly the
      # numbers it saw before.
      path =
        write_fixture([
          event(%{"type" => "stop"}),
          event(%{"type" => "stop"}),
          event(%{"type" => "post_tool_use"})
        ])

      assert buckets!(path, @t0, @t0 + @minute) == [
               %{m: @t0, s: @session, cwd: @cwd, k: "agent", n: 3},
               %{m: @t0, s: @session, cwd: @cwd, k: "reply", n: 2}
             ]
    end

    test "subagent_stop is not a reply — no human received it" do
      path = write_fixture([event(%{"type" => "subagent_stop"})])

      assert buckets!(path, @t0, @t0 + @minute) == [
               %{m: @t0, s: @session, cwd: @cwd, k: "agent", n: 1}
             ]
    end
  end

  describe "Shuttle.Activity.window/3 — waiting spells" do
    # A notify mark is the ONSET of a waiting spell, not a notification. Claude
    # Code re-fires the idle notification every minute; those repeats are the
    # same unanswered ask.
    test "repeat notifications inside one spell collapse to a single onset" do
      path =
        write_fixture(
          for i <- 0..9, do: event(%{"timestamp" => @t0 + i * @minute, "type" => "notification"})
        )

      assert buckets!(path, @t0, @t0 + 10 * @minute) == [
               %{m: @t0, s: @session, cwd: @cwd, k: "notify", n: 1}
             ]
    end

    test "a user prompt closes the spell, so the next notification is a new onset" do
      path =
        write_fixture([
          event(%{"timestamp" => @t0, "type" => "notification"}),
          event(%{"timestamp" => @t0 + @minute, "type" => "notification"}),
          event(%{"timestamp" => @t0 + 2 * @minute, "type" => "user_prompt_submit"}),
          event(%{"timestamp" => @t0 + 3 * @minute, "type" => "notification"})
        ])

      assert buckets!(path, @t0, @t0 + 4 * @minute) == [
               %{m: @t0, s: @session, cwd: @cwd, k: "notify", n: 1},
               %{m: @t0 + 2 * @minute, s: @session, cwd: @cwd, k: "attention", n: 1},
               %{m: @t0 + 3 * @minute, s: @session, cwd: @cwd, k: "notify", n: 1}
             ]
    end

    test "agent activity closes the spell too — a permission granted elsewhere" do
      path =
        write_fixture([
          event(%{"timestamp" => @t0, "type" => "notification"}),
          event(%{"timestamp" => @t0 + @minute, "type" => "post_tool_use"}),
          event(%{"timestamp" => @t0 + 2 * @minute, "type" => "notification"})
        ])

      assert Enum.filter(buckets!(path, @t0, @t0 + 3 * @minute), &(&1.k == "notify")) == [
               %{m: @t0, s: @session, cwd: @cwd, k: "notify", n: 1},
               %{m: @t0 + 2 * @minute, s: @session, cwd: @cwd, k: "notify", n: 1}
             ]
    end

    test "a completed reply closes the spell like any other agent event" do
      path =
        write_fixture([
          event(%{"timestamp" => @t0, "type" => "notification"}),
          event(%{"timestamp" => @t0 + @minute, "type" => "stop"}),
          event(%{"timestamp" => @t0 + 2 * @minute, "type" => "notification"})
        ])

      assert Enum.filter(buckets!(path, @t0, @t0 + 3 * @minute), &(&1.k == "notify")) == [
               %{m: @t0, s: @session, cwd: @cwd, k: "notify", n: 1},
               %{m: @t0 + 2 * @minute, s: @session, cwd: @cwd, k: "notify", n: 1}
             ]
    end

    test "two onsets inside one minute count twice in the same bucket" do
      path =
        write_fixture([
          event(%{"type" => "notification"}),
          event(%{"timestamp" => @t0 + 1_000, "type" => "stop"}),
          event(%{"timestamp" => @t0 + 2_000, "type" => "notification"})
        ])

      assert %{m: @t0, s: @session, cwd: @cwd, k: "notify", n: 2} in buckets!(
               path,
               @t0,
               @t0 + @minute
             )
    end

    test "each identity holds its own spell, and an unattributed event holds a third" do
      unattributed = fn ts ->
        event(%{"timestamp" => ts, "type" => "notification", "tmuxSession" => "", "cwd" => ""})
      end

      path =
        write_fixture([
          event(%{"type" => "notification"}),
          event(%{"type" => "notification", "tmuxSession" => @other_session}),
          unattributed.(@t0),
          # Every one of these is a repeat of its own identity's spell.
          event(%{"timestamp" => @t0 + @minute, "type" => "notification"}),
          event(%{
            "timestamp" => @t0 + @minute,
            "type" => "notification",
            "tmuxSession" => @other_session
          }),
          unattributed.(@t0 + @minute)
        ])

      buckets = buckets!(path, @t0, @t0 + 2 * @minute)

      assert length(buckets) == 3
      assert Enum.all?(buckets, &(&1.m == @t0 and &1.k == "notify" and &1.n == 1))
      assert Enum.map(buckets, & &1.s) == [nil, @session, @other_session]
    end

    test "a spell open before the window suppresses its first in-window notification" do
      path =
        write_fixture([
          event(%{"timestamp" => @t0 - 5 * @minute, "type" => "notification"}),
          event(%{"timestamp" => @t0, "type" => "notification"}),
          event(%{"timestamp" => @t0 + @minute, "type" => "user_prompt_submit"}),
          event(%{"timestamp" => @t0 + 2 * @minute, "type" => "notification"})
        ])

      # The onset happened before the window; only the post-answer ask is new.
      assert buckets!(path, @t0, @t0 + 3 * @minute) == [
               %{m: @t0 + @minute, s: @session, cwd: @cwd, k: "attention", n: 1},
               %{m: @t0 + 2 * @minute, s: @session, cwd: @cwd, k: "notify", n: 1}
             ]
    end

    test "events after the window neither tally nor move spell state" do
      # to_ms cuts the stream: the fold stops contributing there, so a one-minute
      # window sees only the onset.
      path =
        write_fixture([
          event(%{"timestamp" => @t0, "type" => "notification"}),
          event(%{"timestamp" => @t0 + @minute, "type" => "stop"}),
          event(%{"timestamp" => @t0 + 2 * @minute, "type" => "notification"})
        ])

      assert buckets!(path, @t0, @t0) == [
               %{m: @t0, s: @session, cwd: @cwd, k: "notify", n: 1}
             ]
    end
  end

  describe "Shuttle.Activity.window/3 — window and tolerance" do
    test "both window bounds are inclusive and events outside are dropped" do
      path =
        write_fixture([
          event(%{"timestamp" => @t0 - 1}),
          event(%{"timestamp" => @t0}),
          event(%{"timestamp" => @t0 + @minute}),
          event(%{"timestamp" => @t0 + @minute + 1})
        ])

      buckets = buckets!(path, @t0, @t0 + @minute)

      assert Enum.map(buckets, & &1.m) == [@t0, @t0 + @minute]
      assert Enum.all?(buckets, &(&1.n == 1))
    end

    test "skips malformed lines, blank lines, and lines missing timestamp or type" do
      path =
        write_fixture([
          "{ not json at all",
          "",
          "   ",
          ~s({"timestamp":#{@t0},"type":123}),
          ~s({"type":"stop"}),
          ~s({"timestamp":"#{@t0}","type":"stop"}),
          event(%{})
        ])

      assert buckets!(path, @t0, @t0 + @minute) == [
               %{m: @t0, s: @session, cwd: @cwd, k: "agent", n: 1}
             ]
    end

    test "a missing events file yields no buckets (no crash)" do
      assert {:ok, %{buckets: buckets}} =
               Shuttle.Activity.window(@t0, @t0 + @minute, events_file: "/no/such/events.jsonl")

      assert buckets == []
    end
  end

  describe "Shuttle.Activity.window/3 — rotated sibling" do
    test "reads events.jsonl.1 when its mtime falls inside the window" do
      path = write_fixture([event(%{"timestamp" => @t0 + @minute, "type" => "post_tool_use"})])

      write_rotated(
        path,
        [event(%{"timestamp" => @t0, "type" => "user_prompt_submit"})],
        div(@t0, 1_000) + 30
      )

      assert buckets!(path, @t0, @t0 + 2 * @minute) == [
               %{m: @t0, s: @session, cwd: @cwd, k: "attention", n: 1},
               %{m: @t0 + @minute, s: @session, cwd: @cwd, k: "agent", n: 1}
             ]
    end

    test "skips events.jsonl.1 when its mtime predates the window" do
      # The gate is deliberately coarse: rotation renames the file and never
      # writes it again, so an mtime before from_ms proves every line predates
      # the window. The in-range line below is unreachable in production for
      # exactly that reason; the test asserts the 64 MB scan really is skipped.
      path = write_fixture([event(%{"timestamp" => @t0, "type" => "post_tool_use"})])

      write_rotated(
        path,
        [event(%{"timestamp" => @t0, "type" => "user_prompt_submit"})],
        div(@t0, 1_000) - 3_600
      )

      assert buckets!(path, @t0, @t0 + @minute) == [
               %{m: @t0, s: @session, cwd: @cwd, k: "agent", n: 1}
             ]
    end
  end

  describe "Shuttle.Activity.window/3 — tool spans" do
    # The whole point of the fill: a long tool call is one continuous stretch of
    # work, and the minutes between its two stamped events belong to it.
    test "a seven-minute tool call yields seven continuous minutes" do
      path =
        write_fixture([
          event(%{"type" => "pre_tool_use", "timestamp" => @t0}),
          event(%{"type" => "post_tool_use", "timestamp" => @t0 + 6 * @minute + 30_000})
        ])

      buckets = buckets!(path, @t0, @t0 + 10 * @minute)

      assert Enum.map(buckets, & &1.m) == Enum.map(0..6, &(@t0 + &1 * @minute))
      assert Enum.all?(buckets, &(&1 == %{m: &1.m, s: @session, cwd: @cwd, k: "agent", n: 1}))
    end

    test "an unmatched pre fills nothing at all" do
      path = write_fixture([event(%{"type" => "pre_tool_use", "timestamp" => @t0})])

      assert buckets!(path, @t0, @t0 + 10 * @minute) == [
               %{m: @t0, s: @session, cwd: @cwd, k: "agent", n: 1}
             ]
    end

    test "the fill stops at the cap, however late the post arrives" do
      path =
        write_fixture([
          event(%{"type" => "pre_tool_use", "timestamp" => @t0}),
          event(%{"type" => "post_tool_use", "timestamp" => @t0 + 90 * @minute})
        ])

      minutes = buckets!(path, @t0, @t0 + 120 * @minute) |> Enum.map(& &1.m)

      # Minute 0 (the pre) through minute 29 (the last filled one), then the
      # post's own minute. Nothing in between.
      assert minutes == Enum.map(0..29, &(@t0 + &1 * @minute)) ++ [@t0 + 90 * @minute]
    end

    test "a session_start between the two ends the pairing" do
      path =
        write_fixture([
          event(%{"type" => "pre_tool_use", "timestamp" => @t0}),
          event(%{"type" => "session_start", "timestamp" => @t0 + 2 * @minute}),
          event(%{"type" => "post_tool_use", "timestamp" => @t0 + 5 * @minute})
        ])

      assert buckets!(path, @t0, @t0 + 10 * @minute) |> Enum.map(& &1.m) ==
               [@t0, @t0 + 2 * @minute, @t0 + 5 * @minute]
    end

    test "interleaved sessions do not cross-fill" do
      path =
        write_fixture([
          event(%{"type" => "pre_tool_use", "timestamp" => @t0, "sessionId" => "sess-a"}),
          event(%{
            "type" => "pre_tool_use",
            "timestamp" => @t0 + @minute,
            "sessionId" => "sess-b",
            "tmuxSession" => @other_session
          }),
          # B's tool returns first, and must fill nothing — its own pre is one
          # minute back, and A's is not its business.
          event(%{
            "type" => "post_tool_use",
            "timestamp" => @t0 + 2 * @minute,
            "sessionId" => "sess-b",
            "tmuxSession" => @other_session
          }),
          event(%{"type" => "post_tool_use", "timestamp" => @t0 + 4 * @minute, "sessionId" => "sess-a"})
        ])

      buckets = buckets!(path, @t0, @t0 + 10 * @minute)
      by_session = Enum.group_by(buckets, & &1.s, & &1.m)

      assert by_session[@session] == Enum.map(0..4, &(@t0 + &1 * @minute))
      assert by_session[@other_session] == [@t0 + @minute, @t0 + 2 * @minute]
    end

    # A filled minute is a statement that the minute was busy. A real event in
    # it is a count of something. The real event wins, in either order.
    test "a real event in a filled minute replaces the fill rather than adding to it" do
      before_post =
        write_fixture([
          event(%{"type" => "pre_tool_use", "timestamp" => @t0}),
          event(%{"type" => "notification", "timestamp" => @t0 + @minute}),
          event(%{"type" => "subagent_stop", "timestamp" => @t0 + @minute + 1_000}),
          event(%{"type" => "post_tool_use", "timestamp" => @t0 + 3 * @minute})
        ])

      # …and the same minute reached by a real event only after the fill landed.
      after_post =
        write_fixture([
          event(%{"type" => "pre_tool_use", "timestamp" => @t0, "sessionId" => "sess-a"}),
          event(%{"type" => "post_tool_use", "timestamp" => @t0 + 3 * @minute, "sessionId" => "sess-a"}),
          event(%{"type" => "subagent_stop", "timestamp" => @t0 + @minute, "sessionId" => "sess-b"})
        ])

      for path <- [before_post, after_post] do
        agent =
          path
          |> buckets!(@t0, @t0 + 10 * @minute)
          |> Enum.filter(&(&1.k == "agent" and &1.m == @t0 + @minute))

        assert agent == [%{m: @t0 + @minute, s: @session, cwd: @cwd, k: "agent", n: 1}]
      end
    end

    test "a call that began before the window fills only inside it" do
      path =
        write_fixture([
          event(%{"type" => "pre_tool_use", "timestamp" => @t0}),
          event(%{"type" => "post_tool_use", "timestamp" => @t0 + 5 * @minute})
        ])

      assert buckets!(path, @t0 + 2 * @minute, @t0 + 3 * @minute) |> Enum.map(& &1.m) ==
               [@t0 + 2 * @minute, @t0 + 3 * @minute]
    end
  end

  describe "Shuttle.Activity.window/3 — refused windows" do
    test "an inverted window is an error" do
      assert Shuttle.Activity.window(@t0, @t0 - 1) == {:error, :inverted_range}
    end

    test "a window wider than 120 days is an error, and 120 days exactly is not" do
      assert Shuttle.Activity.window(@t0, @t0 + Shuttle.Activity.max_range_ms() + 1) ==
               {:error, :range_too_wide}

      assert {:ok, _} =
               Shuttle.Activity.window(@t0, @t0 + Shuttle.Activity.max_range_ms(),
                 events_file: "/no/such/events.jsonl"
               )
    end
  end

  describe "GET /api/v1/activity" do
    test "200 with the host stamp, echoed bounds, and the buckets" do
      path =
        write_fixture([
          event(%{"type" => "user_prompt_submit"}),
          event(%{"timestamp" => @t0 + 5_000}),
          event(%{"timestamp" => @t0 + 6_000})
        ])

      with_events_file(path)

      conn = get(api_conn(), "/api/v1/activity?from_ms=#{@t0}&to_ms=#{@t0 + @minute}")

      assert conn.status == 200

      assert json_response(conn, 200) == %{
               "host" => Shuttle.Poller.own_host_id(),
               "from_ms" => @t0,
               "to_ms" => @t0 + @minute,
               "buckets" => [
                 %{"m" => @t0, "s" => @session, "cwd" => @cwd, "k" => "agent", "n" => 2},
                 %{"m" => @t0, "s" => @session, "cwd" => @cwd, "k" => "attention", "n" => 1}
               ],
               "spawns" => []
             }
    end

    test "200 with an empty bucket list when this host has no events file" do
      with_events_file(Path.join(System.tmp_dir!(), "shuttle_activity_absent.jsonl"))

      conn = get(api_conn(), "/api/v1/activity?from_ms=#{@t0}&to_ms=#{@t0 + @minute}")
      assert %{"buckets" => []} = json_response(conn, 200)
    end

    test "400 when a bound is missing or is not an integer" do
      for query <- [
            "",
            "?from_ms=#{@t0}",
            "?to_ms=#{@t0}",
            "?from_ms=abc&to_ms=#{@t0}",
            "?from_ms=#{@t0}&to_ms=17e11",
            "?from_ms=#{@t0}&to_ms=#{@t0}x"
          ] do
        conn = get(api_conn(), "/api/v1/activity" <> query)
        assert conn.status == 400, "expected 400 for #{inspect(query)}"
        assert %{"error" => _} = json_response(conn, 400)
      end
    end

    test "400 on an inverted window" do
      conn = get(api_conn(), "/api/v1/activity?from_ms=#{@t0}&to_ms=#{@t0 - 1}")

      assert conn.status == 400
      assert %{"error" => error} = json_response(conn, 400)
      assert error =~ "from_ms"
    end

    test "400 on a window wider than 120 days" do
      to_ms = @t0 + Shuttle.Activity.max_range_ms() + 1
      conn = get(api_conn(), "/api/v1/activity?from_ms=#{@t0}&to_ms=#{to_ms}")

      assert conn.status == 400
      assert %{"error" => error} = json_response(conn, 400)
      assert error =~ "120 days"
    end
  end

  # Point the reader at a fixture. Clears SHUTTLE_DATA_DIR too, so resolution
  # can never fall through to the real ~/.shuttle/events.jsonl on a dev machine.
  defp with_events_file(path) do
    keys = ~w(SHUTTLE_EVENTS_FILE SHUTTLE_DATA_DIR)
    previous = Map.new(keys, &{&1, System.get_env(&1)})

    Enum.each(keys, &System.delete_env/1)
    System.put_env("SHUTTLE_EVENTS_FILE", path)

    on_exit(fn ->
      Enum.each(previous, fn {k, v} ->
        if v, do: System.put_env(k, v), else: System.delete_env(k)
      end)
    end)
  end

end
