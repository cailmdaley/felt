defmodule ShuttleWeb.ActivityControllerTest do
  @moduledoc """
  Reader + wiring for `GET /api/v1/activity` — the per-minute activity
  histogram the temporal view polls.

  The reader (`Shuttle.Activity`) is exercised against fixture `events.jsonl`
  files covering bucket aggregation, the three-way kind mapping, waiting-spell
  collapse (a `"notify"` mark is the onset of an ask, not a repeat of it),
  window bounds, nil session/cwd, malformed-line tolerance, and reading the
  rotated `events.jsonl.1` ahead of the live file. The
  controller's tests point `$SHUTTLE_EVENTS_FILE` at those fixtures and cover
  the 400s.
  """
  use ExUnit.Case, async: true
  use ExUnitProperties
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest

  alias Shuttle.Test.Env

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

  # Write the rotated sibling of `path` with a given mtime. The reader never
  # consults it; the tests stamp one far from the window to show that.
  defp write_rotated(path, lines, mtime_s) do
    File.write!(path <> ".1", Enum.join(lines, "\n") <> "\n")
    File.touch!(path <> ".1", mtime_s)
  end

  defp buckets!(path, from_ms, to_ms) do
    {:ok, buckets} = Shuttle.Activity.window(from_ms, to_ms, events_file: path)
    buckets
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

  # One identity's events, each a person's or the harness's.
  @spell_events [
    {"notification", %{}},
    {"file_sent", %{"files" => ["/tmp/report.html"]}},
    {"user_prompt_submit", %{}},
    {"user_prompt_submit", %{"machine" => true}},
    {"post_tool_use", %{}},
    {"subagent_stop", %{}},
    {"stop", %{}},
    {"session_end", %{}}
  ]

  # Notifications are weighted up so spells open often enough to be closed.
  defp spell_event,
    do: frequency([{3, constant(hd(@spell_events))}, {4, member_of(tl(@spell_events))}])

  # The waiting-spell rule for one identity, stated apart from the fold. A
  # notification is an onset only while no spell is open, and repeats inside
  # the spell are the same ask. A file delivery is no activity at all and leaves
  # the spell as it is. Every other event closes the spell: a person's prompt;
  # a machine-flagged prompt, which is not attention but is the session moving
  # again; a tool return, such as a permission granted elsewhere; a completed
  # reply. The next notification is then a fresh onset, in the same minute or
  # a later one.
  defp spell_model(events) do
    {tally, _open?} =
      Enum.reduce(events, {%{}, false}, fn {ts, type, extra}, {tally, open?} ->
        {kinds, open?} =
          case {type, extra} do
            {"notification", _} -> {if(open?, do: [], else: ["notify"]), true}
            {"file_sent", _} -> {[], open?}
            {"user_prompt_submit", %{"machine" => true}} -> {["agent"], false}
            {"user_prompt_submit", _} -> {["attention"], false}
            {"stop", _} -> {["agent", "reply"], false}
            _ -> {["agent"], false}
          end

        {Enum.reduce(kinds, tally, &Map.update(&2, {minute(ts), &1}, 1, fn n -> n + 1 end)),
         open?}
      end)

    for {{m, k}, n} <- Enum.sort(tally), do: %{m: m, s: @session, cwd: @cwd, k: k, n: n}
  end

  defp minute(ts), do: Integer.floor_div(ts, @minute) * @minute

  describe "Shuttle.Activity.window/3 — waiting spells" do
    # A notify mark is the ONSET of a waiting spell, not a notification. Claude
    # Code re-fires the idle notification every minute; those repeats are the
    # same unanswered ask.
    property "a spell has one onset, and only session activity closes it" do
      check all(
              # Short gaps are weighted up so a spell often opens, closes
              # and reopens inside one minute.
              steps <-
                list_of(
                  {frequency([{1, integer(0..2_000)}, {2, integer(0..(2 * @minute))}]),
                   spell_event()},
                  min_length: 1,
                  max_length: 15
                ),
              max_runs: 100
            ) do
        {events, _} =
          Enum.map_reduce(steps, @t0, fn {gap, {type, extra}}, ts ->
            {{ts + gap, type, extra}, ts + gap}
          end)

        path =
          write_fixture(
            for {ts, type, extra} <- events,
                do: event(Map.merge(extra, %{"timestamp" => ts, "type" => type}))
          )

        assert buckets!(path, @t0, @t0 + 30 * @minute) == spell_model(events)
      end
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
    test "the window names whole minutes: both bounds inclusive, every bucket complete" do
      path =
        write_fixture([
          event(%{"timestamp" => @t0 - 1}),
          event(%{"timestamp" => @t0}),
          event(%{"timestamp" => @t0 + @minute}),
          event(%{"timestamp" => @t0 + @minute + 1}),
          event(%{"timestamp" => @t0 + 2 * @minute})
        ])

      buckets = buckets!(path, @t0, @t0 + @minute)

      # The minute before and the minute after are out; the last minute is
      # served whole, not cut at the bound's millisecond.
      assert Enum.map(buckets, &{&1.m, &1.n}) == [{@t0, 1}, {@t0 + @minute, 2}]
    end

    test "bounds inside a minute select the same minutes, so the answer is the same" do
      path =
        write_fixture([
          event(%{"timestamp" => @t0 + 10_000}),
          event(%{"timestamp" => @t0 + @minute + 10_000}),
          event(%{"timestamp" => @t0 + 2 * @minute + 10_000}),
          event(%{"type" => "pre_tool_use", "timestamp" => @t0 + 3 * @minute}),
          event(%{"type" => "post_tool_use", "timestamp" => @t0 + 7 * @minute})
        ])

      aligned = buckets!(path, @t0 + @minute, @t0 + 5 * @minute)

      # A partial first minute is not served (its start precedes from_ms); the
      # upper bound's minute is served whole wherever inside it the bound falls.
      assert buckets!(path, @t0 + 1, @t0 + 5 * @minute) == aligned
      assert buckets!(path, @t0 + @minute - 1, @t0 + 5 * @minute + 59_999) == aligned
      assert buckets!(path, @t0 + 30_000, @t0 + 5 * @minute + 12_345) == aligned

      # Tool-interior fills are clipped to the same canonical minutes.
      assert Enum.map(aligned, & &1.m) ==
               Enum.map(1..5, &(@t0 + &1 * @minute))
    end

    test "canonical_window/2 ceils the start, floors the end to its last millisecond" do
      assert Shuttle.Activity.canonical_window(@t0, @t0) == {@t0, @t0 + 59_999}

      assert Shuttle.Activity.canonical_window(@t0 + 1, @t0 + 59_999) ==
               {@t0 + @minute, @t0 + 59_999}

      assert Shuttle.Activity.canonical_window(@t0 - 1, @t0 + @minute) ==
               {@t0, @t0 + @minute + 59_999}

      # Idempotent.
      {from, to} = Shuttle.Activity.canonical_window(@t0 + 17, @t0 + 3 * @minute + 5)
      assert Shuttle.Activity.canonical_window(from, to) == {from, to}
    end

    test "a window inside one minute serves nothing rather than a partial minute" do
      path = write_fixture([event(%{"timestamp" => @t0 + 20_000})])
      assert buckets!(path, @t0 + 10_000, @t0 + 30_000) == []
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
      assert {:ok, []} =
               Shuttle.Activity.window(@t0, @t0 + @minute, events_file: "/no/such/events.jsonl")
    end
  end

  describe "Shuttle.Activity.window/3 — rotated sibling" do
    test "reads events.jsonl.1 ahead of the live file" do
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

    test "reads events.jsonl.1 whatever its mtime, so its state reaches the live file" do
      # A spell opened in the rotated file is still open when the live file
      # repeats the ask, however long ago the rotation was: no second onset.
      path =
        write_fixture([
          event(%{"timestamp" => @t0, "type" => "notification"}),
          event(%{"timestamp" => @t0 + @minute, "type" => "post_tool_use"})
        ])

      write_rotated(
        path,
        [event(%{"timestamp" => @t0 - 3_600_000, "type" => "notification"})],
        div(@t0, 1_000) - 3_600
      )

      assert buckets!(path, @t0, @t0 + @minute) == [
               %{m: @t0 + @minute, s: @session, cwd: @cwd, k: "agent", n: 1}
             ]
    end
  end

  # The tool-span rule, stated apart from the fold. Pairing is by `sessionId`,
  # and each session holds at most one pending pre, which a later pre replaces
  # and a session_start discards. A post pairs only with its own session's pre,
  # and not with one stamped after it. It fills the minutes strictly between
  # the two stamped ones, under the identity of the pre, but no further than
  # the first 30 after the pre, however late the post arrives. A filled minute
  # is a statement that the minute was busy and a real event is a count, so a
  # real event in a filled minute replaces the fill, in either file order. The
  # window then selects whole minutes, so a call that began before it fills
  # only inside it.
  defp span_model(events, from_ms, to_ms) do
    {tally, _pending} =
      Enum.reduce(events, {%{}, %{}}, fn {ts, s, sid, type}, {tally, pending} ->
        {tally, pending} =
          case {type, pending[sid]} do
            {"pre_tool_use", _} ->
              {tally, Map.put(pending, sid, {ts, s})}

            {"session_start", _} ->
              {tally, Map.delete(pending, sid)}

            {"post_tool_use", {pre, pre_s}} when pre <= ts ->
              {fill(tally, pre_s, pre, ts), Map.delete(pending, sid)}

            _ ->
              {tally, pending}
          end

        {Map.update(tally, {minute(ts), s}, 1, &if(&1 == :fill, do: 1, else: &1 + 1)), pending}
      end)

    for {{m, s}, n} <- Enum.sort(tally), m >= from_ms and m <= to_ms do
      %{m: m, s: s, cwd: @cwd, k: "agent", n: if(n == :fill, do: 1, else: n)}
    end
  end

  defp fill(tally, s, pre, post) do
    interior = (minute(pre) + @minute)..(minute(post) - @minute)//@minute

    for m <- interior, m < minute(pre) + 30 * @minute, reduce: tally do
      tally -> Map.put_new(tally, {m, s}, :fill)
    end
  end

  describe "Shuttle.Activity.window/3 — tool spans" do
    # The whole point of the fill: a long tool call is one continuous stretch of
    # work, and the minutes between its two stamped events belong to it.
    #
    # Events crowd the first few minutes, so real events land inside calls, or
    # come past the cap, so calls outrun it. The fold runs in file order, so
    # stamps need not ascend.
    property "matched calls fill their interior minutes, capped, inside the window" do
      check all(
              events <-
                list_of(
                  {frequency([{3, integer(0..4)}, {1, integer(28..40)}]),
                   integer(0..(@minute - 1)), member_of([@session, @other_session]),
                   member_of(["sess-a", "sess-b"]),
                   frequency([
                     {3, constant("pre_tool_use")},
                     {3, constant("post_tool_use")},
                     {1, constant("session_start")},
                     {2, constant("subagent_stop")}
                   ])},
                  min_length: 1,
                  max_length: 20
                ),
              from <- integer(0..5),
              width <- integer(0..40),
              max_runs: 100
            ) do
        events = for {m, ms, s, sid, type} <- events, do: {@t0 + m * @minute + ms, s, sid, type}

        path =
          write_fixture(
            for {ts, s, sid, type} <- events do
              event(%{"timestamp" => ts, "type" => type, "tmuxSession" => s, "sessionId" => sid})
            end
          )

        {from_ms, to_ms} = {@t0 + from * @minute, @t0 + (from + width) * @minute}
        assert buckets!(path, from_ms, to_ms) == span_model(events, from_ms, to_ms)
      end
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
    test "200 with the host stamp, the canonical bounds, and the buckets" do
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
               "to_ms" => @t0 + @minute + 59_999,
               "buckets" => [
                 %{"m" => @t0, "s" => @session, "cwd" => @cwd, "k" => "agent", "n" => 2},
                 %{"m" => @t0, "s" => @session, "cwd" => @cwd, "k" => "attention", "n" => 1}
               ]
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

  # Point the reader at a fixture.
  defp with_events_file(path) do
    Env.put_env("SHUTTLE_EVENTS_FILE", path)
  end
end
