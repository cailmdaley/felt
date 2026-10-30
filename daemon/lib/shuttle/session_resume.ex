defmodule Shuttle.SessionResume do
  @moduledoc """
  Resume a past harness session in the host's primary terminal — the
  card History's row action. Not a worker: shuttle neither dispatches, adopts
  nor watches it.

  `prepare/2` runs on the host that ran the session, since the transcript the
  harness resumes from lives there. It starts (or finds) a terminal
  running the harness's own resume for that session id; the caller then
  attaches a kitty tab to it with `Shuttle.Kitty.open/2`, over ssh when the
  host is remote, exactly as the Aloft pill attaches to a live worker.

  ## The command

  The resume invocation is `Shuttle.Agents.build_resume_command/3`, the one the
  dispatcher uses to resume a worker, with no injected prompt: the human is the
  next turn. The agent is the one this host's session ledger recorded for the
  session, resolved through this host's registry (`shuttle agents
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

  ## The terminal name

  `resume-<session uuid>`: one per conversation, so a second click finds the
  first and attaches to it rather than starting a second resume of the same
  conversation. It does not end in `-shuttle` and carries no fiber uid, so
  every "is this a worker?" predicate (`Shuttle.Dispatcher.shuttle_session?/1`,
  the poller's session listing) ignores it and it cannot collide with the
  fiber's worker session.
  """

  require Logger

  alias Shuttle.{Agents, Dispatcher, SessionLedger, Terminal, Transcript, WorkerProcess}

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

  @doc "The terminal name a resume of `session` lives in."
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

      with :ok <- validate_resume_agent(harness, agent) do
        {:ok,
         %{
           session: session,
           tmux: tmux_name(session),
           fiber:
             case SessionLedger.latest_for_session(session,
                    path: Keyword.get(opts, :ledger_path, SessionLedger.default_path())
                  ) do
               %{"fiber" => fiber} -> fiber
               _ -> nil
             end,
           harness: harness,
           agent: agent.id,
           cwd: cwd,
           wrapper: agent.wrapper,
           backend_opts:
             if(harness == "codex",
               do: Dispatcher.codex_options(agent, cwd, developer_instructions: nil),
               else: []
             ),
           command:
             if(harness == "codex",
               do:
                 Shuttle.CodexTerminal.command(
                   agent.wrapper,
                   cwd,
                   session,
                   "unix://" <> Shuttle.CodexApp.Transport.default_socket()
                 ),
               else: Agents.build_resume_command(agent, session, "")
             )
         }}
      end
    end
  end

  defp validate_resume_agent("codex", agent) do
    case Dispatcher.validate_codex_agent(agent) do
      :ok -> :ok
      {:error, {:invalid_axes, message}} -> {:error, message}
    end
  end

  defp validate_resume_agent(_harness, _agent), do: :ok

  @doc """
  Start the resume of `session` in the primary terminal, unless it is already
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

    case Shuttle.AppWorkers.get(session) do
      {:ok, %{"active" => true, "surface" => "cli"}} ->
        Shuttle.CodexTerminal.prepare(session, opts)

      {:error, reason} = error
      when reason in [:session_owner_mismatch, :ownership_record_unreadable] ->
        error

      _ ->
        with :ok <- not_the_worker(session, live.()),
             {:ok, plan} <- plan(session, opts) do
          case Terminal.status(runner, plan.tmux) do
            :alive ->
              {:ok, %{tmux_session: plan.tmux, created: false}}

            :unknown ->
              # Uncertainty prevents launch, but does not prove a reusable viewer.
              with :ok <- resume_identity_free(plan, runner),
                   do: {:error, "Resume terminal visibility is unknown; holding without launch"}

            :gone ->
              with :ok <- resume_identity_free(plan, runner),
                   :ok <- prepare_backend(plan, runner),
                   do: start(plan, runner)
          end
        end
    end
  end

  defp resume_identity_free(%{harness: "codex", session: id}, runner) do
    case Shuttle.AppWorkers.get(id) do
      {:ok, record} ->
        Shuttle.AppWorkers.check_endpoint(record)

      {:error, :not_found} ->
        with :ok <- Shuttle.AppWorkers.check_known_endpoint(id), do: not_held(id, runner)

      {:error, _} = error ->
        error
    end
  end

  defp resume_identity_free(plan, runner), do: not_held(plan.session, runner)

  defp prepare_backend(%{harness: "codex", session: id, backend_opts: opts} = plan, runner) do
    attributes = %{
      "cwd" => plan.cwd,
      "agent_id" => plan.agent,
      "surface" => "cli",
      "terminal_wrapper" => plan.wrapper,
      "terminal_tmux" => plan.tmux
    }

    result =
      with {:ok, loaded} <- Shuttle.AppWorkers.import_embedded(id, attributes, opts, runner),
           :ok <- Shuttle.CodexBackend.require_ready() do
        if loaded, do: {:ok, loaded}, else: Shuttle.AppWorkers.call(id, :resume_thread, [opts])
      end

    case result do
      {:ok, %{"id" => ^id}} ->
        :ok

      {:error, reason} ->
        {:error,
         "Managed Codex resume is waiting: #{inspect(reason)}. Inspect codex_backend in /api/v1/version and restore the recorded endpoint; no embedded fallback is used."}

      _ ->
        {:error, "Managed Codex resume returned a different thread"}
    end
  end

  defp prepare_backend(_plan, _runner), do: :ok

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
    Shuttle.Poller.snapshot(Shuttle.Env.server(Shuttle.Poller), 5_000)
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

  @doc "Whether a terminal or an uncertain observation holds this resume on the host."
  @spec running?(String.t(), module()) :: boolean()
  def running?(name, runner), do: Terminal.present?(runner, name)

  defp start(plan, runner) do
    case Terminal.launch(runner, plan.tmux, plan.cwd, run_script(plan), fiber: plan[:fiber]) do
      :ok ->
        Logger.info("Resume of #{plan.session} (#{plan.agent}) → #{plan.tmux}")
        {:ok, %{tmux_session: plan.tmux, created: true}}

      {:error, :already_running} ->
        {:ok, %{tmux_session: plan.tmux, created: false}}

      {:error, {_tag, message}} ->
        {:error, message}

      {:error, message} ->
        # An external tmux client can still win the name outside our launch lock.
        if String.contains?(message, "duplicate session"),
          do: {:ok, %{tmux_session: plan.tmux, created: false}},
          else: {:error, message}
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

  # The primary backend supplies its environment and viewer readiness gate.
  # A failed resume pauses so the terminal shows why instead of closing.
  defp run_script(plan) do
    snippets = Terminal.primary().script(plan.tmux)

    """
    #!/bin/bash
    trap 'rm -f "$0"' EXIT

    #{snippets.env}#{Dispatcher.erts_scrub_block()}#{snippets.wait_for_viewer}
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
    Dispatcher.resolve_agent_axes(id, nil, false, runner)
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
