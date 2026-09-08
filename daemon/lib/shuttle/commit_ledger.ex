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

  Unlike the session ledger, the daemon does not write this file — `felt hook
  commit` does (cmd/hook_commit.go, wired as the plugin's `commit.sh`), on
  `PostToolUse` for a Bash call that ran a `git commit`. The writer emits the
  fields below in this order, and this module is the contract they answer to:
  a line is a commit when `at` is an integer and `sha` a non-empty string.

  The daemon is a *reader*, so everything here is read-side: the
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
    System.get_env("SHUTTLE_COMMITS_FILE") || Path.join(Shuttle.data_dir(), "commits.jsonl")
  end

  @doc """
  Every commit in the inclusive window `since_ms..until_ms`, oldest first. A
  `nil` `until_ms` is open-ended — the temporal views ask for one day, the
  cross-host registry asks for everything.

  Malformed lines, records with no usable `at`, and records with no `sha` are
  skipped silently; an absent file yields `[]`. A record with no sha is dropped
  for the same reason the session ledger drops a record with no session UUID:
  the sha is the join key every reader dedupes on, and a row without one is a
  row every caller would have to filter.

  Opts (for tests): `:path`.
  """
  @spec read_between(integer(), integer() | nil, keyword()) :: [record()]
  def read_between(since_ms, until_ms, opts \\ [])
      when is_integer(since_ms) and (is_integer(until_ms) or is_nil(until_ms)) do
    path = Keyword.get(opts, :path, default_path())

    Shuttle.Ledger.read_window(path, since_ms, until_ms, "sha", "commit ledger")
  end
end
