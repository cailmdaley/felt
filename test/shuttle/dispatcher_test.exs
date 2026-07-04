defmodule Shuttle.DispatcherTest do
  use ExUnit.Case

  alias Shuttle.Dispatcher
  alias Shuttle.Agents

  # ── Mock Runner ──

  defmodule MockRunner do
    @behaviour Shuttle.Runner

    use Agent

    def start_link(_ \\ []) do
      Agent.start_link(fn -> %{commands: [], tmux_sessions: MapSet.new()} end, name: __MODULE__)
    end

    def reset do
      Agent.update(__MODULE__, fn _ -> %{commands: [], tmux_sessions: MapSet.new()} end)
    end

    def add_tmux_session(session) do
      Agent.update(__MODULE__, fn state ->
        %{state | tmux_sessions: MapSet.put(state.tmux_sessions, session)}
      end)
    end

    def commands do
      Agent.get(__MODULE__, & &1.commands)
    end

    def tmux_sessions do
      Agent.get(__MODULE__, & &1.tmux_sessions)
    end

    # Test fiber registry: id → %{status:, tags:, shuttle:}.
    #
    # `felt show --json` emits id/name/status/created_at/body/modified_at *only*
    # — it does NOT include `shuttle:` or `tags:` (verified against real felt).
    # `felt show --field shuttle` emits structured values as YAML; `--field
    # tags` emits sequences of scalars one-per-line. The cmd handler below
    # routes each `felt show` flavor through the right shape.
    # felt owns resolution and inlines the effective record under
    # `shuttle.resolved.agent` (felt show -j). The daemon reads that finished
    # record — it no longer re-resolves. So each dispatchable fiber here carries
    # a `resolved` agent the way real felt JSON does. The keys mirror felt's
    # omitempty shape (a falsey chrome/headless/effort simply absent).
    @claude_opus_resolved %{
      "id" => "claude-opus",
      "cli" => "claude",
      "wrapper" => "claude",
      "model" => "opus",
      "extra_flags" => "--permission-mode auto"
    }
    @claude_sonnet_resolved %{
      "id" => "claude-sonnet",
      "cli" => "claude",
      "wrapper" => "claude",
      "model" => "sonnet",
      "extra_flags" => "--permission-mode auto"
    }
    @pi_resolved %{
      "id" => "pi-deepseek-flash",
      "cli" => "pi",
      "wrapper" => "pi",
      "provider" => "openrouter",
      "model" => "deepseek/deepseek-v4-flash"
    }

    @test_fibers %{
      "tests/haiku" => %{
        status: "active",
        tags: ["constitution"],
        shuttle: %{"resolved" => %{"agent" => @claude_sonnet_resolved}}
      },
      "tests/closed" => %{
        status: "closed",
        tags: ["constitution"],
        shuttle: %{"resolved" => %{"agent" => @claude_sonnet_resolved}}
      },
      "tests/reopen-fails" => %{
        # Closed fiber whose `felt shuttle reopen` shell-out fails (see the
        # reopen branch in handle_felt/1) — exercises the authoritative-reopen
        # abort for the CLOSED case.
        status: "closed",
        tags: ["constitution"],
        shuttle: %{"resolved" => %{"agent" => @claude_sonnet_resolved}}
      },
      "tests/pi-tagged" => %{
        status: "active",
        tags: ["constitution", "pi"],
        shuttle: %{"agent" => "pi-deepseek-flash", "resolved" => %{"agent" => @pi_resolved}}
      },
      "tests/shuttle-agent-block" => %{
        status: "active",
        tags: ["constitution"],
        shuttle: %{
          "enabled" => true,
          "kind" => "oneshot",
          "agent" => "claude-opus",
          "resolved" => %{"agent" => @claude_opus_resolved}
        }
      },
      "tests/shuttle-agent-overrides-tag" => %{
        # A legacy bare `pi` tag still rides the fiber, but felt's resolved
        # record (claude-opus) is the only thing the daemon reads — the block's
        # agent is the source of truth, tags are inert for dispatch.
        status: "active",
        tags: ["constitution", "pi"],
        shuttle: %{
          "enabled" => true,
          "kind" => "oneshot",
          "agent" => "claude-opus",
          "resolved" => %{"agent" => @claude_opus_resolved}
        }
      },
      "tests/uid-fiber" => %{
        status: "active",
        tags: ["constitution"],
        uid: "01KTHDNZS287ZSSG8X8V59XKWB",
        shuttle: %{
          "enabled" => true,
          "kind" => "oneshot",
          "agent" => "claude-sonnet",
          "resolved" => %{"agent" => @claude_sonnet_resolved}
        }
      }
    }

    @impl true
    def cmd(command, args, _opts) do
      Agent.update(__MODULE__, fn state ->
        %{state | commands: state.commands ++ [{command, args}]}
      end)

      cond do
        command == "felt" ->
          handle_felt(args)

        command == "tmux" and hd(args) == "has-session" ->
          session = Enum.at(args, 2)

          if tmux_session_exists?(tmux_sessions(), session) do
            {"", 0}
          else
            {"can't find session", 1}
          end

        command == "tmux" and hd(args) == "new-session" ->
          session = Enum.at(args, 3)
          add_tmux_session(session)
          {"", 0}

        true ->
          {"", 0}
      end
    end

    defp tmux_session_exists?(sessions, "=" <> session), do: MapSet.member?(sessions, session)

    defp tmux_session_exists?(sessions, session) do
      Enum.any?(sessions, &(&1 == session or String.starts_with?(&1, session <> "/")))
    end

    defp handle_felt(["shuttle", "agents", "resolve" | rest]) do
      # Stub of `felt shuttle agents resolve <name> [--effort E] [--chrome]
      # --json`. felt owns real resolution; here we cover only the agents +
      # axes the capture tests exercise, returning felt's resolved.agent JSON
      # shape (exit 0) or its descriptive non-zero diagnostic. Keeps the suite
      # off a live `felt shuttle agents` verb (it may not be installed yet).
      name = hd(rest)
      effort = flag_value(rest, "--effort")
      chrome = "--chrome" in rest

      cond do
        name == "codex" and chrome ->
          {"chrome not supported by agent codex (claude harness only)", 1}

        name == "claude-opus" and effort == "bogus" ->
          {"effort bogus not allowed for agent claude-opus (allowed: low, medium, high, xhigh, max)",
           1}

        name == "claude-opus" ->
          resolved = %{"id" => "claude-opus", "cli" => "claude", "wrapper" => "claude", "model" => "opus"}
          resolved = if is_binary(effort), do: Map.put(resolved, "effort", effort), else: resolved
          resolved = if chrome, do: Map.put(resolved, "chrome", true), else: resolved
          {Jason.encode!(resolved), 0}

        true ->
          # Default capture agent (claude-sonnet).
          {Jason.encode!(%{
             "id" => "claude-sonnet",
             "cli" => "claude",
             "wrapper" => "claude",
             "model" => "sonnet"
           }), 0}
      end
    end

    defp handle_felt(args) do
      fiber_id = Enum.find(args, &Map.has_key?(@test_fibers, &1))

      cond do
        is_nil(fiber_id) ->
          {"fiber not found", 1}

        # `felt shuttle reopen tests/reopen-fails` fails — the store rejects
        # the reopen. The dispatcher must treat this as fatal for a closed
        # fiber and abort before any tmux spawn.
        "reopen" in args and fiber_id == "tests/reopen-fails" ->
          {"reopen: could not reopen fiber in store", 1}

        # `felt show <id> --json` (felt v1.0.4+) — tool-owned namespaces
        # like `shuttle:` round-trip as flat top-level JSON keys alongside
        # the parsed fields. The dispatcher reads `shuttle.agent` and
        # `tags` directly off the JSON map.
        "--json" in args ->
          fiber = @test_fibers[fiber_id]

          payload =
            %{
              "id" => fiber_id,
              "name" => fiber_id,
              "status" => fiber.status,
              "tags" => fiber.tags,
              "created_at" => "2026-04-28T00:00:00Z",
              "body" => "",
              "modified_at" => "2026-04-28T00:00:00Z"
            }
            |> maybe_put("shuttle", fiber.shuttle)
            |> maybe_put("uid", Map.get(fiber, :uid))

          {Jason.encode!(payload), 0}

        true ->
          {"", 0}
      end
    end

    defp maybe_put(map, _key, nil), do: map
    defp maybe_put(map, key, value), do: Map.put(map, key, value)

    # The value following `flag` in an arg list (e.g. `--effort xhigh`), or nil.
    defp flag_value(args, flag) do
      case Enum.find_index(args, &(&1 == flag)) do
        nil -> nil
        i -> Enum.at(args, i + 1)
      end
    end
  end

  # ── Setup ──

  setup do
    start_supervised!(MockRunner)
    MockRunner.reset()

    # `default_felt_store/0` resolves through `FeltStores.configured_hosts/0`,
    # which reads the FELT_STORES env / persisted stores.json — NOT the injected
    # test runner. On a machine with a configured loom it returns a store; in a
    # bare CI environment it returns [] → `default_felt_store/0` is nil, so the
    # "Felt store:" prompt line is dropped and force-dispatch on a closed fiber
    # aborts with :reopen_unavailable before it can shell `felt shuttle reopen`.
    # Pin a store here so store resolution is deterministic regardless of the
    # host's felt config; delete on exit so the setting never leaks to other
    # suites (the persistent_term cache in configured_hosts/0 is keyed by the
    # base config, so a differing base on the next suite recomputes cleanly).
    prev_stores = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", "/tmp")

    on_exit(fn ->
      if prev_stores,
        do: System.put_env("FELT_STORES", prev_stores),
        else: System.delete_env("FELT_STORES")
    end)

    :ok
  end

  # ── Tests ──

  test "render_prompt opens with orientation, names the fiber, and carries exit contract" do
    # No felt index for tests/haiku → all three context blocks render empty;
    # this test exercises the orientation header.
    prompt = Dispatcher.render_prompt("tests/haiku")

    # Orientation paragraph: names what Shuttle is, what the worker is for,
    # how the practice gets loaded.
    assert prompt =~ "The orchestration system Shuttle dispatched you"
    assert prompt =~ ~s(constitution describes what "done" looks like)
    assert prompt =~ "`shuttle` and `felt` skills carry the practice"

    # Fiber identity on its own line for grep-ability.
    assert prompt =~ "Fiber: tests/haiku"

    # The full practice still lives in the shuttle skill, but the exit
    # contract must be prompt-local so resumed workers do not treat Shuttle
    # work like ordinary chat completion.
    assert prompt =~ "Exit Contract"
    assert prompt =~ "kill $PPID"
    assert prompt =~ "A normal chat final response is not a worker exit"
    refute prompt =~ "Exit before context is half-full"

    # A oneshot must be told to write the clean-handoff marker before exit — it's
    # the signal that distinguishes a clean close (next worker starts fresh) from
    # a mid-thought death (daemon resumes the transcript) — and to rewrite the
    # `## Status` handoff prose. The old `felt history append` ritual is gone.
    assert prompt =~ "felt shuttle handoff"
    assert prompt =~ "## Status"
    refute prompt =~ "felt history append"
  end

  test "render_prompt for a pinned role inverts the exit contract to stay-alive" do
    # A pinned role is an interactive interface — the worker must NOT kill $PPID
    # when it runs out of immediate work; it stays attached and waits. The
    # default (oneshot) contract is the opposite, so the two must not collide.
    pinned = Dispatcher.render_prompt("tests/haiku", kind: "pinned")
    assert pinned =~ "Exit Contract"
    assert pinned =~ "pinned interactive role"
    assert pinned =~ "DO NOT exit"
    assert pinned =~ "stay alive and wait"
    # The autonomous kill-on-exit instruction must be absent for pinned.
    refute pinned =~ "your final action must be `kill $PPID`"

    # Oneshot (the default) keeps the autonomous exit-on-completion contract:
    # the final action is `felt shuttle handoff`, which writes the marker and ends
    # the session (it folds in the old `kill $PPID`).
    oneshot = Dispatcher.render_prompt("tests/haiku")
    assert oneshot =~ "your FINAL action is `felt shuttle handoff"
    refute oneshot =~ "stay alive and wait"
    refute oneshot =~ "pinned interactive role"
  end

  test "render_prompt carries the headless notice only when headless: true" do
    # Headless (-p) workers run unattended — the prompt must tell them the
    # human-gate exception can't apply, or they may park at a checkpoint that
    # never gets answered.
    headless = Dispatcher.render_prompt("tests/haiku", headless: true)
    assert headless =~ "Headless"
    assert headless =~ "no human can attach"
    assert headless =~ "human-gate exception never applies"

    # Default (interactive) dispatch carries no such notice.
    interactive = Dispatcher.render_prompt("tests/haiku")
    refute interactive =~ "no human can attach"
  end

  test "render_prompt names the felt store so the safe-fail global id stays resolvable" do
    # When prompt_fiber_id's local translation misses, the worker holds a
    # global id that doesn't resolve from cwd. The store line makes the
    # fallback mechanical: `felt -C <felt-store> show <id>`.
    prompt = Dispatcher.render_prompt("tests/haiku", felt_store: "/tmp/some-loom")
    assert prompt =~ "Felt store: /tmp/some-loom"

    # Default store renders too — the line is unconditional.
    default_prompt = Dispatcher.render_prompt("tests/haiku")
    assert default_prompt =~ "Felt store: "
  end

  test "render_prompt omits the From User block when no user_message is carried" do
    # With no `:user_message` dispatch parameter, the user-message block
    # suppresses to an empty string, leaving just the header.
    prompt = Dispatcher.render_prompt("tests/haiku")
    refute prompt =~ "From User"
  end

  test "render_prompt inlines the carried user_message as a From User block" do
    # STORE 3: the user's directive rides the dispatch as a transient parameter,
    # inlined into the prompt at launch (no persisted review-comment).
    prompt = Dispatcher.render_prompt("tests/haiku", user_message: "talk to me first")
    assert prompt =~ "From User"
    assert prompt =~ "talk to me first"

    # A blank message renders nothing.
    blank = Dispatcher.render_prompt("tests/haiku", user_message: "   ")
    refute blank =~ "From User"
  end

  test "render_prompt does not inline outcome or last-session (worker reads via felt)" do
    # The fiber's outcome and last editorial event are reachable via
    # `felt show <id>` and `felt history <id>` respectively. The prompt
    # deliberately doesn't duplicate them — the shuttle skill prescribes
    # the read order, and inlining risks drift between the prompt's
    # snapshot and felt's view.
    prompt = Dispatcher.render_prompt("tests/haiku")
    refute prompt =~ "Outcome"
    refute prompt =~ "Last session"
  end

  test "prompt_fiber_id uses the worker cwd's project-local felt view" do
    loom =
      Path.join(System.tmp_dir!(), "shuttle-prompt-loom-#{System.unique_integer([:positive])}")

    work_dir =
      Path.join(System.tmp_dir!(), "shuttle-prompt-work-#{System.unique_integer([:positive])}")

    canonical_path =
      Path.join([
        loom,
        ".felt",
        "ai-futures",
        "shuttle",
        "constitution-shuttle-ctl-ux-fixes",
        "constitution-shuttle-ctl-ux-fixes.md"
      ])

    File.mkdir_p!(Path.dirname(canonical_path))
    File.write!(canonical_path, "---\nname: test\n---\n")
    File.mkdir_p!(work_dir)
    File.ln_s!(Path.join([loom, ".felt", "ai-futures", "shuttle"]), Path.join(work_dir, ".felt"))

    on_exit(fn ->
      File.rm_rf!(loom)
      File.rm_rf!(work_dir)
    end)

    assert Dispatcher.prompt_fiber_id(
             "ai-futures/shuttle/constitution-shuttle-ctl-ux-fixes",
             work_dir,
             loom
           ) == "constitution-shuttle-ctl-ux-fixes"
  end

  test "prompt_fiber_id preserves nested IDs under the project felt root" do
    loom =
      Path.join(System.tmp_dir!(), "shuttle-prompt-loom-#{System.unique_integer([:positive])}")

    work_dir =
      Path.join(System.tmp_dir!(), "shuttle-prompt-work-#{System.unique_integer([:positive])}")

    canonical_path =
      Path.join([
        loom,
        ".felt",
        "ai-futures",
        "portolan",
        "portolan",
        "constitution-shuttle-portolan-version-sync",
        "constitution-shuttle-portolan-version-sync.md"
      ])

    File.mkdir_p!(Path.dirname(canonical_path))
    File.write!(canonical_path, "---\nname: test\n---\n")
    File.mkdir_p!(work_dir)
    File.ln_s!(Path.join([loom, ".felt", "ai-futures", "portolan"]), Path.join(work_dir, ".felt"))

    on_exit(fn ->
      File.rm_rf!(loom)
      File.rm_rf!(work_dir)
    end)

    assert Dispatcher.prompt_fiber_id(
             "ai-futures/portolan/portolan/constitution-shuttle-portolan-version-sync",
             work_dir,
             loom
           ) == "portolan/constitution-shuttle-portolan-version-sync"
  end

  test "render_prompt can display a project-local fiber while querying canonical history" do
    prompt =
      Dispatcher.render_prompt("ai-futures/shuttle/constitution-shuttle-ctl-ux-fixes",
        prompt_fiber_id: "constitution-shuttle-ctl-ux-fixes"
      )

    assert prompt =~ "Fiber: constitution-shuttle-ctl-ux-fixes"
    refute prompt =~ "Fiber: ai-futures/shuttle/constitution-shuttle-ctl-ux-fixes"
  end

  test "session_name/2 keys the canonical name by uid (rename-safe, collision-free)" do
    uid = "01KTHDNZS287ZSSG8X8V59XKWB"
    assert Dispatcher.session_name("tests/haiku", uid) == "haiku-#{uid}-shuttle"
    assert Dispatcher.session_name("a/b/c", uid) == "c-#{uid}-shuttle"
  end

  test "session_name/2 falls back to the legacy leaf-only name when uid is absent" do
    assert Dispatcher.session_name("tests/haiku", nil) == "haiku-shuttle"
    assert Dispatcher.session_name("tests/haiku", "") == "haiku-shuttle"
  end

  test "session_name/1 is the legacy leaf-only form (retained for dual-recognition)" do
    assert Dispatcher.session_name("tests/haiku") == "haiku-shuttle"
    assert Dispatcher.session_name("a/b/c") == "c-shuttle"
  end

  test "session_names/2 returns both forms for dual-recognition" do
    uid = "01KTHDNZS287ZSSG8X8V59XKWB"

    assert Dispatcher.session_names("tests/haiku", uid) == [
             "haiku-#{uid}-shuttle",
             "haiku-shuttle"
           ]

    # No uid → only the legacy form is recognizable.
    assert Dispatcher.session_names("tests/haiku", nil) == ["haiku-shuttle"]

    # Both forms are Shuttle sessions.
    assert Enum.all?(Dispatcher.session_names("tests/haiku", uid), &Dispatcher.shuttle_session?/1)
  end

  test "dispatch creates tmux session for eligible fiber" do
    result = Dispatcher.dispatch("tests/haiku", runner: MockRunner)
    assert {:ok, "haiku-shuttle"} = result

    commands = MockRunner.commands()

    assert Enum.any?(commands, fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "dispatch launches the worker under the uid-keyed session name" do
    uid = "01KTHDNZS287ZSSG8X8V59XKWB"
    expected = "uid-fiber-#{uid}-shuttle"
    assert {:ok, ^expected} = Dispatcher.dispatch("tests/uid-fiber", runner: MockRunner)

    # The new-session tmux command targets the uid-keyed name.
    assert Enum.any?(MockRunner.commands(), fn
             {"tmux", args} -> hd(args) == "new-session" and expected in args
             _ -> false
           end)
  end

  test "dispatch refuses when a live worker exists under the legacy name (dual-recognition)" do
    # A worker launched before the uid-keyed cutover carries the legacy
    # leaf-only name; check_not_running must still see it and refuse a
    # duplicate dispatch for the uid-carrying fiber.
    MockRunner.add_tmux_session("uid-fiber-shuttle")
    assert {:error, :already_running} = Dispatcher.dispatch("tests/uid-fiber", runner: MockRunner)
  end

  test "dispatch refuses closed fiber" do
    result = Dispatcher.dispatch("tests/closed", runner: MockRunner)
    assert {:error, :closed} = result
  end

  test "dispatch with force: true on a closed fiber shells out to felt shuttle reopen" do
    # The kanban Resume button on an awaitingReview / closed card flows here
    # with force=true. Without the reopen step, the worker spawns but the
    # YAML stays closed and Portolan's classifyFiber keeps the card pinned
    # in its prior column — see KanbanModal.runRequeue's comment about why
    # this side-effect is daemon-owned. The contract: force-dispatch on a
    # not-already-clean fiber issues `felt shuttle reopen <fiber>` before
    # tmux new-session fires.
    result = Dispatcher.dispatch("tests/closed", runner: MockRunner, force: true)
    assert {:ok, _session} = result

    commands = MockRunner.commands()

    reopen_call =
      Enum.find(commands, fn
        {"felt", args} -> "reopen" in args and "tests/closed" in args
        _ -> false
      end)

    assert reopen_call != nil, "expected felt shuttle reopen call; got #{inspect(commands)}"

    # And it must precede tmux new-session — reopen-then-spawn, not the other way.
    reopen_index =
      Enum.find_index(commands, fn
        {"felt", args} -> "reopen" in args
        _ -> false
      end)

    tmux_new_index =
      Enum.find_index(commands, fn
        {"tmux", args} -> hd(args) == "new-session"
        _ -> false
      end)

    assert reopen_index < tmux_new_index,
           "reopen must precede tmux new-session; commands: #{inspect(commands)}"
  end

  test "dispatch with force: true on an already-clean fiber skips the reopen shell-out" do
    # No-op short-circuit: re-dispatching a healthy in-flight oneshot
    # shouldn't rewrite frontmatter on every manual click.
    result =
      Dispatcher.dispatch("tests/shuttle-agent-block",
        runner: MockRunner,
        force: true,
        store_session_id: false
      )

    assert {:ok, _session} = result

    refute Enum.any?(MockRunner.commands(), fn
             {"felt", args} -> "reopen" in args
             _ -> false
           end),
           "expected no felt shuttle reopen on already-clean fiber; got #{inspect(MockRunner.commands())}"
  end

  test "dispatch with force: true aborts when reopen of a closed fiber fails" do
    # Authoritative reopen: a closed fiber whose `felt shuttle reopen` exits
    # non-zero must ABORT the dispatch — never spawn a worker with no live
    # mandate (the doomed "terminal opens and immediately closes" worker).
    result = Dispatcher.dispatch("tests/reopen-fails", runner: MockRunner, force: true)
    assert {:error, :reopen_failed} = result

    commands = MockRunner.commands()

    assert Enum.any?(commands, fn
             {"felt", args} -> "reopen" in args and "tests/reopen-fails" in args
             _ -> false
           end),
           "expected the reopen attempt to have been made; got #{inspect(commands)}"

    refute Enum.any?(commands, fn
             {"tmux", args} -> hd(args) == "new-session"
             _ -> false
           end),
           "no worker/tmux session may spawn when reopen fails; got #{inspect(commands)}"
  end

  test "dispatch with force: true on a closed fiber aborts when no felt store is configured" do
    # Without a felt store the closed fiber cannot be reopened, so the reopen
    # is neither attempted nor assumed — the dispatch aborts rather than
    # spawning a worker against a still-closed fiber.
    result = Dispatcher.dispatch("tests/closed", runner: MockRunner, force: true, felt_store: nil)
    assert {:error, :reopen_unavailable} = result

    commands = MockRunner.commands()

    refute Enum.any?(commands, fn
             {"felt", args} -> "reopen" in args
             _ -> false
           end),
           "reopen must not be attempted with no felt store; got #{inspect(commands)}"

    refute Enum.any?(commands, fn
             {"tmux", args} -> hd(args) == "new-session"
             _ -> false
           end),
           "no worker/tmux session may spawn with no felt store; got #{inspect(commands)}"
  end

  test "dispatch refuses already-running fiber" do
    # Pre-seed the tmux session
    MockRunner.add_tmux_session(Dispatcher.session_name("tests/haiku"))

    result = Dispatcher.dispatch("tests/haiku", runner: MockRunner)
    assert {:error, :already_running} = result
  end

  test "dispatch does not treat child fiber session as already-running parent" do
    MockRunner.add_tmux_session(Dispatcher.session_name("tests/haiku/child"))

    result = Dispatcher.dispatch("tests/haiku", runner: MockRunner)
    assert {:ok, "haiku-shuttle"} = result

    assert Enum.any?(MockRunner.commands(), fn
             {"tmux", ["has-session", "-t", "=haiku-shuttle"]} -> true
             _ -> false
           end)
  end

  test "dispatch reads felt's resolved pi agent (pi-tagged fiber)" do
    result = Dispatcher.dispatch("tests/pi-tagged", runner: MockRunner, store_session_id: false)
    assert {:ok, session} = result
    assert session == Dispatcher.session_name("tests/pi-tagged")

    # Verify the tmux new-session command was issued
    commands = MockRunner.commands()

    {_, args} =
      Enum.find(commands, fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)

    assert hd(args) == "new-session"
  end

  test "dispatch uses felt's resolved agent (claude-opus) when present" do
    assert {:ok, _session} = Dispatcher.dispatch("tests/shuttle-agent-block", runner: MockRunner)
    script = read_run_script_for(Dispatcher.session_name("tests/shuttle-agent-block"))
    assert script =~ "agent=claude-opus"
    refute script =~ "agent=claude-sonnet"
  end

  test "dispatch: felt's resolved.agent (claude-opus) wins over a legacy bare tag" do
    assert {:ok, _session} =
             Dispatcher.dispatch("tests/shuttle-agent-overrides-tag", runner: MockRunner)

    script = read_run_script_for(Dispatcher.session_name("tests/shuttle-agent-overrides-tag"))
    assert script =~ "agent=claude-opus"
    refute script =~ "agent=pi-deepseek-flash"
  end

  # The dispatched tmux command takes a run-script tempfile as the last arg
  # (after `bash -l`). Read the script back to verify the agent embedded in it.
  defp read_run_script_for(session) do
    {_, args} =
      Enum.find(MockRunner.commands(), fn {cmd, args} ->
        cmd == "tmux" and hd(args) == "new-session" and Enum.at(args, 3) == session
      end)

    script_path = List.last(args)
    File.read!(script_path)
  end

  # felt owns resolution and inlines the effective record as `shuttle.resolved.agent`
  # JSON. These tests exercise the daemon's job — turning that record into the
  # harness shell command — so they build it via Agents.from_resolved/1, exactly
  # the production path. A resolved record carries the effective axes already
  # overlaid (effort/chrome/headless), which is felt's responsibility, not the
  # daemon's; the daemon only renders what it's handed.
  defp resolved(fields), do: Agents.from_resolved(fields)

  test "build_command for claude uses here-string" do
    agent = resolved(%{"id" => "claude-sonnet", "cli" => "claude", "wrapper" => "claude", "model" => "sonnet"})
    cmd = Agents.build_command(agent, "hello world")
    assert cmd =~ "claude"
    assert cmd =~ "<<<"
    assert cmd =~ "'hello world'"
  end

  test "build_command for codex uses positional arg" do
    agent = resolved(%{"id" => "codex", "cli" => "codex", "wrapper" => "codex", "model" => "gpt-5.5-codex"})
    cmd = Agents.build_command(agent, "hello world")
    assert cmd =~ "codex"
    refute cmd =~ "<<<"
    assert cmd =~ "'hello world'"
  end

  test "build_command for codex spark selects the spark model" do
    agent =
      resolved(%{"id" => "codex-spark", "cli" => "codex", "wrapper" => "codex", "model" => "gpt-5.3-codex-spark"})

    cmd = Agents.build_command(agent, "hello world")
    assert cmd =~ "codex"
    assert cmd =~ "--model 'gpt-5.3-codex-spark'"
    assert cmd =~ "'hello world'"
    refute cmd =~ "<<<"
  end

  test "build_command for pi includes provider and model" do
    agent =
      resolved(%{
        "id" => "pi-kimi",
        "cli" => "pi",
        "wrapper" => "pi",
        "provider" => "openrouter",
        "model" => "moonshotai/kimi-k2.6"
      })

    cmd = Agents.build_command(agent, "hello world")
    assert cmd =~ "pi"
    assert cmd =~ "--provider 'openrouter'"
    assert cmd =~ "--model 'moonshotai/kimi-k2.6'"
  end

  # ── Axis rendering (effort × chrome × headless) per harness ──
  #
  # felt resolves the axes; these assert the daemon renders an already-resolved
  # record's effort/chrome/headless into each CLI's native flag form.

  test "claude effort renders --effort and chrome renders --chrome" do
    agent =
      resolved(%{
        "id" => "claude-opus",
        "cli" => "claude",
        "wrapper" => "claude",
        "model" => "opus",
        "effort" => "xhigh",
        "chrome" => true
      })

    cmd = Agents.build_command(agent, "hi")
    assert cmd =~ "--effort 'xhigh'"
    assert cmd =~ "--chrome"
  end

  test "claude with the resolved default effort renders it, no chrome" do
    agent =
      resolved(%{
        "id" => "claude-opus",
        "cli" => "claude",
        "wrapper" => "claude",
        "model" => "opus",
        "effort" => "xhigh"
      })

    cmd = Agents.build_command(agent, "hi")
    assert cmd =~ "--effort 'xhigh'"
    refute cmd =~ "--chrome"
  end

  test "pi renders effort as :level suffix on the model" do
    agent =
      resolved(%{"id" => "pi-gpt-5.4", "cli" => "pi", "wrapper" => "pi", "model" => "gpt-5.4", "effort" => "high"})

    cmd = Agents.build_command(agent, "hi")
    assert cmd =~ "--model 'gpt-5.4:high'"
    refute cmd =~ "--effort"
  end

  test "pi renders the resolved effort as the model suffix (pi-sonnet :high)" do
    agent =
      resolved(%{
        "id" => "pi-sonnet",
        "cli" => "pi",
        "wrapper" => "pi",
        "model" => "claude-sonnet-4.6",
        "effort" => "high"
      })

    cmd = Agents.build_command(agent, "hi")
    assert cmd =~ "--model 'claude-sonnet-4.6:high'"
  end

  test "codex renders effort via -c model_reasoning_effort" do
    agent =
      resolved(%{"id" => "codex", "cli" => "codex", "wrapper" => "codex", "model" => "gpt-5.5-codex", "effort" => "high"})

    cmd = Agents.build_command(agent, "hi")
    assert cmd =~ ~s(-c model_reasoning_effort='high')
  end

  test "codex renders the resolved default effort" do
    agent =
      resolved(%{"id" => "codex", "cli" => "codex", "wrapper" => "codex", "model" => "gpt-5.5-codex", "effort" => "xhigh"})

    cmd = Agents.build_command(agent, "hi")
    assert cmd =~ ~s(-c model_reasoning_effort='xhigh')
  end

  test "resolved chrome renders --chrome (claude-opus-chrome → opus + chrome)" do
    # felt expanded the chrome alias to the claude-opus base with chrome:true;
    # the daemon renders it.
    agent =
      resolved(%{"id" => "claude-opus", "cli" => "claude", "wrapper" => "claude", "model" => "opus", "chrome" => true})

    cmd = Agents.build_command(agent, "hi")
    assert cmd =~ "--model 'opus'"
    assert cmd =~ "--chrome"
  end

  test "resolved headless renders -p print mode with bypass permissions" do
    # felt expanded the headless alias to the claude-haiku base with
    # headless:true; the daemon renders -p + the bypass swap.
    agent =
      resolved(%{
        "id" => "claude-haiku",
        "cli" => "claude",
        "wrapper" => "claude",
        "model" => "haiku",
        "headless" => true,
        "extra_flags" => "--permission-mode auto"
      })

    cmd = Agents.build_command(agent, "hi", session_id: "11111111-2222-4333-8444-555555555555")
    assert cmd =~ "-p"
    assert cmd =~ "--model 'haiku'"
    assert cmd =~ "--permission-mode bypassPermissions"
    refute cmd =~ "--permission-mode auto"
    # --session-id survives print mode (the durable resume handle)
    assert cmd =~ "--session-id '11111111-2222-4333-8444-555555555555'"
  end

  test "resolved headless composes with effort (-p + --effort max)" do
    agent =
      resolved(%{
        "id" => "claude-opus",
        "cli" => "claude",
        "wrapper" => "claude",
        "model" => "opus",
        "effort" => "max",
        "headless" => true,
        "extra_flags" => "--permission-mode auto"
      })

    cmd = Agents.build_command(agent, "hi")
    assert cmd =~ "-p"
    assert cmd =~ "--effort 'max'"
    assert cmd =~ "--permission-mode bypassPermissions"
  end

  test "non-headless claude keeps interactive permission mode and no -p" do
    agent =
      resolved(%{
        "id" => "claude-sonnet",
        "cli" => "claude",
        "wrapper" => "claude",
        "model" => "sonnet",
        "extra_flags" => "--permission-mode auto"
      })

    cmd = Agents.build_command(agent, "hi")
    assert cmd =~ "--permission-mode auto"
    refute cmd =~ "bypassPermissions"
    refute cmd =~ ~r/(^|\s)-p(\s|$)/
  end

  # ── Resume command shape ──

  test "build_resume_command for claude with empty prompt: --resume only, no stdin pipe" do
    agent = resolved(%{"id" => "claude-sonnet", "cli" => "claude", "wrapper" => "claude", "model" => "sonnet"})
    cmd = Agents.build_resume_command(agent, "abc-123", "")
    assert cmd =~ "claude"
    assert cmd =~ "--resume 'abc-123'"
    refute cmd =~ "<<<"
  end

  test "build_resume_command for claude with prompt: pipes via here-string" do
    agent = resolved(%{"id" => "claude-sonnet", "cli" => "claude", "wrapper" => "claude", "model" => "sonnet"})
    cmd = Agents.build_resume_command(agent, "abc-123", "address the typo")
    assert cmd =~ "--resume 'abc-123'"
    assert cmd =~ "<<< 'address the typo'"
  end

  test "build_resume_command for claude with whitespace-only prompt: treated as empty" do
    agent = resolved(%{"id" => "claude-sonnet", "cli" => "claude", "wrapper" => "claude", "model" => "sonnet"})
    cmd = Agents.build_resume_command(agent, "abc-123", "   \n  ")
    refute cmd =~ "<<<"
  end

  test "build_resume_command for codex with prompt: positional arg" do
    agent = resolved(%{"id" => "codex", "cli" => "codex", "wrapper" => "codex", "model" => "gpt-5.5-codex"})
    cmd = Agents.build_resume_command(agent, "abc-123", "address the typo")
    assert cmd =~ "codex"
    assert cmd =~ "resume 'abc-123'"
    assert cmd =~ "'address the typo'"
    refute cmd =~ "<<<"
  end

  test "build_resume_command for codex with empty prompt: resume only" do
    agent = resolved(%{"id" => "codex", "cli" => "codex", "wrapper" => "codex", "model" => "gpt-5.5-codex"})
    cmd = Agents.build_resume_command(agent, "abc-123", "")
    assert cmd =~ "resume 'abc-123'"
    # No trailing prompt arg.
    assert String.trim_trailing(cmd) |> String.ends_with?("'abc-123'")
  end

  test "build_resume_command for pi: drops prompt (no inline arg supported)" do
    agent =
      resolved(%{
        "id" => "pi-kimi",
        "cli" => "pi",
        "wrapper" => "pi",
        "provider" => "openrouter",
        "model" => "moonshotai/kimi-k2.6"
      })

    cmd = Agents.build_resume_command(agent, "abc-123", "ignored directive")
    assert cmd =~ "--session 'abc-123'"
    refute cmd =~ "ignored directive"
  end

  test "build_resume_command/2 default-arg form still works (zero-arg prompt)" do
    agent = resolved(%{"id" => "claude-sonnet", "cli" => "claude", "wrapper" => "claude", "model" => "sonnet"})
    cmd = Agents.build_resume_command(agent, "abc-123")
    assert cmd =~ "--resume 'abc-123'"
    refute cmd =~ "<<<"
  end

  # ── Resume prompt rendering ──

  test "render_standing_run_prompt frames the run as a recurring occurrence" do
    prompt = Dispatcher.render_standing_run_prompt("tests/haiku", "run-2026-05-06")

    # Standing-role-specific framing
    assert prompt =~ "scheduled run of this standing role"
    assert prompt =~ "one due occurrence, not a new fiber"
    assert prompt =~ "standing-roles reference covers the run lifecycle"

    # Identity lines
    assert prompt =~ "Fiber: tests/haiku"
    assert prompt =~ "Run:"
    assert prompt =~ "run-2026-05-06"

    # The run-specific frontmatter handoff remains in the skill; the generic
    # autonomous-worker exit contract is prompt-local.
    assert prompt =~ "Exit Contract"
    assert prompt =~ "kill $PPID"
    refute prompt =~ "review.state: awaiting"
    refute prompt =~ "felt history append"
  end

  test "render_standing_run_prompt distinguishes ad-hoc runs from scheduled occurrences" do
    prompt =
      Dispatcher.render_standing_run_prompt("tests/haiku", "adhoc-1770000000000", ad_hoc: true)

    assert prompt =~ "ad-hoc run of this standing role"
    assert prompt =~ "does not consume or advance the scheduled occurrence"
    # The slice-5 schema freeze removed review.state and next_due_at; the
    # prompt must not instruct the worker to write either. The daemon owns
    # the awaiting transition (standing-roles.md, "Worker exit handoff").
    refute prompt =~ "review.state"
    refute prompt =~ "next_due_at"
    assert prompt =~ "daemon owns the awaiting transition"
    assert prompt =~ "Run:   adhoc-1770000000000"
  end

  test "resolve_resume_intent forces :fresh for ad-hoc dispatch even with a resumable session" do
    # An ad-hoc run is "do this responsibility right now" work. The prior
    # session's transcript may have wrapped on a "Run accepted. Exiting"
    # turn — resuming there leads to an idle worker that says "nothing new
    # on the fiber" instead of running the responsibility afresh. The
    # ad-hoc branch must short-circuit to :fresh regardless of any
    # `session_uuid`/`dispatched_at` the fiber's shuttle: block carries.
    fiber =
      %{
        "shuttle" => %{
          "kind" => "standing",
          "session_uuid" => "11111111-2222-3333-4444-555555555555",
          "dispatched_at" => iso_now()
        }
      }

    assert Dispatcher.resolve_resume_intent(
             {:standing_run, "adhoc-1770000000000", :ad_hoc},
             "tests/haiku",
             fiber
           ) == :fresh
  end

  test "resolve_resume_intent defers to check_resume_intent for non-ad-hoc dispatches" do
    # The delegation boundary: anything other than {:standing_run, _, :ad_hoc}
    # takes the continuation-decision path. With no shuttle fields there's nothing
    # to resume and the deterministic result is :fresh — but it's the path taken
    # that matters.
    fiber = %{}

    # Scheduled standing run: defer
    assert Dispatcher.resolve_resume_intent(
             {:standing_run, "20260508T070000+0000"},
             "tests/haiku",
             fiber
           ) == :fresh

    # Plain constitution dispatch: defer
    assert Dispatcher.resolve_resume_intent(:constitution, "tests/haiku", fiber) == :fresh
  end

  describe "check_resume_intent — oneshot resume-on-no-handoff discriminator (frontmatter)" do
    # The continuation state lives in the fiber's `shuttle:` block (the substrate
    # that replaced the per-host marker files): `dispatched_at`/`session_uuid` the
    # daemon stamps at dispatch, `handed_off_at` the worker stamps at clean exit.
    # The decision is a pure read off the polled fiber map — no SHUTTLE_DATA_DIR,
    # no marker files.
    setup do
      # A fiber dispatched at a fixed past instant, carrying the resumable session
      # id — the daemon-at-spawn state. Clean-exit tests add a newer
      # `handed_off_at`; dirty-death tests leave it absent.
      dispatched_at = "2026-06-20T18:00:00.000000Z"
      %{dispatched_at: dispatched_at, session_uuid: "aaaa-bbbb-cccc-dddd"}
    end

    test "resumes the prior session when the worker died without a handoff", ctx do
      # A dispatch stamp but no `handed_off_at` after it → died mid-thought →
      # resume the transcript rather than loop a fresh worker.
      assert {:previous, "aaaa-bbbb-cccc-dddd"} =
               Dispatcher.check_resume_intent("task", dispatched_fiber(ctx))
    end

    test "starts fresh when the worker left a clean handoff (handed_off_at >= dispatched_at)", ctx do
      # The worker stamped `handed_off_at` at or after the dispatch → clean close →
      # next worker starts fresh.
      fiber = dispatched_fiber(ctx, %{"handed_off_at" => "2026-06-20T18:05:00.000000Z"})
      assert :fresh = Dispatcher.check_resume_intent("task", fiber)
    end

    test "an explicit resume_mode=fresh directive overrides the dirty-death resume", ctx do
      # A dispatch stamp with no handoff after it — the dirty-death state
      # decide_continuation reads as "resume". But the human clicked "New
      # session", carrying resume_mode=fresh as a dispatch parameter. That
      # explicit directive must win over the autonomous heuristic: "New session"
      # always means a new session, never resume. This is the remote-machine bug —
      # workers there die without a handoff, so every "New session" silently
      # resumed the dead transcript.
      assert :fresh =
               Dispatcher.check_resume_intent("task", dispatched_fiber(ctx), resume_mode: "fresh")
    end

    test "resume_mode=previous resumes the shuttle block's session", ctx do
      # The human clicked "Resume previous". The session id comes from
      # `shuttle.session_uuid` the daemon stamped (the worker never knew its UUID).
      assert {:previous, "aaaa-bbbb-cccc-dddd"} =
               Dispatcher.check_resume_intent("task", dispatched_fiber(ctx), resume_mode: "previous")
    end

    test "resume_mode=previous with no session_uuid surfaces the missing-id error", _ctx do
      # "Resume previous" but the fiber carries no `session_uuid` → there is no
      # session to resume. Surface :missing_session_id rather than silently
      # starting fresh ("New session" is the explicit fresh path).
      fiber = %{"shuttle" => %{"kind" => "oneshot"}}

      assert {:error, :missing_session_id} =
               Dispatcher.check_resume_intent("task", fiber, resume_mode: "previous")
    end

    test "a standing role is never auto-resumed (fresh even with no handoff)", ctx do
      # Scope guard: only oneshots use this mechanism. A standing role dispatches
      # discrete scheduled occurrences — always fresh.
      fiber = dispatched_fiber(ctx, %{"kind" => "standing"})
      assert :fresh = Dispatcher.check_resume_intent("task", fiber)
    end

    test "no prior session (first run) starts fresh", _ctx do
      # No `session_uuid`/`dispatched_at` on the fiber → no session id to resume →
      # fresh.
      fiber = %{"shuttle" => %{"kind" => "oneshot"}}
      assert :fresh = Dispatcher.check_resume_intent("fresh-task", fiber)
    end
  end

  test "render_resume_prompt names the fiber and repeats the exit contract" do
    # No felt history available in test env (no .felt index) — context
    # blocks suppress to empty; the framing block still renders.
    prompt = Dispatcher.render_resume_prompt("tests/haiku")

    assert prompt =~ "Shuttle resumed your previous session"
    assert prompt =~ "Fiber: tests/haiku"
    assert prompt =~ "already loaded in your transcript"
    assert prompt =~ "Exit Contract"
    assert prompt =~ "kill $PPID"
    assert prompt =~ "A normal chat final response is not a worker exit"

    # Resume prompt deliberately omits the fresh-dispatch orientation —
    # skills, conventions, and the constitution are already in scope.
    refute prompt =~ "The orchestration system Shuttle dispatched you"
  end

  # ── Resume-warning dismiss in run script ──

  test "build_run_script with dismiss_resume_warning embeds backgrounded send-keys" do
    script =
      Dispatcher.build_run_script("tests/haiku", "claude --resume 'abc'", "claude-sonnet",
        dismiss_resume_warning: true,
        session: "haiku-shuttle"
      )

    assert script =~ "sleep 2"
    assert script =~ "tmux send-keys -t 'haiku-shuttle' Enter"
    # The dismiss block runs in the background (suffixed with `&`) so it
    # doesn't block the harness command itself.
    assert script =~ ") &"
  end

  test "build_run_script without dismiss_resume_warning emits no send-keys" do
    script =
      Dispatcher.build_run_script("tests/haiku", "claude --resume 'abc'", "claude-sonnet",
        dismiss_resume_warning: false,
        session: "haiku-shuttle"
      )

    refute script =~ "send-keys"
  end

  test "build_run_script for a headless worker skips the client-wait gate and dismiss send-keys" do
    # Headless `-p` workers run unattended — no human client ever attaches, so
    # the 10s wait-for-client gate would only burn its timeout, and the
    # resume-warning dismiss send-keys has no TTY warning page to dismiss.
    script =
      Dispatcher.build_run_script("tests/haiku", "claude -p --resume 'abc'", "claude-haiku",
        dismiss_resume_warning: false,
        headless: true,
        session: "haiku-shuttle"
      )

    refute script =~ "WAIT_DEADLINE"
    refute script =~ "list-clients"
    refute script =~ "send-keys"
  end

  test "build_run_script with no opts (fresh dispatch path) emits no send-keys" do
    # Default opts = [] → dismiss_resume_warning defaults to false. This is
    # the path fresh dispatch takes, so fresh workers never get the dismiss.
    script = Dispatcher.build_run_script("tests/haiku", "claude <<< 'hi'", "claude-sonnet")
    refute script =~ "send-keys"
  end

  test "build_run_script can show a project-local fiber handle in the worker banner" do
    script =
      Dispatcher.build_run_script(
        "ai-futures/shuttle/constitution-shuttle-ctl-ux-fixes",
        "codex exec",
        "codex",
        display_fiber_id: "constitution-shuttle-ctl-ux-fixes"
      )

    assert script =~ "Shuttle worker — constitution-shuttle-ctl-ux-fixes"
    refute script =~ "Shuttle worker — ai-futures/shuttle/constitution-shuttle-ctl-ux-fixes"
  end

  # ── Wait-for-client guard before harness start ──

  test "build_run_script with session waits for a non-control client before the harness" do
    # Without this wait, the harness initializes inside the detached
    # session's 80x24 default-size and bakes its dispatch banner into
    # scrollback at 80 cols — the symptom that drove this gate in.
    script =
      Dispatcher.build_run_script("tests/haiku", "claude --resume 'abc'", "claude-sonnet",
        session: "haiku-shuttle"
      )

    assert script =~ "tmux list-clients -t 'haiku-shuttle'"
    # Filter out tmux's control-mode clients (Portolan's wterm preview
    # uses `tmux -C attach -r` and would otherwise satisfy the wait
    # without a real human terminal attached).
    assert script =~ "client_control_mode"
    assert script =~ "grep -qx '0'"
    # Bounded wait: autonomous dispatches still proceed if no human
    # attaches in time.
    assert script =~ "WAIT_DEADLINE"
    # The wait precedes the start banner so the banner renders at the
    # attached client's terminal size, not at 80x24.
    [wait_idx, banner_idx] =
      Enum.map(["WAIT_DEADLINE", "Shuttle worker —"], fn needle ->
        :binary.match(script, needle) |> elem(0)
      end)

    assert wait_idx < banner_idx
  end

  test "build_run_script with no session skips the wait" do
    # spawn_tmux always passes a session, but the function defaults
    # session to "" — guard against accidental no-session callers
    # spinning forever on a session that doesn't exist.
    script = Dispatcher.build_run_script("tests/haiku", "claude <<< 'hi'", "claude-sonnet")
    refute script =~ "tmux list-clients"
    refute script =~ "WAIT_DEADLINE"
  end

  # ── Capture (spawn-without-constitution) ──

  test "render_capture_prompt carries the yap, store, claim call, and contract" do
    prompt =
      Dispatcher.render_capture_prompt("make the board sing\nwith two lines",
        session: "capture-ab12cd34",
        felt_store: "/Users/x/loom",
        port: 4123,
        session_uuid: "uuid-cap-1",
        agent_id: "claude-opus",
        project_dir: "/Users/x/projects/portolan",
        host: "test-host"
      )

    # The yap, verbatim, in the From User block.
    assert prompt =~ "make the board sing\n  with two lines"
    assert prompt =~ "From User"
    # Crystallize instructions + anchors.
    assert prompt =~ "Felt store: /Users/x/loom"
    assert prompt =~ "Project dir: /Users/x/projects/portolan"
    assert prompt =~ "kind: oneshot"
    assert prompt =~ "agent: claude-opus"
    assert prompt =~ "host: test-host"
    # The claim callback, with this session's identity baked in.
    assert prompt =~ "http://localhost:4123/api/v1/claim"
    assert prompt =~ ~s("tmux_session": "capture-ab12cd34")
    assert prompt =~ ~s("session_uuid": "uuid-cap-1")
    # Worker exit contract present (capture sessions become ordinary workers).
    assert prompt =~ "kill $PPID"
  end

  test "capture spawns a non-shuttle-suffixed session with the prompt in the run script" do
    {:ok, %{session: session, session_uuid: uuid, agent_id: "claude-sonnet"}} =
      Dispatcher.capture("an idea", runner: MockRunner, work_dir: "/tmp", felt_store: "/tmp")

    assert session =~ ~r/^capture-[0-9a-f]{8}$/
    refute String.ends_with?(session, "-shuttle")
    assert is_binary(uuid)

    {_, args} =
      Enum.find(MockRunner.commands(), fn {cmd, args} ->
        cmd == "tmux" and hd(args) == "new-session"
      end)

    assert Enum.at(args, 3) == session
    assert Enum.at(args, 5) == "/tmp"

    # The run script (written to disk, handed to tmux) carries the yap and
    # the claim call with this session's identity baked in.
    script = File.read!(List.last(args))
    assert script =~ "an idea"
    assert script =~ "/api/v1/claim"
    assert script =~ session
    assert script =~ uuid
  end

  test "capture renders requested axes into the command and the install-block step" do
    {:ok, %{session: _}} =
      Dispatcher.capture("an idea",
        runner: MockRunner,
        work_dir: "/tmp",
        felt_store: "/tmp",
        agent: "claude-opus",
        effort: "xhigh",
        chrome: true
      )

    {_, args} =
      Enum.find(MockRunner.commands(), fn {cmd, args} ->
        cmd == "tmux" and hd(args) == "new-session"
      end)

    script = File.read!(List.last(args))
    # Axes rendered on the CLI invocation.
    assert script =~ "--effort 'xhigh'"
    assert script =~ "--chrome"
    # Axes recorded in the crystallize instructions so the fiber reproduces them.
    assert script =~ "`effort: xhigh`"
    assert script =~ "`chrome: true`"
  end

  # A wedged felt (runner :timeout) is a server-side failure, never a client
  # error: it must NOT surface as {:invalid_axes, _} (the HTTP layer maps that
  # to 422) but as a binary reason (500-shaped).
  defmodule TimeoutRunner do
    @behaviour Shuttle.Runner
    def cmd("felt", _args, _opts), do: {"felt … timed out after 60000ms", :timeout}
  end

  test "capture axes-resolve timeout stays 500-shaped, not invalid_axes" do
    assert {:error, reason} =
             Dispatcher.capture("an idea",
               runner: TimeoutRunner,
               work_dir: "/tmp",
               felt_store: "/tmp",
               agent: "claude-sonnet"
             )

    refute match?({:invalid_axes, _}, reason)
    assert reason =~ "timed out"
  end

  test "capture rejects axes outside the agent's constraints" do
    assert {:error, {:invalid_axes, reason}} =
             Dispatcher.capture("an idea",
               runner: MockRunner,
               work_dir: "/tmp",
               felt_store: "/tmp",
               agent: "codex",
               chrome: true
             )

    assert reason =~ "chrome not supported"

    assert {:error, {:invalid_axes, reason2}} =
             Dispatcher.capture("an idea",
               runner: MockRunner,
               work_dir: "/tmp",
               felt_store: "/tmp",
               agent: "claude-opus",
               effort: "bogus"
             )

    assert reason2 =~ "effort bogus not allowed"
  end

  # ── Continuation test helpers ──

  # An RFC3339 UTC timestamp for `now` — the format the daemon stamps into
  # `shuttle.dispatched_at` / `handed_off_at`.
  defp iso_now, do: DateTime.to_iso8601(DateTime.utc_now())

  # A oneshot fiber map carrying the daemon-at-dispatch shuttle fields (session
  # uuid + dispatched_at from the test context), with `extra` merged over them
  # (e.g. a `handed_off_at`, or `kind: standing`).
  defp dispatched_fiber(ctx, extra \\ %{}) do
    %{
      "shuttle" =>
        Map.merge(
          %{
            "kind" => "oneshot",
            "session_uuid" => ctx.session_uuid,
            "dispatched_at" => ctx.dispatched_at
          },
          extra
        )
    }
  end
end
