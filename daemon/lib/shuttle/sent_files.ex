defmodule Shuttle.SentFiles do
  @moduledoc """
  Read the sent-files trail for a fiber from the host-local Claude/Codex hook
  stream (`~/.shuttle/events.jsonl`).

  The standalone Shuttle board shows the artifacts a worker pushed with
  `SendUserFile` on each card. Those sends are recorded — always fresh, server
  independent — by `felt hook event` as `pre_tool_use` events with
  `tool == "SendUserFile"`, carrying `toolInput.files` (absolute, or relative to
  the event's `cwd` — resolved to absolute here so the `/file` route can serve
  them),
  `tmuxSession` (e.g. `morning-post-<ULID>-shuttle`, the embedded 26-char
  Crockford ULID being the fiber id = card `uid`), `sessionId`, and `timestamp`.
  A derived, server-owned index would be stale the moment that server stops —
  events.jsonl is ground truth. (See finding 01KVC1N5XMAAMYXDAGR4V6QA9G.)

  **The trail for a `uid`** = SendUserFile events whose tmux-embedded ULID — or
  `sessionId` — matches the requested `uid`, with `toolInput.files` flattened
  into one entry per path, deduped by `fullPath` keeping the newest send, sorted
  newest-first, capped at `@cap`.

  The events file grows to tens of megabytes between rollovers, so it is
  **streamed** line-by-line (never slurped); malformed lines and
  non-SendUserFile events are skipped. Only the live file is read — a trail
  that rolled over to `events.jsonl.1` is gone, which costs nothing at the
  50-entry cap. The
  path honors the same env the hook reads, via
  `Shuttle.WaitingTracker.default_events_file/0`, so the source can't drift from
  the writer.
  """

  @cap 50

  @doc """
  Return the sent-files trail for `uid` as a list of
  `%{fullPath, basename, timestamp, sessionId}` maps — newest-first, deduped by
  `fullPath`, capped.

  Opts (for tests): `:events_file` (path to the JSONL stream), `:cap`.
  """
  @spec for_uid(String.t(), keyword()) :: [map()]
  def for_uid(uid, opts \\ []) when is_binary(uid) do
    path = Keyword.get(opts, :events_file, default_events_file())
    cap = Keyword.get(opts, :cap, @cap)

    if File.regular?(path) do
      path
      |> File.stream!()
      |> Stream.flat_map(&entries_for_line(&1, uid))
      |> Enum.to_list()
      |> dedupe_newest()
      |> Enum.sort_by(& &1.timestamp, :desc)
      |> Enum.take(cap)
    else
      []
    end
  end

  @doc """
  Every `SendUserFile` send across ALL fibers, stamped at or after `since_ms`,
  oldest first — the global counterpart to `for_uid/2`.

  Each entry additionally carries `uid`, computed the same way `for_uid/2`
  matches (tmux-embedded ULID falling back to `sessionId`), so a caller with no
  single fiber in mind can still group by one. Unlike `for_uid/2` this does
  **not** dedupe by `fullPath` or cap the result — raw entries, oldest-first;
  dedup is the client's job (house rule: recorded evidence only, no server-side
  opinion about which send "wins").

  Reads only the live `events.jsonl`, same as `for_uid/2` — no rotated `.1`
  sibling — the source Shuttle.WaitingTracker.default_events_file/0` resolves.

  Opts (for tests): `:events_file`.
  """
  @spec all_since(integer(), keyword()) :: [map()]
  def all_since(since_ms, opts \\ []) when is_integer(since_ms) do
    path = Keyword.get(opts, :events_file, default_events_file())

    if File.regular?(path) do
      path
      |> File.stream!()
      |> Stream.flat_map(&entries_since_line(&1, since_ms))
      |> Enum.to_list()
      |> Enum.sort_by(& &1.timestamp)
    else
      []
    end
  end

  # One JSONL line → the (possibly empty) list of entries it contributes,
  # unfiltered by fiber. Malformed JSON, non-SendUserFile events, and events
  # older than `since_ms` all collapse to `[]`.
  defp entries_since_line(line, since_ms) do
    with {:ok, event} <- Jason.decode(line),
         "SendUserFile" <- event["tool"],
         timestamp when is_integer(timestamp) and timestamp >= since_ms <- event["timestamp"],
         files when is_list(files) <- get_in(event, ["toolInput", "files"]) do
      session_id = event["sessionId"]
      cwd = event["cwd"]
      uid = event_uid(event)

      for full_path <- files, is_binary(full_path) do
        abs = absolutize(full_path, cwd)

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

  defp default_events_file, do: Shuttle.WaitingTracker.default_events_file()

  # One JSONL line → the (possibly empty) list of entries it contributes for
  # `uid`. Malformed JSON, non-SendUserFile events, and non-matching fibers all
  # collapse to `[]` so a single bad line never breaks the stream.
  defp entries_for_line(line, uid) do
    with {:ok, event} <- Jason.decode(line),
         "SendUserFile" <- event["tool"],
         true <- event_uid(event) == uid,
         files when is_list(files) <- get_in(event, ["toolInput", "files"]) do
      session_id = event["sessionId"]
      timestamp = event["timestamp"]
      cwd = event["cwd"]

      for full_path <- files, is_binary(full_path) do
        abs = absolutize(full_path, cwd)

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

  # SendUserFile records the path as the worker passed it — which is often
  # RELATIVE to the worker's cwd (e.g. `results/scratch/frame.png`). The `/file`
  # route serves only ABSOLUTE paths — a relative one is a 400, so the card's
  # thumbnail renders as a broken-image icon. Resolve against the event's `cwd`
  # here, in `SentFiles`, which runs on the OWNING host (owner-routed): that cwd
  # is a path on the same host where the file actually lives. An already-absolute
  # path passes through verbatim; a relative path with no recorded cwd is left
  # as-is (nothing to resolve against — the pre-cwd-capture behavior).
  defp absolutize(path, cwd) do
    if Path.type(path) == :relative and is_binary(cwd) and cwd != "",
      do: Path.expand(path, cwd),
      else: path
  end

  # The fiber id an event belongs to: the ULID embedded in the tmux session
  # name, falling back to the raw sessionId (capture sessions with no tmux name
  # claim themselves by sessionId).
  defp event_uid(event) do
    Shuttle.ULID.from_tmux(event["tmuxSession"]) || event["sessionId"]
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
