defmodule Shuttle.ActivityFollowerTest do
  @moduledoc """
  `Shuttle.Activity.Follower`: seeds the fold from `events.jsonl.1` and
  `events.jsonl`, follows appends, answers only for its own path, rebuilds on
  a shrink in place, and continues the fold across a real rename-rotation —
  including a waiting spell and a tool call that straddle it.

  The follower's poll interval is set far out, so every catch-up here is the
  one a read performs; nothing depends on timing.
  """
  use ExUnit.Case, async: true

  alias Shuttle.Activity
  alias Shuttle.Activity.Follower

  @t0 1_770_000_000_000
  @m 60_000
  @tmux "alpha-01KTS261GJMMRDRHS2QDMEFV3K-shuttle"
  @cwd "/repo/a"

  setup do
    dir = Path.join(System.tmp_dir!(), "activity_follower_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    {:ok, path: Path.join(dir, "events.jsonl")}
  end

  defp ev(type, minute, extra \\ %{}) do
    %{
      "type" => type,
      "timestamp" => @t0 + minute * @m,
      "tmuxSession" => @tmux,
      "cwd" => @cwd,
      "sessionId" => "s1"
    }
    |> Map.merge(extra)
    |> Jason.encode!()
  end

  defp append(path, lines), do: File.write!(path, Enum.map(lines, &(&1 <> "\n")), [:append])

  defp start(path) do
    name = :"activity_follower_#{System.unique_integer([:positive])}"
    start_supervised!({Follower, events_file: path, poll_interval_ms: 3_600_000, name: name})
    name
  end

  defp all(name, path) do
    {:ok, buckets} = Follower.slice(name, path, @t0 - 1_000 * @m, @t0 + 1_000 * @m)
    buckets
  end

  defp fresh(path),
    do: Activity.slice(Activity.fold_stream(path), @t0 - 1_000 * @m, @t0 + 1_000 * @m)

  defp kinds(buckets), do: Enum.map(buckets, &{div(&1.m - @t0, @m), &1.k, &1.n})

  test "seeds from the rotated file then the live one, and matches a fresh fold", %{path: path} do
    append(path <> ".1", [ev("notification", 0), ev("pre_tool_use", 1)])
    append(path, [ev("notification", 2), ev("post_tool_use", 5)])
    name = start(path)

    assert all(name, path) == fresh(path)

    assert kinds(all(name, path)) == [
             {0, "notify", 1},
             {1, "agent", 1},
             {2, "agent", 1},
             {2, "notify", 1},
             {3, "agent", 1},
             {4, "agent", 1},
             {5, "agent", 1}
           ]
  end

  test "a read catches up on appended lines, and leaves a partial line for later", %{path: path} do
    append(path, [ev("stop", 0)])
    name = start(path)
    assert kinds(all(name, path)) == [{0, "agent", 1}, {0, "reply", 1}]

    append(path, [ev("user_prompt_submit", 1)])
    File.write!(path, String.slice(ev("user_prompt_submit", 2), 0, 20), [:append])
    assert kinds(all(name, path)) == [{0, "agent", 1}, {0, "reply", 1}, {1, "attention", 1}]

    File.write!(path, String.slice(ev("user_prompt_submit", 2), 20..-1//1) <> "\n", [:append])
    assert {2, "attention", 1} in kinds(all(name, path))
    assert all(name, path) == fresh(path)
  end

  test "any other path is a miss, and window/3 then folds that path itself", %{path: path} do
    other = path <> ".other"
    append(other, [ev("stop", 0)])
    on_exit(fn -> File.rm(other) end)
    name = start(path)

    assert Follower.slice(name, other, @t0, @t0 + @m) == :miss
    assert Follower.events_file(name) == path

    assert {:ok, [%{k: "agent"}, %{k: "reply"}]} =
             Activity.window(@t0, @t0 + @m, events_file: other, follower: name)
  end

  test "a follower that is not running is a miss" do
    assert Follower.slice(:no_such_follower, "/x", @t0, @t0 + @m) == :miss
  end

  test "a shrink in place rebuilds from the files", %{path: path} do
    append(path, [ev("stop", 0), ev("stop", 1)])
    name = start(path)
    assert length(all(name, path)) == 4

    File.write!(path, ev("user_prompt_submit", 7) <> "\n")
    assert kinds(all(name, path)) == [{7, "attention", 1}]
  end

  test "rotation continues the fold: a spell and a tool call straddle the rename",
       %{path: path} do
    gamma = %{"tmuxSession" => "gamma", "sessionId" => "g1"}
    append(path, [ev("notification", 0), ev("pre_tool_use", 1, gamma)])
    name = start(path)
    assert kinds(all(name, path)) == [{0, "notify", 1}, {1, "agent", 1}]

    # Written after the follower last read, then rotated away before it reads
    # again: the drain of the rotated file's tail must pick it up.
    append(path, [ev("notification", 2, %{"tmuxSession" => "beta"})])
    File.rename!(path, path <> ".1")

    # The new live file repeats alpha's ask (the same spell, so no mark) and
    # returns gamma's tool call, opened before the rotation.
    append(path, [ev("notification", 3), ev("post_tool_use", 6, gamma)])

    buckets = all(name, path)
    assert buckets == fresh(path)

    assert Enum.map(buckets, &{div(&1.m - @t0, @m), &1.s, &1.k}) == [
             {0, @tmux, "notify"},
             {1, "gamma", "agent"},
             {2, "beta", "notify"},
             {2, "gamma", "agent"},
             {3, "gamma", "agent"},
             {4, "gamma", "agent"},
             {5, "gamma", "agent"},
             {6, "gamma", "agent"}
           ]
  end

  test "a second rotation drops what the overwritten file held, and keeps the spell",
       %{path: path} do
    append(path, [ev("notification", 0), ev("stop", 1, %{"tmuxSession" => "beta"})])
    name = start(path)

    File.rename!(path, path <> ".1")
    append(path, [ev("stop", 10, %{"tmuxSession" => "beta"})])
    assert length(all(name, path)) == 5

    File.rename!(path, path <> ".1")
    append(path, [ev("notification", 20), ev("stop", 21, %{"tmuxSession" => "beta"})])

    # Minutes 0 and 1 lived only in the overwritten file. Alpha's spell from
    # minute 0 is still open, so minute 20 is a repeat, not an onset.
    assert Enum.map(all(name, path), &{div(&1.m - @t0, @m), &1.k}) == [
             {10, "agent"},
             {10, "reply"},
             {21, "agent"},
             {21, "reply"}
           ]
  end

  test "a rotation racing the seed is not counted twice", %{path: path} do
    append(path <> ".1", [ev("stop", 0, %{"tmuxSession" => "a"})])
    append(path, Enum.map(1..5, &ev("stop", &1, %{"tmuxSession" => "b"})))

    # Rotate once, between the seed's read of the live file and its fold of
    # `.1`, and give the new live file lines of its own.
    once = :counters.new(1, [])

    hook = fn ->
      if :counters.get(once, 1) == 0 do
        :counters.add(once, 1, 1)
        File.rename!(path, path <> ".1")
        append(path, Enum.map(6..7, &ev("stop", &1, %{"tmuxSession" => "c"})))
      end
    end

    name = :"activity_follower_#{System.unique_integer([:positive])}"

    start_supervised!(
      {Follower, events_file: path, poll_interval_ms: 3_600_000, name: name, seed_hook: hook}
    )

    assert all(name, path) == fresh(path)
    assert :counters.get(once, 1) == 1
    assert Enum.all?(all(name, path), &(&1.n == 1))
  end

  test "a replacement it cannot account for rebuilds from the files", %{path: path} do
    append(path, [ev("stop", 0)])
    name = start(path)
    assert length(all(name, path)) == 2

    # A new live file whose predecessor did not become events.jsonl.1. It is
    # written beside the old one first, so the two cannot share an inode.
    append(path <> ".new", [ev("user_prompt_submit", 4)])
    File.rename!(path <> ".new", path)
    assert kinds(all(name, path)) == [{4, "attention", 1}]
  end
end
