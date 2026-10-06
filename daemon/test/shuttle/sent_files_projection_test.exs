defmodule Shuttle.SentFilesProjectionTest do
  @moduledoc """
  The in-memory sent-files projection: `Shuttle.EventStream` seeds it from the
  events files once and then reads only appended bytes, and `Shuttle.SentFiles`
  serves `for_uid/2` and `all_since/2` from it.

  The load-bearing test here is `legacy_*` — a verbatim copy of the full-rescan
  reader, pinned against the held projection over the same fixture. Everything
  else checks the projection's mechanics: appends, a prefix it must not
  re-read, truncation, rotation, malformed lines, a partial trailing line, and
  the ledger join that has to stay at read time.
  """
  use ExUnit.Case, async: true

  alias Shuttle.{EventStream, SentFiles}

  @match_ulid "01KTS261GJMMRDRHS2QDMEFV3K"
  @other_ulid "01KTCA2CY6X6P126ZMBK9686SH"
  @session "0883ade1-08e0-4457-94c6-7ac12137eb0f"

  setup do
    base = "sent_files_projection_#{System.unique_integer([:positive])}"
    events = Path.join(System.tmp_dir!(), base <> ".jsonl")
    ledger = Path.join(System.tmp_dir!(), base <> "_ledger.jsonl")
    File.write!(events, "")
    File.write!(ledger, "")
    on_exit(fn -> File.rm(events) && File.rm(ledger) end)
    {:ok, events: events, ledger: ledger}
  end

  # ── fixture writers ──

  defp sent_line(opts) do
    %{
      "type" => "file_sent",
      "sessionId" => Keyword.get(opts, :session, @session),
      "tmuxSession" => Keyword.get(opts, :tmux, "morning-post-#{@match_ulid}-shuttle"),
      "timestamp" => Keyword.get(opts, :ts, 1_000),
      "files" => Keyword.get(opts, :files, ["/tmp/a.html"]),
      "cwd" => Keyword.get(opts, :cwd, "/tmp")
    }
    |> Jason.encode!()
  end

  defp append(path, line), do: File.write!(path, line <> "\n", [:append])

  defp write_claim(ledger, session, uid) do
    File.write!(
      ledger,
      Jason.encode!(%{"session" => session, "uid" => uid, "kind" => "claim", "at" => 1}) <> "\n"
    )
  end

  # ── stream ──

  defp start_stream(events) do
    name = :"sent_files_stream_#{System.unique_integer([:positive])}"

    start_supervised!({EventStream, events_file: events, poll_interval_ms: 10, name: name})
    name
  end

  # Options that force the held projection, and options that force the direct
  # full-file scan — the same reader over the same file, two ways in.
  defp followed(events, ledger, name, extra \\ []),
    do: [events_file: events, session_ledger_file: ledger, stream: name] ++ extra

  defp scanned(events, ledger, extra \\ []),
    do: [events_file: events, session_ledger_file: ledger, stream: :no_such_stream] ++ extra

  defp wait_until(fun, tries \\ 100) do
    cond do
      fun.() -> true
      tries <= 0 -> false
      true -> Process.sleep(10) && wait_until(fun, tries - 1)
    end
  end

  # ── the characterization: the reader this replaced, verbatim ──

  defp legacy_for_uid(uid, opts) do
    path = Keyword.fetch!(opts, :events_file)
    cap = Keyword.get(opts, :cap, 50)
    session_uids = legacy_session_uids(opts)

    if File.regular?(path) do
      path
      |> File.stream!()
      |> Stream.flat_map(&legacy_entries_for_line(&1, uid, session_uids))
      |> Enum.to_list()
      |> legacy_dedupe_newest()
      |> Enum.sort_by(& &1.timestamp, :desc)
      |> Enum.take(cap)
    else
      []
    end
  end

  defp legacy_all_since(since_ms, opts) do
    path = Keyword.fetch!(opts, :events_file)
    session_uids = legacy_session_uids(opts)

    if File.regular?(path) do
      path
      |> File.stream!()
      |> Stream.flat_map(&legacy_entries_since_line(&1, since_ms, session_uids))
      |> Enum.to_list()
      |> Enum.sort_by(& &1.timestamp)
    else
      []
    end
  end

  defp legacy_entries_since_line(line, since_ms, session_uids) do
    with {:ok, event} <- Jason.decode(line),
         files when is_list(files) <- legacy_sent_paths(event),
         timestamp when is_integer(timestamp) and timestamp >= since_ms <- event["timestamp"] do
      session_id = event["sessionId"]
      cwd = event["cwd"]
      uid = legacy_event_uid(event, session_uids)

      for full_path <- files, is_binary(full_path) do
        abs = legacy_absolutize(full_path, cwd)

        %{
          fullPath: abs,
          basename: Path.basename(abs),
          timestamp: timestamp,
          sessionId: session_id,
          uid: uid
        }
      end
    else
      _ -> []
    end
  end

  defp legacy_entries_for_line(line, uid, session_uids) do
    with {:ok, event} <- Jason.decode(line),
         files when is_list(files) <- legacy_sent_paths(event),
         true <- uid in legacy_event_uids(event, session_uids) do
      session_id = event["sessionId"]
      timestamp = event["timestamp"]
      cwd = event["cwd"]

      for full_path <- files, is_binary(full_path) do
        abs = legacy_absolutize(full_path, cwd)

        %{
          fullPath: abs,
          basename: Path.basename(abs),
          timestamp: timestamp,
          sessionId: session_id
        }
      end
    else
      _ -> []
    end
  end

  defp legacy_sent_paths(%{"type" => "file_sent", "files" => files}), do: files

  defp legacy_sent_paths(%{"tool" => "SendUserFile", "toolInput" => %{"files" => files}}),
    do: files

  defp legacy_sent_paths(_), do: nil

  defp legacy_absolutize(path, cwd) do
    if Path.type(path) == :relative and is_binary(cwd) and cwd != "",
      do: Path.expand(path, cwd),
      else: path
  end

  defp legacy_event_uid(event, session_uids) do
    case Shuttle.ULID.from_tmux(event["tmuxSession"]) do
      nil -> Map.get(session_uids, event["sessionId"], event["sessionId"])
      uid -> uid
    end
  end

  defp legacy_event_uids(event, session_uids) do
    [legacy_event_uid(event, session_uids), event["sessionId"]]
    |> Enum.filter(&(is_binary(&1) and &1 != ""))
    |> Enum.uniq()
  end

  defp legacy_session_uids(opts) do
    Shuttle.SessionLedger.read_since(0, path: Keyword.fetch!(opts, :session_ledger_file))
    |> Enum.reduce(%{}, fn record, acc ->
      case {record["session"], record["uid"]} do
        {s, u} when is_binary(s) and s != "" and is_binary(u) and u != "" -> Map.put(acc, s, u)
        _ -> acc
      end
    end)
  end

  defp legacy_dedupe_newest(entries) do
    entries
    |> Enum.reduce(%{}, fn entry, acc ->
      Map.update(acc, entry.fullPath, entry, fn existing ->
        if entry.timestamp >= existing.timestamp, do: entry, else: existing
      end)
    end)
    |> Map.values()
  end

  # A fixture broad enough to exercise every branch the two readers share:
  # tmux-ULID match, sessionId-only match, a ledger claim, a legacy
  # SendUserFile shape, a relative path resolved against cwd, a repeated path
  # (dedupe), an unrelated fiber, a non-sent event, and a malformed line.
  defp write_broad_fixture(events, ledger) do
    write_claim(ledger, "native-sess", @other_ulid)

    [
      sent_line(ts: 1_000, files: ["/tmp/a.html"]),
      sent_line(ts: 2_000, files: ["/tmp/a.html", "relative/b.png"], cwd: "/work"),
      sent_line(ts: 1_500, files: ["/tmp/a.html"]),
      sent_line(ts: 3_000, tmux: "", session: "native-sess", files: ["/tmp/native.html"]),
      sent_line(ts: 4_000, tmux: "other-#{@other_ulid}-shuttle", files: ["/tmp/other.html"]),
      Jason.encode!(%{
        "type" => "pre_tool_use",
        "tool" => "SendUserFile",
        "sessionId" => @session,
        "tmuxSession" => "morning-post-#{@match_ulid}-shuttle",
        "timestamp" => 5_000,
        "toolInput" => %{"files" => ["/tmp/legacy.html"]}
      }),
      Jason.encode!(%{"type" => "stop", "tmuxSession" => "morning-post-#{@match_ulid}-shuttle"}),
      "{not json at all",
      sent_line(ts: 6_000, files: ["/tmp/last.html"])
    ]
    |> Enum.each(&append(events, &1))
  end

  test "the held projection reproduces the full-rescan reader, entry for entry", ctx do
    write_broad_fixture(ctx.events, ctx.ledger)
    name = start_stream(ctx.events)

    legacy_opts = [events_file: ctx.events, session_ledger_file: ctx.ledger]

    for uid <- [@match_ulid, @other_ulid, @session, "native-sess", "nobody"] do
      assert SentFiles.for_uid(uid, followed(ctx.events, ctx.ledger, name)) ==
               legacy_for_uid(uid, legacy_opts),
             "for_uid/2 diverged for #{uid}"
    end

    for since <- [0, 2_000, 4_001, 99_999] do
      assert SentFiles.all_since(since, followed(ctx.events, ctx.ledger, name)) ==
               legacy_all_since(since, legacy_opts),
             "all_since/2 diverged at #{since}"
    end
  end

  test "seeding then tailing equals rescanning the same file", ctx do
    write_broad_fixture(ctx.events, ctx.ledger)
    name = start_stream(ctx.events)

    # Everything below was appended AFTER the seed, so the stream only ever
    # saw it through the tail.
    append(ctx.events, sent_line(ts: 7_000, files: ["/tmp/tailed.html"]))
    append(ctx.events, sent_line(ts: 8_000, files: ["/tmp/a.html"]))

    assert wait_until(fn ->
             length(SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name))) ==
               length(SentFiles.all_since(0, scanned(ctx.events, ctx.ledger)))
           end)

    assert SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name)) ==
             SentFiles.all_since(0, scanned(ctx.events, ctx.ledger))

    assert SentFiles.for_uid(@match_ulid, followed(ctx.events, ctx.ledger, name)) ==
             SentFiles.for_uid(@match_ulid, scanned(ctx.events, ctx.ledger))
  end

  test "an appended event appears without the prefix being re-read", ctx do
    append(ctx.events, sent_line(ts: 1_000, files: ["/tmp/seeded.html"]))
    name = start_stream(ctx.events)

    assert [%{fullPath: "/tmp/seeded.html"}] =
             SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name))

    # Overwrite the seeded prefix IN PLACE with the same number of bytes. A
    # reader that rescans would now see garbage where the first event was; a
    # stream that only reads appended bytes still has it from memory.
    prefix_len = byte_size(File.read!(ctx.events))
    {:ok, fd} = File.open(ctx.events, [:read, :write, :binary])
    :ok = :file.pwrite(fd, 0, String.duplicate("x", prefix_len - 1) <> "\n")
    File.close(fd)

    append(ctx.events, sent_line(ts: 2_000, files: ["/tmp/appended.html"]))

    assert wait_until(fn ->
             length(SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name))) == 2
           end)

    assert Enum.map(SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name)), & &1.fullPath) ==
             ["/tmp/seeded.html", "/tmp/appended.html"]

    # And the proof that the prefix really is gone from the file itself.
    assert Enum.map(SentFiles.all_since(0, scanned(ctx.events, ctx.ledger)), & &1.fullPath) ==
             ["/tmp/appended.html"]
  end

  test "truncation rebuilds from the live file and keeps nothing older", ctx do
    append(ctx.events, sent_line(ts: 1_000, files: ["/tmp/before.html"]))
    name = start_stream(ctx.events)

    assert [%{fullPath: "/tmp/before.html"}] =
             SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name))

    # Truncated in place, with no rotated sibling to hold the old trail: the
    # rebuild holds exactly what the live file holds.
    File.write!(ctx.events, "")
    append(ctx.events, sent_line(ts: 2_000, files: ["/tmp/after.html"]))

    assert wait_until(fn ->
             Enum.map(
               SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name)),
               & &1.fullPath
             ) ==
               ["/tmp/after.html"]
           end)
  end

  test "a send survives one rotation and is gone after the second", ctx do
    rotated = ctx.events <> ".1"
    on_exit(fn -> File.rm(rotated) end)
    append(ctx.events, sent_line(ts: 1_000, files: ["/tmp/first.html"]))
    name = start_stream(ctx.events)

    # Written after the last read, then rotated away before the next: the
    # drain of the rotated file's tail picks it up.
    append(ctx.events, sent_line(ts: 2_000, files: ["/tmp/second.html"]))
    File.rename!(ctx.events, rotated)
    append(ctx.events, sent_line(ts: 3_000, files: ["/tmp/third.html"]))

    paths = fn ->
      Enum.map(SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name)), & &1.fullPath)
    end

    assert paths.() == ["/tmp/first.html", "/tmp/second.html", "/tmp/third.html"]

    assert SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name)) ==
             SentFiles.all_since(0, scanned(ctx.events, ctx.ledger))

    assert Enum.map(
             SentFiles.for_uid(@match_ulid, followed(ctx.events, ctx.ledger, name)),
             & &1.fullPath
           ) ==
             ["/tmp/third.html", "/tmp/second.html", "/tmp/first.html"]

    # The second rename overwrites the file the first two sends lived in.
    File.rename!(ctx.events, rotated)
    append(ctx.events, sent_line(ts: 4_000, files: ["/tmp/fourth.html"]))

    assert paths.() == ["/tmp/third.html", "/tmp/fourth.html"]

    assert SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name)) ==
             SentFiles.all_since(0, scanned(ctx.events, ctx.ledger))
  end

  test "a shrink to a shorter file does not double-count or drop", ctx do
    append(ctx.events, sent_line(ts: 1_000, files: ["/tmp/one.html"]))
    append(ctx.events, sent_line(ts: 2_000, files: ["/tmp/two.html"]))
    name = start_stream(ctx.events)

    # Smaller than the seeded offset, but not empty.
    File.write!(ctx.events, sent_line(ts: 3_000, files: ["/tmp/three.html"]) <> "\n")

    assert wait_until(fn ->
             SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name)) ==
               SentFiles.all_since(0, scanned(ctx.events, ctx.ledger))
           end)

    assert Enum.map(SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name)), & &1.fullPath) ==
             ["/tmp/three.html"]
  end

  test "a malformed line is skipped at seed and at tail", ctx do
    append(ctx.events, "{ broken")
    append(ctx.events, sent_line(ts: 1_000, files: ["/tmp/seeded.html"]))
    name = start_stream(ctx.events)

    assert [%{fullPath: "/tmp/seeded.html"}] =
             SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name))

    append(ctx.events, "]]not json[[")
    append(ctx.events, sent_line(ts: 2_000, files: ["/tmp/tailed.html"]))

    assert wait_until(fn ->
             Enum.map(
               SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name)),
               & &1.fullPath
             ) ==
               ["/tmp/seeded.html", "/tmp/tailed.html"]
           end)
  end

  test "a partial trailing line waits for its newline", ctx do
    name = start_stream(ctx.events)
    File.write!(ctx.events, sent_line(ts: 1_000, files: ["/tmp/partial.html"]), [:append])
    Process.sleep(50)
    assert SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name)) == []

    File.write!(ctx.events, "\n", [:append])

    assert wait_until(fn ->
             match?(
               [%{fullPath: "/tmp/partial.html"}],
               SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name))
             )
           end)
  end

  test "for_uid dedupes by path keeping the newest, sorts newest-first, and caps", ctx do
    append(ctx.events, sent_line(ts: 1_000, files: ["/tmp/dup.html"]))
    append(ctx.events, sent_line(ts: 3_000, files: ["/tmp/dup.html"]))
    append(ctx.events, sent_line(ts: 2_000, files: ["/tmp/dup.html"]))
    append(ctx.events, sent_line(ts: 4_000, files: ["/tmp/b.html"]))
    append(ctx.events, sent_line(ts: 5_000, files: ["/tmp/c.html"]))
    name = start_stream(ctx.events)

    assert [
             %{fullPath: "/tmp/c.html", timestamp: 5_000},
             %{fullPath: "/tmp/b.html", timestamp: 4_000},
             %{fullPath: "/tmp/dup.html", timestamp: 3_000}
           ] = SentFiles.for_uid(@match_ulid, followed(ctx.events, ctx.ledger, name))

    assert [%{fullPath: "/tmp/c.html"}] =
             SentFiles.for_uid(@match_ulid, followed(ctx.events, ctx.ledger, name, cap: 1))

    # No dedupe, no cap, oldest-first on the global feed — the asymmetry is the
    # contract, not an accident.
    assert Enum.map(
             SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name)),
             & &1.timestamp
           ) ==
             [1_000, 2_000, 3_000, 4_000, 5_000]
  end

  test "all_since filters on since_ms and drops events with no integer timestamp", ctx do
    append(ctx.events, sent_line(ts: 1_000, files: ["/tmp/old.html"]))
    append(ctx.events, sent_line(ts: 2_000, files: ["/tmp/new.html"]))

    append(
      ctx.events,
      %{"type" => "file_sent", "sessionId" => @session, "files" => ["/tmp/undated.html"]}
      |> Jason.encode!()
    )

    name = start_stream(ctx.events)
    opts = followed(ctx.events, ctx.ledger, name)

    assert Enum.map(SentFiles.all_since(0, opts), & &1.fullPath) ==
             ["/tmp/old.html", "/tmp/new.html"]

    assert Enum.map(SentFiles.all_since(2_000, opts), & &1.fullPath) == ["/tmp/new.html"]
    assert SentFiles.all_since(2_001, opts) == []

    # for_uid keeps the undated send (it has no window to fail), and an
    # undated entry sorts ahead of dated ones — unchanged from the rescan.
    assert [%{fullPath: "/tmp/undated.html", timestamp: nil} | _] =
             SentFiles.for_uid(@session, opts)
  end

  test "a ledger claim changes uid resolution with no new event appended", ctx do
    append(ctx.events, sent_line(ts: 1_000, tmux: "", files: ["/tmp/native.html"]))
    name = start_stream(ctx.events)

    # Unclaimed: the raw sessionId is the only handle.
    assert [%{uid: @session}] = SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name))
    assert SentFiles.for_uid(@other_ulid, followed(ctx.events, ctx.ledger, name)) == []

    # The ledger claims the session for a fiber. Nothing is appended to
    # events.jsonl, and the projection is untouched — but `uid` is resolved on
    # read, so the trail moves.
    write_claim(ctx.ledger, @session, @other_ulid)

    assert [%{uid: @other_ulid}] = SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name))

    assert [%{fullPath: "/tmp/native.html"}] =
             SentFiles.for_uid(@other_ulid, followed(ctx.events, ctx.ledger, name))
  end

  test "a missing events file neither crashes the stream nor invents entries", ctx do
    File.rm!(ctx.events)
    name = start_stream(ctx.events)

    assert SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name)) == []
    assert SentFiles.for_uid(@match_ulid, followed(ctx.events, ctx.ledger, name)) == []

    # And it picks the file up once it exists.
    append(ctx.events, sent_line(ts: 1_000, files: ["/tmp/late.html"]))

    assert wait_until(fn ->
             match?(
               [%{fullPath: "/tmp/late.html"}],
               SentFiles.all_since(0, followed(ctx.events, ctx.ledger, name))
             )
           end)
  end

  test "a stream on a different file is a miss, and the caller reads that file itself", ctx do
    other = ctx.events <> ".other"
    File.write!(other, sent_line(ts: 1_000, files: ["/tmp/other-file.html"]) <> "\n")
    on_exit(fn -> File.rm(other) end)

    append(ctx.events, sent_line(ts: 1_000, files: ["/tmp/followed.html"]))
    name = start_stream(ctx.events)

    assert EventStream.sent_events(name, other) == :miss

    assert [%{fullPath: "/tmp/other-file.html"}] =
             SentFiles.all_since(0,
               events_file: other,
               session_ledger_file: ctx.ledger,
               stream: name
             )
  end
end
