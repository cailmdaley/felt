defmodule Shuttle.SentFiles do
  @moduledoc """
  Read the sent-files trail for a fiber from the host-local Claude/Codex hook
  stream (`~/.portolan/data/events.jsonl`).

  The standalone Shuttle board shows the artifacts a worker pushed with
  `SendUserFile` on each card. Those sends are recorded — always fresh, server
  independent — by `portolan-hook.sh` as `pre_tool_use` events with
  `tool == "SendUserFile"`, carrying `toolInput.files` (absolute, or relative to
  the event's `cwd` — resolved to absolute here so the `/file` route can serve
  them),
  `tmuxSession` (e.g. `morning-post-<ULID>-shuttle`, the embedded 26-char
  Crockford ULID being the fiber id = card `uid`), `sessionId`, and `timestamp`.
  (Portolan's derived `sent-files.json` is stale the moment its server stops —
  events.jsonl is ground truth. See finding 01KVC1N5XMAAMYXDAGR4V6QA9G.)

  **The trail for a `uid`** = SendUserFile events whose tmux-embedded ULID — or
  `sessionId` — matches the requested `uid`, with `toolInput.files` flattened
  into one entry per path, deduped by `fullPath` keeping the newest send, sorted
  newest-first, capped at `@cap`.

  The events file is ~10 MB and only grows, so it is **streamed** line-by-line
  (never slurped); malformed lines and non-SendUserFile events are skipped. The
  path honors the same env the hook reads, via
  `Shuttle.WaitingTracker.default_events_file/0`, so the source can't drift from
  the writer.
  """

  # 26-char Crockford base32 ULID embedded as `…-<ULID>-shuttle` in the tmux
  # session name (Crockford excludes I, L, O, U).
  @ulid_in_tmux ~r/-([0-9A-HJKMNP-TV-Z]{26})-shuttle$/

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
    ulid_from_tmux(event["tmuxSession"]) || event["sessionId"]
  end

  defp ulid_from_tmux(name) when is_binary(name) do
    case Regex.run(@ulid_in_tmux, name) do
      [_, ulid] -> ulid
      nil -> nil
    end
  end

  defp ulid_from_tmux(_), do: nil

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
