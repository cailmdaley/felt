defmodule Shuttle.SessionResume do
  @moduledoc """
  Resume a past harness session in a tmux session a human attaches to — the
  card History's row action. Not a worker: shuttle neither dispatches, adopts
  nor watches it.

  `prepare/2` runs on the host that ran the session, since the transcript the
  harness resumes from lives there. It starts (or finds) a detached tmux
  session running the harness's own resume for that session id; the caller then
  attaches a kitty tab to it with `Shuttle.Kitty.open/2`, over ssh when the
  host is remote, exactly as the Aloft pill attaches to a live worker.

  ## The command

  The resume invocation is `Shuttle.Agents.build_resume_command/3`, the one the
  dispatcher uses to resume a worker, with no injected prompt: the human is the
  next turn. The agent is the one this host's session ledger recorded for the
  session, resolved through this host's registry (`felt shuttle agents
  resolve`), so model, effort and flags match a dispatch. A ledger line with no
  agent, or an agent that no longer resolves to the transcript's harness,
  resumes with the bare harness CLI.

  ## The working directory

  Read from the transcript, not from the ledger or the fiber: the fiber's
  `project_dir` may have moved since, the ledger records none, and Claude Code
  only finds a session from the directory its transcript is filed under
  (`~/.claude/projects/<cwd with every non-alphanumeric as ->/`). So a Claude
  session resumes in the first recorded `cwd` whose encoding matches that
  directory; Codex in its `session_meta` payload's `cwd`; pi in its session
  header's `cwd`. A transcript with no usable cwd is refused rather than
  resumed somewhere its harness would not find it.

  ## The tmux session

  `resume-<session uuid>`: one per conversation, so a second click finds the
  first and attaches to it rather than starting a second resume of the same
  conversation. It does not end in `-shuttle` and carries no fiber uid, so
  every "is this a worker?" predicate (`Shuttle.Dispatcher.shuttle_session?/1`,
  the poller's session listing) ignores it and it cannot collide with the
  fiber's worker session.
  """

  require Logger

  alias Shuttle.{Agents, Dispatcher, SessionLedger, Transcript, TmuxServer, WorkerProcess}

  @prefix "resume-"

  @typedoc "What `prepare/2` would run, as `plan/2` reports it."
  @type plan :: %{
          session: String.t(),
          tmux: String.t(),
          harness: String.t(),
          agent: String.t(),
          cwd: String.t(),
          command: String.t()
        }

  @doc "The tmux session a resume of `session` lives in."
  @spec tmux_name(String.t()) :: String.t()
  def tmux_name(session) when is_binary(session), do: @prefix <> session

  @doc """
  What resuming `session` on this host would run, without running it.

  Opts: `:runner` (for the registry lookup), the transcript roots
  `Shuttle.Transcript.path/2` takes, and `:ledger_path`.
  """
  @spec plan(String.t(), keyword()) :: {:ok, plan()} | {:error, String.t()}
  def plan(session, opts \\ []) do
    runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)

    with true <- Transcript.valid_session?(session) || {:error, "session must be a UUID"},
         path when is_binary(path) <-
           Transcript.path(session, opts) ||
             {:error, "no transcript for #{session} on this host"},
         harness when is_binary(harness) <-
           Transcript.harness_for(path, opts) || {:error, "unknown harness for #{path}"},
         {:ok, cwd} <- work_dir(harness, path) do
      agent = agent_for(session, harness, runner, opts)

      {:ok,
       %{
         session: session,
         tmux: tmux_name(session),
         harness: harness,
         agent: agent.id,
         cwd: cwd,
         command: Agents.build_resume_command(agent, session, "")
       }}
    end
  end

  @doc """
  Start the resume of `session` in its tmux session, unless it is already
  running there. `{:ok, %{tmux_session: name, created: boolean}}`;
  `{:error, {:live, message}}` when the session is a running worker's, or
  another live process holds it (two harness processes must not share a
  transcript); or `{:error, reason}`, including a process scan that could not
  run.

  Opts: as `plan/2`, plus `:live_sessions` (a 0-arity function standing in for
  `live_sessions/0`).
  """
  @spec prepare(String.t(), keyword()) ::
          {:ok, %{tmux_session: String.t(), created: boolean()}}
          | {:error, {:live, String.t()}}
          | {:error, String.t()}
  def prepare(session, opts \\ []) do
    runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)
    live = Keyword.get(opts, :live_sessions, &live_sessions/0)

    with :ok <- not_the_worker(session, live.()),
         {:ok, plan} <- plan(session, opts) do
      if running?(plan.tmux, runner) do
        {:ok, %{tmux_session: plan.tmux, created: false}}
      else
        start(plan, runner)
      end
    end
  end

  defp not_the_worker(session, live) do
    if session in live,
      do:
        {:error,
         {:live,
          "this session is the fiber's running worker — attach to it instead of resuming it"}},
      else: :ok
  end

  @doc """
  The harness sessions this host's workers are running now, from the poller's
  snapshot: an app conversation's own ids, and for a tmux worker the newest
  session its fiber's ledger paired (the one it was dispatched or resumed on).
  Empty when the poller cannot answer — the dispatcher's own refusal
  (`resume-<uuid>` open) still guards the other direction.
  """
  @spec live_sessions() :: [String.t()]
  def live_sessions do
    Shuttle.Poller.snapshot(Shuttle.Poller, 5_000)
    |> Map.get(:eligible, [])
    |> Enum.flat_map(fn row ->
      app = [row[:session_uuid], row[:transcript_session_uuid]]

      tmux =
        if is_binary(row[:tmux_session]) do
          case SessionLedger.latest_for_uid(row[:uid]) do
            %{"session" => id} -> [id]
            _ -> []
          end
        else
          []
        end

      Enum.filter(app ++ tmux, &is_binary/1)
    end)
  catch
    :exit, _ -> []
  end

  @doc "Whether the tmux session `tmux` exists on this host."
  @spec running?(String.t(), module()) :: boolean()
  def running?(tmux, runner) do
    match?({_, 0}, runner.cmd("tmux", ["has-session", "-t", "=" <> tmux], stderr_to_stdout: true))
  end

  defp start(plan, runner) do
    with :ok <- not_held(plan.session, runner),
         :ok <- tmux_server(runner) do
      script = WorkerProcess.script_path(plan.tmux)

      File.write!(script, run_script(plan))
      File.chmod!(script, 0o755)

      args = ["new-session", "-d", "-s", plan.tmux, "-c", plan.cwd, "bash", "-l", script]

      case runner.cmd("tmux", args, stderr_to_stdout: true) do
        {_, 0} ->
          Logger.info("Resume of #{plan.session} (#{plan.agent}) → tmux #{plan.tmux}")
          {:ok, %{tmux_session: plan.tmux, created: true}}

        {output, _} ->
          File.rm(script)
          output = output |> to_string() |> String.trim()

          # A second click racing the first: the session exists, which is all
          # the caller wanted.
          if String.contains?(output, "duplicate session"),
            do: {:ok, %{tmux_session: plan.tmux, created: false}},
            else: {:error, "tmux failed: #{output}"}
      end
    end
  end

  # No tmux session shows this conversation, yet a process tmux cannot see
  # (a worker whose tmux socket was deleted) may still hold it open.
  defp not_held(session, runner) do
    case WorkerProcess.check_free(runner, session) do
      :ok -> :ok
      {:error, {:held, message}} -> {:error, {:live, message}}
      {:error, {:unknown, message}} -> {:error, message}
    end
  end

  defp tmux_server(runner) do
    case TmuxServer.ensure_available(runner) do
      :ok -> :ok
      {:error, {_tag, message}} -> {:error, message}
    end
  end

  @doc false
  # The script tmux runs: the release's Erlang scrubbed out, a short wait for the
  # kitty tab to attach (so the harness first draws at the tab's size), the
  # resume, and — if it fails — a pause so the tab says why instead of closing.
  def run_script(plan) do
    """
    #!/bin/bash
    trap 'rm -f "$0"' EXIT

    #{Dispatcher.erts_scrub_block()}#{Dispatcher.wait_for_client_block(plan.tmux)}
    #{plan.command} || {
      status=$?
      echo ""
      echo "resume of #{plan.session} exited $status"
      read -r -p "press enter to close " _
    }
    """
  end

  # ── the agent ──────────────────────────────────────────────────────────────

  defp agent_for(session, harness, runner, opts) do
    ledger_opts =
      case Keyword.get(opts, :ledger_path) do
        nil -> []
        path -> [path: path]
      end

    cli = cli_for(harness)

    with %{"agent" => id} when is_binary(id) and id != "" <-
           SessionLedger.latest_for_session(session, ledger_opts),
         {:ok, %{cli: ^cli} = agent} <- resolve_agent(id, runner) do
      # A human is at the terminal, so never the unattended `-p` form.
      %{agent | headless: false}
    else
      _ -> bare_agent(cli)
    end
  end

  defp resolve_agent(id, runner) do
    case runner.cmd("felt", ["shuttle", "agents", "resolve", id, "--json"],
           stderr_to_stdout: true
         ) do
      {output, 0} -> {:ok, output |> Jason.decode!() |> Agents.from_resolved()}
      _ -> :error
    end
  rescue
    _ -> :error
  end

  defp cli_for("claude-code"), do: "claude"
  defp cli_for(harness), do: harness

  defp bare_agent(cli),
    do:
      Agents.from_resolved(%{
        "id" => cli,
        "cli" => cli,
        "wrapper" => cli
      })

  # ── the working directory ──────────────────────────────────────────────────

  @head_lines 200

  defp work_dir(harness, path) do
    case safe_cwd(harness, path) do
      cwd when is_binary(cwd) ->
        if File.dir?(cwd),
          do: {:ok, cwd},
          else: {:error, "#{cwd}, where the session ran, is not a directory on this host"}

      _ ->
        {:error, "the transcript records no working directory to resume in"}
    end
  end

  defp cwd_from("claude-code", path) do
    slug = path |> Path.dirname() |> Path.basename()

    head(path)
    |> Stream.map(&record_cwd(&1, ["cwd"]))
    |> Enum.find(fn cwd -> is_binary(cwd) and claude_slug(cwd) == slug end)
  end

  defp cwd_from("codex", path),
    do: head(path) |> Stream.map(&record_cwd(&1, ["payload", "cwd"])) |> Enum.find(&is_binary/1)

  defp cwd_from("pi", path),
    do: head(path) |> Stream.map(&record_cwd(&1, ["cwd"])) |> Enum.find(&is_binary/1)

  defp cwd_from(_harness, _path), do: nil

  defp safe_cwd(harness, path) do
    cwd_from(harness, path)
  rescue
    _ -> nil
  end

  @doc false
  # Claude Code's project-directory name for a working directory.
  def claude_slug(cwd), do: String.replace(cwd, ~r/[^A-Za-z0-9]/, "-")

  defp head(path), do: path |> File.stream!() |> Stream.take(@head_lines)

  defp record_cwd(line, keys) do
    if String.contains?(line, "\"cwd\"") do
      case Jason.decode(line) do
        {:ok, %{} = record} ->
          case dig(record, keys) do
            cwd when is_binary(cwd) and cwd != "" -> cwd
            _ -> nil
          end

        _ ->
          nil
      end
    end
  end

  defp dig(value, []), do: value
  defp dig(%{} = map, [key | rest]), do: dig(Map.get(map, key), rest)
  defp dig(_value, _keys), do: nil
end
