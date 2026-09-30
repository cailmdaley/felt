defmodule Shuttle.DispatcherTest do
  use ExUnit.Case

  alias Shuttle.Dispatcher
  alias Shuttle.Test.FiberUid

  require Shuttle.Dispatcher
  alias Shuttle.Agents

  # ── Mock Runner ──

  defmodule MockRunner do
    import Shuttle.Test.TmuxSessions

    @behaviour Shuttle.Runner

    use Agent

    @empty %{
      commands: [],
      tmux_sessions: MapSet.new(),
      # Wrapper tokens the mock login bash resolves to something other than an
      # executable — keyed token → what `type -t` reports, or `:missing` /
      # `:wedged`. Everything not listed resolves as a plain `file` on PATH,
      # which is what the vast majority of tests want.
      wrapper_kinds: %{},
      # Whether THIS host has a tmux server, as `tmux ls` would answer:
      # `:present` (the default — every pre-existing test predates the macOS
      # tmux-server preflight and must be unaffected), `:absent` (tmux's own
      # no-server message) or `:timeout`.
      tmux_server: :present
    }

    def start_link(_ \\ []) do
      Agent.start_link(fn -> @empty end, name: __MODULE__)
    end

    def reset do
      Agent.update(__MODULE__, fn _ -> @empty end)
    end

    @doc """
    Makes the mock login bash report `kind` for `wrapper` — `:missing` (nothing
    of that name in a `bash -l` environment), `:wedged` (the probe never
    answers), or a `type -t` word like `"alias"` / `"function"`.
    """
    def set_wrapper_kind(wrapper, kind) do
      Agent.update(__MODULE__, fn state ->
        %{state | wrapper_kinds: Map.put(state.wrapper_kinds, wrapper, kind)}
      end)
    end

    def wrapper_kinds do
      Agent.get(__MODULE__, & &1.wrapper_kinds)
    end

    @doc """
    Sets what `tmux ls` reports about a tmux SERVER on this host — `:present`,
    `:absent` or `:timeout`. Distinct from `add_tmux_session/1`, which is about
    a named session on an existing server.
    """
    def set_tmux_server(state) when state in [:present, :absent, :timeout] do
      Agent.update(__MODULE__, fn s -> %{s | tmux_server: state} end)
    end

    def tmux_server do
      Agent.get(__MODULE__, & &1.tmux_server)
    end

    @doc "Records a non-runner side effect (a kitty launch) in command order."
    def record(command, args) do
      Agent.update(__MODULE__, fn s -> %{s | commands: s.commands ++ [{command, args}]} end)
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
    # Felt show returns ordinary frontmatter without a resolved facet; the
    # separate `shuttle show -j` response includes `shuttle.resolved.agent`.
    # `felt show --field shuttle` emits structured values as YAML; `--field
    # tags` emits sequences of scalars one-per-line. The command handler below
    # provides the corresponding shapes for both CLI names. Shuttle resolves
    # each dispatchable fiber's agent; these fixtures carry that resolved record
    # with the same omitted-false keys as Shuttle JSON.
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
      "model" => "deepseek/deepseek-v4-flash-latest"
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
        # Closed fiber whose `shuttle reopen` shell-out fails (see the
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
      "tests/collaborative" => %{
        status: "active",
        tags: ["constitution"],
        collaboration: %{
          "collaborator" => %{
            "uid" => "01KTS261GJMMRDRHS2QDMEFV3K",
            "origin" => "host-a"
          },
          "role" => %{"uid" => "01KTS261GJMMRDRHS2QDMEFV3M", "origin" => "host-b"}
        },
        shuttle: %{"resolved" => %{"agent" => @claude_sonnet_resolved}}
      },
      "tests/readable-collaborative" => %{
        status: "active",
        tags: ["constitution"],
        collaboration: %{"vizier" => ["fable", "astra"], "organizer" => ["opus"]},
        shuttle: %{"resolved" => %{"agent" => @claude_sonnet_resolved}}
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
        # A free-form `pi` tag still rides the fiber, but Shuttle's resolved
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
      # A fiber with no intrinsic id (a hand-made file never backfilled), and
      # one whose id is not a ULID: neither has a worker session name.
      "tests/no-uid" => %{
        status: "active",
        tags: ["constitution"],
        uid: nil,
        shuttle: %{"resolved" => %{"agent" => @claude_sonnet_resolved}}
      },
      "tests/bad-uid" => %{
        status: "active",
        tags: ["constitution"],
        uid: "not-a-ulid",
        shuttle: %{"resolved" => %{"agent" => @claude_sonnet_resolved}}
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
        command in ["felt", "shuttle"] ->
          handle_cli(args)

        # The wrapper preflight: `bash -lc "type -t -- '<wrapper>'"`. Modeled
        # faithfully — zero exit and a kind word when the token resolves in a
        # login shell, non-zero and no output when it does not.
        command == "bash" ->
          handle_wrapper_probe(args)

        command == "tmux" and hd(args) == "has-session" ->
          session = Enum.at(args, 2)

          if tmux_session_exists?(tmux_sessions(), session) do
            {"", 0}
          else
            {"can't find session", 1}
          end

        # `Shuttle.TmuxServer.presence/1` — is a tmux SERVER running here?
        command == "tmux" and hd(args) == "ls" ->
          case tmux_server() do
            :present ->
              {Enum.join(tmux_sessions(), "\n") <> "\n", 0}

            :absent ->
              {"error connecting to /tmp/tmux-501/default (No such file or directory)", 1}

            :timeout ->
              {"tmux ls timed out after 60000ms", :timeout}
          end

        command == "tmux" and hd(args) == "new-session" ->
          session = Enum.at(args, 3)
          add_tmux_session(session)
          {"", 0}

        true ->
          {"", 0}
      end
    end

    defp handle_wrapper_probe(["-lc", script]) do
      wrapper = probed_wrapper(script)

      case Map.get(wrapper_kinds(), wrapper, "file") do
        # `type -t` prints nothing and exits non-zero when the token resolves
        # to nothing at all.
        :missing -> {"", 1}
        :wedged -> {"bash timed out", :timeout}
        kind -> {kind <> "\n", 0}
      end
    end

    defp handle_wrapper_probe(_args), do: {"", 0}

    # Pull the single-quoted token back out of `type -t -- 'claude'`.
    defp probed_wrapper(script) do
      case Regex.run(~r/type -t -- '(.*)'\z/, script) do
        [_, wrapper] -> String.replace(wrapper, "'\\''", "'")
        _ -> script
      end
    end

    defp handle_cli(["agents", "resolve" | rest]) do
      # Stub of `shuttle agents resolve <name> [--effort E] [--chrome] --json`.
      # Here we cover only the axes the capture tests exercise, returning the
      # resolved.agent JSON shape or the CLI's descriptive refusal.
      name = hd(rest)
      effort = flag_value(rest, "--effort")
      chrome = "--chrome" in rest

      cond do
        # A broken registry entry: neither cli nor wrapper, so there is nothing
        # for the preflight to probe.
        name == "no-wrapper" ->
          {Jason.encode!(%{"id" => "no-wrapper", "model" => "sonnet"}), 0}

        name == "codex" and chrome ->
          {"chrome not supported by agent codex (claude harness only)", 1}

        name == "claude-opus" and effort == "bogus" ->
          {"effort bogus not allowed for agent claude-opus (allowed: low, medium, high, xhigh, max)",
           1}

        name == "claude-opus" ->
          resolved = %{
            "id" => "claude-opus",
            "cli" => "claude",
            "wrapper" => "claude",
            "model" => "opus"
          }

          resolved = if is_binary(effort), do: Map.put(resolved, "effort", effort), else: resolved
          resolved = if chrome, do: Map.put(resolved, "chrome", true), else: resolved
          {Jason.encode!(resolved), 0}

        true ->
          # Any other registered name resolves as a plain claude agent.
          {Jason.encode!(%{
             "id" => name,
             "cli" => "claude",
             "wrapper" => "claude",
             "model" => "opus"
           }), 0}
      end
    end

    defp handle_cli(args) do
      fiber_id = Enum.find(args, &Map.has_key?(@test_fibers, &1))

      cond do
        is_nil(fiber_id) ->
          {"fiber not found", 1}

        # `shuttle reopen tests/reopen-fails` fails — the store rejects
        # the reopen. The dispatcher must treat this as fatal for a closed
        # fiber and abort before any tmux spawn.
        "reopen" in args and fiber_id == "tests/reopen-fails" ->
          {"reopen: could not reopen fiber in store", 1}

        # `shuttle show <id> --json` includes the resolved agent alongside
        # the parsed fiber fields. The dispatcher reads `shuttle.agent` and
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
            |> maybe_put("collaboration", Map.get(fiber, :collaboration))
            |> maybe_put("uid", Map.get(fiber, :uid, Shuttle.Test.FiberUid.for(fiber_id)))

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

  # ── Stub kitty ──

  # The kitty seam `Shuttle.TmuxServer` starts a tmux server through, injected
  # via `config :shuttle, :kitty_impl`. Records each background launch (in
  # MockRunner's command order, so "kitty first, then new-session" is
  # assertable) and, on success, flips the mock host to having a server — which
  # is exactly what a real `kitty @ launch tmux new-session` does.
  defmodule StubKitty do
    use Agent

    def start_link(_ \\ []), do: Agent.start_link(fn -> {:ok, []} end, name: __MODULE__)

    def set_result(result), do: Agent.update(__MODULE__, fn {_r, l} -> {result, l} end)

    def launches, do: Agent.get(__MODULE__, fn {_r, l} -> l end)

    def run_background(argv) do
      MockRunner.record("kitty", ["@", "launch", "--type=background", "--"] ++ argv)

      Agent.get_and_update(__MODULE__, fn {result, launches} ->
        {result, {result, launches ++ [argv]}}
      end)
      |> case do
        :ok ->
          MockRunner.set_tmux_server(:present)
          :ok

        other ->
          other
      end
    end
  end

  # The one darwin gate in `Shuttle.TmuxServer`, injectable so both branches run
  # on either platform.
  defp set_os_type(os_type), do: Application.put_env(:shuttle, :os_type, os_type)

  # ── Setup ──

  setup do
    start_supervised!(MockRunner)
    MockRunner.reset()

    # `default_felt_store/0` resolves through `FeltStores.configured_stores/0`,
    # which reads the SHUTTLE_STORES env / persisted stores.json — NOT the injected
    # test runner. On a machine with a configured loom it returns a store; in a
    # bare CI environment it returns [] → `default_felt_store/0` is nil, and a
    # dispatch has no store to read the fiber from.
    # Pin a store here so store resolution is deterministic regardless of the
    # host's felt config; delete on exit so the setting never leaks to other
    # suites (the persistent_term cache in configured_stores/0 is keyed by the
    # base config, so a differing base on the next suite recomputes cleanly).
    prev_stores = System.get_env("SHUTTLE_STORES")
    System.put_env("SHUTTLE_STORES", "/tmp")

    sessions_file =
      Path.join(
        System.tmp_dir!(),
        "shuttle-dispatcher-ledger-#{System.unique_integer([:positive])}.jsonl"
      )

    prev_sessions_file = System.get_env("SHUTTLE_SESSIONS_FILE")
    System.put_env("SHUTTLE_SESSIONS_FILE", sessions_file)

    start_supervised!(StubKitty)
    Application.put_env(:shuttle, :kitty_impl, StubKitty)

    on_exit(fn ->
      if prev_stores,
        do: System.put_env("SHUTTLE_STORES", prev_stores),
        else: System.delete_env("SHUTTLE_STORES")

      Application.delete_env(:shuttle, :kitty_impl)
      Application.delete_env(:shuttle, :os_type)

      if prev_sessions_file,
        do: System.put_env("SHUTTLE_SESSIONS_FILE", prev_sessions_file),
        else: System.delete_env("SHUTTLE_SESSIONS_FILE")

      File.rm(sessions_file)
      File.rm(sessions_file <> ".1")
    end)

    :ok
  end

  # ── Tests ──

  test "worker entrypoint carries invocation data without duplicated workflow" do
    prompt = Dispatcher.render_prompt("tests/haiku", felt_store: "/tmp/store")
    assert prompt =~ "You are a Shuttle worker. Activate the felt and shuttle skills"
    assert prompt =~ "Fiber: tests/haiku"
    assert prompt =~ "Felt store: /tmp/store"
    assert prompt =~ "Kind: oneshot; surface: cli; headless: false"
    refute prompt =~ "Exit Contract"
    refute prompt =~ "shuttle handoff"
    refute prompt =~ "──"
  end

  test "render_prompt carries the previous-session lineage line only when one exists" do
    prev = %{uuid: "0883ade1-08e0-4457-94c6-7ac12137eb0f", harness: "claude-code"}

    with_lineage = Dispatcher.render_prompt("tests/haiku", previous_session: prev)

    assert with_lineage =~
             "Previous session: 0883ade1-08e0-4457-94c6-7ac12137eb0f (claude-code)"

    # Lineage sits UNDER the store line — fiber, store, then the pointer to
    # what came before.
    assert :binary.match(with_lineage, "Felt store:") |> elem(0) <
             :binary.match(with_lineage, "Previous session:") |> elem(0)

    # Ledger-less fallback carries no harness label — no "()" litter.
    unlabeled =
      Dispatcher.render_prompt("tests/haiku",
        previous_session: %{uuid: "0883ade1-08e0-4457-94c6-7ac12137eb0f", harness: nil}
      )

    assert unlabeled =~ "Previous session: 0883ade1-08e0-4457-94c6-7ac12137eb0f"

    # First dispatch: no line at all.
    refute Dispatcher.render_prompt("tests/haiku") =~ "Previous session:"

    # Resume prompts never carry it — the resumed worker IS the previous session.
    refute Dispatcher.render_resume_prompt("tests/haiku", previous_session: prev) =~
             "Previous session:"

    # Standing runs carry it too — last run's session is real lineage.
    standing =
      Dispatcher.render_standing_run_prompt("tests/haiku", "2026-08-16T06:00",
        previous_session: prev
      )

    assert standing =~ "Previous session: 0883ade1-08e0-4457-94c6-7ac12137eb0f (claude-code)"
  end

  test "role and surface metadata select the skill's exit semantics" do
    assert Dispatcher.render_prompt("tests/a", kind: "pinned") =~ "Kind: pinned"
    assert Dispatcher.render_prompt("tests/a", surface: "app") =~ "surface: app"
    assert Dispatcher.render_prompt("tests/a") =~ "Kind: oneshot"
  end

  test "headless is explicit invocation data" do
    assert Dispatcher.render_prompt("tests/a", headless: true) =~ "headless: true"
    assert Dispatcher.render_prompt("tests/a") =~ "headless: false"
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

  test "fresh, resumed, and standing prompts point at assigned collaboration without snapshotting it" do
    collaboration =
      {:ok,
       %{
         "collaborator" => %{"uid" => "01KTS261GJMMRDRHS2QDMEFV3K"},
         "role" => %{"uid" => "01KTS261GJMMRDRHS2QDMEFV3M", "origin" => "old-host"}
       }}

    for prompt <- [
          Dispatcher.render_prompt("tests/a",
            collaboration: collaboration,
            felt_store: "/tmp/loom"
          ),
          Dispatcher.render_resume_prompt("tests/a",
            collaboration: collaboration,
            felt_store: "/tmp/loom"
          ),
          Dispatcher.render_standing_run_prompt("tests/a", "run-1",
            collaboration: collaboration,
            felt_store: "/tmp/loom"
          )
        ] do
      assert prompt =~
               "Collaboration: collaborator 01KTS261GJMMRDRHS2QDMEFV3K, " <>
                 "role 01KTS261GJMMRDRHS2QDMEFV3M; role store: /tmp/loom"

      refute prompt =~ "felt -C"
      refute prompt =~ "old-host"
      refute prompt =~ "response.host"
    end

    refute Dispatcher.render_prompt("tests/a") =~ "Collaboration:"
    refute Dispatcher.render_resume_prompt("tests/a") =~ "Collaboration:"
    refute Dispatcher.render_standing_run_prompt("tests/a", "run-1") =~ "Collaboration:"
  end

  test "readable collaboration prompts name a singleton actor and hide multi-role rosters" do
    singleton = {:ok, %{"vizier" => ["fable"]}}
    multi = {:ok, %{"vizier" => ["fable", "astra"], "organizer" => ["opus"]}}

    singleton_prompt =
      Dispatcher.render_prompt("tests/a", collaboration: singleton, felt_store: "/tmp/loom")

    # Role fibers resolve through the store's realpath; on macOS /tmp is /private/tmp.
    assert singleton_prompt =~
             ~r"Collaboration: fable in role vizier; role store: (/private)?/tmp/loom\z"

    for prompt <- [
          Dispatcher.render_prompt("tests/a", collaboration: multi),
          Dispatcher.render_resume_prompt("tests/a", collaboration: multi),
          Dispatcher.render_standing_run_prompt("tests/a", "run-1", collaboration: multi)
        ] do
      assert prompt =~ "Collaboration: several assignments on the roster"
      refute prompt =~ "vizier"
      refute prompt =~ "fable"
      refute prompt =~ "astra"
      refute prompt =~ "organizer"
      refute prompt =~ "opus"
    end
  end

  test "worker prompt entrypoints carry this dispatch's facts and no static instructions" do
    prompts = [
      Dispatcher.render_prompt("tests/a", felt_store: "/tmp/shared loom"),
      Dispatcher.render_resume_prompt("tests/a", felt_store: "/tmp/shared loom"),
      Dispatcher.render_standing_run_prompt("tests/a", "run-1", felt_store: "/tmp/shared loom")
    ]

    Enum.each(prompts, fn prompt ->
      assert prompt =~ "You are a Shuttle worker. Activate the felt and shuttle skills."
      assert prompt =~ "Fiber: tests/a"
      assert prompt =~ "Felt store: /tmp/shared loom"
      # Syncing and reading the fiber are the skill's Survey step.
      refute prompt =~ "sync"
      refute prompt =~ "felt -C"
      refute prompt =~ "show <UID>"
      refute prompt =~ "standing-roles.md"
    end)
  end

  test "the fresh prompt is exactly its dispatch facts" do
    assert Dispatcher.render_prompt("tests/a",
             felt_store: "/tmp/store",
             previous_session: %{uuid: "0883ade1-08e0-4457-94c6-7ac12137eb0f", harness: "pi"}
           ) ==
             String.trim_trailing("""
             You are a Shuttle worker. Activate the felt and shuttle skills.
             Fiber: tests/a
             Felt store: /tmp/store
             Kind: oneshot; surface: cli; headless: false
             Previous session: 0883ade1-08e0-4457-94c6-7ac12137eb0f (pi)
             """)
  end

  test "a cut-off previous session is named with its transcript" do
    uuid = "0883ade1-08e0-4457-94c6-7ac12137eb0f"
    path = "/home/u/.claude/projects/-x/#{uuid}.jsonl"

    prompt =
      Dispatcher.render_prompt("tests/a",
        felt_store: "/tmp/store",
        previous_session: %{uuid: uuid, harness: "claude-code", cut_off: true, transcript: path}
      )

    assert prompt =~
             "Previous session: #{uuid} (claude-code) ended without a handoff (host outage, kill, or crash).\n" <>
               "Its transcript, to consult as needed after reading Status: #{path}"

    missing =
      Dispatcher.render_prompt("tests/a",
        previous_session: %{uuid: uuid, harness: nil, cut_off: true, transcript: nil}
      )

    assert missing =~
             "Previous session: #{uuid} ended without a handoff (host outage, kill, or crash); " <>
               "its transcript is not on this host."

    # A resume never names a predecessor, cut off or not.
    refute Dispatcher.render_resume_prompt("tests/a",
             previous_session: %{uuid: uuid, cut_off: true, transcript: path}
           ) =~ "Previous session"
  end

  test "dispatch snapshots collaboration and selected execution recipe into its ledger row" do
    assert {:ok, _} = Dispatcher.dispatch("tests/collaborative", runner: MockRunner)

    assert [record] = Shuttle.SessionLedger.read_since(0)
    assert record["agent"] == "claude-sonnet"
    assert record["model"] == "sonnet"

    assert record["collaboration"] == %{
             "collaborator" => %{
               "uid" => "01KTS261GJMMRDRHS2QDMEFV3K",
               "origin" => "host-a"
             },
             "role" => %{"uid" => "01KTS261GJMMRDRHS2QDMEFV3M", "origin" => "host-b"}
           }
  end

  test "dispatch snapshots the readable collaboration participation map unchanged" do
    assert {:ok, _} = Dispatcher.dispatch("tests/readable-collaborative", runner: MockRunner)

    assert [record] = Shuttle.SessionLedger.read_since(0)
    assert record["collaboration"] == %{"vizier" => ["fable", "astra"], "organizer" => ["opus"]}
  end

  test "render_prompt omits the From User block when no user_message is carried" do
    # With no `:user_message` dispatch parameter, the user-message block
    # suppresses to an empty string, leaving just the header.
    prompt = Dispatcher.render_prompt("tests/haiku")
    refute prompt =~ "From User"
  end

  test "render_prompt inlines the carried user_message as a From User block" do
    # The user's directive rides the dispatch as a transient parameter,
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
             work_dir
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
             work_dir
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

  test "session_name/2 has no name for a fiber without a ULID uid" do
    assert Dispatcher.session_name("tests/haiku", nil) == nil
    assert Dispatcher.session_name("tests/haiku", "") == nil
    assert Dispatcher.session_name("tests/haiku", "not-a-ulid") == nil
  end

  test "the name session_name/2 produces is exactly the name shuttle_session?/1 recognizes" do
    uid = "01KTHDNZS287ZSSG8X8V59XKWB"
    name = Dispatcher.session_name("tests/haiku", uid)

    assert Dispatcher.shuttle_session?(name)
    assert Shuttle.ULID.from_tmux(name) == uid

    for other <- ["haiku-shuttle", "haiku-01J-shuttle", "capture-deadbeef", "resume-#{uid}"] do
      refute Dispatcher.shuttle_session?(other), "#{other} must not read as a worker session"
    end
  end

  test "dispatch creates tmux session for eligible fiber" do
    result = Dispatcher.dispatch("tests/haiku", runner: MockRunner)
    assert result == {:ok, FiberUid.session("tests/haiku")}

    commands = MockRunner.commands()

    assert {"shuttle", ["-C", "/tmp", "show", "tests/haiku", "--json"]} in commands

    assert Enum.any?(commands, fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  # ── Wrapper preflight ──
  #
  # The dispatch path's worst silent failure: the run script invokes the agent's
  # wrapper as a bare token under `bash -l`. If nothing of that name resolves
  # there — the wrapper was never installed, or it is a shell function defined
  # only in the user's zsh/fish config — the tmux session spawns and dies inside
  # a second, `tmux new-session` still exits 0, and the board shows nothing at
  # all. These tests pin the preflight that turns that into a loud refusal.

  test "dispatch preflights the wrapper in a login bash before spawning tmux" do
    assert Dispatcher.dispatch("tests/haiku", runner: MockRunner) ==
             {:ok, FiberUid.session("tests/haiku")}

    commands = MockRunner.commands()

    # The probe must run through a LOGIN bash — the whole point is to test the
    # environment the run script gets, where a profile-sourced shell function
    # counts as resolution just as much as an executable on PATH.
    assert Enum.any?(commands, fn
             {"bash", ["-lc", script]} -> script =~ "type -t -- 'claude'"
             _ -> false
           end)

    # And it must run BEFORE the spawn, not alongside it.
    probe_at = Enum.find_index(commands, &match?({"bash", ["-lc", _]}, &1))
    spawn_at = Enum.find_index(commands, &match?({"tmux", ["new-session" | _]}, &1))
    assert probe_at < spawn_at
  end

  test "dispatch refuses loudly and spawns no tmux session when the wrapper does not resolve" do
    MockRunner.set_wrapper_kind("claude", :missing)

    assert {:error, {:wrapper_unresolved, message}} =
             Dispatcher.dispatch("tests/haiku", runner: MockRunner)

    # The message is the whole deliverable: it must name the wrapper, say where
    # it was looked for, and point at the fix.
    assert message =~ "claude"
    assert message =~ "bash -l"
    assert message =~ "agents.json"

    # No zombie: the session must never have been created.
    refute Enum.any?(MockRunner.commands(), &match?({"tmux", ["new-session" | _]}, &1))
    assert MockRunner.tmux_sessions() == MapSet.new()
  end

  test "dispatch refuses a wrapper that resolves only as a shell alias" do
    # `type` reports an alias, but the run script is a NON-interactive login
    # bash, which does not expand aliases — so an alias probes "resolved" and
    # still dies at launch. Same silent failure, so it gets the same refusal.
    MockRunner.set_wrapper_kind("claude", "alias")

    assert {:error, {:wrapper_unresolved, message}} =
             Dispatcher.dispatch("tests/haiku", runner: MockRunner)

    assert message =~ "ALIAS"
    assert message =~ "does not expand aliases"
    refute Enum.any?(MockRunner.commands(), &match?({"tmux", ["new-session" | _]}, &1))
  end

  test "a wedged login shell does not read as a missing wrapper" do
    # A timeout is never evidence of absence (Shuttle.Runner's contract). An
    # overloaded machine whose login shell is slow must not have every dispatch
    # refused with "your wrapper is missing" — the dispatch proceeds and the
    # spawn reports whatever it actually finds.
    MockRunner.set_wrapper_kind("claude", :wedged)

    assert Dispatcher.dispatch("tests/haiku", runner: MockRunner) ==
             {:ok, FiberUid.session("tests/haiku")}

    assert Enum.any?(MockRunner.commands(), &match?({"tmux", ["new-session" | _]}, &1))
  end

  test "a resume is preflighted too — a missing wrapper cannot spawn a resume session" do
    # Resume renders the same wrapper token into the same login-bash script, so
    # it fails exactly the same way and must be guarded on the same path.
    MockRunner.set_wrapper_kind("claude", :missing)

    assert {:error, {:wrapper_unresolved, _}} =
             Dispatcher.dispatch("tests/haiku", runner: MockRunner, resume_mode: "previous")

    refute Enum.any?(MockRunner.commands(), &match?({"tmux", ["new-session" | _]}, &1))
  end

  test "capture refuses to spawn when the wrapper does not resolve" do
    MockRunner.set_wrapper_kind("claude", :missing)

    assert {:error, {:wrapper_unresolved, message}} =
             Dispatcher.capture("an idea", runner: MockRunner, work_dir: "/tmp")

    assert message =~ "claude"
    refute Enum.any?(MockRunner.commands(), &match?({"tmux", ["new-session" | _]}, &1))
  end

  test "a work_dir that is not on this host is named, not blamed on the wrapper" do
    # The probe runs with `cd: work_dir`, so a missing directory makes it fail
    # in exactly the shape a missing wrapper does — non-zero, no output. Without
    # its own check the operator would be told to fix a harness that is fine,
    # when the real fact is that the checkout lives on another machine. Reachable
    # via force-dispatch, which skips the Poller's project_dir gate.
    missing = "/definitely/not/a/directory/on/this/host"

    assert {:error, {:work_dir_missing, message}} =
             Dispatcher.dispatch("tests/haiku", runner: MockRunner, work_dir: missing)

    assert message =~ missing
    assert message =~ "project_dir"
    # Distinctly NOT a wrapper accusation.
    refute message =~ "bash -l"

    # It must refuse before spending a login shell on the probe, and before tmux.
    refute Enum.any?(MockRunner.commands(), &match?({"bash", ["-lc", _]}, &1))
    refute Enum.any?(MockRunner.commands(), &match?({"tmux", ["new-session" | _]}, &1))
  end

  test "a multi-token wrapper is probed by its command word, not as one quoted token" do
    # `build_command/3` interpolates the wrapper UNQUOTED, so `env FOO=1 claude`
    # is a legitimate record: bash resolves `env` and passes the rest along.
    # Quoting the whole string into one token — as the first cut of the probe
    # did — would refuse a wrapper that works.
    assert {"bash", ["-lc", script]} = Agents.wrapper_probe(%{wrapper: "env FOO=1 claude"})
    assert script == "type -t -- 'env'"
  end

  test "wrapper_probe answers :none for a record with no wrapper instead of raising" do
    assert Agents.wrapper_probe(%{wrapper: nil}) == :none
    assert Agents.wrapper_probe(%{wrapper: "   "}) == :none
    assert Agents.wrapper_probe(nil) == :none
  end

  test "an agent record naming nothing to invoke is refused with its own message" do
    # felt fills `wrapper` from `cli`, so a record with neither is a broken
    # registry entry. It must be refused by name rather than raising out of the
    # probe builder.
    assert {:error, {:wrapper_unresolved, message}} =
             Dispatcher.capture("an idea",
               runner: MockRunner,
               work_dir: "/tmp",
               agent: "no-wrapper"
             )

    assert message =~ "no-wrapper"
    assert message =~ "registry record is incomplete"
    refute Enum.any?(MockRunner.commands(), &match?({"tmux", ["new-session" | _]}, &1))
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

  test "dispatch refuses a fiber without an intrinsic id, naming the fix, before touching tmux" do
    for {fiber, fix} <- [
          {"tests/no-uid", "felt backfill-ids"},
          {"tests/bad-uid", "is not a ULID"}
        ] do
      MockRunner.reset()

      assert {:error, {:uid_missing, message}} = Dispatcher.dispatch(fiber, runner: MockRunner)
      assert Dispatcher.refusal?(:uid_missing, message)
      assert message =~ fiber
      assert message =~ fix

      refute Enum.any?(MockRunner.commands(), &match?({"tmux", _}, &1)),
             "a refused dispatch must not probe or spawn tmux"
    end

    # A forced dispatch is refused just the same — force overrides status,
    # not the missing worker name — and never reopens the fiber first.
    MockRunner.reset()

    assert {:error, {:uid_missing, _}} =
             Dispatcher.dispatch("tests/no-uid", runner: MockRunner, force: true)

    refute Enum.any?(MockRunner.commands(), fn {_, args} -> "reopen" in args end)
  end

  test "dispatch refuses closed fiber" do
    result = Dispatcher.dispatch("tests/closed", runner: MockRunner)
    assert {:error, :closed} = result
  end

  test "dispatch with force: true on a closed fiber shells out to shuttle reopen" do
    # The kanban Resume button on an awaitingReview / closed card flows here
    # with force=true. Without the reopen step, the worker spawns but the
    # YAML stays closed and `classifyFiber` keeps the card pinned
    # in its prior column — see KanbanModal.runRequeue's comment about why
    # this side-effect is daemon-owned. The contract: force-dispatch on a
    # not-already-clean fiber issues `shuttle reopen <fiber>` before
    # tmux new-session fires.
    result = Dispatcher.dispatch("tests/closed", runner: MockRunner, force: true)
    assert {:ok, _session} = result

    commands = MockRunner.commands()

    reopen_call =
      Enum.find(commands, fn
        {"shuttle", args} -> "reopen" in args and "tests/closed" in args
        _ -> false
      end)

    assert reopen_call != nil, "expected shuttle reopen call; got #{inspect(commands)}"

    # Shuttle resolves host identity locally, so the daemon's reopen command
    # needs no `--host` override. `-C <store>` selects the fiber's store.
    {"shuttle", reopen_args} = reopen_call
    refute "--host" in reopen_args, "reopen must not pass --host; got #{inspect(reopen_args)}"
    assert "-C" in reopen_args

    # And it must precede tmux new-session — reopen-then-spawn, not the other way.
    reopen_index =
      Enum.find_index(commands, fn
        {"shuttle", args} -> "reopen" in args
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
        force: true
      )

    assert {:ok, _session} = result

    refute Enum.any?(MockRunner.commands(), fn
             {"shuttle", args} -> "reopen" in args
             _ -> false
           end),
           "expected no shuttle reopen on already-clean fiber; got #{inspect(MockRunner.commands())}"
  end

  test "dispatch with force: true aborts when reopen of a closed fiber fails" do
    # Authoritative reopen: a closed fiber whose `shuttle reopen` exits
    # non-zero must ABORT the dispatch — never spawn a worker with no live
    # mandate (the doomed "terminal opens and immediately closes" worker).
    result = Dispatcher.dispatch("tests/reopen-fails", runner: MockRunner, force: true)
    assert {:error, :reopen_failed} = result

    commands = MockRunner.commands()

    assert Enum.any?(commands, fn
             {"shuttle", args} -> "reopen" in args and "tests/reopen-fails" in args
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
    # Without a felt store there is no fiber to read, let alone reopen — the
    # dispatch aborts rather than spawning a worker against a still-closed
    # fiber.
    result = Dispatcher.dispatch("tests/closed", runner: MockRunner, force: true, felt_store: nil)
    assert {:error, :not_found} = result

    commands = MockRunner.commands()

    refute Enum.any?(commands, fn
             {"shuttle", args} -> "reopen" in args
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
    MockRunner.add_tmux_session(FiberUid.session("tests/haiku"))

    result = Dispatcher.dispatch("tests/haiku", runner: MockRunner)
    assert {:error, :already_running} = result
  end

  test "dispatch does not treat child fiber session as already-running parent" do
    MockRunner.add_tmux_session(FiberUid.session("tests/haiku/child"))

    result = Dispatcher.dispatch("tests/haiku", runner: MockRunner)
    assert result == {:ok, FiberUid.session("tests/haiku")}

    assert Enum.any?(MockRunner.commands(), fn
             {"tmux", ["has-session", "-t", "=" <> session]} ->
               session == FiberUid.session("tests/haiku")

             _ ->
               false
           end)
  end

  test "dispatch reads Shuttle's resolved pi agent (pi-tagged fiber)" do
    result = Dispatcher.dispatch("tests/pi-tagged", runner: MockRunner)
    assert {:ok, session} = result
    assert session == FiberUid.session("tests/pi-tagged")

    # Verify the tmux new-session command was issued
    commands = MockRunner.commands()

    {_, args} =
      Enum.find(commands, fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)

    assert hd(args) == "new-session"
  end

  test "dispatch uses Shuttle's resolved agent (claude-opus) when present" do
    assert {:ok, _session} = Dispatcher.dispatch("tests/shuttle-agent-block", runner: MockRunner)
    script = read_run_script_for(FiberUid.session("tests/shuttle-agent-block"))
    assert script =~ "agent=claude-opus"
    refute script =~ "agent=claude-sonnet"
  end

  test "dispatch: Shuttle's resolved.agent (claude-opus) wins over a free-form tag" do
    assert {:ok, _session} =
             Dispatcher.dispatch("tests/shuttle-agent-overrides-tag", runner: MockRunner)

    script = read_run_script_for(FiberUid.session("tests/shuttle-agent-overrides-tag"))
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

  # Shuttle owns resolution and inlines the effective record as `shuttle.resolved.agent`
  # JSON. These tests exercise the daemon's job — turning that record into the
  # harness shell command — so they build it via Agents.from_resolved/1, exactly
  # the production path. A resolved record carries the effective axes already
  # overlaid (effort/chrome/headless), which is Shuttle's responsibility, not
  # the daemon's; the daemon only renders what it's handed.
  defp resolved(fields), do: Agents.from_resolved(fields)

  # The two four-key base records these tests reuse verbatim.
  defp claude_sonnet,
    do:
      resolved(%{
        "id" => "claude-sonnet",
        "cli" => "claude",
        "wrapper" => "claude",
        "model" => "sonnet"
      })

  defp codex,
    do:
      resolved(%{
        "id" => "codex",
        "cli" => "codex",
        "wrapper" => "codex",
        "model" => "gpt-5.5-codex"
      })

  test "build_command for claude uses here-string" do
    agent = claude_sonnet()

    cmd = Agents.build_command(agent, "hello world")
    assert cmd =~ "claude"
    assert cmd =~ "<<<"
    assert cmd =~ "'hello world'"
  end

  test "build_command for codex uses positional arg" do
    agent = codex()

    cmd = Agents.build_command(agent, "hello world")
    assert cmd =~ "codex"
    refute cmd =~ "<<<"
    assert cmd =~ "'hello world'"
  end

  test "build_command for codex luna selects the luna model" do
    agent =
      resolved(%{
        "id" => "codex-luna",
        "cli" => "codex",
        "wrapper" => "codex",
        "model" => "gpt-6-luna"
      })

    cmd = Agents.build_command(agent, "hello world")
    assert cmd =~ "codex"
    assert cmd =~ "--model 'gpt-6-luna'"
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
        "model" => "moonshotai/kimi-latest"
      })

    cmd = Agents.build_command(agent, "hello world")
    assert cmd =~ "pi"
    assert cmd =~ "--provider 'openrouter'"
    assert cmd =~ "--model 'moonshotai/kimi-latest'"
  end

  # ── Axis rendering (effort × chrome × headless) per harness ──
  #
  # Shuttle resolves the axes; these assert the daemon renders an already-resolved
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
      resolved(%{
        "id" => "pi-kimi",
        "cli" => "pi",
        "wrapper" => "pi",
        "model" => "moonshotai/kimi-latest",
        "effort" => "high"
      })

    cmd = Agents.build_command(agent, "hi")
    assert cmd =~ "--model 'moonshotai/kimi-latest:high'"
    refute cmd =~ "--effort"
  end

  test "codex renders effort via -c model_reasoning_effort" do
    agent =
      resolved(%{
        "id" => "codex",
        "cli" => "codex",
        "wrapper" => "codex",
        "model" => "gpt-5.5-codex",
        "effort" => "high"
      })

    cmd = Agents.build_command(agent, "hi")
    assert cmd =~ ~s(-c model_reasoning_effort='high')
  end

  test "resolved chrome renders --chrome" do
    # Shuttle resolved the claude-opus base with chrome:true; the daemon renders it.
    agent =
      resolved(%{
        "id" => "claude-opus",
        "cli" => "claude",
        "wrapper" => "claude",
        "model" => "opus",
        "chrome" => true
      })

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
    agent = claude_sonnet()

    cmd = Agents.build_resume_command(agent, "abc-123", "")
    assert cmd =~ "claude"
    assert cmd =~ "--resume 'abc-123'"
    refute cmd =~ "<<<"
  end

  test "build_resume_command for claude with prompt: pipes via here-string" do
    agent = claude_sonnet()

    cmd = Agents.build_resume_command(agent, "abc-123", "address the typo")
    assert cmd =~ "--resume 'abc-123'"
    assert cmd =~ "<<< 'address the typo'"
  end

  test "build_resume_command for claude with whitespace-only prompt: treated as empty" do
    agent = claude_sonnet()

    cmd = Agents.build_resume_command(agent, "abc-123", "   \n  ")
    refute cmd =~ "<<<"
  end

  test "build_resume_command for codex with prompt: positional arg" do
    agent = codex()

    cmd = Agents.build_resume_command(agent, "abc-123", "address the typo")
    assert cmd =~ "codex"
    assert cmd =~ "resume 'abc-123'"
    assert cmd =~ "'address the typo'"
    refute cmd =~ "<<<"
  end

  test "build_resume_command for codex with empty prompt: resume only" do
    agent = codex()

    cmd = Agents.build_resume_command(agent, "abc-123", "")
    assert cmd =~ "resume 'abc-123'"
    # No trailing prompt arg.
    assert String.trim_trailing(cmd) |> String.ends_with?("'abc-123'")
  end

  test "build_resume_command for pi with prompt: positional arg" do
    agent =
      resolved(%{
        "id" => "pi-kimi",
        "cli" => "pi",
        "wrapper" => "pi",
        "provider" => "openrouter",
        "model" => "moonshotai/kimi-latest"
      })

    cmd = Agents.build_resume_command(agent, "abc-123", "address the typo")
    assert cmd =~ "--session 'abc-123'"
    assert cmd =~ "'address the typo'"
    # stdin would flip pi into print mode; the message must stay positional.
    refute cmd =~ "<<<"
  end

  test "build_resume_command for pi with empty prompt: session only" do
    agent =
      resolved(%{
        "id" => "pi-kimi",
        "cli" => "pi",
        "wrapper" => "pi",
        "provider" => "openrouter",
        "model" => "moonshotai/kimi-latest"
      })

    cmd = Agents.build_resume_command(agent, "abc-123", "")
    assert cmd =~ "--session 'abc-123'"
    assert String.trim_trailing(cmd) |> String.ends_with?("'abc-123'")
    refute cmd =~ "<<<"
  end

  test "build_resume_command/2 default-arg form still works (zero-arg prompt)" do
    agent = claude_sonnet()

    cmd = Agents.build_resume_command(agent, "abc-123")
    assert cmd =~ "--resume 'abc-123'"
    refute cmd =~ "<<<"
  end

  # ── Resume prompt rendering ──

  test "standing launch carries run identity" do
    prompt = Dispatcher.render_standing_run_prompt("tests/haiku", "run-2026-05-06")
    assert prompt =~ "Fiber: tests/haiku"
    assert prompt =~ "Run: run-2026-05-06"
    assert prompt =~ "Run mode: scheduled"
    assert prompt =~ "Kind: standing"
    refute prompt =~ "shuttle handoff"
  end

  test "standing launch distinguishes ad-hoc from scheduled runs" do
    prompt = Dispatcher.render_standing_run_prompt("tests/haiku", "adhoc-1", ad_hoc: true)
    assert prompt =~ "Run mode: ad-hoc"
    assert prompt =~ "Run: adhoc-1"
    refute prompt =~ "review.state"
    refute prompt =~ "next_due_at"
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
             fiber
           ) == :fresh

    # Plain constitution dispatch: defer
    assert Dispatcher.resolve_resume_intent(:constitution, fiber) == :fresh
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

    @now ~U[2026-06-20 19:00:00Z]

    # An injected transcript lookup: a file last written `age_s` seconds before
    # @now, or none (`nil`).
    defp transcript(nil), do: fn _session -> nil end

    defp transcript(age_s) do
      fn session ->
        %{path: "/t/#{session}.jsonl", mtime: DateTime.add(@now, -age_s, :second)}
      end
    end

    defp intent(fiber, age_s, opts \\ []),
      do:
        Dispatcher.check_resume_intent(
          fiber,
          Keyword.merge([transcript: transcript(age_s), now: @now], opts)
        )

    test "a died-without-handoff session with a warm transcript is resumed", ctx do
      assert {:previous, "aaaa-bbbb-cccc-dddd"} = intent(dispatched_fiber(ctx), 60)

      # The window's edge is still warm (45 minutes by default).
      assert {:previous, _} = intent(dispatched_fiber(ctx), 45 * 60)
    end

    test "a died-without-handoff session with a cold transcript goes fresh, naming it", ctx do
      assert {:cold, "aaaa-bbbb-cccc-dddd", "/t/aaaa-bbbb-cccc-dddd.jsonl"} =
               intent(dispatched_fiber(ctx), 45 * 60 + 1)
    end

    test "a died-without-handoff session with no transcript on this host goes fresh", ctx do
      assert {:cold, "aaaa-bbbb-cccc-dddd", nil} = intent(dispatched_fiber(ctx), nil)
    end

    test "the warm window is one application setting", ctx do
      Application.put_env(:shuttle, :resume_warm_window_s, 10)
      on_exit(fn -> Application.delete_env(:shuttle, :resume_warm_window_s) end)

      assert {:previous, _} = intent(dispatched_fiber(ctx), 10)
      assert {:cold, _, _} = intent(dispatched_fiber(ctx), 11)
    end

    test "a clean handoff goes fresh without looking at the transcript", ctx do
      fiber = dispatched_fiber(ctx, %{"handed_off_at" => "2026-06-20T18:05:00.000000Z"})
      assert :fresh = intent(fiber, 60, transcript: fn _ -> flunk("looked up") end)
    end

    test "an app conversation resumes unless handed off, whatever its transcript", ctx do
      app = dispatched_fiber(ctx, %{"surface" => "app"})
      untouched = fn _ -> flunk("app surface looked up a transcript") end

      assert {:previous, "aaaa-bbbb-cccc-dddd"} = intent(app, nil, transcript: untouched)

      handed_off =
        dispatched_fiber(ctx, %{
          "surface" => "app",
          "handed_off_at" => "2026-06-20T18:05:00.000000Z"
        })

      assert :fresh = intent(handed_off, nil, transcript: untouched)
    end

    test "explicit resume_mode wins over the transcript's temperature", ctx do
      assert {:previous, "aaaa-bbbb-cccc-dddd"} =
               intent(dispatched_fiber(ctx), 10 * 3600, resume_mode: "previous")

      assert {:previous, "aaaa-bbbb-cccc-dddd"} =
               intent(dispatched_fiber(ctx), nil, resume_mode: "previous")

      refute match?({:previous, _}, intent(dispatched_fiber(ctx), 60, resume_mode: "fresh"))
    end

    test "a transcript older than the dispatch is not this dispatch's session", ctx do
      # dispatched_at is 18:00; a transcript last written at 17:59:59 belongs to
      # a predecessor whose id a codex/pi launch never replaced. Plain fresh, no
      # cut-off note — the marker's id says nothing about the latest run.
      assert :fresh = intent(dispatched_fiber(ctx), 3601)
      assert :fresh = intent(dispatched_fiber(ctx), 3601, resume_mode: "fresh")
      assert :fresh = intent(dispatched_fiber(ctx), 3601, resume_mode: "continue")

      # Written in the dispatch's own second still counts as this session's.
      assert {:cold, _, _} = intent(dispatched_fiber(ctx), 3600)
    end

    test "resume_mode=continue applies the no-handoff rule to every kind", ctx do
      pinned = dispatched_fiber(ctx, %{"kind" => "pinned"})
      assert {:previous, "aaaa-bbbb-cccc-dddd"} = intent(pinned, 60, resume_mode: "continue")
      assert {:cold, _, _} = intent(pinned, 45 * 60 + 1, resume_mode: "continue")

      handed_off =
        dispatched_fiber(ctx, %{"kind" => "standing", "handed_off_at" => "2026-06-20T18:05:00Z"})

      assert :fresh = intent(handed_off, 60, resume_mode: "continue")

      # Nothing to resume is fresh, never the Resume button's missing-id error.
      assert :fresh =
               intent(%{"shuttle" => %{"kind" => "oneshot"}}, 60, resume_mode: "continue")
    end

    test "resolve_resume_intent passes the transcript lookup through", ctx do
      assert {:cold, _, nil} =
               Dispatcher.resolve_resume_intent(:constitution, dispatched_fiber(ctx),
                 transcript: transcript(nil),
                 now: @now
               )
    end

    test "starts fresh when the worker left a clean handoff (handed_off_at >= dispatched_at)",
         ctx do
      # The worker stamped `handed_off_at` at or after the dispatch → clean close →
      # next worker starts fresh.
      fiber = dispatched_fiber(ctx, %{"handed_off_at" => "2026-06-20T18:05:00.000000Z"})
      assert :fresh = Dispatcher.check_resume_intent(fiber)
    end

    test "resume_mode=fresh never resumes, but names a cut-off session", ctx do
      # "New session" always means a new session — even over a warm transcript
      # the autonomous rule would resume. The prompt still names what was cut off.
      assert {:cold, "aaaa-bbbb-cccc-dddd", "/t/aaaa-bbbb-cccc-dddd.jsonl"} =
               intent(dispatched_fiber(ctx), 60, resume_mode: "fresh")

      assert {:cold, _, nil} = intent(dispatched_fiber(ctx), nil, resume_mode: "fresh")

      clean = dispatched_fiber(ctx, %{"handed_off_at" => "2026-06-20T18:05:00.000000Z"})
      assert :fresh = intent(clean, 60, resume_mode: "fresh")

      app = dispatched_fiber(ctx, %{"surface" => "app"})
      assert :fresh = intent(app, 60, resume_mode: "fresh")
    end

    test "resume_mode=previous resumes the shuttle block's session", ctx do
      # The human clicked "Resume previous". The session id comes from
      # `shuttle.session_uuid` the daemon stamped (the worker never knew its UUID).
      assert {:previous, "aaaa-bbbb-cccc-dddd"} =
               Dispatcher.check_resume_intent(dispatched_fiber(ctx),
                 resume_mode: "previous"
               )
    end

    test "resume_mode=previous with no session_uuid surfaces the missing-id error", _ctx do
      # "Resume previous" but the fiber carries no `session_uuid` → there is no
      # session to resume. Surface :missing_session_id rather than silently
      # starting fresh ("New session" is the explicit fresh path).
      fiber = %{"shuttle" => %{"kind" => "oneshot"}}

      assert {:error, :missing_session_id} =
               Dispatcher.check_resume_intent(fiber, resume_mode: "previous")
    end

    test "a standing role is never auto-resumed (fresh even with no handoff)", ctx do
      # Scope guard: only oneshots use this mechanism. A standing role dispatches
      # discrete scheduled occurrences — always fresh.
      fiber = dispatched_fiber(ctx, %{"kind" => "standing"})
      assert :fresh = Dispatcher.check_resume_intent(fiber)
    end

    test "no prior session (first run) starts fresh", _ctx do
      # No `session_uuid`/`dispatched_at` on the fiber → no session id to resume →
      # fresh.
      fiber = %{"shuttle" => %{"kind" => "oneshot"}}
      assert :fresh = Dispatcher.check_resume_intent(fiber)
    end
  end

  test "resume reloads current constitution and skills" do
    prompt = Dispatcher.render_resume_prompt("tests/haiku")
    assert prompt =~ "You are a Shuttle worker. Activate the felt and shuttle skills"
    assert prompt =~ "Mode: resume\nSync and re-read the fiber before continuing.\n"
    assert prompt =~ "Mode: resume"
    assert prompt =~ "Fiber: tests/haiku"
    refute prompt =~ "Exit Contract"
  end

  test "build_run_script scrubs the daemon's own release ERTS from the worker env" do
    root = "/opt/shuttle it's/bin/rel"

    script =
      Dispatcher.build_run_script("tests/haiku", "claude <<< 'hi'", "claude-sonnet",
        release_root: root
      )

    # The vars `erl` itself exports.
    assert script =~ "unset ROOTDIR BINDIR PROGNAME EMU ESCRIPT_NAME"
    assert script =~ "unset RELEASE_ROOT"

    # It must run BEFORE the harness command, or the damage is already done.
    [scrub_at, command_at] =
      Enum.map(["unset ROOTDIR BINDIR PROGNAME EMU", "claude <<< 'hi'"], fn needle ->
        :binary.match(script, needle) |> elem(0)
      end)

    assert scrub_at < command_at

    # Run the scrub itself against a worker env that inherited the release's
    # PATH and erl's exports but no RELEASE_ROOT — the shape a daemon-launched
    # worker actually receives.
    inherited =
      Enum.join(
        [
          "#{root}/erts-16.4/bin",
          "#{root}/bin",
          "/usr/bin",
          "#{root}.prev/bin",
          "/bin"
        ],
        ":"
      )

    probe = Dispatcher.erts_scrub_block(root) <> ~s(printf '%s|%s' "$PATH" "${ROOTDIR-unset}")

    {out, 0} =
      System.cmd("/bin/bash", ["-c", probe],
        env: [
          {"PATH", inherited},
          {"ROOTDIR", "#{root}"},
          {"BINDIR", "#{root}/erts-16.4/bin"},
          {"RELEASE_ROOT", nil}
        ]
      )

    assert out == "/usr/bin:#{root}.prev/bin:/bin|unset"
  end

  test "erts_scrub_block drops inherited harness session identity" do
    probe =
      Dispatcher.erts_scrub_block(nil) <>
        ~s(printf '%s|%s|%s|%s|%s' "${AI_AGENT-unset}" "${PI_SESSION_ID-unset}" ) <>
        ~s("${CLAUDE_CODE_SESSION_ID-unset}" "${CLAUDE_SESSION_ID-unset}" "${CODEX_THREAD_ID-unset}")

    {out, 0} =
      System.cmd("/bin/bash", ["-c", probe],
        env: [
          {"AI_AGENT", "pi"},
          {"PI_SESSION_ID", "stale-pi"},
          {"CLAUDE_CODE_SESSION_ID", "stale-claude"},
          {"CLAUDE_SESSION_ID", "stale-claude"},
          {"CODEX_THREAD_ID", "stale-codex"}
        ]
      )

    assert out == "unset|unset|unset|unset|unset"
  end

  test "erts_scrub_block leaves PATH alone with no release root" do
    refute Dispatcher.erts_scrub_block(nil) =~ "PATH="
    assert Dispatcher.erts_scrub_block(nil) =~ "unset ROOTDIR BINDIR PROGNAME EMU ESCRIPT_NAME"
  end

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

  describe "pi session capture" do
    # The encoding was once wrong in the leading slash — /a/b munged to
    # ---a-b-- (three dashes) where pi writes --a-b-- — and every pi dispatch's
    # session-UUID capture timed out, so no ledger line, no resume, and no
    # day-view attribution for any pi worker. This is that bug's tombstone.
    test "pi_sessions_dir encodes the cwd the way pi does" do
      assert Shuttle.HarnessPaths.pi_sessions_dir("/home/user/loom") =~ "--home-user-loom--"
      refute Shuttle.HarnessPaths.pi_sessions_dir("/home/user/loom") =~ "---"

      assert Shuttle.HarnessPaths.pi_sessions_dir("/Users/cd280747/dev/felt") =~
               "--Users-cd280747-dev-felt--"
    end

    @prev %{uuid: "11111111-2222-3333-4444-555555555555", harness: "claude-code"}

    test "a pi dispatch refuses to resume a claude-code session" do
      agent = %{id: "w", cli: "pi", wrapper: "pi"}

      assert Dispatcher.effective_resume_intent({:previous, @prev.uuid}, agent,
               previous_session: @prev
             ) == :fresh
    end

    test "same-harness resume stands, and an unknown harness still tries" do
      claude = %{id: "w", cli: "claude", wrapper: "claude"}
      pi = %{id: "w", cli: "pi", wrapper: "pi"}

      intent = {:previous, @prev.uuid}

      assert Dispatcher.effective_resume_intent(intent, claude, previous_session: @prev) == intent

      assert Dispatcher.effective_resume_intent(intent, pi,
               previous_session: %{uuid: @prev.uuid, harness: nil}
             ) ==
               intent
    end
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
    # used `tmux -C attach -r` and would otherwise have satisfied the wait
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

  test "render_capture_prompt carries the yap, store, claim data, and skill reference" do
    prompt =
      Dispatcher.render_capture_prompt("make the board sing\nwith two lines",
        session: "capture-ab12cd34",
        felt_store: "/Users/x/loom",
        listen: "tcp://127.0.0.1:4123",
        session_uuid: "uuid-cap-1",
        agent_id: "claude-opus",
        project_dir: "/Users/x/projects/portolan",
        host: "test-host"
      )

    # The yap, verbatim, in the From User block.
    assert prompt =~ "make the board sing\nwith two lines"
    assert prompt =~ "From User"
    # Launch metadata and anchors.
    assert prompt =~ "Felt store: /Users/x/loom"
    assert prompt =~ "Project dir: /Users/x/projects/portolan"
    assert prompt =~ ~s("kind":"oneshot")
    assert prompt =~ ~s("agent":"claude-opus")
    assert prompt =~ ~s("host":"test-host")
    # The claim callback, with this session's identity baked in.
    assert prompt =~ "Claim endpoint: http://127.0.0.1:4123/api/v1/claim"
    # On a unix listener the worker has no port; the line carries the socket form.
    unix_prompt =
      Dispatcher.render_capture_prompt("yap",
        session: "capture-ab12cd34",
        felt_store: "/Users/x/loom",
        listen: "unix:///srv/shuttle/sock/daemon.sock",
        agent_id: "claude-opus",
        project_dir: "/Users/x/projects/portolan",
        host: "test-host"
      )

    assert unix_prompt =~
             "Claim endpoint: http://localhost/api/v1/claim via `curl --unix-socket '/srv/shuttle/sock/daemon.sock'`"

    assert prompt =~ ~s("tmux_session":"capture-ab12cd34")
    assert prompt =~ ~s("session_uuid":"uuid-cap-1")
    refute prompt =~ ~s("meeting")
    # Capture behavior is defined once in its reference.
    assert prompt =~ "references/capture.md"
  end

  test "a meeting capture's Claim body carries the meeting's launch id" do
    prompt =
      Dispatcher.render_capture_prompt("Meeting mode (call).",
        session: "capture-ab12cd34",
        felt_store: "/Users/x/loom",
        listen: "tcp://127.0.0.1:4123",
        agent_id: "pi-luna",
        project_dir: "/home/x/loom",
        host: "candide",
        meeting: "launch-xyz"
      )

    [claim_line] = Regex.run(~r/^Claim: (.*)$/m, prompt, capture: :all_but_first)

    assert %{
             "fiber_id" => "<fiber id>",
             "tmux_session" => "capture-ab12cd34",
             "meeting" => "launch-xyz"
           } = claim = Jason.decode!(claim_line)

    refute Map.has_key?(claim, "session_uuid")
  end

  test "capture identity and install metadata roundtrip JSON on both surfaces" do
    message = "  preserve\n\tindent, \"quotes\", $HOME and `code`\n\n"

    opts = [
      session: "capture-one",
      session_uuid: "exact-thread",
      felt_store: "/tmp/store",
      project_dir: "/tmp/project \"quoted\"",
      agent_id: "codex-sol",
      host: "host-a",
      effort: "high",
      chrome: true,
      listen: "tcp://127.0.0.1:4567"
    ]

    for surface <- ["cli", "app"] do
      prompt =
        if surface == "app",
          do: Dispatcher.render_app_capture_prompt(message, opts),
          else: Dispatcher.render_capture_prompt(message, opts)

      assert String.ends_with?(prompt, "From User:\n" <> message)
      assert prompt =~ "references/capture.md"
      assert prompt =~ "Claim endpoint: http://127.0.0.1:4567/api/v1/claim"
      [_, install_json] = Regex.run(~r/^Install: (.+)$/m, prompt)
      [_, claim_json] = Regex.run(~r/^Claim: (.+)$/m, prompt)
      install = Jason.decode!(install_json)
      claim = Jason.decode!(claim_json)

      assert install == %{
               "kind" => "oneshot",
               "surface" => surface,
               "project_dir" => opts[:project_dir],
               "agent" => "codex-sol",
               "host" => "host-a",
               "effort" => "high",
               "chrome" => true
             }

      assert claim["session_uuid"] == "exact-thread"
      assert claim["agent"] == "codex-sol"
      assert claim["fiber_id"] == "<fiber id>"

      if surface == "app" do
        assert claim["surface"] == "app"
        refute Map.has_key?(claim, "tmux_session")
      else
        assert claim["tmux_session"] == "capture-one"
        refute Map.has_key?(claim, "surface")
      end

      refute prompt =~ "shuttle handoff"
      refute prompt =~ "──"
    end
  end

  test "every dispatch preserves nonblank user instructions verbatim" do
    message = " \n    indented\n\tline with \"quotes\" and 'apostrophes'\n\n"
    opts = [user_message: message, felt_store: "/tmp/store"]

    for prompt <- [
          Dispatcher.render_prompt("tests/a", opts),
          Dispatcher.render_resume_prompt("tests/a", opts),
          Dispatcher.render_standing_run_prompt("tests/a", "run-1", opts)
        ] do
      assert String.ends_with?(prompt, "From User:\n" <> message)
    end
  end

  test "capture omits unknown identity and unrequested optional axes" do
    prompt =
      Dispatcher.render_capture_prompt("idea",
        session: "capture-one",
        felt_store: "/tmp/store",
        project_dir: "/tmp/project"
      )

    [_, install_json] = Regex.run(~r/^Install: (.+)$/m, prompt)
    [_, claim_json] = Regex.run(~r/^Claim: (.+)$/m, prompt)
    install = Jason.decode!(install_json)
    claim = Jason.decode!(claim_json)
    for key <- ["host", "chrome", "effort"], do: refute(Map.has_key?(install, key))
    refute Map.has_key?(claim, "session_uuid")
  end

  test "capture spawns a non-shuttle-suffixed session with the prompt in the run script" do
    {:ok, %{session: session, session_uuid: uuid, agent_id: "claude-opus"}} =
      Dispatcher.capture("an idea", runner: MockRunner, work_dir: "/tmp", felt_store: "/tmp")

    assert session =~ ~r/^capture-[0-9a-f]{8}$/
    refute Dispatcher.shuttle_session?(session)
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

  test "capture renders requested axes into the command and install metadata" do
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
    # Explicit axes survive into the new fiber install metadata.
    assert script =~ ~s("effort":"xhigh")
    assert script =~ ~s("chrome":true)
  end

  # A wedged shuttle (runner :timeout) is a server-side failure, never a
  # client error: it must NOT surface as {:invalid_axes, _} (the HTTP layer
  # maps that to 422) but as a binary reason (500-shaped).
  defmodule TimeoutRunner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", _args, _opts), do: {"shuttle … timed out after 60000ms", :timeout}
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

  # ── macOS tmux-server preflight ──
  #
  # The daemon must never be the process that forks the tmux server on macOS:
  # TCC charges every worker's file access to the tree's responsible process,
  # which for a launchd-spawned daemon is the daemon's own binary ("erlexec").
  # So on darwin an absent server is started through kitty, or the dispatch is
  # refused outright.

  describe "tmux server preflight" do
    test "darwin with no server asks kitty first, then spawns the worker" do
      set_os_type({:unix, :darwin})
      MockRunner.set_tmux_server(:absent)

      assert {:ok, session} = Dispatcher.dispatch("tests/haiku", runner: MockRunner)

      # kitty was asked to fork a server holding the anchor session, and the
      # anchor deliberately is NOT a `-shuttle` name (nothing must adopt it).
      assert [argv] = StubKitty.launches()

      assert argv == [
               "tmux",
               "new-session",
               "-d",
               "-s",
               "shuttle-anchor",
               "--",
               "sh",
               "-c",
               "exec sleep 2147483647"
             ]

      refute Dispatcher.shuttle_session?("shuttle-anchor")

      # …and it happened BEFORE the worker's own `tmux new-session`.
      commands = MockRunner.commands()
      kitty_at = Enum.find_index(commands, fn {cmd, _} -> cmd == "kitty" end)

      new_session_at =
        Enum.find_index(commands, fn
          {"tmux", ["new-session" | _]} -> true
          _ -> false
        end)

      assert is_integer(kitty_at)
      assert is_integer(new_session_at)
      assert kitty_at < new_session_at

      # `exit-empty` is disarmed on the server kitty just forked, so it cannot
      # die between here and the worker's own `new-session`.
      assert Enum.any?(commands, &(&1 == {"tmux", ["set-option", "-s", "exit-empty", "off"]}))

      assert session =~ "-shuttle"
    end

    test "darwin with no server and no reachable kitty refuses the dispatch outright" do
      set_os_type({:unix, :darwin})
      MockRunner.set_tmux_server(:absent)
      StubKitty.set_result({:error, "no live kitty remote-control socket"})

      assert {:error, {:tmux_server_unavailable, message}} =
               Dispatcher.dispatch("tests/haiku", runner: MockRunner)

      assert message =~ "kitty"
      assert message =~ "erlexec"

      # Nothing spawned: the refusal is the whole point — a server forked here
      # would poison every worker on it.
      refute Enum.any?(MockRunner.commands(), fn
               {"tmux", ["new-session" | _]} -> true
               _ -> false
             end)

      assert MockRunner.tmux_sessions() == MapSet.new()
    end

    test "darwin with a server already running never touches kitty, but disarms exit-empty" do
      set_os_type({:unix, :darwin})
      MockRunner.set_tmux_server(:present)

      assert {:ok, _session} = Dispatcher.dispatch("tests/haiku", runner: MockRunner)
      assert StubKitty.launches() == []

      # The race this closes: a human-started server with no anchor session
      # exits the moment its last session goes away, which can happen between
      # `tmux ls` answering `:present` and the worker's `new-session` — and that
      # `new-session` would then fork a daemon-rooted server, the one outcome
      # this whole preflight exists to prevent.
      commands = MockRunner.commands()
      assert Enum.any?(commands, &(&1 == {"tmux", ["set-option", "-s", "exit-empty", "off"]}))

      exit_empty_at =
        Enum.find_index(commands, &(&1 == {"tmux", ["set-option", "-s", "exit-empty", "off"]}))

      new_session_at =
        Enum.find_index(commands, fn
          {"tmux", ["new-session" | _]} -> true
          _ -> false
        end)

      assert exit_empty_at < new_session_at
    end

    test "linux keeps today's behaviour exactly — an absent server is not the daemon's business" do
      set_os_type({:unix, :linux})
      MockRunner.set_tmux_server(:absent)

      assert {:ok, _session} = Dispatcher.dispatch("tests/haiku", runner: MockRunner)
      assert StubKitty.launches() == []
    end

    test "an unreadable tmux ls is uncertainty, and uncertainty never blocks" do
      set_os_type({:unix, :darwin})
      MockRunner.set_tmux_server(:timeout)

      assert {:ok, _session} = Dispatcher.dispatch("tests/haiku", runner: MockRunner)
      assert StubKitty.launches() == []

      # And uncertainty touches nothing: there may be no server there to harden.
      refute Enum.any?(MockRunner.commands(), fn
               {"tmux", ["set-option" | _]} -> true
               _ -> false
             end)
    end

    test "capture refuses identically" do
      set_os_type({:unix, :darwin})
      MockRunner.set_tmux_server(:absent)
      StubKitty.set_result({:error, "no live kitty remote-control socket"})

      assert {:error, {:tmux_server_unavailable, message}} =
               Dispatcher.capture("an idea",
                 runner: MockRunner,
                 work_dir: "/tmp",
                 felt_store: "/tmp"
               )

      assert message =~ "kitty"
      assert MockRunner.tmux_sessions() == MapSet.new()
    end
  end

  # ── Continuation test helpers ──

  # An RFC3339 UTC timestamp for `now` — the format the daemon stamps into
  # `shuttle.dispatched_at` / `handed_off_at`.
  defp iso_now, do: DateTime.to_iso8601(DateTime.utc_now())

  # A oneshot fiber map carrying the daemon-at-dispatch shuttle fields (session
  # uuid + dispatched_at from the test context), nested under shuttle.runtime.
  # `extra` merges over the
  # whole shuttle map for config keys (e.g. `kind: standing`) EXCEPT the
  # runtime-key names, which route into the nested runtime block instead (e.g.
  # a clean-exit test's `handed_off_at`).
  @runtime_key_names ~w(dispatched_at session_uuid handed_off_at run_id)

  defp dispatched_fiber(ctx, extra \\ %{}) do
    {runtime_extra, config_extra} = Map.split(extra, @runtime_key_names)

    %{
      "shuttle" =>
        Map.merge(
          %{
            "kind" => "oneshot",
            "runtime" =>
              Map.merge(
                %{"session_uuid" => ctx.session_uuid, "dispatched_at" => ctx.dispatched_at},
                runtime_extra
              )
          },
          config_extra
        )
    }
  end
end
