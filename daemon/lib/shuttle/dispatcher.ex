defmodule Shuttle.Dispatcher do
  @moduledoc """
  Dispatches a single worker for a felt constitution fiber:
  - Locates the fiber via felt CLI
  - Checks status (refuses closed)
  - Checks for existing tmux session
  - Creates tmux session with dispatch prompt
  - Invokes the resolved agent wrapper
  """

  require Logger

  alias Shuttle.Agents

  # Codex and pi mint their own session UUIDs after the process starts. A cold
  # harness can spend tens of seconds loading before it writes the transcript
  # header (a live Codex dispatch on 2026-08-23 took 28 s), so an attempt count
  # is not a meaningful bound: each scan gets slower as the day directory
  # grows. Bound the asynchronous reconciliation by elapsed time instead.
  @session_capture_timeout_ms 120_000
  @session_capture_poll_ms 250

  @type dispatch_result ::
          {:ok, String.t()}
          | {:error, :not_found}
          | {:error, :closed}
          | {:error, :already_running}
          | {:error, :reopen_unavailable}
          | {:error, :reopen_failed}
          | {:error, :missing_session_id}
          | {:error, {:wrapper_unresolved, String.t()}}
          | {:error, {:work_dir_missing, String.t()}}
          | {:error, String.t()}

  @doc """
  Dispatches a worker for the given fiber ID.

  Returns `{:ok, tmux_session_name}` on success, or an error tuple.

  Options:
    * `:runner` — module implementing `Shuttle.Runner` behavior for test injection.
      Defaults to `Shuttle.Runner.Default`.
    * `:work_dir` — working directory for the tmux session. Defaults to `File.cwd!()`.
    * `:felt_store` — directory containing the `.felt/` index this dispatch
      should read fibers from. Defaults to `default_felt_store/0`.
      The Poller passes its configured `state.felt_store` here so each shuttle
      instance is consistent within itself; running multiple shuttle instances
      against different felt stores (e.g. one for `~/loom`, another for a
      standalone project root) is the supported way to span felt stores.
    * `:prompt_context` — `:constitution` (default) or `:standing_run`.
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
         uid = Map.get(fiber, "uid"),
         :ok <- check_not_closed(fiber, force),
         :ok <- maybe_reopen_on_force(fiber_id, fiber, force, runner, felt_store),
         :ok <- check_not_running(fiber_id, uid, runner),
         {:ok, agent} <- resolve_agent(fiber),
         :ok <- validate_agent(agent),
         :ok <- check_work_dir(work_dir),
         :ok <- preflight_wrapper(agent, work_dir, runner) do
      resume_intent =
        resolve_resume_intent(prompt_context, fiber,
          force: force,
          resume_mode: Keyword.get(opts, :resume_mode)
        )

      case resume_intent do
        {:error, _} = error ->
          error

        resume_intent ->
          create_tmux_session(fiber_id, agent, work_dir, runner, prompt_context, resume_intent,
            felt_store: felt_store,
            uid: uid,
            kind: fiber_kind(fiber),
            fiber_path: Map.get(fiber, "path"),
            run_id: prompt_context_run_id(prompt_context),
            user_message: Keyword.get(opts, :user_message),
            previous_session: previous_session_info(fiber, uid)
          )
      end
    end
  end

  @doc """
  Decides whether this dispatch should resume a prior worker session or start
  fresh, given the prompt context and the user's continuation directive.

  - Ad-hoc standing-role dispatches default to fresh. Resuming would land
    the worker in a transcript whose last assistant turn was "Run accepted.
    Exiting" — they'd idle ("nothing new on the fiber") instead of doing the
    new run. The kanban modal's manual "Resume" button overrides this by
    passing `force: true`, which routes back through `check_resume_intent`
    so the carried `resume_mode` is honored.
  - All other contexts defer to `check_resume_intent/2`, which honors the
    `resume_mode` dispatch parameter (`"previous"` / `"fresh"`), falling back
    to the continuation heuristic (read off the fiber's `shuttle:` block) when no
    directive is carried.

  Options:
    * `:force` — when true, the ad-hoc short-circuit is skipped and the carried
      `resume_mode` wins. Set by manual kanban dispatches.
    * `:resume_mode` — the user's continuation directive (`"previous"` /
      `"fresh"` / absent), carried with the dispatch call.
  """
  @spec resolve_resume_intent(any(), map(), keyword()) ::
          :fresh | {:previous, String.t()} | {:error, :missing_session_id}
  def resolve_resume_intent(prompt_context, fiber, opts \\ []) do
    force? = Keyword.get(opts, :force, false)

    case prompt_context do
      {:standing_run, _, :ad_hoc} when not force? ->
        :fresh

      _ ->
        check_resume_intent(fiber, resume_mode: Keyword.get(opts, :resume_mode))
    end
  end

  @doc """
  Resolves the continuation intent from the carried `resume_mode` directive and,
  when absent, the per-host markers.

  Returns one of:
  - `:fresh` — no resume requested, or a fresh run was explicitly requested.
  - `{:previous, session_id}` — resume requested and the dispatch marker holds a
    session UUID. The dispatcher invokes the harness-appropriate resume command.
  - `{:error, :missing_session_id}` — `resume_mode == "previous"` but the
    dispatch marker has no usable session id. The caller surfaces this instead
    of silently starting fresh; "New session" is the explicit fresh path.

  `resume_mode` is the user's directive (a transient dispatch parameter, no
  longer a persisted felt event). The session id comes ONLY from the fiber's
  `shuttle.session_uuid` (`Shuttle.Continuation`) — the worker never knew its own
  UUID, the daemon stamped it at dispatch.

  Options:
    * `:resume_mode` — `"previous"` / `"fresh"` / absent.
  """
  @spec check_resume_intent(map(), keyword()) ::
          :fresh | {:previous, String.t()} | {:error, :missing_session_id}
  def check_resume_intent(fiber, opts \\ []) do
    resume_mode = Keyword.get(opts, :resume_mode)
    session_id = Shuttle.Continuation.resumable_session_id(fiber)

    cond do
      # A human explicitly asked to resume (kanban Resume button passes
      # resume_mode:previous). Honor it, or surface the missing-id error.
      resume_mode == "previous" ->
        if is_binary(session_id) and session_id != "",
          do: {:previous, session_id},
          else: {:error, :missing_session_id}

      # A human explicitly asked for a new session ("New session" / "Requeue
      # fresh" passes resume_mode:fresh). This directive is UNCONDITIONAL — it
      # wins over the autonomous dirty-death heuristic below. Without it, a
      # oneshot whose prior worker died WITHOUT a clean handoff (routine on
      # remote machines, where SSH drops and kills cut workers off mid-thought)
      # falls through to decide_continuation and gets resumed — so "New session"
      # silently reopened the dead transcript. "New session" means new, always.
      resume_mode == "fresh" ->
        :fresh

      # No directive (resume_mode absent): decide fresh-vs-resume by whether the
      # previous worker handed off cleanly. The autonomous-loop path.
      true ->
        decide_continuation(fiber, session_id)
    end
  end

  # The autonomous fresh-vs-resume decision when there is no human resume
  # directive. A long-running oneshot loops across sessions: a worker exits, the
  # next poll re-dispatches and continues. The question is whether the previous
  # session ended CLEANLY (it stamped `shuttle.handed_off_at` via `felt shuttle
  # handoff` as its last act — then the next worker starts fresh and reads the
  # `## Status` block) or DIED mid-thought (no handoff — the process was killed,
  # common on remote machines — then the fresh worker loses the in-flight
  # reasoning and loops). On a dirty death we resume the prior transcript instead;
  # the `resume || fresh-same-id` self-heal makes resume safe even if the
  # transcript is gone.
  #
  # The whole decision is now read straight off the fiber's `shuttle:` block
  # (`Shuttle.Continuation`, no file IO — `felt show -j` already carried it):
  # `handed_off_at` present AND `>= dispatched_at` → fresh, else resume
  # `session_uuid`. Store-agnostic — no work_dir/aggregate federation, no
  # `SQLITE_BUSY` append-drop that could make a clean exit look dirty.
  #
  # Scoped to oneshots: pinned and standing roles always start fresh. A pinned
  # role only autonomously redispatches after a CLEAN handoff (the worker asked
  # for a fresh session; a dirty death parks it instead), and standing roles
  # dispatch discrete scheduled occurrences — both fresh. First run / no prior
  # session → fresh (nothing to resume).
  defp decide_continuation(fiber, session_id) do
    cond do
      fiber_kind(fiber) != "oneshot" -> :fresh
      not (is_binary(session_id) and session_id != "") -> :fresh
      Shuttle.Continuation.clean_handoff_since_dispatch?(fiber) -> :fresh
      true -> {:previous, session_id}
    end
  end

  @doc """
  Returns shuttle's default felt store.

  Mirrors `Shuttle.FeltStores.configured_hosts/0` and keeps `Dispatcher`
  working standalone (e.g. via the CLI) without a running Poller.
  """
  @spec default_felt_store() :: String.t() | nil
  def default_felt_store do
    Shuttle.FeltStores.configured_hosts() |> List.first()
  end

  @doc """
  Renders the universal dispatch prompt for a fiber ID.

  The prompt opens with a single orientation paragraph — what Shuttle is,
  what the worker is here to do, and how the practice gets loaded — then
  inlines exactly one context block:

    - **From User** — the user's message for this dispatch, if any.
      Carried as a transient dispatch parameter (`:user_message`),
      inlined here and discarded — never persisted.

  We deliberately *don't* inline the fiber's outcome or the last
  handoff prose. Both are already in scope after the worker calls
  `felt show <fiber-id>` (which renders outcome and the body, including
  the `## Status` handoff block the previous session rewrote). The
  shuttle skill prescribes that read order; duplicating either here just
  bloats the prompt and risks drift between the inlined snapshot and
  felt's own view.

  Why keep the From User block inlined? The user's directive arrives
  *with* the dispatch — it isn't in the constitution the worker reads on
  arrival, and having it sit at the top of the prompt where causal
  attention sees it first conditions the worker's reading of everything
  that follows.

  The exit contract appears directly in the prompt, even though the full
  practice lives in the `shuttle` skill. Resumed sessions otherwise arrive
  with a lighter prompt and can mistake Shuttle work for ordinary chat
  completion; keeping the handoff ritual in the causal foreground preserves
  the dispatcher contract across fresh and resumed runs.

  ## Options

    * `:felt_store` — directory containing the `.felt/` index to query.
      Defaults to `default_felt_store/0`. The Poller threads its
      configured `state.felt_store` here so each shuttle instance reads
      from the felt store it's responsible for.
  """
  @spec render_prompt(String.t(), keyword()) :: String.t()
  def render_prompt(fiber_id, opts \\ []) do
    prompt_fiber_id = Keyword.get(opts, :prompt_fiber_id, fiber_id)

    header = """
    The orchestration system Shuttle dispatched you on this fiber. The constitution describes what "done" looks like; drive toward it across one or more sessions. The `shuttle` and `felt` skills carry the practice — activate them next.

    Fiber: #{prompt_fiber_id}
    """

    compose_prompt(header, opts)
  end

  # Renders the lineage line for fresh dispatch prompts: the previous worker's
  # session UUID (and harness, when the ledger knows it). Returns "" when the
  # fiber has no prior session on this host.
  #
  # Why it's in the prompt at all: the `## Status` handoff is the previous
  # worker's *summary*; the transcript is the previous worker's *actual last
  # turns* — searches run, dead ends hit, thinking left mid-flight. The UUID
  # names that transcript on disk, and the shuttle skill's transcript recipes
  # turn it into surgical reads. Resume prompts never carry it (a resumed
  # worker IS the previous session), and a fiber's first dispatch has none.
  defp render_previous_session_line(opts) do
    case Keyword.get(opts, :previous_session) do
      %{uuid: uuid} = prev when is_binary(uuid) and uuid != "" ->
        harness =
          case Map.get(prev, :harness) do
            h when is_binary(h) and h != "" -> " (#{h})"
            _ -> ""
          end

        "Previous session: #{uuid}#{harness}\n"

      _ ->
        ""
    end
  end

  @doc """
  Renders the prompt injected into a *resumed* worker session.

  Mirrors the fresh dispatch prompt's From User block and exit contract so
  the resumed worker sees the same intent and termination signals at the
  top of context. The framing paragraph is shorter — skills, conventions,
  and the constitution are already in the resumed transcript, so repeating
  them is noise.

  When no `:user_message` is carried on the dispatch, the From User block
  is suppressed and the worker just gets the framing sentence.
  """
  @spec render_resume_prompt(String.t(), keyword()) :: String.t()
  def render_resume_prompt(fiber_id, opts \\ []) do
    prompt_fiber_id = Keyword.get(opts, :prompt_fiber_id, fiber_id)

    header = """
    Shuttle resumed your previous session on this fiber. Skills and conventions are already loaded in your transcript from the original dispatch; pick up from the last clean checkpoint, or address the message below if one's there.

    Fiber: #{prompt_fiber_id}
    """

    # A resumed worker IS the previous session — no lineage pointer to itself.
    compose_prompt(header, Keyword.delete(opts, :previous_session))
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
          trimmed -> render_block("From User", trimmed)
        end

      _ ->
        ""
    end
  end

  # Render a labeled rule-bordered block. Header is "┌─ <label> ─…",
  # content is indented two spaces, closed with a matching bottom rule.
  # Total visual width is fixed at @rule_width chars so blocks align in the
  # terminal even when their headers differ in length.
  @rule_width 76
  defp render_block(label, content) do
    # "┌─ " (3) + label + " " (1) + trailing dashes = @rule_width
    leading = "┌─ #{label} "
    trailing = max(@rule_width - String.length(leading), 3)
    top = leading <> String.duplicate("─", trailing)
    bottom = "└" <> String.duplicate("─", @rule_width - 1)

    # Inset the content under the box header so multi-line directives stay
    # visually grouped.
    body =
      content
      |> String.trim()
      |> String.split("\n")
      |> Enum.map(&("  " <> &1))
      |> Enum.join("\n")

    "#{top}\n#{body}\n#{bottom}"
  end

  @doc """
  Renders a standing-role run prompt for one scheduled occurrence.

  Mirrors the fresh dispatch prompt's shape (orientation paragraph +
  optional From User block). Standing roles are recurring fibers — this
  framing makes the run feel like one due occurrence of a durable
  responsibility rather than a new constitution. The awaiting-review
  handoff specifics (frontmatter shape on exit) live in the shuttle
  skill's "Standing Roles" section, not the prompt — keeping the prompt
  oriented and the practice in one place.
  """
  @spec render_standing_run_prompt(String.t(), String.t(), keyword()) :: String.t()
  def render_standing_run_prompt(fiber_id, run_id, opts \\ []) do
    ad_hoc? = Keyword.get(opts, :ad_hoc, false)
    prompt_fiber_id = Keyword.get(opts, :prompt_fiber_id, fiber_id)

    orientation =
      if ad_hoc? do
        "The orchestration system Shuttle dispatched you for an ad-hoc run of this standing role — right-now work that does not consume or advance the scheduled occurrence. Standing roles are recurring responsibilities; write the run's work product into `outcome` and exit per the contract below (the daemon owns the awaiting transition). The `shuttle` and `felt` skills carry the practice — activate them next."
      else
        "The orchestration system Shuttle dispatched you for a scheduled run of this standing role. Standing roles are recurring responsibilities — this dispatch is one due occurrence, not a new fiber. Write the run's work product into `outcome` and exit per the contract below. The `shuttle` and `felt` skills carry the practice — activate them next; the skill's standing-roles reference covers the run lifecycle."
      end

    header = """
    #{orientation}
    Fiber: #{prompt_fiber_id}
    Run:   #{run_id}
    """

    # A standing run is definitionally standing — declare it here so the exit
    # contract is right regardless of how the caller threaded opts. The handoff
    # marker is inert for standing (runs always dispatch fresh); the daemon
    # owns the awaiting transition on worker exit.
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
  # globbed path. On any felt miss/error fall back to the global `fiber_id`,
  # preserving the previous safe-fail. The worker's view is `work_dir`, not the
  # configured store root, so no felt_store is needed here.
  # Runs through the injected `runner` — this sits on the Poller's dispatch
  # path (via `create_tmux_session/7`), so a bare System.cmd here was the one
  # unbounded felt call left in it: a wedged felt would block the Poller
  # GenServer. Bounded, a timeout degrades to the global-id fallback.
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

  # Shared composition for all top-level prompts: a per-prompt orientation
  # header, the mandatory exit contract, and optional context blocks. The
  # shape is documented in AGENTS.md under "Dispatch prompt structure".
  # Outcome and last-session are deliberately not inlined — the shuttle
  # skill prescribes that the worker reads them via `felt show` (outcome +
  # the body's `## Status` block) on arrival, and duplicating either here risks
  # drift between the prompt's snapshot and felt's view.
  defp compose_prompt(header, opts) do
    felt_store = Keyword.get(opts, :felt_store, default_felt_store())

    # The store line is the worker's absolute anchor. `prompt_fiber_id`
    # translates the global id to the work_dir-local view when it can, but
    # its safe-fail hands the worker a *global* id that doesn't resolve from
    # cwd either — historically the worker then groped for the fiber. With
    # the store named, the fallback read is mechanical:
    # `felt -C <felt-store> show <id>`. (When local resolution succeeded,
    # plain `felt show <id>` from the project dir works and the line is
    # simply unused.)
    header =
      case felt_store do
        store when is_binary(store) and store != "" ->
          String.trim(header) <> "\nFelt store: #{store}"

        _ ->
          String.trim(header)
      end

    # Lineage sits UNDER the store line: the fiber and the store are what a
    # worker needs to read its constitution, and the previous session is a
    # pointer it only follows once oriented.
    header =
      case render_previous_session_line(opts) do
        "" -> header
        line -> header <> "\n" <> String.trim_trailing(line)
      end

    # Order: header, exit contract, user message block. The exit contract is
    # always present; the From User block carries the per-dispatch intent
    # (including any "talk to me first" signal) and renders only when a
    # `:user_message` was carried on the dispatch.
    [
      header,
      render_exit_contract(Keyword.get(opts, :kind, "oneshot")),
      render_headless_notice(Keyword.get(opts, :headless, false)),
      render_user_message_block(opts)
    ]
    |> Enum.reject(&(&1 == ""))
    |> Enum.join("\n\n")
    |> String.trim()
  end

  # Print-mode (`claude -p`) workers run unattended: stdout is not a TTY, no
  # human can attach, and the exit contract's human-gate exception therefore
  # cannot apply. Surfacing that in the prompt — right after the exit contract,
  # where causal attention meets the termination semantics — stops a headless
  # worker from parking itself at a "wait for the human" checkpoint that will
  # never be answered.
  defp render_headless_notice(true) do
    render_block(
      "Headless",
      "Headless print-mode run: no human can attach to this session — work to completion and exit. The human-gate exception never applies here; if you hit something you would normally pause to ask about, record it in the outcome and `## Status`, keep driving to a clean checkpoint, then exit."
    )
  end

  defp render_headless_notice(_), do: ""

  # Pinned roles carry a three-case exit contract. A pinned role is a standing
  # interface a human drives — a status hub, a debug intake, a long-lived
  # workbench — that rests parked on the strip and is started by hand. Its exit
  # semantics depend on what the worker is doing:
  #
  #  (a) while a human is actively driving, the session IS the interface — run
  #      out of immediate work and STAY ALIVE at idle, waiting for the next
  #      message, never `kill $PPID`.
  #  (b) for a long AUTONOMOUS arc, write `## Status` and run `felt shuttle
  #      handoff` — the daemon reads the fresh handoff marker and relaunches a
  #      fresh worker next tick, so the arc continues across clean sessions.
  #  (c) when the arc is genuinely DONE, set `status: closed` first, then hand
  #      off — it lands in Awaiting review and returns to the pinned strip when
  #      the human accepts.
  #
  # The load-bearing distinction (b vs. a dirty death): only a clean `felt
  # shuttle handoff` stamps a fresh marker, and only that relaunches. An idle
  # exit without handoff, a crash, or a human kill leaves no fresh marker → the
  # role parks back to the strip and waits for a human Resume. So the default
  # when there's nothing left to drive and no autonomous arc in flight is (a):
  # stay alive.
  defp render_exit_contract("pinned") do
    render_block(
      "Exit Contract",
      "This is a pinned interactive role — a standing interface a human drives, not a one-shot task. (a) While a human is driving and you run out of immediate work, DO NOT exit — stay alive and wait for the next message; the session is the interface. (b) On a long AUTONOMOUS arc, rewrite the constitution's `## Status` then run `felt shuttle handoff <fiber-id>` — only a clean handoff makes the daemon relaunch a fresh worker; an idle exit or crash parks the role back to the strip. (c) When the arc is genuinely done, set `status: closed` FIRST, then hand off — it lands in Awaiting review. Default when idle: (a) stay alive. The shuttle skill's exit semantics carry the rest."
    )
  end

  # Oneshots and standing roles share one exit ritual: rewrite `## Status`,
  # then `felt shuttle handoff` (stamps the clean-exit marker and ends the
  # session). For standing roles the marker is inert — scheduled runs always
  # dispatch fresh (decide_continuation is scoped to oneshots) and the daemon
  # marks the run awaiting on exit — but one uniform contract beats a variant
  # whose only difference is which kill command ends the session.
  defp render_exit_contract(_kind) do
    render_block(
      "Exit Contract",
      "This is an autonomous Shuttle worker — a normal chat final response is not a worker exit. At a clean checkpoint, after updating the fiber (outcome, findings, commits), rewrite the constitution's `## Status` in prose — the handoff the next session lands on, rewritten, never a session log — then your FINAL action is `felt shuttle handoff <fiber-id>`: it marks the session complete and closes it. That mark is what tells the daemon you finished at a checkpoint, so the next worker starts fresh from your `## Status` instead of resuming this transcript mid-thought. Exception: if the directive or constitution asks you to wait for a human, or the state of the work makes human input the clear next move (taste calls open, feedback mid-loop), stay alive at that checkpoint instead — do not hand off. The shuttle skill's exit semantics carry the rest."
    )
  end

  # ── Capture (spawn-without-constitution) ──

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
    * `:agent` — agent registry name (default `"claude-sonnet"`, the bare
      fallback; fable is disabled and is never a default)
    * `:effort` — reasoning-effort token, validated against the agent's
      `effort_levels` (same contract as `shuttle.effort` on a fiber)
    * `:chrome` — boolean; claude harness only (same as `shuttle.chrome`)
    * `:port` — daemon HTTP port for the claim callback
    * `:host` — owning host id to stamp into the shuttle block (optional)

  Returns `{:ok, %{session:, session_uuid:, agent_id:}}` or `{:error, reason}`.
  """
  @spec capture(String.t(), keyword()) :: {:ok, map()} | {:error, term()}
  def capture(yap, opts \\ []) when is_binary(yap) do
    runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)
    work_dir = Keyword.fetch!(opts, :work_dir)
    felt_store = Keyword.get(opts, :felt_store, default_felt_store())
    agent_name = Keyword.get(opts, :agent) || "claude-sonnet"
    effort = Keyword.get(opts, :effort)
    chrome = Keyword.get(opts, :chrome) == true
    port = Keyword.get(opts, :port, 4000)
    host = Keyword.get(opts, :host)

    with {:ok, agent} <- capture_resolve_axes(agent_name, effort, chrome, runner),
         :ok <- validate_agent(agent),
         :ok <- check_work_dir(work_dir),
         :ok <- preflight_wrapper(agent, work_dir, runner) do
      session = capture_session_name()

      # Only claude can be handed a session id up front; `build_command/3` and
      # `render_capture_prompt/2` both treat a nil `session_id`/`session_uuid`
      # as absent, so the other harnesses need no separate path.
      session_uuid = if agent.cli == "claude", do: generate_uuid4()

      prompt =
        render_capture_prompt(yap,
          session: session,
          felt_store: felt_store,
          port: port,
          session_uuid: session_uuid,
          agent_id: agent.id,
          project_dir: work_dir,
          host: host,
          effort: effort,
          chrome: chrome
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

  # Capture/Stash resolves an agent name + axes with no fiber on disk, so it
  # shells felt — the registry owner — rather than re-resolving locally:
  #   felt shuttle agents resolve <name> [--effort <E>] [--chrome] --json
  # emits the same shape felt inlines as `shuttle.resolved.agent`. The daemon
  # turns it into a command record via from_resolved/1. felt exits non-zero with
  # a descriptive stderr message on an unknown agent / dangling alias /
  # unsupported axis; that becomes `{:error, {:invalid_axes, msg}}` so the HTTP
  # layer can answer 422 (client error) without string-sniffing — other capture
  # failures (tmux spawn, missing model config) stay 500-shaped. Routed through
  # the injected `runner` so tests need no live `felt shuttle agents` verb.
  defp capture_resolve_axes(agent_name, effort, chrome, runner) do
    args =
      ["shuttle", "agents", "resolve", agent_name] ++
        if(is_binary(effort) and effort != "", do: ["--effort", effort], else: []) ++
        if(chrome, do: ["--chrome"], else: []) ++
        ["--json"]

    # `stderr_to_stdout: true`: on success felt writes only the resolved JSON to
    # stdout (nothing to stderr), so `output` is clean JSON; on a non-zero exit
    # stdout is empty and stderr carries felt's descriptive diagnostic, so
    # `output` is the constraint message. Folding gives the right bytes either way.
    case runner.cmd("felt", args, stderr_to_stdout: true) do
      {output, 0} ->
        {:ok, Agents.from_resolved(Jason.decode!(output))}

      # A runner timeout is a wedged node, not a bad request — it must stay
      # 500-shaped (see moduledoc: only axes-validation failures answer 422).
      {output, :timeout} ->
        {:error, "felt shuttle agents resolve timed out: #{String.trim(output)}"}

      {output, _status} ->
        {:error, {:invalid_axes, String.trim(output)}}
    end
  rescue
    # ErlangError: the spawn itself failed — most pointedly `felt` not on PATH
    # (`:enoent`). Jason.DecodeError: felt exited 0 but emitted non-JSON (a
    # contract violation). Either surfaces loudly as a 500 rather than crashing.
    e in [ErlangError, Jason.DecodeError] ->
      {:error, "felt shuttle agents resolve failed: #{Exception.message(e)}"}
  end

  @doc false
  # Public for tests. The prompt a capture session wakes to: the yap verbatim,
  # then the crystallize → install → claim → realize instructions.
  def render_capture_prompt(yap, opts) do
    session = Keyword.fetch!(opts, :session)
    felt_store = Keyword.fetch!(opts, :felt_store)
    port = Keyword.get(opts, :port, 4000)
    session_uuid = Keyword.get(opts, :session_uuid)
    agent_id = Keyword.get(opts, :agent_id, "")
    project_dir = Keyword.get(opts, :project_dir, "")
    host = Keyword.get(opts, :host)

    uuid_field =
      if session_uuid, do: ~s(, "session_uuid": "#{session_uuid}"), else: ""

    host_line =
      if is_binary(host) and host != "",
        do: "Set `host: #{host}` in the shuttle block.\n",
        else: ""

    # Explicitly-requested axes ride into the crystallized fiber's shuttle
    # block so redispatches reproduce the launch shape. Defaults stay
    # implicit — the block records intent, not resolved configuration.
    effort = Keyword.get(opts, :effort)

    axes_yaml =
      [
        if(is_binary(effort) and effort != "", do: ", `effort: #{effort}`"),
        if(Keyword.get(opts, :chrome) == true, do: ", `chrome: true`")
      ]
      |> Enum.reject(&is_nil/1)
      |> Enum.join()

    header = """
    Shuttle capture session. The user had an idea and spoke it into the board's capture box; you are the session it spawned. Your job: crystallize the idea into a fiber, claim this session as its worker, then realize it. The `felt` and `shuttle` skills carry the practice — activate them first.

    Felt store: #{felt_store}
    Project dir: #{project_dir}

    Steps, in order (the order is load-bearing — claim BEFORE activating, or the poll loop dispatches a duplicate worker in the gap):
    1. **Crystallize.** Read the idea below and file it as a fiber in the felt store, nested under the right parent (felt-skill judgment — search for kin first). Write the lede and a `## Desired State` the idea has earned; don't over-spec a sketch.
    2. **Install the shuttle block.** Add to the fiber's frontmatter: `shuttle:` with `kind: oneshot`, `agent: #{agent_id}`#{axes_yaml}, `project_dir: #{project_dir}`. #{host_line}Leave felt `status` as `open` for now.
    3. **Claim this session** (registers you with the daemon as the fiber's worker — exit handling, liveness, and the kanban all flow from this):

       curl -s -X POST http://localhost:#{port}/api/v1/claim -H 'Content-Type: application/json' -d '{"fiber_id": "<the fiber id you created>", "tmux_session": "#{session}"#{uuid_field}, "agent": "#{agent_id}"}'

       A successful claim renames this tmux session to the fiber's canonical worker name — that is expected. The claim is idempotent: if the response is lost, retry with the same body.
    4. **Activate.** Now set felt `status: active`. (Doing this before the claim would make the fiber dispatch-eligible while the daemon cannot yet see this session — a duplicate worker would spawn.)
    5. **Realize.** From here you are an ordinary Shuttle worker on that fiber: drive toward the Desired State, keep the outcome current, and exit per the contract below.
    """

    [
      String.trim(header),
      render_exit_contract("oneshot"),
      render_block("From User", String.trim(yap))
    ]
    |> Enum.join("\n\n")
    |> String.trim()
  end

  # `capture-<hex>` — distinguishable, collision-free enough, and crucially
  # not `-shuttle`-suffixed (see `capture/2`).
  defp capture_session_name do
    suffix = :crypto.strong_rand_bytes(4) |> Base.encode16(case: :lower)
    "capture-" <> suffix
  end

  @doc """
  Canonical tmux session name for a fiber, keyed by its uid.

  The form is `<leaf>-<uid>-shuttle`: the human-readable leaf keeps tmux/kitty
  titles legible from the left edge when truncated, and the uid (the fiber's
  intrinsic ULID) makes the name collision-free and rename-safe — two fibers
  sharing a leaf no longer collide, and renaming a fiber leaves the running
  worker's session addressable by the uid that does not change.

  When `uid` is `nil` or empty (legacy/test callers without a resolved uid),
  falls back to the leaf-only `<leaf>-shuttle` form.
  """
  @spec session_name(String.t(), String.t() | nil) :: String.t()
  def session_name(fiber_id, uid) when is_binary(uid) and uid != "" do
    fiber_leaf(fiber_id) <> "-" <> uid <> "-shuttle"
  end

  def session_name(fiber_id, _uid), do: session_name(fiber_id)

  @doc """
  Legacy leaf-only tmux session name (`<leaf>-shuttle`).

  Retained for **dual-recognition** during the uid-keyed cutover: live workers
  launched under the old scheme carry this name, and matching/adoption paths
  that lack a uid still recognize them. New sessions are launched under
  `session_name/2`.
  """
  @spec session_name(String.t()) :: String.t()
  def session_name(fiber_id) do
    fiber_leaf(fiber_id) <> "-shuttle"
  end

  @doc """
  Both tmux session-name forms for a fiber — the uid-keyed canonical name and
  the legacy leaf-only name — so recognition/adoption matches a live worker
  regardless of which scheme launched it. Returns `[new, legacy]` when a uid is
  available, or just `[legacy]` when it is not.
  """
  @spec session_names(String.t(), String.t() | nil) :: [String.t()]
  def session_names(fiber_id, uid) when is_binary(uid) and uid != "" do
    [session_name(fiber_id, uid), session_name(fiber_id)]
  end

  def session_names(fiber_id, _uid), do: [session_name(fiber_id)]

  @doc """
  Returns true when a tmux session name belongs to a Shuttle worker.

  Both name forms — `<leaf>-<uid>-shuttle` and the legacy `<leaf>-shuttle` —
  end in `-shuttle`, so the suffix test recognizes either.
  """
  @spec shuttle_session?(String.t()) :: boolean()
  def shuttle_session?(session_name) do
    String.ends_with?(session_name, "-shuttle")
  end

  # ── Internal ──

  defp fiber_leaf(fiber_id) do
    case String.trim_trailing(fiber_id, "/") do
      "" -> ""
      trimmed -> trimmed |> String.split("/") |> List.last()
    end
  end

  # First tries the runner's default cwd (so tests / one-off CLI invocations
  # in a project's working directory still resolve the fiber against that
  # project's `.felt/`). Falls back to the configured `felt_store` so the
  # daemon path always lands in the right index regardless of where the BEAM
  # process happens to be running. The default `felt_store` is
  # `default_felt_store/0` (~/loom) — pass `:felt_store` explicitly to point at
  # a different root.
  defp fetch_fiber(fiber_id, runner, felt_store) do
    case run_felt(runner, ["show", fiber_id, "--json"]) do
      {:ok, output} ->
        decode_fiber(output)

      # Retry inside the resolved store — but only when there IS one. With an
      # empty registry `felt_store` is nil, and `System.cmd(cd: nil)` would raise.
      {:error, _} when is_binary(felt_store) ->
        case run_felt(runner, ["show", fiber_id, "--json"], cd: felt_store) do
          {:ok, output} -> decode_fiber(output)
          {:error, _} -> {:error, :not_found}
        end

      {:error, _} ->
        {:error, :not_found}
    end
  end

  defp decode_fiber(output) do
    case Jason.decode(output) do
      {:ok, fiber} -> {:ok, fiber}
      {:error, _} -> {:error, "invalid fiber JSON"}
    end
  end

  # Reject closed fibers by default. Manual force-dispatch (the "New session"
  # / "Resume" buttons) explicitly opts in to dispatching against closed
  # fibers; `maybe_reopen_on_force/5` then reopens the YAML so the kanban
  # view actually reclassifies the card.
  defp check_not_closed(_fiber, true), do: :ok

  defp check_not_closed(fiber, _force) do
    status = Map.get(fiber, "status", "")

    if status == "closed" do
      {:error, :closed}
    else
      :ok
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
  # a missing felt store (`{:error, :reopen_unavailable}`) or a non-zero
  # `felt shuttle reopen` (`{:error, :reopen_failed}`) ABORTS the dispatch and
  # propagates through the `with` chain to the caller. (This reverses the prior
  # deliberate "reopen is non-fatal" choice for the closed case.)
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
  # failure aborts the dispatch (`:reopen_unavailable` / `:reopen_failed`).
  # Otherwise the worker has a live mandate regardless, so a failure only risks
  # a sticky kanban column and we log loudly and continue.
  defp reopen(fiber_id, _runner, nil, fatal?) do
    if fatal? do
      Logger.error(
        "Force-dispatch aborted for #{fiber_id}: fiber is closed and no felt store is " <>
          "configured, so it cannot be reopened — refusing to spawn a worker with no live mandate"
      )

      {:error, :reopen_unavailable}
    else
      Logger.warning("Force-dispatch reopen skipped for #{fiber_id}: no felt store configured")
      :ok
    end
  end

  defp reopen(fiber_id, runner, felt_store, fatal?) do
    case run_reopen(fiber_id, runner, felt_store) do
      {:ok, output} ->
        Logger.info("Force-dispatch reopened #{fiber_id}: #{String.trim(output)}")
        :ok

      {:command_error, code, output} ->
        reopen_failure(
          fiber_id,
          fatal?,
          "`felt shuttle reopen` failed (exit #{code}: #{String.trim(to_string(output))})"
        )

      {:error, reason} ->
        reopen_failure(fiber_id, fatal?, "`felt shuttle reopen` raised #{inspect(reason)}")
    end
  end

  defp reopen_failure(fiber_id, true, detail) do
    Logger.error(
      "Force-dispatch aborted for #{fiber_id}: #{detail} — refusing to spawn a worker " <>
        "against a still-closed fiber"
    )

    {:error, :reopen_failed}
  end

  defp reopen_failure(fiber_id, false, detail) do
    Logger.warning(
      "Force-dispatch reopen failed for #{fiber_id} " <>
        "(worker will still spawn but kanban card may stick in its prior column): #{detail}"
    )

    :ok
  end

  # Shell `felt shuttle reopen` through the one audited write helper
  # (`Shuttle.Felt.Shuttle`). Post-S1/C1, felt's own `resolveOwnHost` is pure
  # local state (no re-entrant daemon round-trip), so this no longer needs to
  # hand felt an explicit `--host` override the way it once did — see
  # `Shuttle.Felt.Shuttle`'s moduledoc.
  defp run_reopen(fiber_id, runner, felt_store) do
    Shuttle.Felt.Shuttle.run("reopen", fiber_id, [], runner: runner, felt_store: felt_store)
  end

  defp closed?(fiber), do: Map.get(fiber, "status", "") == "closed"

  defp already_clean?(fiber) do
    status = Map.get(fiber, "status", "")
    tempered = Map.get(fiber, "tempered")
    closed_at = Map.get(fiber, "closed-at") || Map.get(fiber, "closed_at")

    status == "active" and is_nil(tempered) and is_nil(closed_at)
  end

  # Dual-recognition: a live worker under either the uid-keyed name or the
  # legacy leaf-only name blocks a fresh dispatch OR a resume. `present?` treats
  # an inconclusive `has-session` as present, so a transient tmux failure can
  # never let a dispatch (especially a resume) spawn over a still-live worker —
  # the daemon refuses with :already_running and the caller adopts instead.
  defp check_not_running(fiber_id, uid, runner) do
    fiber_id
    |> session_names(uid)
    |> Enum.any?(&Shuttle.Tmux.present?(runner, &1))
    |> case do
      true -> {:error, :already_running}
      false -> :ok
    end
  end

  defp resolve_agent(fiber) do
    # felt resolves name + axes → the effective record and inlines it under
    # shuttle.resolved.agent (felt show -j). The daemon consumes that finished
    # record and renders it (Agents.build_command); it keeps no registry. Absent
    # resolved.agent ⇒ felt could not resolve (unknown agent) or felt is not on
    # PATH — fail the dispatch loudly rather than launch a broken worker.
    case get_in(fiber, ["shuttle", "resolved", "agent"]) do
      resolved when is_map(resolved) ->
        {:ok, Agents.from_resolved(resolved)}

      _ ->
        {:error,
         "no resolved agent in felt JSON for #{inspect(get_in(fiber, ["shuttle", "agent"]))} (felt must emit shuttle.resolved.agent)"}
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
  # The Poller's `project_dir_available?/1` already disqualifies such a fiber on
  # the autonomous path, but a human force-dispatch (kanban Requeue, drag to
  # launch) bypasses eligibility entirely and lands straight here — so this is
  # the only place the forced path can learn it.
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
  # the Poller parks the fiber for a cooldown (see `wrapper_preflight_open?/2`).
  # Caching the ANSWER would be wrong at exactly the moment it mattered (the
  # operator installs the wrapper and the daemon goes on refusing); parking the
  # FIBER expires on its own and a force-dispatch skips it.
  #
  @wrapper_probe_timeout_ms 15_000

  defp preflight_wrapper(agent, work_dir, runner) do
    case Agents.wrapper_probe(agent) do
      # felt fills a record's `wrapper` from its `cli` when the record omits it
      # (internal/shuttle/registry_config.go), so nothing to probe means the
      # registry record itself names nothing to invoke.
      :none ->
        dispatch_refused(
          :wrapper_unresolved,
          "agent #{agent.id} names no wrapper or cli to invoke — its registry record is " <>
            "incomplete (`felt shuttle agents` prints the effective registry)."
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
            "in `~/.config/felt/agents.json` (`felt shuttle agents` prints the effective registry)."
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

  # The shuttle block's `kind` (new-format) / `mode` (old-format), defaulting to
  # "oneshot". Threaded into the prompt so the exit contract can diverge for
  # pinned interactive roles (stay alive at idle, or handoff for an autonomous
  # arc) vs oneshot/standing work (rewrite `## Status`, then handoff).
  defp fiber_kind(fiber) do
    case Map.get(fiber, "shuttle") do
      shuttle when is_map(shuttle) ->
        Shuttle.Poller.role_kind(shuttle)

      _ ->
        "oneshot"
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

  # Dispatch: fresh worker (new session) or resume previous.
  # `resume_intent` is `:fresh | {:previous, session_id}` from check_resume_intent/3.
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
          record_dispatch_session(fiber_id, session_id, runner,
            felt_store: felt_store,
            run_id: Keyword.get(opts, :run_id),
            tmux: session,
            harness: Shuttle.SessionLedger.harness_for_cli(agent.cli),
            uid: Keyword.get(opts, :uid),
            ledger_kind: :resume
          )
        end)

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
          store_session_id(fiber_id, session_uuid, runner,
            felt_store: felt_store,
            run_id: Keyword.get(opts, :run_id),
            tmux: session,
            harness: Shuttle.SessionLedger.harness_for_cli(agent.cli),
            uid: Keyword.get(opts, :uid),
            ledger_kind: :dispatch
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

  # Spawn a tmux session from a run-script string.
  defp spawn_tmux(session, work_dir, run_script, runner) do
    tmp_path =
      Path.join(System.tmp_dir!(), "shuttle-run-#{System.unique_integer([:positive])}.sh")

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
  # `store_session_id` returns (Runner-bounded felt shell-outs now make this a
  # bounded, not unbounded, blocking call — see F3). Only the piece that
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
  # `shuttle.runtime` block by shelling `felt shuttle mark-runtime` (felt owns
  # the nesting). At the next dispatch the worker's
  # `handed_off_at` is compared against this `dispatched_at` to decide
  # fresh-vs-resume. `felt_store` + `fiber_id` are the store/scoped-id pair the
  # dispatch read the fiber with, so felt resolves it. A missing `:felt_store`
  # skips the write — the fiber then reads as a fresh dispatch, the safe
  # default. `uuid` may be `nil` (codex/pi at launch, or `:none` agents) — the
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
      # Explicit, not tmux-inferred: a fiber with no uid yields a plain
      # `<leaf>-shuttle` tmux name, and an inferred-nil uid line would be
      # invisible to latest_for_uid forever (the claim path already passes it).
      uid: Keyword.get(opts, :uid),
      session: uuid,
      tmux: Keyword.get(opts, :tmux),
      harness: Keyword.get(opts, :harness),
      kind: Keyword.get(opts, :ledger_kind, :dispatch)
    )
  end

  # Backfill `session_uuid` into an ALREADY-STAMPED marker — the codex/pi
  # async capture path. Deliberately does not touch `dispatched_at`: it shells
  # `felt shuttle mark-runtime --session <uuid>` with no `--dispatched-at`
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
      Path.expand(cwd) == Path.expand(work_dir) and
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
  # dismiss claude --resume's interactive warning page.
  def build_run_script(fiber_id, command, agent_id, opts \\ []) do
    dismiss_resume_warning = Keyword.get(opts, :dismiss_resume_warning, false)
    session = Keyword.get(opts, :session, "")
    # Headless `-p` workers run unattended: no human client attaches, so the
    # wait-for-client gate below would only burn its full timeout for nothing.
    headless = Keyword.get(opts, :headless, false)
    display_fiber_id = Keyword.get(opts, :display_fiber_id, fiber_id)

    # The fiber's `.md` path for the worker's `felt shuttle handoff`: it stamps
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
    # standing role). After the timeout the harness proceeds at the
    # default-size, same as the world before this gate existed.
    wait_for_client_block =
      if session != "" and not headless do
        ~s"""
        WAIT_DEADLINE=$(( $(date +%s) + 10 ))
        while [ "$(date +%s)" -lt "$WAIT_DEADLINE" ]; do
          if tmux list-clients -t '#{session}' -F '\#{client_control_mode}' 2>/dev/null | grep -qx '0'; then
            break
          fi
          sleep 0.2
        done
        """
      else
        ""
      end

    """
    #!/bin/bash
    set -e
    trap 'rm -f "$0"' EXIT

    #{erts_scrub_block()}#{fiber_key_block}#{wait_for_client_block}
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Shuttle worker — #{display_fiber_id} — agent=#{agent_id} — $(date '+%H:%M:%S')"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    #{dismiss_block}#{command}

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Shuttle worker exited (agent=#{agent_id})"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    """
  end

  # Scrub the daemon's OWN Erlang runtime out of the worker's environment.
  #
  # The daemon is a Mix release with a bundled ERTS, and `erl` exports ROOTDIR,
  # BINDIR, PROGNAME and EMU into the BEAM's environment — which every tmux
  # worker then inherits. Under the escript those pointed at the host's
  # Erlang install and were harmless. Under a release they point INTO
  # `bin/rel`, whose ERTS ships no `mix`, no `start.boot` for anything but the
  # daemon, and no full OTP lib tree. A worker that runs `mix`, `elixir`,
  # `erl`, `iex` or `escript` then dies with
  # `cannot get bootfile .../bin/rel/bin/start.boot` — which is exactly how
  # this was found: a worker dispatched onto this very repo could not build it.
  #
  # `bash -l` does not fix it: the login profile PREPENDS to the inherited
  # PATH, so the release's erts bin keeps shadowing the real toolchain, and
  # ROOTDIR survives untouched regardless of PATH order.
  #
  # So the worker's script drops the four exported vars and filters the
  # release's own directories out of PATH before anything else runs. A worker
  # with no Erlang on PATH is correct — it sees whatever the host installs,
  # the same as before the daemon shipped its own.
  defp erts_scrub_block do
    ~S"""
    unset ROOTDIR BINDIR PROGNAME EMU ESCRIPT_NAME
    if [ -n "${RELEASE_ROOT:-}" ]; then
      PATH=$(printf '%s' "$PATH" | tr ':' '\n' \
        | grep -vF "$RELEASE_ROOT/erts" | grep -vF "$RELEASE_ROOT/bin" \
        | paste -sd: -)
      export PATH
    fi
    unset RELEASE_ROOT RELEASE_SYS_CONFIG RELEASE_TMP RELEASE_VSN RELEASE_NAME \
          RELEASE_NODE RELEASE_COOKIE RELEASE_MODE RELEASE_BOOT_SCRIPT \
          RELEASE_BOOT_SCRIPT_CLEAN RELEASE_DISTRIBUTION RELEASE_PROG RELEASE_COMMAND
    """
  end

  defp run_felt(runner, args, opts \\ []) do
    cd = Keyword.get(opts, :cd)

    cmd_opts =
      if cd do
        [cd: cd, stderr_to_stdout: true]
      else
        [stderr_to_stdout: true]
      end

    case runner.cmd("felt", args, cmd_opts) do
      {output, 0} -> {:ok, output}
      {output, _} -> {:error, output}
    end
  end
end
