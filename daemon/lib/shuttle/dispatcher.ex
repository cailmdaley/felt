defmodule Shuttle.Dispatcher do
  @moduledoc """
  Dispatches a single worker for a felt constitution fiber:
  - Locates the fiber via the Shuttle CLI
  - Refuses a fiber without an intrinsic id (its worker would have no name)
  - Checks status (refuses closed)
  - Checks for an existing worker
  - Starts the selected terminal or app surface with the dispatch prompt
  - Records the session identity for continuation
  """

  require Logger

  alias Shuttle.{Agents, Collaboration}

  # Codex and pi mint their own session UUIDs after the process starts. A cold
  # harness can spend tens of seconds loading before it writes the transcript
  # header (a live Codex dispatch on 2026-08-23 took 28 s), so an attempt count
  # is not a meaningful bound: each scan gets slower as the day directory
  # grows. Bound the asynchronous reconciliation by elapsed time instead.
  @session_capture_timeout_ms 120_000
  @session_capture_poll_ms 250

  @typedoc """
  Why a forced start could not arm its fiber: `message` is the Shuttle CLI's
  own words (or the daemon's, for a block with no directory), and `needs`
  names the block field a human must supply before the start can proceed
  (`"project_dir"`), else `nil`.
  """
  @type arm_refusal :: %{message: String.t(), needs: String.t() | nil}

  @type dispatch_result ::
          {:ok, String.t()}
          | {:error, :not_found}
          | {:error, :closed}
          | {:error, :not_active}
          | {:error, :already_running}
          | {:error, {:arm_refused, arm_refusal()}}
          | {:error, :missing_session_id}
          | {:error, {:uid_missing, String.t()}}
          | {:error, {:wrapper_unresolved, String.t()}}
          | {:error, {:work_dir_missing, String.t()}}
          | {:error, {:tmux_server_unavailable, String.t()}}
          | {:error, {:session_open_in_resume, String.t()}}
          | {:error, {:transcript_held, String.t()}}
          | {:error, String.t()}

  @doc """
  True for a dispatch preflight refusal — `{:error, {tag, message}}` with an
  operator-facing `message` every surface renders verbatim (the poller's
  `blocked` row, the dispatch API's 422, the CLI's stderr). Usable in guards
  after `require Shuttle.Dispatcher`.
  """
  defguard refusal?(tag, message)
           when tag in [
                  :uid_missing,
                  :wrapper_unresolved,
                  :work_dir_missing,
                  :tmux_server_unavailable,
                  :session_open_in_resume,
                  :transcript_held
                ] and is_binary(message)

  @doc """
  Dispatches a worker for the given fiber ID.

  Returns `{:ok, worker_reference}` on success, or an error tuple. Terminal
  references are tmux names; app references are `codex-app:<session UUID>`.

  Options:
    * `:runner` — module implementing `Shuttle.Runner` behavior for test injection.
      Defaults to `Shuttle.Runner.Default`.
    * `:work_dir` — working directory for the tmux session. Defaults to `File.cwd!()`.
    * `:felt_store` — directory containing the `.felt/` index this dispatch
      should read fibers from. Defaults to the first configured store; the
      Poller passes the fiber's owning store.
    * `:prompt_context` — `:constitution` (default), or
      `{:standing_run, run_id}` / `{:standing_run, run_id, :ad_hoc}`.
    * `:force` — explicit manual dispatch override. When true, the dispatcher
      stops refusing closed fibers (the Poller already relaxes eligibility
      under force) and `resolve_resume_intent` ignores the ad-hoc
      short-circuit so the caller's `resume_mode` is honored regardless of
      dispatch context.
    * `:resume_mode` — the user's continuation directive, a transient dispatch
      parameter carried with the dispatch call: `"previous"` resumes the
      dispatch marker's session, `"fresh"` always starts new (unconditional —
      wins over the marker heuristic), absent → marker-decided.
    * `:user_message` — the user's free-text directive for this dispatch,
      inlined into the prompt at launch (the "From User" block). Transient: it
      rides the dispatch call, never a persisted felt event.
  """
  @spec dispatch(String.t(), keyword()) :: dispatch_result()
  def dispatch(fiber_id, opts \\ []) do
    runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)
    work_dir = Keyword.get(opts, :work_dir, File.cwd!())
    prompt_context = Keyword.get(opts, :prompt_context, :constitution)
    felt_store = Keyword.get(opts, :felt_store, default_felt_store())
    force = Keyword.get(opts, :force, false)

    with {:ok, fiber} <- fetch_fiber(fiber_id, runner, felt_store),
         {:ok, uid} <- check_uid(fiber_id, fiber),
         :ok <- check_dispatchable(fiber, force),
         :ok <- maybe_reopen_on_force(fiber_id, fiber, force, runner, felt_store),
         :ok <- check_not_running(fiber_id, uid, runner, get_in(fiber, ["shuttle", "surface"])),
         :ok <- check_app_not_running(fiber_id, uid),
         {:ok, agent} <- resolve_agent(fiber),
         :ok <- validate_agent(agent),
         :ok <- check_work_dir(work_dir),
         :ok <-
           preflight_surface(
             Map.get(fiber["shuttle"] || %{}, "surface", "cli"),
             agent,
             work_dir,
             runner
           ) do
      resume_intent =
        resolve_resume_intent(prompt_context, fiber,
          force: force,
          resume_mode: Keyword.get(opts, :resume_mode)
        )

      previous_session = previous_session_info(fiber, uid)

      {resume_intent, previous_session} =
        case resume_intent do
          {:cold, session_id, transcript} ->
            {:fresh, cut_off_session(previous_session, session_id, transcript)}

          intent ->
            {intent, previous_session}
        end

      case resume_intent do
        {:error, _} = error ->
          error

        resume_intent ->
          create_worker(fiber_id, agent, work_dir, runner, prompt_context, resume_intent,
            felt_store: felt_store,
            surface: get_in(fiber, ["shuttle", "surface"]) || "cli",
            uid: uid,
            kind: Shuttle.Poller.fiber_kind(fiber),
            fiber_path: Map.get(fiber, "path"),
            run_id: prompt_context_run_id(prompt_context),
            user_message: Keyword.get(opts, :user_message),
            previous_session: previous_session,
            collaboration: Collaboration.snapshot(fiber),
            agent: agent.id,
            model: agent.model
          )
      end
    end
  end

  @doc """
  Decides whether this dispatch should resume a prior worker session or start
  fresh, given the prompt context and the user's continuation directive.

  - Ad-hoc standing-role dispatches start fresh. Resuming would land the
    worker in a transcript whose last assistant turn was "Run accepted.
    Exiting" — it would idle instead of doing the new run. A forced dispatch
    (the board's Resume button, a delivered message) skips this and goes
    through `check_resume_intent/2`.
  - All other contexts defer to `check_resume_intent/2`.

  Options:
    * `:force` — when true, the ad-hoc short-circuit is skipped.
    * `:resume_mode`, `:transcript`, `:now` — passed to `check_resume_intent/2`.
  """
  @spec resolve_resume_intent(any(), map(), keyword()) :: continuation()
  def resolve_resume_intent(prompt_context, fiber, opts \\ []) do
    force? = Keyword.get(opts, :force, false)

    case prompt_context do
      {:standing_run, _, :ad_hoc} when not force? ->
        :fresh

      _ ->
        check_resume_intent(fiber, Keyword.delete(opts, :force))
    end
  end

  @doc """
  Resolves the continuation intent from the carried `resume_mode` directive and
  the fiber's `shuttle.runtime` markers.

  Returns one of:
  - `:fresh` — start a new session.
  - `{:previous, session_id}` — resume that session with the harness's resume
    command.
  - `{:cold, session_id, transcript_path | nil}` — start a new session; the
    previous one ended without a handoff, and the prompt names it and where
    its transcript is (`nil`: not on this host).
  - `{:error, :missing_session_id}` — `resume_mode == "previous"` but the fiber
    carries no session id. The caller surfaces this rather than starting fresh.

  `resume_mode`:
    * `"previous"` — the board's Resume button: resume `session_uuid`,
      unconditionally.
    * `"fresh"` — the board's New session: always a new session, naming the
      previous one when it ended without a handoff.
    * `"continue"` — a message delivered to a fiber with no live worker
      (`Shuttle.Delivery`): the no-handoff rule below, for any kind of fiber.
    * absent — the autonomous loop: the no-handoff rule for oneshots; a
      standing constitution starts fresh, since it runs discrete occurrences.

  The no-handoff rule: with no session, or a clean handoff since dispatch
  (`handed_off_at >= dispatched_at`), start fresh. A `surface: app`
  conversation keeps its identity in the Codex App Server, so it resumes.
  Otherwise the session's transcript decides — see `continue_or_cold/3`.

  Options:
    * `:resume_mode` — as above.
    * `:transcript` — `fn session_id -> %{path, mtime} | nil end`, the
      transcript lookup (default `Shuttle.Continuation.transcript_stat/1`).
    * `:now` — the `DateTime` the transcript's age is measured against.
  """
  @type continuation ::
          :fresh
          | {:previous, String.t()}
          | {:cold, String.t(), String.t() | nil}
          | {:error, :missing_session_id}

  @spec check_resume_intent(map(), keyword()) :: continuation()
  def check_resume_intent(fiber, opts \\ []) do
    session_id = Shuttle.Continuation.resumable_session_id(fiber)

    case Keyword.get(opts, :resume_mode) do
      "previous" ->
        if session_id, do: {:previous, session_id}, else: {:error, :missing_session_id}

      "fresh" ->
        # Never a resume (an app conversation's `{:previous, _}` included), but
        # a cut-off terminal session is still named.
        case continuation(fiber, session_id, opts, :fresh_only) do
          {:previous, _} -> :fresh
          other -> other
        end

      "continue" ->
        continuation(fiber, session_id, opts, :resume_if_warm)

      _ ->
        if Shuttle.Poller.fiber_kind(fiber) == "oneshot",
          do: continuation(fiber, session_id, opts, :resume_if_warm),
          else: :fresh
    end
  end

  # The no-handoff rule; its transcript lookup runs only past the first three
  # clauses.
  defp continuation(fiber, session_id, opts, want) do
    cond do
      is_nil(session_id) -> :fresh
      Shuttle.Continuation.clean_handoff_since_dispatch?(fiber) -> :fresh
      app?(fiber) -> {:previous, session_id}
      true -> continue_or_cold(fiber, session_id, opts, want)
    end
  end

  # A session that ended without a handoff, judged by its transcript (one
  # resolve + one stat):
  #   - last written before this dispatch's `dispatched_at` → the id is not
  #     this dispatch's session (a codex/pi launch whose own id was never
  #     scraped leaves its predecessor's in the marker) → plain fresh;
  #   - written within the warm window → resume, while the prompt cache still
  #     holds it (unless the caller only wants fresh);
  #   - older, or not on this host → fresh, naming the cut-off session. Past the
  #     window a resume replays the whole transcript uncached, which costs more
  #     than a fresh worker reading `## Status`, whatever its size.
  defp continue_or_cold(fiber, session_id, opts, want) do
    lookup = Keyword.get(opts, :transcript, &Shuttle.Continuation.transcript_stat/1)
    transcript = lookup.(session_id)
    now = Keyword.get_lazy(opts, :now, &DateTime.utc_now/0)

    cond do
      Shuttle.Continuation.predates_dispatch?(transcript, fiber) ->
        :fresh

      want == :resume_if_warm and Shuttle.Continuation.warm?(transcript, now) ->
        {:previous, session_id}

      true ->
        {:cold, session_id, transcript && transcript.path}
    end
  end

  defp app?(fiber), do: get_in(fiber, ["shuttle", "surface"]) == "app"

  # The previous-session record for a fresh launch after a cut-off session.
  defp cut_off_session(previous, session_id, transcript) do
    harness =
      cond do
        is_binary(transcript) -> Shuttle.Transcript.harness_for(transcript)
        match?(%{uuid: ^session_id}, previous) -> previous[:harness]
        true -> nil
      end

    %{uuid: session_id, harness: harness, cut_off: true, transcript: transcript}
  end

  # The first configured felt store: the default when a caller names none.
  defp default_felt_store do
    Shuttle.FeltStores.configured_stores() |> List.first()
  end

  @doc "Renders the skill entrypoint and launch-specific data for a worker."
  @spec render_prompt(String.t(), keyword()) :: String.t()
  def render_prompt(fiber_id, opts \\ []) do
    compose_prompt(
      "You are a Shuttle worker. Activate the felt and shuttle skills.\nFiber: #{Keyword.get(opts, :prompt_fiber_id, fiber_id)}",
      opts
    )
  end

  # Optional provenance for fresh workers; current instructions live in the
  # constitution and this dispatch's user message. A session that died without
  # handing off (`cut_off`) is named as such, with where its transcript is.
  defp render_previous_session_line(opts) do
    case Keyword.get(opts, :previous_session) do
      %{uuid: uuid} = prev when is_binary(uuid) and uuid != "" ->
        harness =
          case Map.get(prev, :harness) do
            h when is_binary(h) and h != "" -> " (#{h})"
            _ -> ""
          end

        "Previous session: #{uuid}#{harness}" <> render_cut_off(prev)

      _ ->
        ""
    end
  end

  defp render_cut_off(%{cut_off: true, transcript: path}) when is_binary(path),
    do:
      " ended without a handoff (host outage, kill, or crash).\n" <>
        "Its transcript, to consult as needed after reading Status: #{path}"

  defp render_cut_off(%{cut_off: true}),
    do:
      " ended without a handoff (host outage, kill, or crash); " <>
        "its transcript is not on this host."

  defp render_cut_off(_), do: ""

  @doc "Renders a resumed worker's skill entrypoint and current launch data."
  @spec render_resume_prompt(String.t(), keyword()) :: String.t()
  def render_resume_prompt(fiber_id, opts \\ []) do
    compose_prompt(
      "You are a Shuttle worker. Activate the felt and shuttle skills.\nMode: resume\nSync and re-read the fiber before continuing.\nFiber: #{Keyword.get(opts, :prompt_fiber_id, fiber_id)}",
      Keyword.delete(opts, :previous_session)
    )
  end

  # Renders the user's dispatch message (the `:user_message` parameter) as a
  # "From User" block for inclusion in the dispatch prompt. Returns "" when no
  # message is carried (or it is blank).
  #
  # The message is a transient dispatch parameter — it rides the dispatch call,
  # is inlined here at launch, and is discarded. There is no persistence: a
  # directive arrives *with* its dispatch, so there is no "which comment is
  # current?" to compute, and no stale-directive-replay to guard against.
  defp render_user_message_block(opts) do
    case Keyword.get(opts, :user_message) do
      message when is_binary(message) ->
        case String.trim(message) do
          "" -> ""
          _ -> "From User:\n" <> message
        end

      _ ->
        ""
    end
  end

  @doc """
  Renders a standing-role run prompt for one scheduled occurrence.

  The fresh dispatch prompt plus the run id and whether the run is scheduled
  or ad-hoc. How a standing run proceeds and hands off for review lives in the
  shuttle skill's `references/standing-roles.md`, not the prompt.
  """
  @spec render_standing_run_prompt(String.t(), String.t(), keyword()) :: String.t()
  def render_standing_run_prompt(fiber_id, run_id, opts \\ []) do
    ad_hoc? = Keyword.get(opts, :ad_hoc, false)
    prompt_fiber_id = Keyword.get(opts, :prompt_fiber_id, fiber_id)

    mode = if ad_hoc?, do: "ad-hoc", else: "scheduled"

    header =
      "You are a Shuttle worker. Activate the felt and shuttle skills.\nFiber: #{prompt_fiber_id}\nRun: #{run_id}\nRun mode: #{mode}"

    compose_prompt(header, Keyword.put(opts, :kind, "standing"))
  end

  @doc false
  @spec prompt_fiber_id(String.t(), String.t(), module()) :: String.t()
  # The worker runs `felt show <id>` from inside `work_dir`, whose `.felt`
  # symlinks into a sub-store view of the loom — so the id it sees is
  # project-local (e.g. global `ai-futures/shuttle/X` → local `constitution/X`).
  # felt already computes that local address: `felt -C work_dir show <id> -j`
  # resolves the fiber against the worker's felt view and carries its
  # view-relative `id`. Read it directly rather than reconstructing it from a
  # globbed path. On any felt miss/error fall back to the global `fiber_id`.
  # The worker's view is `work_dir`, not the configured store root, so no
  # felt_store is needed here.
  # Runs through the injected, bounded `runner`: this sits on the Poller's
  # dispatch path (via `create_tmux_session/7`), where a wedged felt would
  # otherwise block the Poller GenServer. A timeout degrades to the global-id
  # fallback.
  def prompt_fiber_id(fiber_id, work_dir, runner \\ Shuttle.Runner.Default) do
    case felt_show_id(work_dir, fiber_id, runner) do
      {:ok, local_id} -> local_id
      :error -> fiber_id
    end
  end

  defp felt_show_id(work_dir, fiber_id, runner) do
    case runner.cmd("felt", ["-C", work_dir, "show", fiber_id, "-j"], stderr_to_stdout: false) do
      {output, 0} ->
        case Jason.decode(output) do
          {:ok, %{"id" => id}} when is_binary(id) and id != "" -> {:ok, id}
          _ -> :error
        end

      _ ->
        :error
    end
  rescue
    _ -> :error
  end

  # Prompts carry dispatch facts and the attention contract; the shuttle
  # skill owns the detailed worker workflow.
  defp compose_prompt(header, opts) do
    felt_store = Keyword.get(opts, :felt_store, default_felt_store())

    [
      header,
      "Close with an outcome when done; ask with a report when a human decision unlocks work; otherwise just end your turn. Never raise a flag on every turn.",
      if(Keyword.get(opts, :kind) == "standing",
        do:
          "For a standing run, finish with handoff instead of close; the daemon marks the run for review.",
        else: ""
      ),
      if(felt_store, do: "Felt store: #{felt_store}", else: ""),
      "Kind: #{Keyword.get(opts, :kind, "oneshot")}; surface: #{Keyword.get(opts, :surface, "cli")}; headless: #{Keyword.get(opts, :headless, false)}",
      render_previous_session_line(opts),
      Collaboration.prompt_section(Keyword.get(opts, :collaboration), felt_store)
    ]
    |> Enum.reject(&(&1 == ""))
    |> Enum.join("\n")
    |> append_user_message(opts)
  end

  defp append_user_message(header, opts) do
    case render_user_message_block(opts) do
      "" -> header
      message -> header <> "\n\n" <> message
    end
  end

  @doc """
  Spawns a tmux agent session from a free-text capture prompt — no
  pre-existing fiber required.

  The chat-to-card intake: the user's yap is carried verbatim into the
  spawned session's prompt, together with the felt store and instructions to
  crystallize the idea into a fiber, install a `shuttle:` block, claim the
  session via `POST /api/v1/claim`, and then continue as the worker realizing
  the new constitution. The session name (`capture-<hex>`) deliberately does
  NOT end in `-shuttle`: the daemon's orphan/adoption machinery ignores it
  until the worker claims it, at which point the claim verb renames the tmux
  session to the canonical `<leaf>-<uid>-shuttle` form — from then on it is
  indistinguishable from a dispatched worker.

  Options:
    * `:runner` — `Shuttle.Runner` impl (default `Shuttle.Runner.Default`)
    * `:work_dir` — project directory to spawn in (required)
    * `:felt_store` — felt store the worker should file into
    * `:agent` — agent registry name (default `"claude-opus"`, the bare
      fallback; fable is disabled and is never a default)
    * `:effort` — reasoning-effort token, validated against the agent's
      `effort_levels` (same contract as `shuttle.effort` on a fiber)
    * `:chrome` — boolean; claude harness only (same as `shuttle.chrome`)
    * `:host` — owning host id to stamp into the shuttle block (optional)
    * `:meeting` — the launch id of the meeting this capture scribes; it rides
      in the supplied `Claim` body, so the claim stamps it on the fiber

  Returns `{:ok, %{session:, session_uuid:, agent_id:}}` or `{:error, reason}`.
  """
  @spec capture(String.t(), keyword()) :: {:ok, map()} | {:error, term()}
  def capture(yap, opts \\ []) when is_binary(yap) do
    runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)
    work_dir = Keyword.fetch!(opts, :work_dir)
    felt_store = Keyword.get(opts, :felt_store, default_felt_store())
    agent_name = Keyword.get(opts, :agent) || "claude-opus"
    effort = Keyword.get(opts, :effort)
    chrome = Keyword.get(opts, :chrome) == true
    host = Keyword.get(opts, :host)

    surface = Keyword.get(opts, :surface) || "cli"

    with {:ok, agent} <- resolve_agent_axes(agent_name, effort, chrome, runner),
         :ok <- validate_agent(agent),
         :ok <- check_work_dir(work_dir),
         :ok <- preflight_surface(surface, agent, work_dir, runner) do
      if surface == "app" do
        capture_app(yap, agent, work_dir, felt_store, opts)
      else
        session = capture_session_name()

        # Only claude can be handed a session id up front; `build_command/3` and
        # `render_capture_prompt/2` both treat a nil `session_id`/`session_uuid`
        # as absent, so the other harnesses need no separate path.
        session_uuid = if agent.cli == "claude", do: generate_uuid4()

        prompt =
          render_capture_prompt(yap,
            session: session,
            felt_store: felt_store,
            session_uuid: session_uuid,
            agent_id: agent.id,
            project_dir: work_dir,
            host: host,
            meeting: Keyword.get(opts, :meeting),
            effort: effort,
            chrome: chrome,
            headless: agent[:headless] == true
          )

        command = Agents.build_command(agent, prompt, session_id: session_uuid)

        # No `session:` opt: capture sessions are headless by design (the user
        # stays on the board), so the wait-for-client gate would only delay the
        # worker by its 10s timeout.
        run_script = build_run_script(session, command, agent.id, display_fiber_id: "capture")

        Logger.info("Capture session via #{agent.id} → tmux session #{session}")

        case spawn_tmux(session, work_dir, run_script, runner) do
          {:ok, _} -> {:ok, %{session: session, session_uuid: session_uuid, agent_id: agent.id}}
          error -> error
        end
      end
    end
  end

  # Resolves an agent name + axes with no fiber on disk (a capture, or
  # `Shuttle.SessionResume`'s ledger-named agent), so it shells shuttle — the
  # registry owner — rather than re-resolving locally:
  #   shuttle agents resolve <name> [--effort <E>] [--chrome] --json
  # emits the same shape inlines as `shuttle.resolved.agent`. The daemon turns
  # it into a command record via from_resolved/1. shuttle exits non-zero with a
  # descriptive diagnostic on an unknown agent / dangling alias / unsupported
  # axis; that becomes `{:error, {:invalid_axes, msg}}` so the HTTP layer can
  # answer 422 without string-sniffing. Other capture failures stay 500-shaped.
  # Routed through the injected `runner` so tests need no live shuttle process.
  @doc false
  def resolve_agent_axes(agent_name, effort, chrome, runner) do
    args =
      ["agents", "resolve", agent_name] ++
        if(is_binary(effort) and effort != "", do: ["--effort", effort], else: []) ++
        if(chrome, do: ["--chrome"], else: []) ++
        ["--json"]

    # `stderr_to_stdout: true` keeps successful resolved JSON and a refused
    # request's diagnostic in the same result string.
    case Shuttle.CLI.run(args, runner: runner) do
      {:ok, output} ->
        {:ok, Agents.from_resolved(Jason.decode!(output))}

      # A runner timeout is a wedged node, not a bad request — it must stay
      # 500-shaped (see moduledoc: only axes-validation failures answer 422).
      {:command_error, :timeout, output} ->
        {:error, "shuttle agents resolve timed out: #{String.trim(output)}"}

      {:command_error, _status, output} ->
        {:error, {:invalid_axes, String.trim(output)}}

      {:error, reason} ->
        {:error, "shuttle agents resolve failed: #{reason}"}
    end
  rescue
    # A malformed successful response is a CLI contract violation and surfaces
    # loudly as a 500 rather than crashing the capture path.
    e in Jason.DecodeError ->
      {:error, "shuttle agents resolve failed: #{Exception.message(e)}"}
  end

  @doc false
  def render_capture_prompt(yap, opts) do
    render_capture_entrypoint(yap, Keyword.put(opts, :surface, "cli"))
  end

  defp render_capture_entrypoint(yap, opts) do
    surface = Keyword.fetch!(opts, :surface)
    claim = %{fiber_id: "<fiber id>", agent: Keyword.get(opts, :agent_id, "")}

    claim =
      if surface == "app",
        do: Map.put(claim, :surface, "app"),
        else: Map.put(claim, :tmux_session, Keyword.fetch!(opts, :session))

    if surface == "app", do: Keyword.fetch!(opts, :session_uuid)

    claim =
      Enum.reduce([:session_uuid, :meeting], claim, fn key, acc ->
        case Keyword.get(opts, key) do
          value when is_binary(value) and value != "" -> Map.put(acc, key, value)
          _ -> acc
        end
      end)

    install = %{
      kind: "oneshot",
      surface: surface,
      agent: Keyword.get(opts, :agent_id, ""),
      project_dir: Keyword.fetch!(opts, :project_dir)
    }

    install =
      Enum.reduce([:host, :effort, :chrome], install, fn key, acc ->
        case Keyword.get(opts, key) do
          value when value in [nil, "", false] -> acc
          value -> Map.put(acc, key, value)
        end
      end)

    header = """
    You are a Shuttle capture worker. Activate the felt and shuttle skills and read shuttle references/capture.md.
    Felt store: #{Keyword.fetch!(opts, :felt_store)}
    Project dir: #{Keyword.fetch!(opts, :project_dir)}
    Headless: #{Keyword.get(opts, :headless, false)}
    Install: #{Jason.encode!(install)}
    Claim endpoint: #{claim_endpoint(Keyword.get(opts, :listen, Shuttle.listen()))}
    Claim: #{Jason.encode!(claim)}
    """

    append_user_message(String.trim_trailing(header), user_message: yap)
  end

  # Where the capture worker POSTs its claim. On a unix listener the worker has
  # no TCP port to hit, so the line carries the socket form curl understands.
  defp claim_endpoint("unix://" <> path),
    do: "http://localhost/api/v1/claim via `curl --unix-socket '#{path}'`"

  defp claim_endpoint("tcp://" <> authority), do: "http://#{authority}/api/v1/claim"

  # `capture-<hex>` — distinguishable, collision-free enough, and crucially
  # not `-shuttle`-suffixed (see `capture/2`).
  defp capture_session_name do
    suffix = :crypto.strong_rand_bytes(4) |> Base.encode16(case: :lower)
    "capture-" <> suffix
  end

  @doc """
  The tmux session name of a fiber's worker: `<leaf>-<uid>-shuttle`.

  The human-readable leaf keeps tmux/kitty titles legible from the left edge
  when truncated, and the uid (the fiber's intrinsic ULID) makes the name
  collision-free and rename-safe — two fibers sharing a leaf do not collide,
  and renaming a fiber leaves the running worker's session addressable by the
  uid that does not change.

  `nil` when `uid` is not a ULID: such a fiber has no worker name, and
  `dispatch/2` refuses it (`:uid_missing`). The names produced here are exactly
  the names `shuttle_session?/1` recognizes.
  """
  @spec session_name(String.t(), String.t() | nil) :: String.t() | nil
  def session_name(fiber_id, uid) do
    if Shuttle.ULID.valid?(uid), do: fiber_leaf(fiber_id) <> "-" <> uid <> "-shuttle"
  end

  @doc """
  Returns true when a tmux session name belongs to a Shuttle worker: it parses
  as `<leaf>-<ULID>-shuttle` (`Shuttle.ULID.from_tmux/1`).
  """
  @spec shuttle_session?(String.t()) :: boolean()
  def shuttle_session?(session_name), do: Shuttle.ULID.from_tmux(session_name) != nil

  # ── Internal ──

  defp fiber_leaf(fiber_id) do
    case String.trim_trailing(fiber_id, "/") do
      "" -> ""
      trimmed -> trimmed |> String.split("/") |> List.last()
    end
  end

  # Read the fiber from the store this dispatch was given — the Poller passes
  # the fiber's owning store; the default is `default_felt_store/0`. With no
  # store there is nothing to read. Shuttle's show includes the resolved agent
  # record the dispatch preflight consumes; stderr stays out of the JSON.
  defp fetch_fiber(_fiber_id, _runner, nil), do: {:error, :not_found}

  defp fetch_fiber(fiber_id, runner, felt_store) do
    case Shuttle.CLI.run_in_store(felt_store, ["show", fiber_id, "--json"],
           runner: runner,
           stderr_to_stdout: false
         ) do
      {:ok, output} -> decode_fiber(output)
      _ -> {:error, :not_found}
    end
  end

  defp decode_fiber(output) do
    case Jason.decode(output) do
      {:ok, fiber} -> {:ok, fiber}
      {:error, _} -> {:error, "invalid fiber JSON"}
    end
  end

  # An unforced dispatch launches only what this fresh read still finds
  # `active`. The tick that chose the fiber read it earlier, so a pause, rest
  # or close landing in between must stop the launch here: `closed` and every
  # other status alike. Manual force-dispatch (the "New session" / "Resume"
  # buttons) explicitly opts in to dispatching a fiber that is not armed;
  # `maybe_reopen_on_force/5` then reopens the YAML so the kanban view
  # actually reclassifies the card.
  defp check_dispatchable(_fiber, true), do: :ok

  defp check_dispatchable(fiber, _force) do
    case Map.get(fiber, "status", "") do
      "active" -> :ok
      "closed" -> {:error, :closed}
      _ -> {:error, :not_active}
    end
  end

  # Force-dispatch reopens the fiber as part of the same transaction. Without
  # this, force lets the worker spawn (the closed gate above is relaxed) but
  # `status: closed`, `tempered`, and `closed_at` stay on disk — the kanban
  # keeps the card in its closed/tempered column forever, even though a worker
  # is now running. Reopen (status=active, tempered cleared, closed_at cleared)
  # lets the card reclassify as in-flight on the next poll.
  #
  # Skips the shell-out when the fiber is already in a clean active state —
  # re-dispatching a healthy in-flight oneshot shouldn't rewrite frontmatter
  # on every click.
  #
  # For a CLOSED fiber the reopen is AUTHORITATIVE: it must succeed before any
  # worker spawns. A worker dispatched against a still-`closed` fiber has no
  # live mandate — it boots and dies within seconds (the "terminal opens and
  # immediately closes" symptom) while the card stays in its closed column. So
  # a non-zero `shuttle reopen` (`{:error, {:arm_refused, refusal}}`) ABORTS
  # the dispatch and propagates through the `with` chain to the caller, carrying
  # the CLI's own reason.
  #
  # For a non-closed-but-not-clean fiber (e.g. tempered yet still active) the
  # reopen stays best-effort: the worker has a live mandate regardless, so a
  # failed reopen only risks a sticky kanban column, which we log loudly.
  defp maybe_reopen_on_force(_fiber_id, _fiber, false, _runner, _felt_store), do: :ok

  defp maybe_reopen_on_force(fiber_id, fiber, true, runner, felt_store) do
    if already_clean?(fiber) do
      :ok
    else
      reopen(fiber_id, runner, felt_store, closed?(fiber))
    end
  end

  # One reopen, two severities. `fatal?` is the closed-fiber case above: a
  # failure aborts the dispatch. Otherwise the worker has a live mandate
  # regardless, so a failure only risks a sticky kanban column and we log
  # loudly and continue.
  defp reopen(fiber_id, runner, felt_store, fatal?) do
    case run_reopen(fiber_id, runner, felt_store) do
      {:ok, output} ->
        Logger.info("Force-dispatch reopened #{fiber_id}: #{String.trim(output)}")
        :ok

      {:command_error, code, output} ->
        reopen_failure(fiber_id, fatal?, cli_reason(output), "exit #{code}")

      {:error, reason} ->
        reopen_failure(
          fiber_id,
          fatal?,
          "`shuttle reopen` could not run: #{inspect(reason)}",
          "raised"
        )
    end
  end

  defp reopen_failure(fiber_id, true, message, how) do
    Logger.error(
      "Force-dispatch aborted for #{fiber_id}: `shuttle reopen` failed (#{how}: #{message}) " <>
        "— refusing to spawn a worker against a still-closed fiber"
    )

    {:error, {:arm_refused, %{message: message, needs: nil}}}
  end

  defp reopen_failure(fiber_id, false, message, how) do
    Logger.warning(
      "Force-dispatch reopen failed for #{fiber_id} " <>
        "(worker will still spawn but kanban card may stick in its prior column): " <>
        "`shuttle reopen` failed (#{how}: #{message})"
    )

    :ok
  end

  # The CLI's stderr, trimmed; a plain statement when it printed nothing.
  defp cli_reason(output) do
    case String.trim(to_string(output)) do
      "" -> "`shuttle reopen` failed without a message"
      text -> text
    end
  end

  # Shell `shuttle reopen` through the one audited write helper
  # (`Shuttle.CLI`). The daemon's host is resolved locally, so no `--host`
  # override is passed — see `Shuttle.CLI`'s moduledoc.
  defp run_reopen(fiber_id, runner, felt_store) do
    Shuttle.CLI.run_lifecycle("reopen", fiber_id, [], runner: runner, felt_store: felt_store)
  end

  defp closed?(fiber), do: Map.get(fiber, "status", "") == "closed"

  defp already_clean?(fiber) do
    status = Map.get(fiber, "status", "")
    tempered = Map.get(fiber, "tempered")
    closed_at = Map.get(fiber, "closed-at") || Map.get(fiber, "closed_at")

    status == "active" and is_nil(tempered) and is_nil(closed_at)
  end

  # A fiber's worker is named by its uid (`session_name/2`), so a fiber without
  # one cannot be dispatched: refuse before anything else touches it, with the
  # fix named, through the same refusal shape every preflight uses (the
  # Poller's `blocked` row, the dispatch API's 422, the CLI's stderr).
  defp check_uid(fiber_id, fiber) do
    uid = Map.get(fiber, "uid")

    cond do
      Shuttle.ULID.valid?(uid) ->
        {:ok, uid}

      uid in [nil, ""] ->
        dispatch_refused(
          :uid_missing,
          "fiber #{fiber_id} has no intrinsic id, and a worker's tmux session is named " <>
            "<leaf>-<id>-shuttle. Run `felt backfill-ids` in its store, or add an `id:` (ULID) " <>
            "to its frontmatter."
        )

      true ->
        dispatch_refused(
          :uid_missing,
          "fiber #{fiber_id}'s id #{inspect(uid)} is not a ULID (26 uppercase Crockford " <>
            "base32 characters), so its worker has no tmux session name. Replace the `id:` in " <>
            "its frontmatter with a ULID."
        )
    end
  end

  # A live worker blocks a fresh dispatch OR a resume. `present?` treats an
  # inconclusive `has-session` as present, so a transient tmux failure can
  # never let a dispatch (especially a resume) spawn over a still-live worker —
  # the daemon refuses with :already_running and the caller adopts instead.
  defp check_not_running(fiber_id, uid, runner, surface) do
    cond do
      surface == "app" and Shuttle.Env.find_executable("tmux") == nil -> :ok
      Shuttle.Tmux.present?(runner, session_name(fiber_id, uid)) -> {:error, :already_running}
      true -> :ok
    end
  end

  defp resolve_agent(fiber) do
    # Shuttle resolves name + axes → the effective record and inlines it under
    # shuttle.resolved.agent (`shuttle show -j`). The daemon consumes that
    # finished record and renders it (Agents.build_command); it keeps no
    # registry. Absent resolved.agent ⇒ Shuttle could not resolve the agent or
    # `shuttle` is not on PATH — fail the dispatch rather than launch a broken
    # worker.
    case get_in(fiber, ["shuttle", "resolved", "agent"]) do
      resolved when is_map(resolved) ->
        {:ok, Agents.from_resolved(resolved)}

      _ ->
        {:error,
         "no resolved agent in Shuttle JSON for #{inspect(get_in(fiber, ["shuttle", "agent"]))} (shuttle must emit shuttle.resolved.agent)"}
    end
  end

  defp validate_agent(agent) do
    if agent.requires_model and is_nil(agent.model) do
      {:error, "agent #{agent.id} requires a model but none configured"}
    else
      :ok
    end
  end

  # ── Dispatch preflight ──

  # The work directory is load-bearing twice over: `spawn_tmux` hands it to
  # `tmux new-session -c`, and the wrapper probe below runs in it. When it is not
  # a directory on this host BOTH fail — and the probe fails in exactly the shape
  # a missing wrapper does (non-zero exit, no output), so without this check the
  # operator is told their harness is broken when the real fact is that the
  # fiber's checkout lives on another machine.
  #
  # The Poller never hands this a missing declared `project_dir`: it refuses
  # the dispatch (`project_dir_for_dispatch/1`). This check covers every other work_dir — a
  # capture's, a direct caller's — and one that vanished between the two.
  defp check_work_dir(work_dir) when is_binary(work_dir) and work_dir != "" do
    if File.dir?(work_dir) do
      :ok
    else
      dispatch_refused(
        :work_dir_missing,
        "work directory #{work_dir} is not a directory on this host, so neither the worker's " <>
          "tmux session nor its harness could start there. The fiber's `project_dir` most " <>
          "likely names a checkout that lives on another machine — dispatch it from that host, " <>
          "or correct `project_dir` in the fiber's `shuttle:` block."
      )
    end
  end

  defp check_work_dir(_work_dir), do: :ok

  # The dispatch path's worst silent failure. `Agents.build_command/3` renders
  # the agent's `wrapper` into a script the daemon runs as `bash -l`. When the
  # wrapper's command word resolves to nothing there — a zsh/fish user whose bash
  # login profile never defines the shell function, or a wrapper that was simply
  # never installed — bash exits 127 the instant the script reaches it. The tmux
  # session spawns and dies inside a second; `spawn_tmux` saw a successful `tmux
  # new-session` and reported a successful dispatch; the board shows nothing at
  # all. A stranger's very first dispatch can vanish with no error on any surface.
  #
  # So resolution is checked BEFORE the spawn, in the same environment the run
  # script will use, and a failure aborts the dispatch as a first-class error.
  # The existing failure surfaces then carry it without further plumbing: the
  # daemon log (`Logger.error` here), the snapshot's `blocked` rows (the Poller
  # records every dispatch error there), and the dispatch API's 422.
  #
  # The result is not cached, but a refusal is not re-probed every tick either —
  # the Poller parks the fiber for a cooldown (see `preflight_cooldown_open?/2`).
  # Caching the ANSWER would be wrong at exactly the moment it mattered (the
  # operator installs the wrapper and the daemon goes on refusing); parking the
  # FIBER expires on its own and a force-dispatch skips it.
  #
  @wrapper_probe_timeout_ms 15_000

  defp preflight_wrapper(agent, work_dir, runner) do
    case Agents.wrapper_probe(agent) do
      # Shuttle fills a record's `wrapper` from its `cli` when the record omits it
      # (internal/shuttle/registry_config.go), so nothing to probe means the
      # registry record itself names nothing to invoke.
      :none ->
        dispatch_refused(
          :wrapper_unresolved,
          "agent #{agent.id} names no wrapper or cli to invoke — its registry record is " <>
            "incomplete (`shuttle agents` prints the effective registry)."
        )

      {command, args} ->
        run_wrapper_probe(agent, command, args, work_dir, runner)
    end
  end

  defp run_wrapper_probe(agent, command, args, work_dir, runner) do
    word = Agents.wrapper_command_word(agent.wrapper)

    # Probed from the work_dir the run script will start in, so a per-directory
    # environment (direnv and kin) is in scope for the probe exactly as it will
    # be for the worker. `check_work_dir/1` has already established it exists,
    # so a failure here is about the wrapper and nothing else.
    opts = [stderr_to_stdout: true, timeout_ms: @wrapper_probe_timeout_ms]

    opts =
      if is_binary(work_dir) and work_dir != "", do: Keyword.put(opts, :cd, work_dir), else: opts

    case runner.cmd(command, args, opts) do
      {output, 0} ->
        check_wrapper_kind(agent, word, String.trim(output))

      # A timeout is never evidence of absence (see `Shuttle.Runner`): a wedged
      # login shell must not be reported to the operator as a missing wrapper.
      # Let the dispatch through and let the spawn report what it finds.
      {_output, :timeout} ->
        Logger.warning(
          "Wrapper preflight for #{agent.id} timed out probing `#{word}` in a login bash; " <>
            "dispatching anyway (a timeout is not evidence the wrapper is missing)"
        )

        :ok

      {output, _status} ->
        dispatch_refused(
          :wrapper_unresolved,
          "agent #{agent.id}'s wrapper `#{word}` did not resolve in a `bash -l` environment " <>
            "(`type -t #{word}` failed#{probe_detail(output)}). Shuttle launches every worker " <>
            "through a login bash, so the wrapper must be an executable on PATH or a shell " <>
            "function defined by your bash login profile — a definition that exists only in zsh " <>
            "or fish is invisible here. Install it, or point the agent at a CLI that is on PATH " <>
            "in `~/.config/shuttle/agents.json` (`shuttle agents` prints the effective registry)."
        )
    end
  end

  # `type` reported an alias. The run script is a NON-INTERACTIVE login bash,
  # which does not expand aliases, so an alias-only wrapper probes clean and
  # still dies at launch — the same silent failure this preflight exists to end,
  # so it is refused just as loudly.
  #
  # Not every bash reaches this branch: bash 3.2 (still the system bash on macOS)
  # exits non-zero from `type -t` for an alias rather than printing `alias`, so
  # there the generic unresolved message covers the case instead. Both refuse the
  # dispatch, which is the part that matters.
  defp check_wrapper_kind(agent, word, "alias") do
    dispatch_refused(
      :wrapper_unresolved,
      "agent #{agent.id}'s wrapper `#{word}` is a shell ALIAS. Shuttle runs workers in a " <>
        "non-interactive login bash, which does not expand aliases, so the launch would die " <>
        "immediately. Define it as a shell function or an executable on PATH instead."
    )
  end

  defp check_wrapper_kind(_agent, _word, _kind), do: :ok

  # The last preflight, and the only one that is macOS-only: a tmux server must
  # already exist, forked by the user's kitty rather than by this daemon. When
  # the daemon forks it, macOS privacy charges every worker's file access to the
  # daemon's binary and the whole fleet drowns in "erlexec" prompts the daemon
  # can never satisfy — see `Shuttle.TmuxServer`. Placed LAST so it only runs
  # for a dispatch that was otherwise going to happen, and immediately before
  # `spawn_tmux`, whose `tmux new-session` is the fork in question.
  #
  # `spawn_tmux/4` itself is untouched: `tmux new-session`'s exit status stays
  # the dispatch's ground truth. (Rejected alternative: routing every dispatch
  # through `kitty @ launch` — kitty's exit code masks tmux's, and it would
  # refuse dispatch whenever kitty is closed even with a healthy human-born
  # server.)
  defp ensure_tmux_server(runner) do
    case Shuttle.TmuxServer.ensure_available(runner) do
      :ok -> :ok
      {:error, {tag, message}} -> dispatch_refused(tag, message)
    end
  end

  defp check_resume_target_free(session_id, runner) do
    with :ok <- check_no_human_resume(session_id, runner) do
      case Shuttle.WorkerProcess.check_free(runner, session_id) do
        :ok -> :ok
        {:error, {_held_or_unknown, message}} -> dispatch_refused(:transcript_held, message)
      end
    end
  end

  defp check_no_human_resume(session_id, runner) do
    tmux = Shuttle.SessionResume.tmux_name(session_id)

    if Shuttle.SessionResume.running?(tmux, runner) do
      dispatch_refused(
        :session_open_in_resume,
        "session #{session_id} is open in tmux #{tmux} (a resume from the card's History). " <>
          "Close that terminal, or attach to it, before this fiber's worker resumes the same session."
      )
    else
      :ok
    end
  end

  # Every preflight refusal takes this shape: a tagged reason the surfaces can
  # match on, and an operator-facing message they render verbatim (the Poller's
  # `blocked` row, the dispatch API's 422, the CLI's stderr).
  defp dispatch_refused(tag, message) do
    Logger.error("Dispatch refused — #{message}")
    {:error, {tag, message}}
  end

  # `type -t` prints nothing on failure; anything on stderr is the login shell's
  # own noise and is worth quoting when there is some.
  defp probe_detail(output) do
    case String.trim(to_string(output)) do
      "" -> ""
      detail -> ": #{detail}"
    end
  end

  # The previous worker's session, for the prompt's lineage line. The session
  # ledger is authoritative (UUID + harness, newest line for the fiber's uid);
  # the runtime marker is the fallback for fibers whose sessions predate the
  # ledger (UUID only — better an unlabeled pointer than none). Read BEFORE
  # this dispatch appends its own line / stamps its own marker, so the value
  # is genuinely the predecessor's.
  defp previous_session_info(fiber, uid) do
    case Shuttle.SessionLedger.latest_for_uid(uid) do
      %{"session" => session} = record ->
        %{uuid: session, harness: record["harness"]}

      nil ->
        case Shuttle.Continuation.resumable_session_id(fiber) do
          nil -> nil
          uuid -> %{uuid: uuid, harness: nil}
        end
    end
  end

  # The standing run id carried in the prompt context tuple, stamped into the
  # `shuttle.run_id` field at dispatch. nil for a plain oneshot/constitution
  # dispatch.
  defp prompt_context_run_id({:standing_run, run_id}), do: run_id
  defp prompt_context_run_id({:standing_run, run_id, _}), do: run_id
  defp prompt_context_run_id(_), do: nil

  defp preflight_surface("cli", agent, work_dir, runner) do
    with :ok <- preflight_wrapper(agent, work_dir, runner), do: ensure_tmux_server(runner)
  end

  defp preflight_surface("app", %{cli: "codex", headless: false}, _work_dir, _runner), do: :ok

  defp preflight_surface(_, _, _, _),
    do:
      {:error,
       {:invalid_axes,
        "App surface requires an interactive Codex agent; surface must be cli or app."}}

  defp check_app_not_running(fiber_id, uid) do
    if Shuttle.AppWorkers.for_fiber(fiber_id, uid), do: {:error, :already_running}, else: :ok
  end

  defp create_worker(fiber_id, agent, work_dir, runner, context, intent, opts) do
    if Keyword.get(opts, :surface) == "app" do
      create_app_worker(fiber_id, agent, work_dir, runner, context, intent, opts)
    else
      # A saved app conversation is never silently resumed through a terminal.
      case intent do
        {:previous, id} ->
          case Shuttle.AppWorkers.get(id) do
            {:ok, _} -> {:error, :session_surface_mismatch}
            _ -> create_tmux_session(fiber_id, agent, work_dir, runner, context, intent, opts)
          end

        _ ->
          create_tmux_session(fiber_id, agent, work_dir, runner, context, intent, opts)
      end
    end
  end

  defp app_opts(agent, work_dir, opts),
    do: [
      cwd: work_dir,
      felt_store: Keyword.get(opts, :felt_store),
      model: agent.model,
      effort: agent.effort
    ]

  defp create_app_worker(fiber_id, agent, work_dir, runner, context, intent, opts) do
    client = Shuttle.AppWorkers.client()

    start =
      case intent do
        :fresh -> client.start_thread(app_opts(agent, work_dir, opts))
        {:previous, id} -> resume_app_thread(client, id, fiber_id, agent, work_dir, opts)
      end

    with {:ok, %{"id" => id} = thread} <- start,
         :ok <-
           put_app_worker(thread, agent, work_dir, %{
             "fiber_id" => fiber_id,
             "uid" => Keyword.get(opts, :uid),
             "felt_store" => Keyword.get(opts, :felt_store)
           }) do
      # Identity is durable before naming, turning, or adopting the conversation.
      if intent == :fresh, do: name_app_thread(client, id, Path.basename(fiber_id))

      marker =
        Shuttle.Continuation.write_dispatch(runner, Keyword.get(opts, :felt_store), fiber_id, %{
          session_uuid: id,
          run_id: Keyword.get(opts, :run_id)
        })

      if marker == :ok do
        append_session_ledger(
          fiber_id,
          app_transcript_id(thread),
          Keyword.merge(opts,
            harness: "codex",
            ledger_kind: if(intent == :fresh, do: :dispatch, else: :resume),
            thread_id: id
          )
        )

        prompt =
          case intent do
            :fresh -> render_context_prompt(fiber_id, context, opts)
            _ -> render_resume_prompt(fiber_id, opts)
          end

        case Shuttle.AppWorkers.start_turn(id, prompt, app_opts(agent, work_dir, opts)) do
          {:ok, _} -> {:ok, Shuttle.AppWorkers.ref(id)}
          error -> error
        end
      else
        # Keep the durable record: a retry must recover this exact identity.
        :ok =
          Shuttle.AppWorkers.update(id, %{
            "launch_state" => "blocked",
            "last_error" => inspect(marker)
          })

        {:error, {:app_launch_failed, id, {:runtime_marker_failed, marker}}}
      end
    end
  end

  defp resume_app_thread(client, id, fiber_id, agent, work_dir, opts) do
    with :ok <-
           Shuttle.AppWorkers.reserve_resume(
             id,
             fiber_id,
             Keyword.get(opts, :uid),
             Keyword.get(opts, :felt_store)
           ) do
      case client.resume_thread(id, app_opts(agent, work_dir, opts)) do
        {:ok, %{"id" => ^id}} = result ->
          result

        result ->
          reason =
            case result do
              {:ok, _} -> :resume_identity_mismatch
              {:error, reason} -> reason
            end

          :ok =
            Shuttle.AppWorkers.update(id, %{
              "launch_state" => "blocked",
              "last_error" => inspect(reason)
            })

          {:error, {:app_launch_failed, id, reason}}
      end
    end
  end

  defp capture_app(yap, agent, work_dir, felt_store, opts) do
    client = Shuttle.AppWorkers.client()

    with {:ok, %{"id" => id} = thread} <- client.start_thread(app_opts(agent, work_dir, opts)),
         :ok <-
           put_app_worker(thread, agent, work_dir, %{
             "fiber_id" => nil,
             "uid" => nil,
             "felt_store" => felt_store
           }),
         :ok <- name_app_thread(client, id, yap),
         {:ok, _} <-
           Shuttle.AppWorkers.start_turn(
             id,
             render_app_capture_prompt(
               yap,
               Keyword.merge(opts,
                 session_uuid: id,
                 agent_id: agent.id,
                 project_dir: work_dir,
                 felt_store: felt_store,
                 surface: "app"
               )
             ),
             app_opts(agent, work_dir, Keyword.put(opts, :felt_store, felt_store))
           ) do
      {:ok,
       %{
         session: Shuttle.AppWorkers.ref(id),
         session_uuid: id,
         agent_id: agent.id,
         surface: "app"
       }}
    end
  end

  # The durable record of a just-started app conversation; `fiber` carries its
  # `fiber_id`, `uid` and `felt_store` (nil fiber and uid for a capture).
  defp put_app_worker(%{"id" => id} = thread, agent, work_dir, fiber) do
    Shuttle.AppWorkers.put(
      Map.merge(fiber, %{
        "session_uuid" => id,
        "thread_id" => id,
        "transcript_session_uuid" => app_transcript_id(thread),
        "project_id" => thread["projectId"],
        "cwd" => work_dir,
        "agent_id" => agent.id,
        "active" => true,
        "launch_state" => "starting",
        "started_at" => DateTime.to_iso8601(DateTime.utc_now())
      })
    )
  end

  defp app_transcript_id(%{"id" => id} = thread),
    do: thread["sessionId"] || Shuttle.AppWorkers.transcript_id(id)

  defp name_app_thread(client, id, title) do
    label =
      title
      |> String.split(~r/\R/, trim: true)
      |> List.first()
      |> then(&(&1 || "conversation"))
      |> String.replace(~r/[\x00-\x1f\x7f]/, " ")
      |> String.trim()
      |> String.slice(0, 80)

    # Naming is cosmetic; a rejected rename must not block the durable worker.
    _ = client.name_thread(id, "Shuttle — " <> label)
    :ok
  rescue
    _ -> :ok
  catch
    :exit, _ -> :ok
  end

  def render_app_capture_prompt(yap, opts) do
    render_capture_entrypoint(yap, Keyword.put(opts, :surface, "app"))
  end

  defp create_tmux_session(fiber_id, agent, work_dir, runner, prompt_context, resume_intent, opts) do
    resume_intent = effective_resume_intent(resume_intent, agent, opts)
    session = session_name(fiber_id, Keyword.get(opts, :uid))
    felt_store = Keyword.get(opts, :felt_store, default_felt_store())
    worker_fiber_id = prompt_fiber_id(fiber_id, work_dir, runner)

    prompt_opts =
      opts
      |> Keyword.put(:work_dir, work_dir)
      |> Keyword.put(:prompt_fiber_id, worker_fiber_id)
      |> Keyword.put(:headless, agent[:headless] == true)

    case resume_intent do
      {:previous, session_id} ->
        # Two harness processes on one transcript would interleave it. A
        # human resume of this very session (a card History row,
        # `Shuttle.SessionResume`) may be open in `resume-<uuid>`, or a live
        # process tmux cannot see may still hold it (a worker whose tmux
        # socket was deleted). Either way the dispatch is refused like any
        # other preflight — the poller parks the fiber as blocked with the
        # message — rather than killing a process a person may be typing in.
        case check_resume_target_free(session_id, runner) do
          :ok ->
            # Resume mode: invoke the harness-appropriate resume command and
            # inject a small prompt as the next user turn so the resumed
            # worker knows it was deliberately woken (and sees the user's
            # latest directive if there is one). Without this the worker
            # would wake blind to the directive that triggered the resume.
            Logger.info(
              "Resuming #{fiber_id} session #{session_id} via #{agent.id} → tmux #{session}"
            )

            resume_prompt = render_resume_prompt(fiber_id, prompt_opts)
            resume_command = Agents.build_resume_command(agent, session_id, resume_prompt)

            # Try resume; fall back to a fresh launch if the harness can't resume the
            # target session. claude --resume exits non-zero ("No conversation found")
            # when the on-disk transcript is gone — without a fallback the worker dies
            # in <1s and, because the daemon keeps re-selecting the same id from
            # history, the fiber flaps forever and can never be launched (the
            # own-words deadlock). The fallback reuses the SAME session id, so
            # `claude --session-id <id>` recreates the transcript under it and the next
            # resume succeeds — the fiber self-heals. `||` keeps the resume failure
            # non-fatal under `set -e`; harness-agnostic (no knowledge of where any CLI
            # stores transcripts — the run itself reports success or failure).
            # The fallback prompt must NOT carry the lineage line: the "previous"
            # session here is the very session_id the fallback relaunches under —
            # and the fallback only fires because its transcript is GONE, so the
            # line would send the worker hunting for a file that does not exist.
            fallback_command =
              fresh_fallback_command(
                agent,
                fiber_id,
                session_id,
                prompt_context,
                Keyword.delete(prompt_opts, :previous_session)
              )

            command = "#{resume_command} || #{fallback_command}"

            # claude --resume shows an interactive "you're about to use a
            # previous session" warning that only an Enter keypress at the
            # TTY can dismiss. The heredoc-piped prompt arrives *after* the
            # warning, so we can't fold it in. Schedule a tmux send-keys to
            # fire a couple seconds in. Other harnesses (codex/pi) don't
            # show this warning — and a headless `-p` resume has no TTY warning
            # page and no human to attach, so both the dismiss send-keys and the
            # wait-for-client gate are skipped for it.
            headless = Keyword.fetch!(prompt_opts, :headless)

            run_script =
              build_run_script(fiber_id, command, agent.id,
                dismiss_resume_warning: agent.cli == "claude" and not headless,
                session: session,
                headless: headless,
                display_fiber_id: worker_fiber_id,
                fiber_path: Keyword.get(opts, :fiber_path)
              )

            # Resuming is a dispatch boundary too: stamp a FRESH dispatched_at
            # (same session_id — resuming doesn't change session identity, and the
            # fresh-fallback path above reuses it as well) so the continuation
            # heuristic compares a subsequent clean-exit or died-mid-window against
            # THIS run, not the run being resumed. The session id is already known
            # synchronously here (it's the resume target itself), unlike fresh
            # codex/pi dispatch — no capture/backfill needed, one synchronous stamp
            # same as fresh dispatch.
            spawn_and_record(session, work_dir, run_script, runner, fn ->
              record_dispatch_session(
                fiber_id,
                session_id,
                runner,
                Keyword.merge(opts,
                  felt_store: felt_store,
                  run_id: Keyword.get(opts, :run_id),
                  tmux: session,
                  harness: Shuttle.SessionLedger.harness_for_cli(agent.cli),
                  uid: Keyword.get(opts, :uid),
                  ledger_kind: :resume
                )
              )
            end)

          refused ->
            refused
        end

      :fresh ->
        # Fresh mode: build the full dispatch prompt.
        {command, session_uuid} =
          build_fresh_command(agent, fiber_id, prompt_context, prompt_opts)

        Logger.info("Dispatching #{fiber_id} via #{agent.id} → tmux session #{session}")

        run_script =
          build_run_script(fiber_id, command, agent.id,
            display_fiber_id: worker_fiber_id,
            fiber_path: Keyword.get(opts, :fiber_path)
          )

        # Store the session UUID in the dispatch marker so "Resume previous"
        # and the autonomous continuation heuristic can recover it.
        spawn_and_record(session, work_dir, run_script, runner, fn ->
          store_session_id(
            fiber_id,
            session_uuid,
            runner,
            Keyword.merge(opts,
              felt_store: felt_store,
              run_id: Keyword.get(opts, :run_id),
              tmux: session,
              harness: Shuttle.SessionLedger.harness_for_cli(agent.cli),
              uid: Keyword.get(opts, :uid),
              ledger_kind: :dispatch
            )
          )
        end)
    end
  end

  # Spawn, and on a successful spawn only, record the dispatch. A spawn failure
  # propagates unchanged — nothing is stamped for a worker that never started.
  defp spawn_and_record(session, work_dir, run_script, runner, record_fun) do
    case spawn_tmux(session, work_dir, run_script, runner) do
      {:ok, _} = result ->
        record_fun.()
        result

      error ->
        error
    end
  end

  # The fresh launch a resume falls back to when the target session is gone.
  # Carries the FULL dispatch prompt (the worker is starting a new conversation,
  # not waking an existing one). For claude it reuses the resume target's id via
  # `--session-id`, so the new session is created UNDER that id and the next
  # dispatch can resume it — the fiber self-heals after one fresh run. Other
  # harnesses get a plain fresh session (no --session-id); they still recover (the
  # launch succeeds), they just don't reuse the id.
  defp fresh_fallback_command(agent, fiber_id, session_id, prompt_context, opts) do
    prompt = render_context_prompt(fiber_id, prompt_context, opts)
    # `build_command/3` ignores `session_id` for every non-claude harness.
    Agents.build_command(agent, prompt, session_id: session_id)
  end

  # Build the fresh dispatch command. For Claude we generate and inject a UUID
  # upfront (--session-id) so we can store it synchronously. For codex/pi we
  # dispatch normally and capture the UUID asynchronously after spawn.
  defp build_fresh_command(agent, fiber_id, prompt_context, opts) do
    prompt = render_context_prompt(fiber_id, prompt_context, opts)
    prompt_fiber_id = Keyword.get(opts, :prompt_fiber_id, fiber_id)

    case agent.cli do
      "claude" ->
        uuid = generate_uuid4()
        command = Agents.build_command(agent, prompt, session_id: uuid)
        {command, {:claude, uuid}}

      cli when cli in ["codex", "pi"] ->
        command = Agents.build_command(agent, prompt)
        work_dir = Keyword.get(opts, :work_dir, File.cwd!())
        {command, {:capture, cli, work_dir, prompt_fiber_id, DateTime.utc_now()}}

      _ ->
        command = Agents.build_command(agent, prompt)
        {command, :none}
    end
  end

  # A resume is only meaningful WITHIN one harness: `pi --session <uuid>`
  # cannot open a claude-code transcript and vice versa. When the ledger knows
  # which harness recorded the target session and it is not the one being
  # dispatched (an agent switch on the fiber — the pi-package fiber moving from
  # a claude worker to a pi one), start fresh instead. The fallback `||`
  # already made this self-heal one wasted launch later; refusing up front
  # costs nothing and doesn't burn the launch. An UNKNOWN harness (older ledger
  # lines, or a marker with no ledger line) still tries the resume — the
  # fallback covers it, and declining a maybe-working resume would be worse.
  @doc false
  def effective_resume_intent({:previous, _session_id} = intent, agent, opts) do
    prev_harness =
      opts
      |> Keyword.get(:previous_session)
      |> case do
        %{harness: harness} when is_binary(harness) and harness != "" -> harness
        _ -> nil
      end

    if prev_harness && prev_harness != Shuttle.SessionLedger.harness_for_cli(agent.cli),
      do: :fresh,
      else: intent
  end

  def effective_resume_intent(intent, _agent, _opts), do: intent

  # Spawn a tmux session from a run-script string. The script's path names the
  # session (`Shuttle.WorkerProcess.script_path/1`) and stays in the pane
  # bash's argv for the worker's life, so the process table can vouch for a
  # worker tmux cannot see.
  defp spawn_tmux(session, work_dir, run_script, runner) do
    tmp_path = Shuttle.WorkerProcess.script_path(session)

    File.write!(tmp_path, run_script)
    File.chmod!(tmp_path, 0o755)

    args = ["new-session", "-d", "-s", session, "-c", work_dir, "bash", "-l", tmp_path]

    case runner.cmd("tmux", args, stderr_to_stdout: true) do
      {_, 0} ->
        Logger.info("Worker running: tmux attach -t #{session}")
        {:ok, session}

      {output, _} ->
        File.rm(tmp_path)
        {:error, "tmux failed: #{output}"}
    end
  end

  # Stamp the dispatch marker in the fiber's `shuttle:` block right after a
  # successful fresh dispatch, so "Resume previous" and the autonomous
  # continuation heuristic can recover it (the block is the only structured
  # session-id home — the worker never knows its own UUID, the daemon does).
  # `opts` carries `:fiber_path` (the fiber's `.md`, from `fiber["path"]`) and
  # `:run_id` (the standing run id, nil for a oneshot).
  #
  # `dispatched_at` is the dispatch-boundary ground truth the continuation
  # heuristic compares `handed_off_at` against — it must exist the moment the
  # tmux session starts doing work, not some seconds later. So for EVERY
  # agent, `record_dispatch_session/4` runs SYNCHRONOUSLY here, before
  # `store_session_id` returns (a bounded blocking call: the Runner bounds
  # every CLI shell-out). Only the piece that
  # genuinely can't be known yet — codex/pi's session UUID, scraped from a
  # JSONL file the harness hasn't necessarily written when tmux launches — is
  # deferred to an async task, and that task only BACKFILLS `session_uuid`
  # into the marker already stamped here; it never creates the marker itself.
  #
  # - Claude: UUID was pre-specified (`--session-id`) — the sync write already
  #   carries it, nothing left to backfill.
  # - Codex/Pi: sync write carries `dispatched_at` (+ `run_id`) with no
  #   `session_uuid` yet; the async task backfills it once scraped.
  # - None: agent doesn't support session IDs; sync write still stamps
  #   `dispatched_at` so the continuation heuristic has a real boundary.
  defp store_session_id(fiber_id, {:claude, uuid}, runner, opts),
    do: record_dispatch_session(fiber_id, uuid, runner, opts)

  defp store_session_id(
         fiber_id,
         {:capture, cli, work_dir, capture_fiber_id, dispatched_after},
         runner,
         opts
       ) do
    record_dispatch_session(fiber_id, nil, runner, opts)

    # Fire-and-forget: capture the session UUID from the harness's JSONL file
    # in a background task. `dispatched_at` is already on disk, so the card can
    # honestly report `identity_pending` while a cold harness starts; the
    # elapsed-time deadline above leaves ordinary startup latency room without
    # letting a failed capture task live forever. Supervised (not bare
    # Task.start) so tests can enumerate and kill stragglers before tearing
    # down the tmp dirs the backfill writes into.
    Task.Supervisor.start_child(Shuttle.TaskSupervisor, fn ->
      deadline = System.monotonic_time(:millisecond) + @session_capture_timeout_ms

      case capture_session_uuid(cli, work_dir, capture_fiber_id, dispatched_after, deadline) do
        {:ok, uuid} ->
          backfill_session_uuid(fiber_id, uuid, runner, opts)

        {:error, reason} ->
          Logger.warning(
            "Could not capture session UUID for #{fiber_id} (#{cli}): #{reason}. " <>
              "Resume previous will be unavailable."
          )
      end
    end)
  end

  defp store_session_id(fiber_id, :none, runner, opts),
    do: record_dispatch_session(fiber_id, nil, runner, opts)

  # Stamp `{session_uuid, dispatched_at, run_id}` into the fiber's
  # `shuttle.runtime` block by shelling `shuttle mark-runtime`. At the next
  # dispatch the worker's `handed_off_at` is compared against this
  # `dispatched_at` to decide fresh-vs-resume. `felt_store` + `fiber_id` are the
  # store/scoped-id pair the dispatch read the fiber with, so Shuttle resolves
  # it. A missing `:felt_store` skips the write — the fiber then reads as a
  # fresh dispatch, the safe default. `uuid` may be `nil` (codex/pi at launch,
  # or `:none` agents) — the
  # marker still gets a `dispatched_at` boundary, just no `session_uuid` yet.
  defp record_dispatch_session(fiber_id, uuid, runner, opts) do
    write_runtime_marker(fiber_id, uuid, opts, "dispatch marker", fn store ->
      Shuttle.Continuation.write_dispatch(runner, store, fiber_id, %{
        session_uuid: uuid,
        run_id: Keyword.get(opts, :run_id)
      })
    end)
  end

  # The one runtime-marker writer both entry points share: guard on the felt
  # store, run the caller's Continuation write, and on success log + append the
  # structural half to the session ledger. A missing store suppresses the
  # ledger append too — that is behaviour, not just a skipped write.
  defp write_runtime_marker(fiber_id, uuid, opts, label, write_fun) do
    case Keyword.get(opts, :felt_store) do
      store when is_binary(store) and store != "" ->
        case write_fun.(store) do
          :ok ->
            if is_binary(uuid) and uuid != "" do
              Logger.info("Recorded session UUID #{uuid} for #{fiber_id} in shuttle.runtime")
            else
              Logger.info("Stamped dispatched_at for #{fiber_id} in shuttle.runtime")
            end

            # `record/1` drops a nil uuid itself, so the codex/pi launch
            # (boundary stamped, UUID not yet scraped) contributes no line
            # here — its line comes from the backfill, once the pairing is
            # actually known.
            append_session_ledger(fiber_id, uuid, opts)

          {:error, reason} ->
            Logger.warning(
              "Could not write #{label} for #{fiber_id} (#{store}): #{inspect(reason)}"
            )
        end

      _ ->
        Logger.debug("write_runtime_marker (#{label}): no felt_store for #{fiber_id}; skipping")
    end
  rescue
    e -> Logger.warning("Could not write #{label} for #{fiber_id}: #{inspect(e)}")
  end

  # Append the fiber↔session pairing to this host's session ledger. Carries the
  # tmux name and harness the dispatch site put in `opts`; the ledger derives
  # the fiber ULID from the tmux name and stamps host and time itself. Never
  # raises and never branches the caller — a lost ledger line costs a join row,
  # not a worker.
  defp append_session_ledger(fiber_id, uuid, opts) do
    Shuttle.SessionLedger.record(
      fiber: fiber_id,
      # Explicit, not tmux-inferred: an app worker has no tmux name to infer
      # from, and the claim path passes it the same way.
      uid: Keyword.get(opts, :uid),
      session: uuid,
      thread_id: Keyword.get(opts, :thread_id),
      tmux: Keyword.get(opts, :tmux),
      harness: Keyword.get(opts, :harness),
      kind: Keyword.get(opts, :ledger_kind, :dispatch),
      agent: Keyword.get(opts, :agent),
      model: Keyword.get(opts, :model),
      collaboration: Keyword.get(opts, :collaboration)
    )
  end

  # Backfill `session_uuid` into an ALREADY-STAMPED marker — the codex/pi
  # async capture path. Deliberately does not touch `dispatched_at`: it shells
  # `shuttle mark-runtime --session <uuid>` with no `--dispatched-at`
  # flag, and mark-runtime only writes fields whose flag is present, so the
  # boundary `record_dispatch_session/4` stamped synchronously at launch is
  # left exactly as it was.
  # (The ledger line the shared writer appends is the codex/pi `dispatch` line:
  # that pairing becomes known here, not at launch.)
  defp backfill_session_uuid(fiber_id, uuid, runner, opts) do
    write_runtime_marker(fiber_id, uuid, opts, "session UUID backfill", fn store ->
      Shuttle.Continuation.backfill_session_uuid(runner, store, fiber_id, uuid)
    end)
  end

  # Poll for the session UUID written by codex/pi to their respective session
  # JSONL files until the elapsed-time deadline.
  #
  # Disk layouts:
  #   codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl
  #          First line: {"type":"session_meta","payload":{"id":"<uuid>","cwd":"..."}}
  #   pi:    ~/.pi/agent/sessions/<encoded-cwd>/<iso>_<uuid>.jsonl
  #          First line: {"type":"session","id":"<uuid>","cwd":"..."}
  #
  # Codex stores all sessions in one date directory, so cwd alone is not a
  # unique worker identity: the human can be driving an interactive Codex
  # thread from the same project while Shuttle dispatches a worker. Require
  # the transcript to be new enough for this dispatch and to contain Shuttle's
  # fiber prompt before accepting its UUID.
  defp capture_session_uuid(cli, work_dir, fiber_id, dispatched_after, deadline) do
    if System.monotonic_time(:millisecond) >= deadline do
      {:error, "timed out waiting for session file"}
    else
      :timer.sleep(@session_capture_poll_ms)

      case find_session_file(cli, work_dir, fiber_id, dispatched_after) do
        {:ok, path} ->
          read_uuid_from_jsonl(cli, path)

        {:error, _} ->
          capture_session_uuid(cli, work_dir, fiber_id, dispatched_after, deadline)
      end
    end
  end

  # Candidate transcripts for this harness, newest first. Both harnesses lead
  # each basename with an ISO stamp, so descending basename order is descending
  # time — within a day directory and across them. The first candidate that
  # matches cwd, recency AND content is this dispatch's session; a bare
  # newest-file pick would steal another worker's session whenever two workers
  # share a cwd.
  defp candidate_session_files("codex", _work_dir) do
    Shuttle.HarnessPaths.codex_session_dirs()
    |> Enum.flat_map(fn dir ->
      case File.ls(dir) do
        {:ok, files} ->
          files
          |> Enum.filter(&String.starts_with?(&1, "rollout-"))
          |> Enum.map(&Path.join(dir, &1))

        {:error, _} ->
          []
      end
    end)
    |> Enum.sort_by(&Path.basename/1, :desc)
  end

  defp candidate_session_files("pi", work_dir) do
    dir = Shuttle.HarnessPaths.pi_sessions_dir(work_dir)

    case File.ls(dir) do
      {:ok, files} -> files |> Enum.sort(:desc) |> Enum.map(&Path.join(dir, &1))
      {:error, _} -> []
    end
  end

  defp candidate_session_files(_cli, _work_dir), do: []

  defp find_session_file(cli, work_dir, fiber_id, dispatched_after) do
    cli
    |> candidate_session_files(work_dir)
    |> Enum.find(&session_matches?(cli, &1, work_dir, fiber_id, dispatched_after))
    |> case do
      nil -> {:error, :not_found}
      path -> {:ok, path}
    end
  end

  # The JSONL first line each harness writes as its session header, reduced to
  # the map that carries `id` / `cwd` / `timestamp`. Codex nests them under
  # `payload` of a `session_meta` event; pi puts them on a top-level `session`
  # event. Everything downstream reads the same three keys.
  defp session_header(cli, content) do
    with [first_line | _] <- String.split(content, "\n", parts: 2),
         {:ok, event} <- Jason.decode(first_line) do
      case {cli, event} do
        {"codex", %{"type" => "session_meta", "payload" => payload}} when is_map(payload) ->
          {:ok, payload}

        {"pi", %{"type" => "session"}} ->
          {:ok, event}

        _ ->
          :error
      end
    else
      _ -> :error
    end
  end

  # The transcript's session header names its cwd and start time, but the
  # dispatch prompt's fiber line only appears once the first message lands
  # (~1s after the header), so the WHOLE file is searched — the retry loop
  # above re-reads until it matches.
  defp session_matches?(cli, path, work_dir, fiber_id, dispatched_after) do
    with {:ok, content} <- File.read(path),
         {:ok, header} <- session_header(cli, content),
         cwd when is_binary(cwd) <- Map.get(header, "cwd"),
         timestamp when is_binary(timestamp) <- Map.get(header, "timestamp"),
         {:ok, started_at, _} <- DateTime.from_iso8601(timestamp) do
      Shuttle.Env.expand(cwd) == Shuttle.Env.expand(work_dir) and
        DateTime.compare(started_at, DateTime.add(dispatched_after, -5, :second)) != :lt and
        String.contains?(content, "Fiber: #{fiber_id}")
    else
      _ -> false
    end
  end

  # No cwd re-check here: the only caller hands us the path
  # `find_session_file/4` just returned, and `session_matches?/5` already
  # required the header's cwd to expand to `work_dir` before returning it.
  defp read_uuid_from_jsonl(cli, path) do
    with {:ok, content} <- File.read(path),
         {:ok, header} <- session_header(cli, content),
         uuid when is_binary(uuid) and uuid != "" <- Map.get(header, "id") do
      {:ok, uuid}
    else
      _ -> {:error, "could not parse session UUID from #{path}"}
    end
  end

  # Generates a random UUID v4 using Erlang's :crypto module.
  # Sets version bits (byte 6 top nibble = 0100) and variant bits
  # (byte 8 top 2 bits = 10) per RFC 4122.
  defp generate_uuid4 do
    <<a::48, _::4, b::12, _::2, c::62>> = :crypto.strong_rand_bytes(16)

    <<g1::binary-8, g2::binary-4, g3::binary-4, g4::binary-4, g5::binary-12>> =
      Base.encode16(<<a::48, 4::4, b::12, 2::2, c::62>>, case: :lower)

    Enum.join([g1, g2, g3, g4, g5], "-")
  end

  # POSIX single-quote a value for safe interpolation into the run script's
  # `export` line. Single-quoting suppresses every shell special char; an
  # embedded `'` is closed, escaped (`'\''`), and reopened.
  defp shell_single_quote(value) do
    "'" <> String.replace(value, "'", "'\\''") <> "'"
  end

  defp render_context_prompt(fiber_id, {:standing_run, run_id}, opts) do
    render_standing_run_prompt(fiber_id, run_id, opts)
  end

  defp render_context_prompt(fiber_id, {:standing_run, run_id, :ad_hoc}, opts) do
    render_standing_run_prompt(fiber_id, run_id, Keyword.put(opts, :ad_hoc, true))
  end

  defp render_context_prompt(fiber_id, _, opts), do: render_prompt(fiber_id, opts)

  @doc false
  # Public for tests. Builds the bash script that wraps the harness command
  # with start/exit banners. With `dismiss_resume_warning: true` and a
  # `session:` name, also schedules a backgrounded tmux send-keys to
  # dismiss claude --resume's interactive warning page. `release_root:`
  # overrides the release root the environment scrub filters PATH against
  # (see `erts_scrub_block/1`).
  def build_run_script(fiber_id, command, agent_id, opts \\ []) do
    dismiss_resume_warning = Keyword.get(opts, :dismiss_resume_warning, false)
    session = Keyword.get(opts, :session, "")
    # Headless `-p` workers run unattended: no human client attaches, so the
    # wait-for-client gate below would only burn its full timeout for nothing.
    headless = Keyword.get(opts, :headless, false)
    display_fiber_id = Keyword.get(opts, :display_fiber_id, fiber_id)

    # The fiber's `.md` path for the worker's `shuttle handoff`: it stamps
    # `shuttle.handed_off_at` directly into this file (no felt-store resolution,
    # no ambiguity), so the daemon hands it the path it already resolved at
    # dispatch. The worker writes the same `shuttle:` block this daemon reads on
    # the next poll.
    fiber_key_block =
      case Keyword.get(opts, :fiber_path) do
        path when is_binary(path) and path != "" ->
          "export SHUTTLE_FIBER_PATH=#{shell_single_quote(path)}\n"

        _ ->
          ""
      end

    # When resuming claude, schedule a backgrounded tmux send-keys to
    # dismiss the interactive warning page. Runs *inside* the same tmux
    # session it's targeting — tmux send-keys can target the current
    # session, the keypress lands on whatever's at the prompt (claude's
    # warning UI). 2 seconds is a safety margin for claude startup.
    dismiss_block =
      if dismiss_resume_warning and session != "" do
        # Single-quote the session name so slashes/dots don't trip the shell.
        ~s|( sleep 2; tmux send-keys -t '#{session}' Enter ) &\n    |
      else
        ""
      end

    # Wait briefly for a real interactive tmux client (e.g. kitty's
    # `tmux attach`) to attach before starting the harness. We spawn the
    # tmux session detached (`tmux new-session -d ...`), which inherits
    # the server's `default-size` (80x24 by default). If the harness
    # starts rendering before a human-sized client attaches, its initial
    # output — especially `claude --resume`, which emits the dispatch
    # banner and "remote-control is active" line as soon as it loads
    # saved state — bakes into the scrollback at 80 cols and stays there
    # even after tmux resizes on attach (resize doesn't reflow scrollback).
    # The user sees a tiny ~80-col-wide content area inside a much larger
    # kitty tab. Waiting until the first non-control client attaches lets
    # the harness initialize at the kitty terminal's real size.
    #
    # Control-mode clients (`tmux -C attach -r` previews) don't count —
    # they declare a fake 200x50 and don't represent a human attach.
    # Filter them out via `client_control_mode=0`.
    #
    # The expected client of this gate is an auto-attach in the kanban's
    # dispatch-success path (kitty `launch --type=tab tmux attach`), which
    # lands in ~300-500ms. The 10s timeout is the safety net for the rare
    # cases where that auto-attach can't run — kitty isn't running, or the
    # daemon was dispatched with no human in the loop (CLI, scheduled
    # standing constitution). After the timeout the harness proceeds at the
    # default-size.
    wait_for_client_block =
      if session != "" and not headless, do: wait_for_client_block(session), else: ""

    """
    #!/bin/bash
    set -e
    trap 'rm -f "$0"' EXIT

    #{erts_scrub_block(Keyword.get_lazy(opts, :release_root, &release_root/0))}#{fiber_key_block}#{wait_for_client_block}
    echo ""
    echo "Shuttle worker — #{display_fiber_id} — agent=#{agent_id} — $(date '+%H:%M:%S')"

    #{dismiss_block}#{command}

    echo ""
    echo "Shuttle worker exited (agent=#{agent_id})"
    """
  end

  @doc false
  # Shell that waits up to 10s for a human tmux client on `session` (see the
  # wait-for-client note in `build_run_script/4`). Shared with
  # `Shuttle.SessionResume`, whose tab attaches the same way.
  def wait_for_client_block(session) do
    ~s"""
    WAIT_DEADLINE=$(( $(date +%s) + 10 ))
    while [ "$(date +%s)" -lt "$WAIT_DEADLINE" ]; do
      if tmux list-clients -t '#{session}' -F '\#{client_control_mode}' 2>/dev/null | grep -qx '0'; then
        break
      fi
      sleep 0.2
    done
    """
  end

  # Scrub the daemon's OWN Erlang runtime out of the worker's environment.
  #
  # The daemon is a Mix release with a bundled ERTS, and `erl` exports ROOTDIR,
  # BINDIR, PROGNAME and EMU into the BEAM's environment — which every tmux
  # worker then inherits, along with a PATH that leads with the release's
  # `erts-*/bin` and `bin`. Those point INTO the release, whose ERTS ships no
  # `mix`, no `start.boot` for anything but the daemon, and no full OTP lib
  # tree. A worker that runs `mix`, `elixir`, `erl`, `iex` or `escript` then
  # dies with `cannot get bootfile .../bin/rel/bin/start.boot`.
  #
  # `bash -l` does not fix it: the login profile PREPENDS to the inherited
  # PATH, so the release's erts bin keeps shadowing the real toolchain, and
  # ROOTDIR survives untouched regardless of PATH order.
  #
  # So the script drops the exported vars and removes every PATH entry at or
  # under the release root before anything else runs. The root is written into
  # the script when the daemon builds it — the worker's own environment carries
  # no reliable `RELEASE_ROOT`. A worker with no Erlang on PATH is correct: it
  # sees whatever the host installs.
  #
  # `release_root` is nil when the daemon runs under Mix rather than as a
  # release: `:code.root_dir/0` is then the host's own OTP install, the very
  # toolchain workers should keep, so PATH is left alone.
  #
  # Harness identity goes too. A tmux server started from inside a Claude, Codex
  # or Pi session keeps that session's AI_AGENT and *_SESSION_ID / THREAD_ID in
  # its global environment, and every pane inherits it; `shuttle message`
  # and `send-file` read those to attribute the sender, so a worker would speak
  # as the stale session. Each harness sets its own on launch.
  @doc false
  # Shared with `Shuttle.SessionResume`: any shell the daemon starts in tmux
  # must drop the release's Erlang first.
  def erts_scrub_block(release_root \\ release_root()) do
    path_filter =
      case release_root do
        root when is_binary(root) and root != "" ->
          """
          PATH=$(printf '%s' "$PATH" | tr ':' '\\n' \\
            | awk -v r=#{shell_single_quote(root)} '$0 != r && index($0, r "/") != 1' \\
            | paste -sd: -)
          export PATH
          """

        _ ->
          ""
      end

    """
    unset ROOTDIR BINDIR PROGNAME EMU ESCRIPT_NAME
    #{path_filter}unset RELEASE_ROOT RELEASE_SYS_CONFIG RELEASE_TMP RELEASE_VSN RELEASE_NAME \\
          RELEASE_NODE RELEASE_COOKIE RELEASE_MODE RELEASE_BOOT_SCRIPT \\
          RELEASE_BOOT_SCRIPT_CLEAN RELEASE_DISTRIBUTION RELEASE_PROG RELEASE_COMMAND
    unset AI_AGENT PI_SESSION_ID CLAUDE_CODE_SESSION_ID CLAUDE_SESSION_ID CODEX_THREAD_ID
    """
  end

  @doc false
  # The root of the release this daemon runs from, or nil under Mix (see
  # `erts_scrub_block/1`). A release carries no Mix, so its absence is the tell.
  def release_root do
    if Code.ensure_loaded?(Mix), do: nil, else: to_string(:code.root_dir())
  end
end
