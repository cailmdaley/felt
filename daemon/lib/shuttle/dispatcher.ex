defmodule Shuttle.Dispatcher do
  @moduledoc """
  Dispatches a single worker for a felt constitution fiber:
  - Locates the fiber via the Shuttle CLI
  - Refuses a fiber without an intrinsic id (its worker would have no name)
  - Checks status (refuses closed)
  - Checks for an existing worker
  - Starts the selected terminal with the dispatch prompt
  - Records the session identity for continuation
  """

  require Logger

  alias Shuttle.Agents

  # Pi mints its session UUID after the process starts. Bound asynchronous
  # transcript reconciliation by elapsed time rather than scan count.
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
                  :backend_not_ready,
                  :uid_missing,
                  :wrapper_unresolved,
                  :work_dir_missing,
                  :tmux_server_unavailable,
                  :session_open_in_resume,
                  :transcript_held
                ] and is_binary(message)

  @doc """
  Dispatches a worker for the given fiber ID.

  Returns `{:ok, terminal_name}` on success, or an error tuple.

  Options:
    * `:runner` — module implementing `Shuttle.Runner` behavior for test injection.
      Defaults to `Shuttle.Runner.Default`.
    * `:work_dir` — working directory for the tmux session. Defaults to `Shuttle.FS.cwd!()`.
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
    * `:developer_instructions` — optional Codex developer text, combined with
      the agent record's instructions as a native CLI configuration override.
      On resume, an explicit value requests a native context override;
      absence preserves the thread's existing developer instructions.
    * `:threads` — `{entries, live}`: the poller's cached constitutions and its
      running workers' runtime keys, from which an orchestrator's launch prompt
      renders its `## Threads` roster (`Shuttle.Threads.roster/4`).
  """
  @spec dispatch(String.t(), keyword()) :: dispatch_result()
  def dispatch(fiber_id, opts \\ []) do
    runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)
    work_dir = Keyword.get(opts, :work_dir, Shuttle.FS.cwd!())
    prompt_context = Keyword.get(opts, :prompt_context, :constitution)
    felt_store = Keyword.get_lazy(opts, :felt_store, &default_felt_store/0)
    force = Keyword.get(opts, :force, false)

    with {:ok, fiber} <- fetch_fiber(fiber_id, runner, felt_store),
         :ok <- validate_restoration_request(opts, fiber, prompt_context, force),
         :ok <- check_dispatchable(fiber, force),
         {:ok, fiber} <- maybe_reopen_on_force(fiber_id, fiber, force, runner, felt_store),
         {:ok, uid} <- check_uid(fiber_id, fiber),
         :ok <- Shuttle.Terminal.require_config(),
         :ok <- check_not_running(fiber, runner),
         {:ok, agent} <- resolve_agent(fiber, fiber_id),
         :ok <- validate_agent(agent),
         :ok <- check_work_dir(work_dir),
         :ok <- preflight_terminal(agent, work_dir, runner) do
      resume_intent =
        if restoration?(opts, fiber, prompt_context, force) do
          {:previous, Shuttle.Continuation.resumable_session_id(fiber)}
        else
          resolve_resume_intent(prompt_context, fiber,
            force: force,
            resume_mode: Keyword.get(opts, :resume_mode)
          )
        end

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
            poller: Keyword.get(opts, :poller),
            identity_token: Keyword.get(opts, :identity_token),
            felt_store: felt_store,
            uid: uid,
            launch_evidence: Shuttle.Continuation.launch_evidence?(fiber),
            kind: Shuttle.Poller.fiber_kind(fiber),
            fiber_path: Map.get(fiber, "path"),
            fiber: Map.get(fiber, "id") || fiber_id,
            run_id: prompt_context_run_id(prompt_context),
            user_message: Keyword.get(opts, :user_message),
            developer_instructions: Keyword.get(opts, :developer_instructions),
            runner: runner,
            restoration: restoration?(opts, fiber, prompt_context, force),
            turn_phase: Keyword.get(opts, :turn_phase),
            previous_session: previous_session,
            threads: Keyword.get(opts, :threads),
            role: get_in(fiber, ["shuttle", "role"]),
            agent: agent.id,
            model: agent.model
          )
      end
    end
  end

  # A restoration flag authorizes only the same dirty continuation observed in
  # the freshly-read fiber. Manual dispatches and human continuation directives
  # keep their own resume semantics.
  defp restoration?(opts, fiber, prompt_context, force) do
    Keyword.get(opts, :restoration, false) and not force and
      is_nil(Keyword.get(opts, :resume_mode)) and autonomous_context?(prompt_context) and
      is_nil(Keyword.get(opts, :user_message)) and
      Shuttle.Continuation.restoration?(fiber)
  end

  defp autonomous_context?(:constitution), do: true
  defp autonomous_context?({:standing_run, _run_id}), do: true
  defp autonomous_context?(_), do: false

  defp validate_restoration_request(opts, fiber, prompt_context, force) do
    if Keyword.get(opts, :restoration, false) and
         not restoration?(opts, fiber, prompt_context, force) do
      dispatch_refused(
        :restoration_marker_stale,
        "the worker's durable continuation marker no longer authorizes restoration; poll again before dispatching"
      )
    else
      :ok
    end
  end

  # Hook state is reconstructed from the host's durable event stream at boot.
  # A positive working phase means the turn was in flight, including a process
  # that ended inside its turn when its terminal closed. Missing or closed
  # evidence reopens quietly, since waking a human's conversation is the costly
  # ambiguity.
  defp quiet_restoration?(session_id, opts) do
    phase =
      case Keyword.get(opts, :turn_phase) do
        fun when is_function(fun, 1) ->
          fun.(session_id)

        _ ->
          Shuttle.EventStream.catch_up_session_phase(session_id)
      end

    phase != "working"
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
  (`handed_off_at >= dispatched_at`), start fresh.
  Otherwise the session's transcript decides — see `continue_or_cold/4`.

  Options:
    * `:resume_mode` — as above.
    * `:transcript` — `fn session_id -> %{path, mtime} | nil end`, the
      transcript lookup (default `Shuttle.Continuation.transcript_stat/1`).
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

      "pulse" ->
        continuation(fiber, session_id, opts, :resume_always)

      "continue" ->
        continuation(fiber, session_id, opts, :resume_if_present)

      _ ->
        if Shuttle.Poller.fiber_kind(fiber) == "oneshot",
          do: continuation(fiber, session_id, opts, :resume_if_present),
          else: :fresh
    end
  end

  # The no-handoff rule; its transcript lookup runs only past the first three
  # clauses.
  defp continuation(fiber, session_id, opts, want) do
    cond do
      is_nil(session_id) -> :fresh
      Shuttle.Continuation.clean_handoff_since_dispatch?(fiber) -> :fresh
      want == :resume_always -> {:previous, session_id}
      true -> continue_or_cold(fiber, session_id, opts, want)
    end
  end

  # A session that ended without a handoff, judged by its transcript (one
  # resolve + one stat):
  #   - last written before this dispatch's `dispatched_at` → the id is not
  #     this dispatch's session (a Pi launch whose own id was never
  #     scraped leaves its predecessor's in the marker) → plain fresh;
  #   - present on this host → resume (unless the caller only wants fresh);
  #   - absent → fresh, naming the cut-off session.
  defp continue_or_cold(fiber, session_id, opts, want) do
    lookup = Keyword.get(opts, :transcript, &Shuttle.Continuation.transcript_stat/1)
    transcript = lookup.(session_id)

    cond do
      Shuttle.Continuation.predates_dispatch?(transcript, fiber) ->
        :fresh

      want == :resume_if_present and transcript != nil ->
        {:previous, session_id}

      true ->
        {:cold, session_id, transcript && transcript.path}
    end
  end

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
      "You are a Shuttle worker. Activate the felt and shuttle skills.\nFiber: #{fiber_id}",
      opts,
      fiber_id
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
      "You are a Shuttle worker. Activate the felt and shuttle skills.\nMode: resume\nFiber: #{fiber_id}",
      Keyword.delete(opts, :previous_session),
      fiber_id
    )
  end

  defp render_cut_off_turn_prompt(fiber_id, opts) do
    render_resume_prompt(fiber_id, opts) <>
      "\n\nYour terminal closed during your last turn, before that turn finished. " <>
      "Continue it from where it stopped."
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

    mode = if ad_hoc?, do: "ad-hoc", else: "scheduled"

    header =
      "You are a Shuttle worker. Activate the felt and shuttle skills.\nFiber: #{fiber_id}\nRun: #{run_id}\nRun mode: #{mode}"

    compose_prompt(header, opts, fiber_id)
  end

  # A launch message carries only what this dispatch knows and the skill
  # cannot: the fiber's store-relative id with the store it resolves in, the
  # headless mode and the previous session. Everything else (the exit contract,
  # standing runs' handoff) lives in the fiber or the shuttle skill.
  defp compose_prompt(header, opts, fiber_id) do
    felt_store = Keyword.get(opts, :felt_store, default_felt_store())

    [
      header,
      if(felt_store, do: "Felt store: #{felt_store}", else: ""),
      if(Keyword.get(opts, :headless) == true, do: "Headless: true", else: ""),
      render_previous_session_line(opts),
      Shuttle.Threads.prompt(fiber_id, Keyword.put(opts, :felt_store, felt_store))
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

    with {:ok, agent} <- resolve_agent_axes(agent_name, effort, chrome, runner),
         :ok <- validate_agent(agent),
         :ok <- check_work_dir(work_dir),
         :ok <- preflight_terminal(agent, work_dir, runner) do
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
      run_script =
        build_run_script(session, command, agent.id,
          display_fiber_id: "capture",
          terminal_session: session
        )

      Logger.info("Capture session via #{agent.id} → terminal #{session}")

      case Shuttle.Terminal.launch(runner, session, work_dir, run_script, preflighted: true) do
        :ok -> {:ok, %{session: session, session_uuid: session_uuid, agent_id: agent.id}}
        error -> error
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
    render_capture_entrypoint(yap, opts)
  end

  defp render_capture_entrypoint(yap, opts) do
    claim = %{
      fiber_id: "<fiber id>",
      agent: Keyword.get(opts, :agent_id, ""),
      tmux_session: Keyword.fetch!(opts, :session)
    }

    claim =
      Enum.reduce([:session_uuid, :meeting], claim, fn key, acc ->
        case Keyword.get(opts, key) do
          value when is_binary(value) and value != "" -> Map.put(acc, key, value)
          _ -> acc
        end
      end)

    install = %{
      kind: "oneshot",
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
  # Force-dispatch reopens a fiber that is not already clean. The reopen is a
  # fiber write, and every fiber write stamps a missing intrinsic id, so the
  # fiber is read again afterwards: a hand-written draft launched from the
  # board gains its id here and passes `check_uid/2`.
  defp maybe_reopen_on_force(_fiber_id, fiber, false, _runner, _felt_store), do: {:ok, fiber}

  defp maybe_reopen_on_force(fiber_id, fiber, true, runner, felt_store) do
    if already_clean?(fiber) do
      {:ok, fiber}
    else
      with :ok <- reopen(fiber_id, runner, felt_store, closed?(fiber)) do
        case fetch_fiber(fiber_id, runner, felt_store) do
          {:ok, reread} -> {:ok, reread}
          _ -> {:ok, fiber}
        end
      end
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

  @doc "The dispatch gate shared with the poller: uncertainty holds only a prior launch."
  def worker_present?(fiber, runner), do: check_worker(fiber, runner) != :ok

  def check_worker(fiber, runner) do
    case session_name(fiber["id"], fiber["uid"]) do
      nil ->
        :ok

      session ->
        Shuttle.Terminal.check_available(runner, session,
          launch_evidence: Shuttle.Continuation.launch_evidence?(fiber)
        )
    end
  end

  defp check_not_running(fiber, runner), do: check_worker(fiber, runner)

  defp resolve_agent(fiber, fiber_id) do
    # Shuttle resolves name + axes → the effective record and inlines it under
    # shuttle.resolved.agent (`shuttle show -j`). The daemon consumes that
    # finished record and renders it (Agents.build_command); it keeps no
    # registry and maps no other name (a model name, say) to an agent. Absent
    # resolved.agent ⇒ the block names an id the registry does not know, an
    # axis it refuses, or `shuttle` is not on PATH — fail the dispatch rather
    # than launch a broken worker, naming the check that says which.
    case get_in(fiber, ["shuttle", "resolved", "agent"]) do
      resolved when is_map(resolved) ->
        {:ok, Agents.from_resolved(resolved)}

      _ ->
        {:error,
         "agent #{inspect(get_in(fiber, ["shuttle", "agent"]))} did not resolve; " <>
           "`shuttle status #{fiber_id}` says why and `shuttle agents` lists the ids"}
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

  # The work directory is load-bearing twice over: `Terminal.launch` hands it to
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
    if Shuttle.FS.dir?(work_dir) do
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
  # session spawns and dies inside a second; `Terminal.launch` saw a successful `tmux
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

  # The terminal server must have the intended privacy root before it forks
  # workers. Keep this last so only otherwise-ready dispatches can start it.
  defp ensure_terminal_ready(runner) do
    case Shuttle.Terminal.primary().ensure_ready(runner) do
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

    case Shuttle.Terminal.status(runner, tmux) do
      :gone ->
        :ok

      :unknown ->
        # Preserve the process-scan diagnostic when it is the uncertain evidence.
        case Shuttle.WorkerProcess.check_free(runner, session_id) do
          {:error, {_, message}} -> dispatch_refused(:transcript_held, message)
          :ok -> resume_terminal_held(session_id, tmux)
        end

      :alive ->
        resume_terminal_held(session_id, tmux)
    end
  end

  defp resume_terminal_held(session_id, tmux) do
    dispatch_refused(
      :session_open_in_resume,
      "session #{session_id} is open in terminal #{tmux} (a resume from the card's History). " <>
        "Close that terminal, or attach to it, before this fiber's worker resumes the same session."
    )
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

  def preflight_terminal(%{cli: "codex", headless: true}, _work_dir, _runner),
    do:
      {:error,
       {:invalid_axes, "Codex workers require an interactive agent; headless is not supported."}}

  def preflight_terminal(agent, work_dir, runner) do
    with :ok <- preflight_wrapper(agent, work_dir, runner), do: ensure_terminal_ready(runner)
  end

  defp create_worker(fiber_id, agent, work_dir, runner, context, intent, opts),
    do: create_tmux_session(fiber_id, agent, work_dir, runner, context, intent, opts)

  defp create_tmux_session(fiber_id, agent, work_dir, runner, prompt_context, resume_intent, opts) do
    agent =
      if agent.cli == "codex" do
        instructions =
          [agent[:developer_instructions], opts[:developer_instructions]]
          |> Enum.reject(&(&1 in [nil, ""]))
          |> Enum.join("\n\n")

        Map.put(agent, :developer_instructions, instructions)
      else
        agent
      end

    resume_intent = effective_resume_intent(resume_intent, agent, opts)
    session = session_name(fiber_id, Keyword.get(opts, :uid))
    felt_store = Keyword.get(opts, :felt_store, default_felt_store())

    prompt_opts =
      opts
      |> Keyword.put(:work_dir, work_dir)
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

            quiet? = Keyword.get(opts, :restoration) and quiet_restoration?(session_id, opts)

            resume_prompt =
              cond do
                quiet? ->
                  ""

                Keyword.get(opts, :restoration) ->
                  render_cut_off_turn_prompt(fiber_id, prompt_opts)

                true ->
                  render_resume_prompt(fiber_id, prompt_opts)
              end

            resume_agent =
              if quiet? and agent.cli == "claude",
                do: Map.put(agent, :headless, false),
                else: agent

            resume_command = Agents.build_resume_command(resume_agent, session_id, resume_prompt)

            # Restoration always remains attached to the recorded conversation,
            # including when it was mid-turn. A failed resume stays visible as
            # a blocked worker instead of waking a new conversation.
            fallback_command =
              if Keyword.get(opts, :restoration) or agent.cli == "codex" do
                nil
              else
                fresh_fallback_command(
                  agent,
                  fiber_id,
                  session_id,
                  prompt_context,
                  Keyword.delete(prompt_opts, :previous_session)
                )
              end

            resumed_at = DateTime.utc_now()

            fallback_signal =
              if agent.cli == "pi" and not Keyword.get(opts, :restoration),
                do: private_fallback_signal(session, resumed_at, session_id),
                else: nil

            command =
              cond do
                is_nil(fallback_command) ->
                  resume_command

                fallback_signal ->
                  "#{resume_command} || { touch #{shell_single_quote(fallback_signal)}; #{fallback_command}; }"

                true ->
                  "#{resume_command} || #{fallback_command}"
              end

            # claude --resume shows an interactive "you're about to use a
            # previous session" warning that only an Enter keypress at the
            # TTY can dismiss. The heredoc-piped prompt arrives *after* the
            # warning, so we can't fold it in. Schedule a tmux send-keys to
            # fire a couple seconds in. Pi doesn't
            # show this warning — and a headless `-p` resume has no TTY warning
            # page and no human to attach, so both the dismiss send-keys and the
            # wait-for-client gate are skipped for it.
            headless = resume_agent[:headless] == true

            run_script =
              build_run_script(fiber_id, command, agent.id,
                dismiss_resume_warning: agent.cli == "claude" and not headless,
                session: session,
                headless: headless,
                fiber_path: Keyword.get(opts, :fiber_path),
                terminal_session: session
              )

            # Resume stamps a fresh dispatch boundary with the requested UUID.
            # A Pi fallback clears it and captures its new identity without
            # moving that boundary.
            result =
              spawn_and_record(
                session,
                work_dir,
                run_script,
                runner,
                opts,
                fn ->
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
                      ledger_kind: :resume,
                      dispatched_at: DateTime.to_iso8601(resumed_at)
                    )
                  )

                  if fallback_signal do
                    fallback_opts =
                      Keyword.merge(opts,
                        felt_store: felt_store,
                        tmux: session,
                        harness: Shuttle.SessionLedger.harness_for_cli(agent.cli),
                        uid: Keyword.get(opts, :uid),
                        fallback_signal: fallback_signal
                      )

                    monitor_resume_fallback(
                      fiber_id,
                      agent.cli,
                      work_dir,
                      resumed_at,
                      runner,
                      fallback_signal,
                      fallback_opts
                    )
                  end
                end
              )

            if fallback_signal != nil and match?({:error, _}, result),
              do: Shuttle.FS.rm_rf(Path.dirname(fallback_signal))

            result

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
            fiber_path: Keyword.get(opts, :fiber_path),
            terminal_session: session
          )

        # Store the session UUID in the dispatch marker so "Resume previous"
        # and the autonomous continuation heuristic can recover it.
        spawn_and_record(
          session,
          work_dir,
          run_script,
          runner,
          opts,
          fn ->
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
          end
        )
    end
  end

  # Spawn, and on a successful spawn only, record the dispatch. A spawn failure
  # propagates unchanged — nothing is stamped for a worker that never started.
  defp spawn_and_record(session, work_dir, run_script, runner, opts, record_fun) do
    launch_opts =
      opts
      |> Keyword.take([:fiber, :felt_store, :launch_evidence])
      |> Keyword.put(:preflighted, true)

    case Shuttle.Terminal.launch(runner, session, work_dir, run_script, launch_opts) do
      :ok ->
        Logger.info("Worker running: #{Shuttle.Terminal.primary().id()} #{session}")
        record_fun.()
        {:ok, session}

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
  # upfront (--session-id) so we can store it synchronously. Codex/Pi identity is
  # captured asynchronously after spawn.
  defp build_fresh_command(agent, fiber_id, prompt_context, opts) do
    prompt = render_context_prompt(fiber_id, prompt_context, opts)

    case agent.cli do
      "claude" ->
        uuid = generate_uuid4()
        command = Agents.build_command(agent, prompt, session_id: uuid)
        {command, {:claude, uuid}}

      cli when cli in ["pi", "codex"] ->
        command = Agents.build_command(agent, prompt)
        work_dir = Keyword.get(opts, :work_dir, Shuttle.FS.cwd!())
        {command, {:capture, cli, work_dir, DateTime.utc_now()}}

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
  # genuinely can't be known yet — Codex/Pi session identity, scraped from a
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
         {:capture, cli, work_dir, dispatched_after},
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
      deadline = System.monotonic_time(:millisecond) + capture_timeout_ms()

      capture_and_backfill(
        fiber_id,
        cli,
        work_dir,
        dispatched_after,
        runner,
        opts,
        deadline
      )
    end)
  end

  defp store_session_id(fiber_id, :none, runner, opts),
    do: record_dispatch_session(fiber_id, nil, runner, opts)

  defp private_fallback_signal(session, dispatched_at, predecessor) do
    path = fallback_signal_path(session, DateTime.to_iso8601(dispatched_at))
    Shuttle.FS.mkdir_p!(Path.dirname(path))
    Shuttle.FS.chmod!(Path.dirname(path), 0o700)
    Shuttle.FS.write!(Path.join(Path.dirname(path), "predecessor"), predecessor)
    path
  end

  defp fallback_signal_path(session, boundary) do
    key = :crypto.hash(:sha256, session <> "\n" <> boundary) |> Base.encode16(case: :lower)
    Path.join([Shuttle.data_dir(), "identity-fallbacks", key, "started"])
  end

  @doc false
  def pending_resume_fallback(session, boundary) when is_binary(boundary) do
    path = fallback_signal_path(session, boundary)
    dir = Path.dirname(path)

    if Shuttle.FS.exists?(Path.join(dir, "predecessor")) and
         not Shuttle.FS.exists?(Path.join(dir, "completed")),
       do: path
  end

  def pending_resume_fallback(_session, _boundary), do: nil

  @doc false
  def complete_resume_fallback(nil, _uuid), do: :ok

  def complete_resume_fallback(signal, uuid) do
    case Shuttle.FS.write(Path.join(Path.dirname(signal), "completed"), uuid) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("Could not complete fallback identity acquisition: #{inspect(reason)}")
    end
  end

  @doc false
  def monitor_resume_fallback(fiber_id, cli, work_dir, dispatched_at, runner, signal, opts) do
    Task.Supervisor.start_child(Shuttle.TaskSupervisor, fn ->
      if await_fallback(
           signal,
           Keyword.fetch!(opts, :tmux),
           runner,
           System.monotonic_time(:millisecond)
         ) do
        case Keyword.get(opts, :poller) do
          nil ->
            Shuttle.Continuation.backfill_session_uuid(
              runner,
              Keyword.fetch!(opts, :felt_store),
              fiber_id,
              ""
            )

          poller ->
            send(poller, {:fallback_started, fiber_id, Keyword.get(opts, :identity_token), opts})
        end

        deadline = System.monotonic_time(:millisecond) + capture_timeout_ms()

        capture_and_backfill(
          fiber_id,
          cli,
          work_dir,
          dispatched_at,
          runner,
          opts,
          deadline
        )
      end
    end)
  end

  defp await_fallback(path, session, runner, next_liveness_check) do
    now = System.monotonic_time(:millisecond)

    cond do
      Shuttle.FS.exists?(path) ->
        true

      now >= next_liveness_check ->
        if Shuttle.Terminal.present?(runner, session) do
          :timer.sleep(@session_capture_poll_ms)
          await_fallback(path, session, runner, now + 10_000)
        else
          false
        end

      true ->
        :timer.sleep(@session_capture_poll_ms)
        await_fallback(path, session, runner, next_liveness_check)
    end
  end

  defp capture_and_backfill(
         fiber_id,
         cli,
         work_dir,
         dispatched_after,
         runner,
         opts,
         deadline
       ) do
    case capture_session_uuid(cli, work_dir, fiber_id, dispatched_after, deadline) do
      {:ok, uuid} ->
        case Keyword.get(opts, :poller) do
          nil ->
            backfill_session_uuid(fiber_id, uuid, runner, opts)

          poller ->
            send(
              poller,
              {:captured_session, fiber_id, Keyword.get(opts, :identity_token), uuid, opts}
            )
        end

      {:error, reason} ->
        if poller = Keyword.get(opts, :poller) do
          send(
            poller,
            {:identity_capture_failed, fiber_id, Keyword.get(opts, :identity_token), reason}
          )
        end

        Logger.warning(
          "Could not capture session UUID for #{fiber_id} (#{cli}): #{reason}. " <>
            "Resume previous will be unavailable."
        )
    end
  end

  # Stamp `{session_uuid, dispatched_at, run_id}` into the fiber's
  # `shuttle.runtime` block by shelling `shuttle mark-runtime`. At the next
  # dispatch the worker's `handed_off_at` is compared against this
  # `dispatched_at` to decide fresh-vs-resume. `felt_store` + `fiber_id` are the
  # store/scoped-id pair the dispatch read the fiber with, so Shuttle resolves
  # it. A missing `:felt_store` skips the write — the fiber then reads as a
  # fresh dispatch, the safe default. `uuid` may be `nil` (Pi at launch,
  # or `:none` agents) — the
  # marker still gets a `dispatched_at` boundary, just no `session_uuid` yet.
  defp record_dispatch_session(fiber_id, uuid, runner, opts) do
    write_runtime_marker(fiber_id, uuid, opts, "dispatch marker", fn store ->
      Shuttle.Continuation.write_dispatch(runner, store, fiber_id, %{
        session_uuid: uuid,
        run_id: Keyword.get(opts, :run_id),
        dispatched_at: Keyword.get(opts, :dispatched_at)
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

            # `record/1` drops a nil uuid itself, so the Pi launch
            # (boundary stamped, UUID not yet scraped) contributes no line
            # here — its line comes from the backfill, once the pairing is
            # actually known.
            append_session_ledger(fiber_id, uuid, opts)

            if poller = Keyword.get(opts, :poller) do
              send(
                poller,
                {:dispatched_identity, fiber_id, Keyword.get(opts, :identity_token), uuid}
              )
            end

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
      # Preserve the intrinsic fiber identity across terminal renames.
      uid: Keyword.get(opts, :uid),
      session: uuid,
      tmux: Keyword.get(opts, :tmux),
      harness: Keyword.get(opts, :harness),
      kind: Keyword.get(opts, :ledger_kind, :dispatch),
      agent: Keyword.get(opts, :agent),
      model: Keyword.get(opts, :model),
      role: Keyword.get(opts, :role)
    )
  end

  # Backfill `session_uuid` into an ALREADY-STAMPED marker — the Codex/Pi
  # async capture path. Deliberately does not touch `dispatched_at`: it shells
  # `shuttle mark-runtime --session <uuid>` with no `--dispatched-at`
  # flag, and mark-runtime only writes fields whose flag is present, so the
  # boundary `record_dispatch_session/4` stamped synchronously at launch is
  # left exactly as it was.
  # (The ledger line the shared writer appends is the harness `dispatch` line:
  # that pairing becomes known here, not at launch.)
  defp backfill_session_uuid(fiber_id, uuid, runner, opts) do
    write_runtime_marker(fiber_id, uuid, opts, "session UUID backfill", fn store ->
      Shuttle.Continuation.backfill_session_uuid(runner, store, fiber_id, uuid)
    end)
  end

  # Poll the harness's session JSONL files until the elapsed-time deadline. A candidate
  # must match cwd, dispatch time and the fiber prompt, so concurrent workers
  # sharing a checkout cannot borrow one another's identity.
  @doc false
  def retry_session_capture(fiber_id, cli, work_dir, dispatched_after, runner, opts) do
    Task.Supervisor.start_child(Shuttle.TaskSupervisor, fn ->
      deadline = System.monotonic_time(:millisecond) + capture_timeout_ms()

      capture_and_backfill(
        fiber_id,
        cli,
        work_dir,
        dispatched_after,
        runner,
        opts,
        deadline
      )
    end)
  end

  defp capture_timeout_ms,
    do: Shuttle.Env.app(:session_capture_timeout_ms, @session_capture_timeout_ms)

  defp capture_session_uuid(cli, work_dir, fiber_id, dispatched_after, deadline) do
    if System.monotonic_time(:millisecond) >= deadline do
      {:error, "timed out waiting for session file"}
    else
      :timer.sleep(Shuttle.Env.app(:session_capture_poll_ms, @session_capture_poll_ms))

      case find_session_file(cli, work_dir, fiber_id, dispatched_after) do
        {:ok, path} ->
          read_uuid_from_jsonl(cli, path)

        {:error, _} ->
          capture_session_uuid(cli, work_dir, fiber_id, dispatched_after, deadline)
      end
    end
  end

  # Pi candidates are sorted newest first by their ISO-stamped basenames.
  # The first candidate that
  # matches cwd, recency AND content is this dispatch's session; a bare
  # newest-file pick would steal another worker's session whenever two workers
  # share a cwd.
  defp candidate_session_files("pi", work_dir, _dispatched_after) do
    dir = Shuttle.HarnessPaths.pi_sessions_dir(work_dir)

    case Shuttle.FS.ls(dir) do
      {:ok, files} -> files |> Enum.sort(:desc) |> Enum.map(&Path.join(dir, &1))
      {:error, _} -> []
    end
  end

  defp candidate_session_files("codex", _work_dir, dispatched_after) do
    Shuttle.HarnessPaths.codex_session_dirs(since: dispatched_after)
    |> Enum.flat_map(fn dir ->
      case Shuttle.FS.ls(dir) do
        {:ok, files} -> files |> Enum.sort(:desc) |> Enum.map(&Path.join(dir, &1))
        {:error, _} -> []
      end
    end)
  end

  defp candidate_session_files(_cli, _work_dir, _dispatched_after), do: []

  defp find_session_file(cli, work_dir, fiber_id, dispatched_after) do
    cli
    |> candidate_session_files(work_dir, dispatched_after)
    |> Enum.find(&session_matches?(cli, &1, work_dir, fiber_id, dispatched_after))
    |> case do
      nil -> {:error, :not_found}
      path -> {:ok, path}
    end
  end

  # Pi's first JSONL line carries its id, cwd and timestamp.
  defp session_header(cli, content) do
    with [first_line | _] <- String.split(content, "\n", parts: 2),
         {:ok, event} <- Jason.decode(first_line) do
      case {cli, event} do
        {"pi", %{"type" => "session"}} ->
          {:ok, event}

        {"codex", %{"type" => "session_meta", "payload" => payload}} ->
          {:ok, payload}

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
    with {:ok, content} <- Shuttle.FS.read(path),
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
    with {:ok, content} <- Shuttle.FS.read(path),
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
  # `session:` name, also schedules the backend's submit key to
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
    terminal = Keyword.get_lazy(opts, :terminal, &Shuttle.Terminal.primary/0)
    snippets = terminal.script(session)
    terminal_session = Keyword.get(opts, :terminal_session, session)

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

    # Dismiss the resume warning after startup, and let interactive workers
    # wait for a viewer before the harness draws its first screen.
    dismiss_block =
      if dismiss_resume_warning and session != "", do: snippets.submit_key, else: ""

    wait_for_client_block =
      if session != "" and not headless, do: snippets.wait_for_viewer, else: ""

    """
    #!/bin/bash
    set -e
    trap 'rm -f "$0"' EXIT

    export SHUTTLE_TERMINAL_SESSION=#{shell_single_quote(terminal_session)}
    #{snippets.env}#{erts_scrub_block(Keyword.get_lazy(opts, :release_root, &release_root/0))}#{snippets.passthrough}#{fiber_key_block}#{wait_for_client_block}
    echo ""
    echo "Shuttle worker — #{display_fiber_id} — agent=#{agent_id} — $(date '+%H:%M:%S')"

    #{dismiss_block}#{command}

    echo ""
    echo "Shuttle worker exited (agent=#{agent_id})"
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
  def passthrough_block do
    # Passthrough trusts pane output to send raw terminal controls to the outer terminal.
    ~S([ -n "${TMUX_PANE:-}" ] && tmux set-option -p -t "$TMUX_PANE" allow-passthrough on 2>/dev/null || true) <>
      "\n"
  end

  @doc false
  # The root of the release this daemon runs from, or nil under Mix (see
  # `erts_scrub_block/1`). A release carries no Mix, so its absence is the tell.
  def release_root do
    if Code.ensure_loaded?(Mix), do: nil, else: to_string(:code.root_dir())
  end
end
