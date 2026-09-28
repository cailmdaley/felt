defmodule Shuttle.ActivityFoldTest do
  @moduledoc """
  Characterization of `Shuttle.Activity`'s window-independent fold against the
  windowed per-request scan it replaced (`Shuttle.Test.LegacyActivityScan`).

  One fixture exercises every rule in the moduledoc — spells and their
  onsets, machine prompts, stop → reply, tool-call fills with the cap, the
  `session_start` discard, fill-then-real and real-then-fill, file deliveries,
  malformed lines — and the two readers must agree on it for every window in a
  grid that starts and ends mid-spell, mid-tool-call, inside minutes and past
  the last event. The two places they legitimately part ways are asserted as
  the fold's behaviour, separately.
  """
  use ExUnit.Case, async: true

  alias Shuttle.Activity
  alias Shuttle.Test.LegacyActivityScan, as: Legacy

  @t0 1_770_000_000_000
  @s 1_000
  @m 60_000

  @a {"alpha-01KTS261GJMMRDRHS2QDMEFV3K-shuttle", "/repo/a"}
  @b {"beta-01KTCA2CY6X6P126ZMBK9686SH-shuttle", "/repo/b"}
  @none {nil, nil}

  defp ev({tmux, cwd}, type, ts, extra \\ %{}) do
    %{"type" => type, "timestamp" => @t0 + ts}
    |> then(&if tmux, do: Map.put(&1, "tmuxSession", tmux), else: &1)
    |> then(&if cwd, do: Map.put(&1, "cwd", cwd), else: &1)
    |> Map.merge(extra)
    |> Jason.encode!()
  end

  defp sid(id), do: %{"sessionId" => id}

  defp fixture_lines do
    [
      # A: a spell with two repeats, answered by a person.
      ev(@a, "notification", 0),
      ev(@a, "notification", 10 * @s),
      ev(@a, "notification", 70 * @s),
      ev(@a, "user_prompt_submit", 2 * @m),
      # A: a tool call whose interior meets real events already tallied (two
      # at 3m, so a fill that overwrote them would show) and one tallied after
      # the fill (6m).
      ev(@a, "pre_tool_use", 2 * @m + 5 * @s, sid("s1")),
      ev(@b, "notification", 2 * @m + 30 * @s),
      ev(@a, "user_prompt_submit", 3 * @m, %{"machine" => true}),
      ev(@a, "subagent_stop", 3 * @m + 20 * @s),
      "not json at all",
      ev(@b, "stop", 4 * @m),
      ev(@a, "post_tool_use", 9 * @m, sid("s1")),
      ev(@a, "subagent_stop", 6 * @m + 10 * @s),
      ~s({"type": "stop"}),
      ~s({"timestamp": #{@t0 + 9 * @m}}),
      # C: a restart between pre and post discards the pairing.
      ev(@b, "pre_tool_use", 10 * @m, sid("s3")),
      ev(@b, "session_start", 11 * @m, sid("s3")),
      ev(@b, "post_tool_use", 15 * @m, sid("s3")),
      ev(@b, "post_tool_use", 16 * @m, sid("nobody")),
      # A: an hour-long call, filled only to the cap.
      ev(@a, "pre_tool_use", 20 * @m, sid("s4")),
      # Unattributed: a long spell a file delivery does not disturb.
      ev(@none, "notification", 30 * @m),
      ev(@none, "notification", 31 * @m),
      ev(@none, "file_sent", 33 * @m + 5 * @s),
      ev(@none, "notification", 32 * @m),
      ev(@none, "user_prompt_submit", 35 * @m),
      ev(@none, "notification", 36 * @m),
      # B: two onsets in one minute.
      ev(@b, "notification", 50 * @m),
      ev(@b, "pre_tool_use", 50 * @m + 10 * @s),
      ev(@b, "notification", 50 * @m + 20 * @s),
      ev(@a, "stop", 55 * @m),
      ev(@a, "post_tool_use", 80 * @m, sid("s4")),
      ev(@b, "stop", 81 * @m)
    ]
  end

  defp write!(path, lines), do: File.write!(path, Enum.join(lines, "\n") <> "\n")

  setup do
    path =
      Path.join(System.tmp_dir!(), "activity_fold_#{System.unique_integer([:positive])}.jsonl")

    on_exit(fn -> File.rm(path) && File.rm(path <> ".1") end)
    {:ok, path: path}
  end

  @froms [
    -5 * @m,
    0,
    30 * @s,
    @m,
    2 * @m + 30 * @s,
    5 * @m,
    21 * @m,
    25 * @m,
    31 * @m,
    34 * @m,
    50 * @m
  ]
  @tos [
    0,
    @m,
    3 * @m,
    6 * @m + 30 * @s,
    8 * @m,
    12 * @m,
    30 * @m,
    33 * @m,
    45 * @m,
    90 * @m,
    200 * @m
  ]

  test "fold-then-slice equals the windowed scan for every window in the grid", %{path: path} do
    write!(path, fixture_lines())
    acc = Activity.fold_stream(path)

    windows = for f <- @froms, t <- @tos, f <= t, do: {@t0 + f, @t0 + t + 17 * @s}
    assert length(windows) > 70

    for {from_ms, to_ms} <- windows do
      {:ok, legacy} = Legacy.window(from_ms, to_ms, events_file: path)
      assert Activity.slice(acc, from_ms, to_ms) == legacy, "window #{from_ms}..#{to_ms}"
      assert Activity.window(from_ms, to_ms, events_file: path) == {:ok, legacy}
    end
  end

  test "the fixture exercises what it claims", %{path: path} do
    write!(path, fixture_lines())
    all = Activity.slice(Activity.fold_stream(path), @t0 - @m, @t0 + 200 * @m)

    at = fn m, {s, cwd}, k ->
      Enum.find(all, &(&1.m == @t0 + m and &1.s == s and &1.cwd == cwd and &1.k == k))
    end

    # One onset for three notifications.
    assert %{n: 1} = at.(0, @a, "notify")
    refute at.(@m, @a, "notify")
    # Real-then-fill keeps the real count; fill-then-real replaces the fill.
    assert %{n: 2} = at.(3 * @m, @a, "agent")
    assert %{n: 1} = at.(6 * @m, @a, "agent")
    assert %{n: 1} = at.(8 * @m, @a, "agent")
    # The cap: 21..49 filled, 50..79 not.
    assert at.(49 * @m, @a, "agent")
    refute at.(50 * @m, @a, "agent")
    # The restart discarded C's pairing.
    refute at.(12 * @m, @b, "agent")
    # stop → agent + reply.
    assert at.(55 * @m, @a, "reply") && at.(55 * @m, @a, "agent")
    # Two onsets in one minute.
    assert %{n: 2} = at.(50 * @m, @b, "notify")
    # The unattributed spell: one onset, then one after the answer.
    assert at.(30 * @m, @none, "notify")
    refute at.(32 * @m, @none, "notify")
    assert at.(36 * @m, @none, "notify")
  end

  test "a spell open in the rotated file stays open, even when the window predates nothing in it",
       %{path: path} do
    # The windowed scan skipped a rotated file whose mtime predates the window,
    # so it re-opened this spell at its first in-window repeat. The fold always
    # reads both files, and the repeat is a repeat.
    write!(path <> ".1", [ev(@a, "notification", 0)])
    File.touch!(path <> ".1", div(@t0, 1_000) + 5)
    write!(path, [ev(@a, "notification", 10 * @m), ev(@a, "stop", 11 * @m)])

    {:ok, legacy} = Legacy.window(@t0 + 5 * @m, @t0 + 20 * @m, events_file: path)
    assert %{k: "notify"} = hd(legacy)

    assert Activity.slice(Activity.fold_stream(path), @t0 + 5 * @m, @t0 + 20 * @m) == [
             %{m: @t0 + 11 * @m, s: elem(@a, 0), cwd: elem(@a, 1), k: "agent", n: 1},
             %{m: @t0 + 11 * @m, s: elem(@a, 0), cwd: elem(@a, 1), k: "reply", n: 1}
           ]
  end

  test "state follows file order, so a line stamped past the window still moves it",
       %{path: path} do
    # A concurrent writer's line can land in the file after one stamped later.
    # The windowed scan ignored every line stamped past `to_ms`; the fold does
    # not know about windows, so the late-stamped notification opens the spell
    # and the earlier-stamped one written after it is a repeat.
    write!(path, [ev(@a, "notification", 5 * @m), ev(@a, "notification", @m)])

    {:ok, legacy} = Legacy.window(@t0, @t0 + 2 * @m, events_file: path)
    assert [%{m: m, k: "notify"}] = legacy
    assert m == @t0 + @m

    assert Activity.slice(Activity.fold_stream(path), @t0, @t0 + 2 * @m) == []
  end

  test "drop_before removes earlier minutes and older pending calls, nothing else", %{path: path} do
    write!(path, [
      ev(@a, "pre_tool_use", 0, sid("old")),
      ev(@a, "stop", @m),
      ev(@a, "pre_tool_use", 5 * @m + 40 * @s, sid("new")),
      ev(@a, "stop", 6 * @m)
    ])

    acc = path |> Activity.fold_stream() |> Activity.drop_before(@t0 + 5 * @m + 30 * @s)

    assert acc |> Activity.slice(@t0 - @m, @t0 + 10 * @m) |> Enum.map(& &1.m) |> Enum.uniq() ==
             [@t0 + 5 * @m, @t0 + 6 * @m]

    # The old call no longer fills when it returns; the newer one does.
    acc =
      Activity.fold_lines(acc, [
        ev(@a, "post_tool_use", 9 * @m, sid("old")),
        ev(@a, "post_tool_use", 9 * @m, sid("new"))
      ])

    assert Activity.slice(acc, @t0 + 2 * @m, @t0 + 2 * @m) == []
    assert acc |> Activity.slice(@t0 + 7 * @m, @t0 + 7 * @m) |> length() == 1
    assert Activity.drop_before(acc, nil) == acc

    # Identities that only the dropped minutes referred to are forgotten.
    b_only = path |> Activity.fold_stream() |> Activity.fold_lines([ev(@b, "stop", 0)])
    assert map_size(b_only.names) == 2
    assert map_size(Activity.drop_before(b_only, @t0 + 5 * @m).names) == 1
  end
end
