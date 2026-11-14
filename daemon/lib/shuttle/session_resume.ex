defmodule Shuttle.SessionResume do
  @moduledoc """
  Resume a past harness session from a card's History, or a card's last
  session (`c` on a card with no worker).

  ## A constitution's own session resumes as its worker

  A session the ledger pairs with a constitution this host runs is that
  card's conversation, so it resumes as the card's worker: the Poller
  force-dispatches the fiber (`ad_hoc`, as a delivered message does) with
  `resume_session`, and the dispatcher resumes exactly that session in the
  worker's own terminal, with nothing injected because the human takes the
  next turn. From then on it is an ordinary worker: the board shows it Working
  or Your turn, `shuttle.runtime.session_uuid` names it, a standing schedule
  waits for it to end, and messages to the card reach it. Starting it arms the
  card as any forced start does (`Shuttle.Poller`'s forced start).

  While the card has a live worker, resuming that worker's session attaches
  to it, and resuming any other of its sessions is refused: a card has one
  live conversation.

  ## Any other session resumes in a terminal of its own

  A session with no constitution here (none paired, or one homed on another
  host) resumes in `resume-<session uuid>`, which no "is this a worker?"
  predicate matches, so a second click finds it rather than starting a second
  process on the transcript. `prepare/2` runs on the host that ran the
  session, since the transcript the harness resumes from lives there.

  ## The command

  The resume invocation is `Shuttle.Agents.build_resume_command/3`, the one the
  dispatcher uses to resume a worker, with no injected prompt. The agent is
  the one this host's session ledger recorded for the session, resolved
  through this host's registry (`shuttle agents resolve`), so model, effort and
  flags match a dispatch. A ledger line with no agent, or an agent that no
  longer resolves to the transcript's harness, resumes with the bare harness
  CLI.

  ## The working directory

  Read from the transcript, not from the ledger or the fiber: the fiber's
  `project_dir` may have moved since, the ledger records none, and Claude Code
  only finds a session from the directory its transcript is filed under
  (`~/.claude/projects/<cwd with every non-alphanumeric as ->/`). So a Claude
  session resumes in the first recorded `cwd` whose encoding matches that
  directory; Codex in its `session_meta` payload's `cwd`; pi in its session
  header's `cwd`. A transcript with no usable cwd is refused rather than
  resumed somewhere its harness would not find it. A worker resume runs there
  too.
  """

  require Logger

  alias Shuttle.{Agents, Dispatcher, Poller, SessionLedger, Terminal, Transcript, WorkerProcess}

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

      fiber = fiber_of(session, opts)

      {:ok,
       %{
         session: session,
         tmux: tmux_name(session),
         fiber: fiber && fiber.slug,
         fiber_path: fiber && fiber.path,
         harness: harness,
         agent: agent.id,
         cwd: cwd,
         wrapper: agent.wrapper,
         command: Agents.build_resume_command(agent, session, "")
       }}
    end
  end

  @doc """
  Resume `session`: as its constitution's worker when this host runs one
  (see the moduledoc), otherwise in the primary terminal unless it is already
  running there. `{:ok, %{tmux_session: name, created: boolean}}` names the
  terminal to open; `{:error, {:live, message}}` when the session is a running
  worker's, the card already has a different live conversation, or another
  live process holds it (two harness processes must not share a transcript);
  or `{:error, reason}`, including a refused launch and a process scan that
  could not run.

  Opts: as `plan/2`, plus `:live_sessions` (a 0-arity function standing in for
  `live_sessions/0`), and for the worker path `:own_host_id`, `:live_worker`
  (`Shuttle.Poller.live_worker/1`) and `:dispatch`
  (`Shuttle.Poller.dispatch_fiber/2`).
  """
  @spec prepare(String.t(), keyword()) ::
          {:ok, %{tmux_session: String.t(), created: boolean()}}
          | {:error, {:live, String.t()}}
          | {:error, String.t()}
  def prepare(session, opts \\ []) do
    case worker_fiber(session, opts) do
      %{} = fiber -> resume_as_worker(session, fiber, opts)
      nil -> resume_in_terminal(session, opts)
    end
  end

  defp resume_in_terminal(session, opts) do
    runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)
    live = Keyword.get(opts, :live_sessions, &live_sessions/0)

    with :ok <- not_the_worker(session, live.()),
         {:ok, plan} <- plan(session, opts),
         :ok <- Terminal.require_config() do
      if Terminal.locate(runner, plan.tmux) do
        {:ok, %{tmux_session: plan.tmux, created: false}}
      else
        with :ok <- not_held(session, runner) do
          case Terminal.status(runner, plan.tmux) do
            :gone -> start(plan, runner)
            :alive -> reuse(plan, runner)
            :unknown -> unreachable()
          end
        end
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
  snapshot and the newest session each fiber's ledger paired.
  Empty when the poller cannot answer — the dispatcher's own refusal
  (`resume-<uuid>` open) still guards the other direction.
  """
  @spec live_sessions() :: [String.t()]
  def live_sessions do
    Shuttle.Poller.snapshot(Shuttle.Env.server(Shuttle.Poller), 5_000)
    |> Map.get(:eligible, [])
    |> Enum.flat_map(fn row ->
      # A worker whose launch receipt shows its run script exited no longer
      # holds its conversation, though the Poller has yet to reap it.
      tmux =
        if is_binary(row[:tmux_session]) and
             Terminal.Receipts.status(runner(), row[:tmux_session]) != :exited do
          case SessionLedger.latest_for_uid(row[:uid]) do
            %{"session" => id} -> [id]
            _ -> []
          end
        else
          []
        end

      Enum.filter(tmux, &is_binary/1)
    end)
  catch
    :exit, _ -> []
  end

  # ── a constitution's own session ───────────────────────────────────────────

  # The constitution this host runs that the session belongs to, or nil.
  defp worker_fiber(session, opts) do
    with true <- Transcript.valid_session?(session),
         %{fiber: %{"shuttle" => %{} = shuttle} = fiber} <- fiber_entry(session, opts),
         own when is_binary(own) <- own_host_id(opts),
         true <- Poller.host_owned?(shuttle, own) do
      fiber
    else
      _ -> nil
    end
  end

  defp own_host_id(opts) do
    Keyword.get_lazy(opts, :own_host_id, &Poller.own_host_id/0)
  rescue
    _ -> nil
  end

  defp resume_as_worker(session, fiber, opts) do
    address = fiber["uid"] || fiber["id"]
    name = fiber["slug"] || fiber["id"] || address
    live = Keyword.get(opts, :live_worker, &Poller.live_worker/1)

    runner = Keyword.get(opts, :runner, runner())

    case live.(address) do
      %{session_uuid: ^session, session: tmux} ->
        # A worker the Poller cannot see is not opened: the launch below lets
        # the Poller reap it when it has ended, or refuse while it may not have.
        if Terminal.locate(runner, tmux),
          do: {:ok, %{tmux_session: tmux, created: false}},
          else: launch(session, fiber, opts)

      %{session_uuid: other} ->
        {:error,
         {:live,
          "#{name} has a live worker (session #{other || "starting"}); attach to it, " <>
            "or end it before resuming another of its sessions"}}

      nil ->
        launch(session, fiber, opts)
    end
  end

  # Every refusal comes before the launch, because a forced start arms the card
  # (reopens a closed or paused one) before the dispatcher's own checks run.
  # A session already open in a terminal of its own (resumed before its card
  # ran resumes as workers) is that terminal.
  defp launch(session, fiber, opts) do
    address = fiber["uid"] || fiber["id"]
    name = fiber["slug"] || fiber["id"] || address
    runner = Keyword.get(opts, :runner, runner())
    tmux = tmux_name(session)

    if Terminal.locate(runner, tmux) do
      {:ok, %{tmux_session: tmux, created: false}}
    else
      with {:ok, plan} <- plan(session, opts),
           :ok <- same_harness(plan, fiber, name),
           :ok <- not_in_terminal(tmux, runner),
           :ok <- not_held(session, runner) do
        launch_worker(address, session, plan, opts)
      end
    end
  end

  # The worker runs the fiber's agent, which resumes only its own harness's
  # transcripts.
  defp same_harness(plan, fiber, name) do
    agent_cli = get_in(fiber, ["shuttle", "resolved", "agent", "cli"])
    cli = cli_for(plan.harness)

    if agent_cli in [nil, cli],
      do: :ok,
      else:
        {:error,
         "session #{plan.session} ran under #{plan.harness}, but #{name}'s agent runs " <>
           "#{agent_cli}; set its agent (`shuttle set-agent`) to resume it as the worker"}
  end

  # A terminal of its own that exists but cannot be opened still holds the
  # transcript.
  defp not_in_terminal(tmux, runner) do
    case Terminal.status(runner, tmux) do
      :gone -> :ok
      _ -> {:error, {:live, "this session is open in terminal #{tmux}, which cannot be reached"}}
    end
  end

  defp launch_worker(address, session, plan, opts) do
    dispatch = Keyword.get(opts, :dispatch, &Poller.dispatch_fiber/2)

    result =
      dispatch.(address,
        force: true,
        ad_hoc: true,
        resume_mode: "previous",
        resume_session: session,
        work_dir: plan.cwd
      )

    case result do
      {:ok, tmux} ->
        Logger.info("Resume of #{session} as #{address}'s worker → #{tmux}")
        Poller.refresh_document(address)
        {:ok, %{tmux_session: tmux, created: true}}

      error ->
        {_status, body} = ShuttleWeb.DispatchReply.render(address, error)
        {:error, body[:message] || body[:error] || "the worker did not start: #{body[:reason]}"}
    end
  end

  # The fiber that ran the session names its Rex session, tab and pane, and its
  # document is the terminal's `SHUTTLE_FIBER_PATH`.
  defp fiber_of(session, opts) do
    case fiber_entry(session, opts) do
      %{fiber: fiber} = entry -> %{slug: fiber["slug"] || fiber["id"], path: entry[:path]}
      nil -> nil
    end
  end

  # The ledger's record, else the fiber whose runtime last held this session.
  defp fiber_entry(session, opts) do
    row =
      SessionLedger.latest_for_session(session,
        path: Keyword.get(opts, :ledger_path, SessionLedger.default_path())
      ) || %{}

    # The uid survives renames; the path-shaped name is the fallback.
    ledger = Enum.find([row["uid"], row["fiber"]], &(is_binary(&1) and &1 != ""))
    ledger_name = if is_binary(row["fiber"]) and row["fiber"] != "", do: row["fiber"]

    entry =
      Enum.find(fiber_entries(), fn %{fiber: fiber} ->
        if ledger,
          do: ledger in identities(fiber),
          else: get_in(fiber, ["shuttle", "runtime", "session_uuid"]) == session
      end)

    cond do
      entry -> entry
      ledger_name -> %{fiber: %{"slug" => ledger_name}}
      true -> nil
    end
  end

  @doc "The runner a resume terminal is driven with."
  def runner, do: Shuttle.Env.app(:session_resume_runner, Shuttle.Runner.Default)

  defp identities(row), do: Enum.filter([row["uid"], row["id"], row["slug"]], &is_binary/1)

  defp fiber_entries, do: Shuttle.Env.app(:session_resume_fibers, &cached_fibers/0).()

  defp cached_fibers do
    case Shuttle.Poller.cached_fiber_documents(
           felt_stores: Shuttle.FeltStores.configured_stores()
         ) do
      {:ok, %{fibers: entries}} -> entries
      _ -> []
    end
  catch
    :exit, _ -> []
  end

  @doc "Whether a terminal or an uncertain observation holds this resume on the host."
  @spec running?(String.t(), module()) :: boolean()
  def running?(name, runner), do: Terminal.present?(runner, name)

  defp start(plan, runner) do
    case Terminal.launch(runner, plan.tmux, plan.cwd, run_script(plan),
           fiber: plan[:fiber],
           conversation_uuid: plan.session
         ) do
      :ok ->
        Logger.info("Resume of #{plan.session} (#{plan.agent}) → #{plan.tmux}")
        {:ok, %{tmux_session: plan.tmux, created: true}}

      {:error, :already_running} ->
        reuse(plan, runner)

      {:error, {_tag, message}} when is_binary(message) ->
        {:error, message}

      {:error, message} when is_binary(message) ->
        # An external tmux client can still win the name outside our launch lock.
        if String.contains?(message, "duplicate session"),
          do: reuse(plan, runner),
          else: {:error, message}

      {:error, reason} ->
        {:error, "Resume terminal failed: #{inspect(reason)}"}
    end
  end

  defp reuse(plan, runner) do
    if Terminal.locate(runner, plan.tmux),
      do: {:ok, %{tmux_session: plan.tmux, created: false}},
      else: unreachable()
  end

  defp unreachable, do: {:error, "Resume terminal is unreachable; holding without launch"}

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

    #{snippets.env}#{Dispatcher.erts_scrub_block()}#{snippets.passthrough}#{fiber_path_export(plan)}#{snippets.wait_for_viewer}
    #{plan.command} || {
      status=$?
      echo ""
      echo "resume of #{plan.session} exited $status"
      read -r -p "press enter to close " _
    }
    """
  end

  defp fiber_path_export(%{fiber_path: path}) when is_binary(path),
    do: "export SHUTTLE_FIBER_PATH=#{Dispatcher.shell_single_quote(path)}\n"

  defp fiber_path_export(_plan), do: ""

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
        if Shuttle.FS.dir?(cwd),
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

  defp head(path), do: path |> Shuttle.FS.stream!() |> Stream.take(@head_lines)

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
