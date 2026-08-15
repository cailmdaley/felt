defmodule Shuttle.CommitLedger do
  @moduledoc """
  The append-only record of which harness session made which commit —
  `~/.shuttle/commits.jsonl`, this host's commit ledger.

  ## Why it exists

  Sibling to `Shuttle.SessionLedger`, and for the same reason. Commit↔session
  attribution used to be *inferred*: read the commit subject, match a prefix
  against a fiber's leaf, hope the worker wrote the subject the board expects.
  That inference is a string game — it fails on any subject a human phrased
  freely, and it says nothing about *who* committed. The ledger makes the
  attribution **structural**: the hook fires at the one moment the pairing is
  certain (a `git commit` just returned inside a session) and appends one line
  naming it.

  One line per commit:

      {"at":1786203000000,"kind":"commit","sha":"79def80…",
       "subject":"desk: cycle lens","repo":"~/dev/felt",
       "files":3,"insertions":42,"deletions":7,
       "session":"0883ade1-…","tmux":"edits-01KTS…-shuttle","cwd":"~/dev/felt"}

  Pure machine exhaust, like the session ledger: a pairing and its provenance.
  The subject rides along so a reader can render the line without going back to
  the repo (which may live on another host), not as editorial content.

  ## The writer is the hook

  Unlike the session ledger, the daemon does not write this file — `loom/hooks/
  shuttle-hook.sh` does, on `PostToolUse` for a Bash call that ran a
  `git commit`. The daemon is a *reader*, so everything here is read-side: the
  same tolerant parse, the same rotated-sibling streaming, the same "a
  malformed line is skipped, never raised".

  That split is deliberate. The pairing is knowable only inside the session's
  own process tree, where the daemon is not; a daemon-side writer would be back
  to inference.

  ## Coverage is partial by construction

  Commits made before the hook existed, or outside a harness session, are not
  here, and there is no fallback: readers draw only what this file records,
  joined on `sha`. A stretch of days before the hook existed has no prose rather
  than a reconstructed one, which is the honest answer.
  """

  require Logger

  @rotated_suffix ".1"

  @typedoc "One ledger line, as written and as served."
  @type record :: %{String.t() => String.t() | integer() | nil}

  @doc """
  The ledger path, honoring the same env the rest of the daemon's host-local
  state does: `SHUTTLE_COMMITS_FILE`, else `$SHUTTLE_DATA_DIR/commits.jsonl`,
  default `~/.shuttle/commits.jsonl` — the same resolver `sessions.jsonl` and
  `events.jsonl` use, with a different leaf.
  """
  @spec default_path() :: String.t()
  def default_path do
    System.get_env("SHUTTLE_COMMITS_FILE") ||
      Path.join(
        System.get_env("SHUTTLE_DATA_DIR") ||
          Path.join(System.user_home!() || "/root", ".shuttle"),
        "commits.jsonl"
      )
  end

  @doc """
  Every commit stamped at or after `since_ms`, oldest first.

  Streams the rotated sibling then the live file, so a window reaching back
  past a rotation is whole. Malformed lines, records with no usable `at`, and
  records with no `sha` are skipped silently; an absent file yields `[]`.

  A record with no sha is dropped for the same reason the session ledger drops
  a record with no session UUID: the sha is the join key every reader dedupes
  on, and a row without one is a row every caller would have to filter.

  Opts (for tests): `:path`.
  """
  @spec read_since(integer(), keyword()) :: [record()]
  def read_since(since_ms, opts \\ []) when is_integer(since_ms) do
    read_between(since_ms, nil, opts)
  end

  @doc """
  Every commit in the inclusive window `since_ms..until_ms`, oldest first. A
  `nil` `until_ms` is open-ended — the temporal views ask for one day, the
  cross-host registry asks for everything.

  Opts (for tests): `:path`.
  """
  @spec read_between(integer(), integer() | nil, keyword()) :: [record()]
  def read_between(since_ms, until_ms, opts \\ [])
      when is_integer(since_ms) and (is_integer(until_ms) or is_nil(until_ms)) do
    path = Keyword.get(opts, :path, default_path())

    [path <> @rotated_suffix, path]
    |> Enum.filter(&File.regular?/1)
    |> Enum.flat_map(&stream_records(&1, since_ms, until_ms))
    |> Enum.sort_by(& &1["at"])
  end

  defp stream_records(path, since_ms, until_ms) do
    path
    |> File.stream!()
    |> Stream.flat_map(&parse_line(&1, since_ms, until_ms))
    |> Enum.to_list()
  rescue
    # Vanished or unreadable between the check and the stream — a rotation
    # racing this read. Serve what the other file gave us.
    error ->
      Logger.debug("commit ledger: skipped #{path} — #{Exception.message(error)}")
      []
  end

  defp parse_line(line, since_ms, until_ms) do
    case Jason.decode(line) do
      {:ok, %{"at" => at, "sha" => sha} = record}
      when is_integer(at) and is_binary(sha) and sha != "" ->
        if at >= since_ms and (is_nil(until_ms) or at <= until_ms), do: [record], else: []

      _ ->
        []
    end
  end
end
