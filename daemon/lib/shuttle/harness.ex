defmodule Shuttle.Harness do
  @moduledoc """
  The verbs the daemon calls on an agent harness, one module per harness.

  What a harness *is* — how its identity is learned, how messages reach it,
  whether it reports idle — is the Go registry's table of facts
  (`internal/harness`), carried on every resolved agent record under
  `"harness"`; the daemon reads it there and keeps no table of its own. What a
  harness *does* lives here: the command lines that launch and resume it, and
  the readers of its transcript. A site that holds only a harness's name (a
  session-ledger row, an event-stream line) asks the harness's module.

  `daemon/test/fixtures/harnesses/` is the conformance fixture set: the Go
  table and, per harness, a fixed agent record with its expected command lines
  and a recorded transcript with what each reader makes of it. Both suites
  run every module against it. `docs/dev/harnesses.md` describes the contract.
  """

  @type agent :: Shuttle.Agents.agent_record()

  @doc "The canonical name, as agent records' `cli` and addresses spell it."
  @callback name() :: String.t()
  @doc "The spelling session-ledger rows and event-stream lines use."
  @callback ledger_name() :: String.t()
  @doc "The executable a record without a wrapper runs."
  @callback binary() :: String.t()

  @doc """
  The shell command that starts a conversation with `prompt` as its first
  turn. `opts`: `:session_id` (a conversation id the harness takes up front)
  and `:work_dir`.
  """
  @callback launch_command(agent(), String.t(), keyword()) :: String.t()
  @doc "The shell command that reopens conversation `session_id`, with `prompt` as the next turn when it is not blank."
  @callback resume_command(agent(), String.t(), String.t(), keyword()) :: String.t()

  @doc """
  Finds the conversation a worker launched at `dispatched_after` in `work_dir`
  started, for a harness whose identity is reported after launch: `{:ok, id}`,
  or `:error` until it can be found. `opts` carries `:fiber_id`.
  """
  @callback find_session(String.t(), DateTime.t(), keyword()) :: {:ok, String.t()} | :error

  @doc "Usage entries in one decoded transcript record (`Shuttle.TranscriptUsage`)."
  @callback usage_entries(map()) :: [map()]
  @doc """
  Whether one decoded transcript record moves the turn: `{:interrupted, id,
  at_ms}` when the human interrupted it, `:other` for any other turn record,
  nil for a record that says nothing about the turn (`Shuttle.InterruptWatcher`).
  """
  @callback turn_record(map()) :: {:interrupted, String.t(), integer()} | :other | nil
  @doc "The conversation's own task list and the cursor for the next read (`Shuttle.HarnessTasks`)."
  @callback tasks(String.t(), map(), keyword()) :: {[map()], map()}
  @doc "The working directory a transcript at `path` records (`Shuttle.SessionResume`)."
  @callback transcript_cwd(String.t()) :: String.t() | nil
  @doc "The root of the harness's transcript tree (`Shuttle.HarnessPaths`)."
  @callback transcript_root(keyword()) :: String.t()
  @doc "Wildcards for conversation `session`'s transcript, the preferred file first."
  @callback transcript_globs(String.t(), keyword()) :: [String.t()]

  @doc "Whether the hooks report the human's turn: what pulse and idle-only wakes need."
  @callback idle_signal?() :: boolean()
  @doc "Whether `turn_record/1` can read the human's interrupt from the transcript."
  @callback interrupts?() :: boolean()
  @doc """
  Whether one receiver process carries one conversation at a time, so a new
  receiver's session start succeeds the old one (`Shuttle.SessionBinding`).
  """
  @callback receiver_succession?() :: boolean()
  @doc """
  What a failed resume falls back to: `:fresh` (a new conversation under the
  same assigned id), `:recapture` (a new conversation whose id is captured
  again), or `:none` (the worker stays visibly blocked).
  """
  @callback resume_fallback() :: :fresh | :recapture | :none
  @doc "How the conversation id is learned: `\"assigned\"` at launch or `\"reported\"` after it."
  @callback identity() :: String.t()
  @doc "Whether a message reaches an idle worker typed into its terminal (`/api/v1/sessions/input`)."
  @callback takes_paste?() :: boolean()
  @doc """
  For a harness that takes pasted input, the argument pair a process resuming
  conversation `session` carries, by which the daemon finds a receiver no hook
  has registered yet (`/api/v1/sessions/receiver`).
  """
  @callback resume_args(String.t()) :: [String.t()]
  @optional_callbacks resume_args: 1

  @modules [
    Shuttle.Harness.Claude,
    Shuttle.Harness.Codex,
    Shuttle.Harness.Pi,
    Shuttle.Harness.Antigravity
  ]

  @doc "Every harness module."
  def modules, do: @modules

  @doc "The module for a canonical or ledger spelling, or nil."
  @spec module(String.t() | nil) :: module() | nil
  def module(name) when is_binary(name),
    do: Enum.find(@modules, &(&1.name() == name or &1.ledger_name() == name))

  def module(_), do: nil

  @doc "Normalize a known ledger or registry spelling to its canonical name; unknown names pass through."
  @spec normalize(String.t()) :: String.t()
  def normalize(name) when is_binary(name) do
    case module(name) do
      nil -> name
      mod -> mod.name()
    end
  end

  @doc "The ledger spelling of a known harness, or nil."
  @spec ledger_name(String.t() | nil) :: String.t() | nil
  def ledger_name(name) do
    case module(name) do
      nil -> nil
      mod -> mod.ledger_name()
    end
  end

  @doc "True when name is a spelling of one of Shuttle's harnesses."
  @spec supported?(term()) :: boolean()
  def supported?(name), do: module(name) != nil

  @doc "Whether the named harness reports the human's turn; false for an unknown one."
  def idle_signal?(name), do: call(name, :idle_signal?, [], false)

  @doc """
  The id in the first of `paths` whose header (its first line, as `header`
  reads it) names `work_dir` and a start no earlier than five seconds before
  the dispatch, and whose content carries the dispatch prompt's fiber line
  (`opts[:fiber_id]`), so concurrent workers sharing a checkout cannot borrow
  one another's identity. The fiber line appears only once the first message
  lands, about a second after the header, so the whole file is searched and
  the caller retries.
  """
  @spec scan_session_files(
          [String.t()],
          (map() -> {:ok, map()} | :error),
          String.t(),
          DateTime.t(),
          keyword()
        ) ::
          {:ok, String.t()} | :error
  def scan_session_files(paths, header, work_dir, dispatched_after, opts) do
    fiber_id = Keyword.fetch!(opts, :fiber_id)
    earliest = DateTime.add(dispatched_after, -5, :second)

    Enum.find_value(paths, :error, fn path ->
      with {:ok, content} <- Shuttle.FS.read(path),
           [first | _] <- String.split(content, "\n", parts: 2),
           {:ok, record} <- Jason.decode(first),
           {:ok, %{"cwd" => cwd, "timestamp" => stamp, "id" => id}}
           when is_binary(cwd) and is_binary(stamp) and is_binary(id) and id != "" <-
             header.(record),
           {:ok, started_at, _} <- DateTime.from_iso8601(stamp),
           true <- same_directory?(cwd, work_dir),
           true <- DateTime.compare(started_at, earliest) != :lt,
           true <- names_fiber?(content, fiber_id) do
        {:ok, id}
      else
        _ -> nil
      end
    end)
  end

  @doc """
  Whether `content` carries the dispatch prompt's line for `fiber_id`, the id
  whole: `Fiber: a/b` followed by a character no fiber id holds, or the end,
  so `a/b` does not match the prompt of a concurrently started `a/b-review`.
  """
  @spec names_fiber?(String.t(), String.t()) :: boolean()
  def names_fiber?(content, fiber_id),
    do: Regex.match?(~r/Fiber: #{Regex.escape(fiber_id)}(?![A-Za-z0-9_\/-])/, content)

  @doc "Whether two working directories are the same once expanded and their symlinks resolved."
  def same_directory?(left, right) do
    Shuttle.HarnessPaths.real_path(Shuttle.Env.expand(left)) ==
      Shuttle.HarnessPaths.real_path(Shuttle.Env.expand(right))
  end

  @doc false
  def call(name, verb, args, default) do
    case module(name) do
      nil -> default
      mod -> apply(mod, verb, args)
    end
  end
end
