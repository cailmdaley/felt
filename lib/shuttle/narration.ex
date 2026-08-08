defmodule Shuttle.Narration do
  @moduledoc """
  Commit narration for a time window — the data layer behind
  `GET /api/v1/narration`.

  ## What it reads

  The daemon's **primary felt store** (`Shuttle.FeltStores.configured_hosts/0`,
  first entry — the same store the poller treats as primary) is a git repo, or
  sits inside one. `git log` there is the closest thing this system has to a
  narrated history: by convention every commit subject reads
  `<fiber-slug>: what happened`, so a window's subjects are its story. This
  module returns those subjects verbatim; parsing the convention is the
  reader's business, not ours. Merge commits are excluded — `Merge branch 'x'`
  is plumbing, not narration.

  ## The window is an instant range

  `commits_between/3` takes **epoch-millisecond instants**, the only form. It
  hands git `--since=@<secs>` / `--until=@<secs>`, the raw-seconds form, which
  is parsed identically no matter what timezone the daemon process runs in.

  That zone-independence is the whole reason for the form. A civil-day window
  would be resolved here, in the daemon's zone, while the browser computed those
  dates in its own — a UTC daemon serving a UTC+2 browser shifts the window two
  hours. Measured on a throwaway repo, the same civil-day request returned the
  commit under `TZ=UTC` and nothing under `TZ=Europe/Paris`, while the `@<secs>`
  form returned it under UTC, Paris, Los Angeles, and Tokyo alike. Callers that
  think in civil days resolve them to instants on their own side.

  ## Bounded, because this is a shell-out in a request path

  The git call goes through `Shuttle.Runner.Default`, not bare `System.cmd/3`,
  which has no timeout. A store root on a stalled network mount would otherwise
  block its request process forever while the board re-asks every 60 s, piling
  up wedged processes — the exact hazard `Shuttle.Runner`'s moduledoc was
  written about and that `Shuttle.FiberDocuments` already defends against. The
  bound here is 10 s rather than the runner's 60 s default: this is a
  decorative strip behind a 60 s poll, so it should give up well inside one
  poll interval.

  Callers are expected to bound the *width* of the window too; the controller
  refuses anything past `max_range_days/0`.

  ## Never 500

  Every failure is the empty list: a store root that is not a git repo, a repo
  with no commits, a missing directory, a git binary that is not installed, a
  store on an unresponsive filesystem (the timeout lands here as a non-zero
  status), a daemon with no configured store at all. The narration strip is
  decoration on a temporal view — it degrades to blank, it does not take the
  view down.
  """

  # ASCII unit separator: git subjects can contain anything printable, so the
  # date/subject delimiter has to be something a subject cannot.
  @separator "\x1f"

  # Well inside the board's 60 s narration poll — see the moduledoc.
  @timeout_ms 10_000

  # A year plus slack, so "the last twelve months" and "this calendar year,
  # edges included" both fit while a hand-crafted full-history walk does not.
  @max_range_days 370

  @typedoc "One commit, in the wire shape the endpoint serves."
  @type commit :: %{iso: String.t(), subject: String.t()}

  @doc "The widest window the endpoint will serve, in days."
  @spec max_range_days() :: pos_integer()
  def max_range_days, do: @max_range_days

  @doc "The widest window the endpoint will serve, in milliseconds."
  @spec max_range_ms() :: pos_integer()
  def max_range_ms, do: @max_range_days * 24 * 60 * 60 * 1_000

  @doc """
  Commits whose committer date falls in the inclusive instant range
  `from_ms..to_ms` (epoch milliseconds), newest first (git's own order).

  Timezone-free: the bounds reach git as raw seconds.

  Opts (for tests): `:store_root`, `:runner`.
  """
  @spec commits_between(integer(), integer(), keyword()) :: [commit()]
  def commits_between(from_ms, to_ms, opts \\ [])
      when is_integer(from_ms) and is_integer(to_ms) do
    # git resolves `@<secs>` at whole-second granularity, so both bounds
    # truncate down. That widens the window by at most 999 ms at the head,
    # which is nothing against a strip of commit subjects.
    run(["--since=@#{div(from_ms, 1_000)}", "--until=@#{div(to_ms, 1_000)}"], opts)
  end

  defp run(bounds, opts) do
    case Keyword.get(opts, :store_root) || default_store_root() do
      root when is_binary(root) and root != "" -> git_log(Path.expand(root), bounds, opts)
      _ -> []
    end
  end

  defp default_store_root do
    List.first(Shuttle.FeltStores.configured_hosts())
  rescue
    _ -> nil
  end

  # `git -C` discovers the enclosing repo itself, so a store that merely lives
  # *inside* a repo works with no extra probing. `-C` rather than the runner's
  # `:cd` deliberately: `cd:` into a missing directory raises inside
  # `Port.open`, where `-C` just exits non-zero, which is the empty list.
  defp git_log(root, bounds, opts) do
    args =
      ["-C", root, "log", "--no-merges"] ++ bounds ++ ["--pretty=format:%cI#{@separator}%s"]

    # Fold stderr in rather than letting it reach the daemon's console: a store
    # that isn't a repo would otherwise print `fatal: not a git repository` on
    # every poll. Folded lines are harmless — `parse/1` keeps only lines
    # carrying the separator, and any non-zero status (`:timeout` included)
    # discards the output whole.
    case runner(opts).cmd("git", args, stderr_to_stdout: true, timeout_ms: @timeout_ms) do
      {output, 0} -> parse(output)
      _ -> []
    end
  rescue
    _ -> []
  catch
    :exit, _ -> []
  end

  # Injection is per-call, through the `:runner` opt the tests use to script git.
  defp runner(opts), do: Keyword.get(opts, :runner, Shuttle.Runner.Default)

  defp parse(output) do
    output
    |> String.split("\n", trim: true)
    |> Enum.flat_map(fn line ->
      case String.split(line, @separator, parts: 2) do
        [iso, subject] -> [%{iso: iso, subject: subject}]
        _ -> []
      end
    end)
  end
end
