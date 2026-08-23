defmodule Shuttle.SessionLedger do
  @moduledoc """
  The append-only record of which harness session belonged to which fiber —
  `~/.shuttle/sessions.jsonl`, this host's session ledger.

  ## Why it exists

  Fiber↔session association used to be *inferred*: read the tmux session name,
  pull the ULID out of it, hope the worker is still alive. That inference
  disappears the moment the session ends, so nothing downstream can answer
  "which sessions has this card had?" after the fact. The ledger makes the
  association **structural**: at each moment the daemon certainly knows the
  pairing, it appends one line naming it, and that line outlives the session.

  One line per session, not per event:

      {"fiber":"work/paper/edits","uid":"01KTS…","session":"0883ade1-…",
       "harness":"claude-code","host":"hub-mac","tmux":"edits-01KTS…-shuttle",
       "at":1786203000000,"kind":"dispatch"}

  Pure machine exhaust — a pairing and its provenance, no editorial content, no
  narrative. That distinction is deliberate: this is not felt-history reborn,
  and nothing here is written for a human to read as prose.

  ## The three moments

  `kind` names which one:

    * `"dispatch"` — the daemon launched a worker and knows its session UUID.
      For claude the UUID is pre-specified (`--session-id`) and known at
      launch; for codex/pi it is scraped from the harness's JSONL afterward, so
      the line is written by the backfill instead. Either way it is written
      **after** the UUID is real, never speculatively.
    * `"claim"` — an externally-spawned session registered itself against a
      fiber through `POST /api/v1/claim`.
    * `"resume"` — a worker was relaunched against an existing session UUID.

  A record with no session UUID is **not written**. An unpaired line would be
  the one thing this file exists to rule out, and `record/1` drops it rather
  than emitting a row a reader would have to filter.

  ## Durability posture

  Same as `events.jsonl` (`cmd/shuttle_events.go`): O_APPEND single-write
  lines, rotation at a byte cap to a `.1` sibling, readers streaming both. The
  cap is far smaller here because the volume is — one line per session against
  one line per hook event.

  Writes are best-effort and never raise: a ledger append must not be able to
  fail a dispatch. A lost line costs a join row, not a worker.
  """

  require Logger

  @rotated_suffix ".1"

  # ~40k sessions at typical line length. The events stream needs 64 MB because
  # it carries every hook event; this carries one line per session.
  @max_bytes 8 * 1024 * 1024

  @kinds ~w(dispatch claim resume)

  # The ULID felt embeds in `<leaf>-<ULID>-shuttle`. Same shape
  # `Shuttle.SentFiles` reads (Crockford base32 excludes I, L, O, U).
  @ulid_in_tmux ~r/-([0-9A-HJKMNP-TV-Z]{26})-shuttle$/

  @typedoc "One ledger line, as written and as served."
  @type record :: %{String.t() => String.t() | integer() | nil}

  @doc """
  The ledger path, honoring the same env the rest of the daemon's host-local
  state does: `SHUTTLE_SESSIONS_FILE`, else `$SHUTTLE_DATA_DIR/sessions.jsonl`,
  default `~/.shuttle/sessions.jsonl` — the `events.jsonl` resolver with a
  different leaf, so both files land in one place.
  """
  @spec default_path() :: String.t()
  def default_path do
    System.get_env("SHUTTLE_SESSIONS_FILE") ||
      Path.join(
        System.get_env("SHUTTLE_DATA_DIR") ||
          Path.join(System.user_home!() || "/root", ".shuttle"),
        "sessions.jsonl"
      )
  end

  @doc """
  Append one pairing.

  Required: `:fiber`, `:session`, `:kind`. Optional: `:tmux`, `:harness`,
  `:uid` (derived from the tmux name when omitted), `:host` (this daemon's
  own_host_id when omitted), `:at` (now when omitted).

  Returns `:ok` always — including when the record is dropped for having no
  session UUID, and when the write itself fails. Callers are on the dispatch
  path and must not branch on this.

  Opts (for tests): `:path`.
  """
  @spec record(keyword()) :: :ok
  def record(fields) when is_list(fields) do
    with {:ok, line} <- build_line(fields) do
      append(line, Keyword.get(fields, :path, default_path()))
    end

    :ok
  rescue
    error ->
      Logger.debug("session ledger: dropped a record — #{Exception.message(error)}")
      :ok
  end

  # A pairing with no session UUID is not a pairing. Drop it here so no caller
  # has to remember the rule and no reader has to filter for it.
  defp build_line(fields) do
    session = presence(Keyword.get(fields, :session))
    fiber = presence(Keyword.get(fields, :fiber))
    kind = to_kind(Keyword.get(fields, :kind))

    if session && fiber && kind do
      tmux = presence(Keyword.get(fields, :tmux))

      {:ok,
       Jason.encode!(%{
         "fiber" => fiber,
         "uid" => presence(Keyword.get(fields, :uid)) || uid_from_tmux(tmux),
         "session" => session,
         "harness" => presence(Keyword.get(fields, :harness)),
         "host" => presence(Keyword.get(fields, :host)) || own_host(),
         "tmux" => tmux,
         "at" => Keyword.get(fields, :at) || System.system_time(:millisecond),
         "kind" => kind
       }) <> "\n"}
    else
      :drop
    end
  end

  defp to_kind(kind) when is_atom(kind) and not is_nil(kind), do: to_kind(Atom.to_string(kind))
  defp to_kind(kind) when kind in @kinds, do: kind
  defp to_kind(_), do: nil

  defp uid_from_tmux(name) when is_binary(name) do
    case Regex.run(@ulid_in_tmux, name) do
      [_, ulid] -> ulid
      nil -> nil
    end
  end

  defp uid_from_tmux(_), do: nil

  defp own_host do
    Shuttle.Poller.own_host_id()
  rescue
    _ -> nil
  end

  # Rotate-then-append, mirroring `appendEventLine` in cmd/shuttle_events.go:
  # one O_APPEND write per line (atomic against other appenders on Darwin and
  # Linux alike, which is why the line is built whole before we get here).
  defp append(line, path) do
    File.mkdir_p!(Path.dirname(path))
    maybe_rotate(path)
    File.write!(path, line, [:append])
  rescue
    error ->
      Logger.debug("session ledger: append to #{path} failed — #{Exception.message(error)}")
      :ok
  end

  defp maybe_rotate(path) do
    case File.stat(path) do
      {:ok, %File.Stat{size: size}} when size >= @max_bytes ->
        File.rename(path, path <> @rotated_suffix)

      _ ->
        :ok
    end
  end

  @doc """
  Every record stamped at or after `since_ms`, oldest first.

  Streams the rotated sibling then the live file, so a window reaching back
  past a rotation is whole. Malformed lines and records with no usable `at` are
  skipped silently; an absent file yields `[]`.

  Opts (for tests): `:path`.
  """
  @spec read_since(integer(), keyword()) :: [record()]
  def read_since(since_ms, opts \\ []) when is_integer(since_ms) do
    path = Keyword.get(opts, :path, default_path())

    [path <> @rotated_suffix, path]
    |> Enum.filter(&File.regular?/1)
    |> Enum.flat_map(&stream_records(&1, since_ms))
    |> Enum.sort_by(& &1["at"])
  end

  @doc """
  The host that ran `session`, from the newest ledger line naming it — or `nil`
  when this host never recorded that session.

  The pairing rung the transcript reader stands on: a hover asks a daemon for
  the words of a session it may not have run, and this is how that daemon knows
  whose disk they are on without the caller having to say.

  Opts (for tests): `:path`.
  """
  @spec host_for_session(String.t() | nil, keyword()) :: String.t() | nil
  def host_for_session(session, opts \\ [])

  def host_for_session(session, opts) when is_binary(session) and session != "" do
    0
    |> read_since(opts)
    |> Enum.filter(&(&1["session"] == session))
    |> List.last()
    |> case do
      %{"host" => host} when is_binary(host) and host != "" -> host
      _ -> nil
    end
  end

  def host_for_session(_session, _opts), do: nil

  @doc """
  The newest ledger line carrying `session`, or `nil` when this host has never
  recorded that session. Unlike `host_for_session/2`, this preserves the
  harness and fiber fields needed by a provenance receipt.

  Opts (for tests): `:path`.
  """
  @spec latest_for_session(String.t() | nil, keyword()) :: record() | nil
  def latest_for_session(session, opts \\ [])

  def latest_for_session(session, opts) when is_binary(session) and session != "" do
    path = Keyword.get(opts, :path, default_path())

    [path, path <> @rotated_suffix]
    |> Enum.filter(&File.regular?/1)
    |> Enum.find_value(&newest_session_match(&1, session))
  end

  def latest_for_session(_session, _opts), do: nil

  @doc """
  The newest ledger line carrying a session UUID for `uid` (the fiber's ULID —
  stable across renames, unlike the path-shaped fiber id) — or `nil` when this
  host has never recorded a session for it.

  The lineage rung the dispatch prompt stands on: at fresh dispatch this is the
  PREVIOUS worker's session — its UUID names the on-disk transcript, its
  `harness` says which CLI's store to look in.

  Opts (for tests): `:path`.
  """
  @spec latest_for_uid(String.t() | nil, keyword()) :: record() | nil
  def latest_for_uid(uid, opts \\ [])

  def latest_for_uid(uid, opts) when is_binary(uid) and uid != "" do
    path = Keyword.get(opts, :path, default_path())

    # This sits on the dispatch path (Poller GenServer), so no
    # decode-everything-and-sort: scan newest-first — live file before its
    # rotated sibling, lines back-to-front (append-only, so file order is time
    # order) — with a substring prefilter so only candidate lines are decoded.
    [path, path <> @rotated_suffix]
    |> Enum.filter(&File.regular?/1)
    |> Enum.find_value(fn file -> newest_match_in(file, uid) end)
  end

  def latest_for_uid(_uid, _opts), do: nil

  defp newest_match_in(file, uid) do
    file
    |> File.read!()
    |> String.split("\n", trim: true)
    |> Enum.reverse()
    |> Enum.find_value(fn line ->
      with true <- String.contains?(line, uid),
           {:ok, %{"uid" => ^uid, "session" => session} = record} <- Jason.decode(line),
           true <- is_binary(session) and session != "" do
        record
      else
        _ -> nil
      end
    end)
  rescue
    # Vanished or unreadable between the check and the read — a rotation
    # racing this scan. Fall through to the next file.
    _ -> nil
  end

  defp newest_session_match(file, session) do
    file
    |> File.read!()
    |> String.split("\n", trim: true)
    |> Enum.reverse()
    |> Enum.find_value(fn line ->
      with true <- String.contains?(line, session),
           {:ok, %{"session" => ^session} = record} <- Jason.decode(line) do
        record
      else
        _ -> nil
      end
    end)
  rescue
    _ -> nil
  end

  defp stream_records(path, since_ms) do
    path
    |> File.stream!()
    |> Stream.flat_map(&parse_line(&1, since_ms))
    |> Enum.to_list()
  rescue
    # Vanished or unreadable between the check and the stream — a rotation
    # racing this read. Serve what the other file gave us.
    error ->
      Logger.debug("session ledger: skipped #{path} — #{Exception.message(error)}")
      []
  end

  defp parse_line(line, since_ms) do
    case Jason.decode(line) do
      {:ok, %{"at" => at} = record} when is_integer(at) and at >= since_ms -> [record]
      _ -> []
    end
  end

  @doc """
  The `harness` value for an agent record's `cli`.

  The registry names the executable (`claude`, `codex`, `pi`); the ledger names
  the harness, and for Claude those differ. An unknown or absent cli is `nil`
  rather than a guess — a wrong harness label is worse than none.
  """
  @spec harness_for_cli(String.t() | nil) :: String.t() | nil
  def harness_for_cli("claude"), do: "claude-code"
  def harness_for_cli(cli) when cli in ["codex", "pi"], do: cli
  def harness_for_cli(_), do: nil

  defp presence(value) when is_binary(value) and value != "", do: value
  defp presence(_), do: nil
end
