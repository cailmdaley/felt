defmodule Shuttle.SentFiles do
  @moduledoc """
  Read the sent-files trail for a fiber from the host-local Claude/Codex hook
  stream (`~/.shuttle/events.jsonl`).

  The standalone Shuttle board shows artifacts registered with
  `felt shuttle send-file`. The command writes `file_sent` events with top-level
  `files`, `sessionId`, `tmuxSession`, `cwd`, and `timestamp`. A harness's
  `SendUserFile` tool call, recorded by the hook, carries its paths in
  `toolInput.files`.
  Paths are absolute or resolved against the owning host's recorded `cwd`.
  A worker's tmux-embedded ULID associates the delivery with its fiber. Native
  sessions without a tmux name use the session ledger's fiber claim; an
  unclaimed session remains addressable by its raw `sessionId`.

  ## No PERSISTED index; an in-memory follower instead

  A derived index written to disk would be stale the moment the server that
  maintains it stops — events.jsonl is ground truth, and that has not changed
  (see finding 01KVC1N5XMAAMYXDAGR4V6QA9G). An **in-memory** projection is a
  different thing and is not barred by that argument: `Shuttle.SentFiles.Follower`
  seeds from the whole file at boot and then reads only appended bytes, so it
  cannot outlive the file it was built from and cannot disagree with it — it is
  a pure function of a prefix of ground truth, recomputed on every start. It is
  a read strategy, not a second source of truth.

  Following is what makes these two functions affordable. A rescan costs a
  full re-stream and full `Jason.decode` of a 50 MB stream **per request** —
  measured at ~50 MB of `rchar` and ~0.7 CPU-seconds a call, at a dozen calls
  a minute, essentially the daemon's whole read and CPU budget. The interesting content is tiny (a couple hundred `file_sent` events
  among sixty thousand lines, growing a few hundred lines a day), so holding it
  in memory costs nothing. A 304 could not defend these endpoints: the ETag is
  over `events.jsonl`, which is the live hook stream for every session on the
  host and changes every few seconds, so the conditional request essentially
  never hits.

  `for_uid/2` and `all_since/2` read the follower when it is following the same
  path they resolve; otherwise (the test suite, an injected fixture, a crashed
  follower) they fall back to streaming that file directly. Both paths share one
  parse — `parse_line/1` — so the fallback cannot drift from the projection.

  **The `uid` is resolved at READ time, never stored.** The join is against the
  session ledger, which changes independently of `events.jsonl`; a `uid`
  precomputed at ingest would go stale the moment a native session's fiber claim
  landed. The projection holds only what the event itself says.

  **The trail for a `uid`** = sent-file events whose tmux-embedded ULID — or
  claimed session-ledger UID — matches the requested `uid`, with the event's
  file paths flattened into one entry per path, deduped by `fullPath`
  keeping the newest send, sorted newest-first, capped at `@cap`. An event from
  an unclaimed session matches its raw `sessionId`.

  Only the live file is read — a trail that rolled over to `events.jsonl.1` is
  gone, which costs nothing at the 50-entry cap. So on truncation or rotation
  the follower rebuilds from the live file alone, reproducing exactly that. The
  path honors the same env the hook reads, via
  `Shuttle.WaitingTracker.default_events_file/0`, so the source can't drift from
  the writer.
  """

  @cap 50

  @typedoc """
  One projected sent-file event: what the event itself says, absolutized, with
  no ledger join applied. `timestamp` is whatever the line carried — possibly
  absent, which `all_since/2` filters out and `for_uid/2` tolerates.
  """
  @type event :: %{
          paths: [String.t()],
          session_id: String.t() | nil,
          tmux_session: String.t() | nil,
          timestamp: term()
        }

  @doc """
  Return the sent-files trail for `uid` as a list of
  `%{fullPath, basename, timestamp, sessionId}` maps — newest-first, deduped by
  `fullPath`, capped.

  Opts (for tests): `:events_file` (path to the JSONL stream),
  `:session_ledger_file` (path to the session ledger), `:cap`,
  `:follower` (the follower process to read from).
  """
  @spec for_uid(String.t(), keyword()) :: [map()]
  def for_uid(uid, opts \\ []) when is_binary(uid) do
    cap = Keyword.get(opts, :cap, @cap)
    session_uids = session_uids(opts)

    opts
    |> events()
    |> Enum.flat_map(&entries_for_event(&1, uid, session_uids))
    |> dedupe_newest()
    |> Enum.sort_by(& &1.timestamp, :desc)
    |> Enum.take(cap)
  end

  @doc """
  Every sent file across ALL fibers, stamped at or after `since_ms`,
  oldest first — the global counterpart to `for_uid/2`.

  Each entry additionally carries `uid`, computed the same way `for_uid/2`
  matches (tmux-embedded ULID, then session-ledger claim, then raw `sessionId`),
  so a caller with no single fiber in mind can still group by one. Unlike
  `for_uid/2` this does
  **not** dedupe by `fullPath` or cap the result — raw entries, oldest-first;
  dedup is the client's job (house rule: recorded evidence only, no server-side
  opinion about which send "wins").

  Reads only the live `events.jsonl`, same as `for_uid/2` — no rotated `.1`
  sibling — the source `Shuttle.WaitingTracker.default_events_file/0` resolves.

  Opts (for tests): `:events_file`, `:session_ledger_file`, `:follower`.
  """
  @spec all_since(integer(), keyword()) :: [map()]
  def all_since(since_ms, opts \\ []) when is_integer(since_ms) do
    session_uids = session_uids(opts)

    opts
    |> events()
    |> Enum.flat_map(&entries_since_event(&1, since_ms, session_uids))
    |> Enum.sort_by(& &1.timestamp)
  end

  @doc """
  Default host-local events stream path — the one place this module names its
  source, delegated so it cannot drift from the writer.
  """
  @spec default_events_file() :: Path.t()
  def default_events_file, do: Shuttle.WaitingTracker.default_events_file()

  @doc """
  One JSONL line → the (possibly empty) list of projected events it contributes.

  Malformed JSON, non-sent-file events, and events naming no usable path all
  collapse to `[]`, so a single bad line never breaks ingest. This is the ONLY
  parse of the stream: the follower folds it over appended lines and
  `scan_file/1` folds it over a whole file.
  """
  @spec parse_line(String.t()) :: [event()]
  def parse_line(line) do
    with {:ok, event} <- Jason.decode(line),
         files when is_list(files) <- sent_paths(event) do
      cwd = event["cwd"]
      paths = for path <- files, is_binary(path), do: absolutize(path, cwd)

      case paths do
        [] ->
          []

        paths ->
          [
            %{
              paths: paths,
              session_id: event["sessionId"],
              tmux_session: event["tmuxSession"],
              timestamp: event["timestamp"]
            }
          ]
      end
    else
      _ -> []
    end
  end

  @doc """
  Project a whole events file in one streaming pass — the fallback read, and
  what the follower's boot seed is equivalent to. A missing file is `[]`.
  """
  @spec scan_file(Path.t()) :: [event()]
  def scan_file(path) do
    if File.regular?(path) do
      path
      |> File.stream!()
      |> Stream.flat_map(&parse_line/1)
      |> Enum.to_list()
    else
      []
    end
  end

  # The projected events to read, in file order (oldest-first — `dedupe_newest/1`
  # depends on it). From the follower when it is following the very path we
  # resolve; otherwise straight off disk.
  defp events(opts) do
    path = Keyword.get(opts, :events_file, default_events_file())
    follower = Keyword.get(opts, :follower, Shuttle.SentFiles.Follower)

    case Shuttle.SentFiles.Follower.events(follower, path) do
      {:ok, events} ->
        events

      :miss ->
        Shuttle.FileTail.warn_miss("sent-files", Shuttle.SentFiles.Follower, path)
        scan_file(path)
    end
  end

  # `felt shuttle send-file` events, then a harness's SendUserFile tool call.
  defp sent_paths(%{"type" => "file_sent", "files" => files}), do: files
  defp sent_paths(%{"tool" => "SendUserFile", "toolInput" => %{"files" => files}}), do: files
  defp sent_paths(_), do: nil

  # A projected event → the entries it contributes for `uid`; a non-matching
  # fiber contributes none. Timestamps are passed through as recorded, including
  # a missing one.
  defp entries_for_event(event, uid, session_uids) do
    if uid in event_uids(event, session_uids) do
      for full_path <- event.paths do
        %{
          fullPath: full_path,
          basename: Path.basename(full_path),
          timestamp: event.timestamp,
          sessionId: event.session_id
        }
      end
    else
      []
    end
  end

  # A projected event → the entries it contributes to the global feed. An event
  # with no integer timestamp, or one older than `since_ms`, contributes none —
  # the window is the whole filter here, there is no fiber gate.
  defp entries_since_event(%{timestamp: ts} = event, since_ms, session_uids)
       when is_integer(ts) and ts >= since_ms do
    uid = event_uid(event, session_uids)

    for full_path <- event.paths do
      %{
        fullPath: full_path,
        basename: Path.basename(full_path),
        timestamp: ts,
        sessionId: event.session_id,
        uid: uid
      }
    end
  end

  defp entries_since_event(_event, _since_ms, _session_uids), do: []

  # SendUserFile records the path as the worker passed it — which is often
  # RELATIVE to the worker's cwd (e.g. `results/scratch/frame.png`). The `/file`
  # route serves only ABSOLUTE paths — a relative one is a 400, so the card's
  # thumbnail renders as a broken-image icon. Resolve against the event's `cwd`
  # here, in `SentFiles`, which runs on the OWNING host (owner-routed): that cwd
  # is a path on the same host where the file actually lives. An already-absolute
  # path passes through verbatim; a relative path with no recorded cwd is left
  # as-is, with nothing to resolve it against.
  defp absolutize(path, cwd) do
    if Path.type(path) == :relative and is_binary(cwd) and cwd != "",
      do: Path.expand(path, cwd),
      else: path
  end

  # The fiber id an event belongs to: prefer the ULID embedded in the tmux
  # session name, then the session ledger's claim, then the raw sessionId.
  defp event_uid(event, session_uids) do
    case Shuttle.ULID.from_tmux(event.tmux_session) do
      nil -> Map.get(session_uids, event.session_id, event.session_id)
      uid -> uid
    end
  end

  defp event_uids(event, session_uids) do
    [event_uid(event, session_uids), event.session_id]
    |> Enum.filter(&(is_binary(&1) and &1 != ""))
    |> Enum.uniq()
  end

  defp session_uids(opts) do
    ledger_opts =
      case Keyword.get(opts, :session_ledger_file) do
        path when is_binary(path) -> [path: path]
        _ -> []
      end

    Shuttle.SessionLedger.read_since(0, ledger_opts)
    |> Enum.reduce(%{}, fn record, acc ->
      case {record["session"], record["uid"]} do
        {session, uid}
        when is_binary(session) and session != "" and is_binary(uid) and uid != "" ->
          Map.put(acc, session, uid)

        _ ->
          acc
      end
    end)
  end

  # Keep only the newest send per fullPath. Entries arrive in file order
  # (oldest-first); reducing into a map keyed by path lets a later (newer) send
  # overwrite an earlier one, so the survivor carries the freshest timestamp.
  defp dedupe_newest(entries) do
    entries
    |> Enum.reduce(%{}, fn entry, acc ->
      Map.update(acc, entry.fullPath, entry, fn existing ->
        if entry.timestamp >= existing.timestamp, do: entry, else: existing
      end)
    end)
    |> Map.values()
  end
end
