defmodule Shuttle.PollerTest do
  use ExUnit.Case

  alias Shuttle.ActionQueries
  alias Shuttle.Poller
  alias Shuttle.Poller.Snapshot
  alias Shuttle.Dispatcher

  # ── Mock Runner ──

  defmodule MockRunner do
    @behaviour Shuttle.Runner

    use Agent

    def start_link(_ \\ []) do
      Agent.start_link(
        fn ->
          %{
            commands: [],
            tmux_sessions: MapSet.new(),
            fibers: %{},
            shuttle: %{},
            felt_ls: [],
            felt_ls_stderr_warning: false,
            felt_ls_delay_ms: 0,
            new_session_delay_ms: 0
          }
        end,
        name: __MODULE__
      )
    end

    def reset do
      # Remove any fiber files written by set_shuttle so tests start clean.
      File.rm_rf("/tmp/.felt")

      Agent.update(__MODULE__, fn _ ->
        %{
          commands: [],
          tmux_sessions: MapSet.new(),
          fibers: %{},
          shuttle: %{},
          felt_ls: [],
          felt_ls_stderr_warning: false,
          felt_ls_delay_ms: 0,
          new_session_delay_ms: 0
        }
      end)
    end

    # Carry a felt-style absolute `path` so the poller's store-ownership check
    # (which reads felt's `path`) sees the fiber as rooted in `/tmp`. Preserves
    # an existing path when `set_shuttle` already wrote one, and synthesizes the
    # canonical `<id>/<leaf>.md` shape otherwise, mirroring real felt's output.
    def set_fiber(id, fiber) do
      Agent.update(__MODULE__, fn state ->
        existing_path = get_in(state.fibers, [id, "path"])
        path = Map.get(fiber, "path") || existing_path || synth_path(id)
        put_in(state.fibers[id], Map.put(fiber, "path", path))
      end)
    end

    defp synth_path(id) do
      leaf = id |> String.split("/") |> List.last()
      realpath(Path.join(["/tmp/.felt", id, "#{leaf}.md"]))
    end

    # Write a real .md file carrying the given shuttle: block and felt status so
    # the poller can discover host ownership from the filesystem while reading
    # shuttle metadata through the mocked `felt ls` / `felt show` JSON surfaces.
    # The status defaults to "active" — pass an explicit value for tests that
    # verify eligibility gates (closed, untracked, etc.).
    def set_shuttle(id, yaml, status \\ "active") do
      # Post-cutover, every installed block carries an explicit `host:` equal
      # to the owning daemon's own_host_id (the strict eligibility predicate
      # has no nil-wildcard). The factory mirrors that: a block whose YAML
      # omits `host:` is stamped with the test daemon's identity
      # ("test-host", set via SHUTTLE_HOST in config/test.exs) so generic
      # dispatch tests stay eligible. Host-specific tests pass an explicit
      # `host:` line, which wins.
      yaml =
        if Regex.match?(~r/^\s*host\s*:/m, yaml) do
          yaml
        else
          String.trim_trailing(yaml) <> "\nhost: test-host\n"
        end

      felt_dir = "/tmp/.felt"
      segments = String.split(id, "/")
      basename = List.last(segments)
      dir_path = Path.join([felt_dir | segments] ++ ["#{basename}.md"])
      File.mkdir_p!(Path.dirname(dir_path))
      indented = yaml |> String.trim() |> String.split("\n") |> Enum.map_join("\n", &("  " <> &1))
      File.write!(dir_path, "---\nstatus: #{status}\nshuttle:\n#{indented}\n---\nbody\n")

      # Mirror real felt: carry the absolute, symlink-resolved on-disk `path`.
      # The poller reads this `path` to decide store ownership instead of
      # walking the filesystem, so the mock's `felt ls`/`felt show` JSON must
      # expose it the same way the real CLI now does.
      carried_path = realpath(dir_path)

      shuttle_block =
        case YamlElixir.read_from_string(yaml) do
          {:ok, data} when is_map(data) -> data
          _ -> %{}
        end

      Agent.update(__MODULE__, fn state ->
        fiber =
          state.fibers
          |> Map.get(id, %{
            "id" => id,
            "name" => id,
            "created_at" => "2026-04-28T00:00:00Z",
            "tags" => ["constitution"]
          })
          |> Map.put("status", status)
          |> Map.put("shuttle", shuttle_block)
          |> Map.put("path", carried_path)

        state
        |> put_in([:shuttle, id], yaml)
        |> put_in([:fibers, id], fiber)
      end)
    end

    # Merge scalar continuation fields into a fiber's parsed `shuttle:` block —
    # the in-memory analog of the daemon stamping `dispatched_at`/`session_uuid`
    # (or the worker stamping `handed_off_at`) into the fiber's frontmatter. The
    # poller reads these straight off the `felt show -j` map, so updating the map
    # is what the continuation/orphan readers see on the next poll.
    #
    # C5: nests runtime-key fields under `shuttle.runtime`, mirroring real felt's
    # on-disk shape (Stage 5 — `mark-runtime` only ever writes nested) now that
    # `Shuttle.Continuation`'s readers no longer fall back to flat. Any
    # non-runtime key in `fields` (there are none among current callers, but
    # keeping this generic) still merges at the top level.
    @runtime_key_names ~w(dispatched_at session_uuid handed_off_at run_id)

    def put_shuttle_fields(id, fields) do
      {runtime_fields, config_fields} = Map.split(fields, @runtime_key_names)

      Agent.update(__MODULE__, fn state ->
        fiber = Map.get(state.fibers, id) || %{"id" => id, "shuttle" => %{}}
        shuttle = Map.get(fiber, "shuttle") || %{}
        runtime = Map.merge(Map.get(shuttle, "runtime") || %{}, runtime_fields)

        shuttle =
          shuttle
          |> Map.merge(config_fields)
          |> Map.put("runtime", runtime)

        put_in(state.fibers[id], Map.put(fiber, "shuttle", shuttle))
      end)
    end

    # The full fiber map for `id` (carries `path`), for tests that read back what
    # a write path (e.g. the claim's frontmatter stamp) wrote to the real file.
    def fiber(id), do: Agent.get(__MODULE__, &Map.get(&1.fibers, id))

    # Absolute, symlink-resolved path of a written fiber file, computed with the
    # SAME resolver the poller uses for store ownership (Shuttle.Realpath). This
    # keeps both sides in agreement on every OS: on macOS `/tmp` → `/tmp`,
    # on Linux `/tmp` stays `/tmp`. A hardcoded /tmp→/tmp rewrite passed
    # only on macOS and dropped every fiber as unowned on Linux CI.
    defp realpath(path) do
      expanded = Path.expand(path)

      case Shuttle.Realpath.resolve(expanded) do
        {:ok, resolved} -> resolved
        {:error, _} -> expanded
      end
    end

    # Kept for backward compat; no longer consulted by discover_candidates
    # (discovery now walks files for shuttle: blocks).  Still used by the
    # mock's felt ls handler which other code paths may call.
    def set_felt_ls(fibers), do: Agent.update(__MODULE__, &%{&1 | felt_ls: fibers})

    def set_felt_ls_stderr_warning(enabled),
      do: Agent.update(__MODULE__, &Map.put(&1, :felt_ls_stderr_warning, enabled))

    # Simulate a wedged felt on an overloaded node: every `felt ls` variant
    # returns the bounded runner's timeout shape ({message, :timeout}) while
    # `felt show` keeps answering — the exact incident profile the poller's
    # last-known-candidate retention degrades through.
    def set_felt_ls_timeout(enabled),
      do: Agent.update(__MODULE__, &Map.put(&1, :felt_ls_timeout, enabled))

    def set_felt_ls_delay(ms),
      do: Agent.update(__MODULE__, &Map.put(&1, :felt_ls_delay_ms, ms))

    # Simulate a wedged tmux: `tmux ls` returns the bounded runner's timeout
    # shape. The session list is then UNKNOWN — the poller must skip its
    # destructive/reconciling scans, never read it as "no sessions".
    def set_tmux_ls_timeout(enabled),
      do: Agent.update(__MODULE__, &Map.put(&1, :tmux_ls_timeout, enabled))

    def add_tmux_session(session),
      do: Agent.update(__MODULE__, &%{&1 | tmux_sessions: MapSet.put(&1.tmux_sessions, session)})

    def remove_tmux_session(session),
      do:
        Agent.update(__MODULE__, &%{&1 | tmux_sessions: MapSet.delete(&1.tmux_sessions, session)})

    def set_new_session_delay(ms),
      do: Agent.update(__MODULE__, &Map.put(&1, :new_session_delay_ms, ms))

    # Force `tmux kill-session` to fail. The message atoms mimic tmux's own
    # "session/server already gone" exits — every one of these kill_session must
    # still treat as success: `:not_found`/`:no_such` are per-session phrasings,
    # `:no_server` is tmux with no server at all. Any boolean value simulates a
    # genuine kill failure (e.g. a zombie process tmux couldn't reap).
    def set_kill_session_failure(:not_found),
      do:
        Agent.update(
          __MODULE__,
          &Map.put(&1, :kill_session_failure, {"can't find session: nope", 1})
        )

    def set_kill_session_failure(:no_such),
      do:
        Agent.update(
          __MODULE__,
          &Map.put(&1, :kill_session_failure, {"no such session: shuttle-x", 1})
        )

    def set_kill_session_failure(:no_server),
      do:
        Agent.update(
          __MODULE__,
          &Map.put(&1, :kill_session_failure, {"no server running on /tmp/tmux-501/default", 1})
        )

    def set_kill_session_failure(enabled) when is_boolean(enabled),
      do:
        Agent.update(
          __MODULE__,
          &Map.put(&1, :kill_session_failure, enabled && {"tmux: hung up", 1})
        )

    # S2: override what `felt shuttle contract` reports, for tests exercising
    # the boot-time contract handshake. Must be called BEFORE the poller
    # starts (init/1 probes once, synchronously). `level` is the raw stdout
    # string (a mismatched integer, or garbage to exercise "unparseable");
    # `exit_status` defaults to 0 (a nonzero exit is a separate skew shape).
    def set_contract_level(level, exit_status \\ 0) when is_binary(level),
      do:
        Agent.update(__MODULE__, &(&1 |> Map.put(:contract_level, level) |> Map.put(:contract_exit, exit_status)))

    def commands, do: Agent.get(__MODULE__, & &1.commands)

    # Real felt inlines a fully-resolved `shuttle.resolved.agent` on every fiber
    # with a shuttle facet (felt show -j) and serves the registry via `felt
    # shuttle agents [resolve]`. The daemon reads those records and no longer
    # resolves names itself, so the mock synthesizes them — keyed off the block's
    # `agent` name (default claude-sonnet). Only the command-rendering keys
    # matter (id/cli/wrapper/model); axes are absent here. Defined before `cmd`
    # so the attribute is in scope where the felt-resolve branch reads it.
    @resolved_agents %{
      "claude-sonnet" => %{
        "id" => "claude-sonnet",
        "cli" => "claude",
        "wrapper" => "claude",
        "model" => "sonnet"
      },
      "claude-opus" => %{
        "id" => "claude-opus",
        "cli" => "claude",
        "wrapper" => "claude",
        "model" => "opus"
      },
      "claude-haiku" => %{
        "id" => "claude-haiku",
        "cli" => "claude",
        "wrapper" => "claude",
        "model" => "haiku"
      },
      "codex" => %{
        "id" => "codex",
        "cli" => "codex",
        "wrapper" => "codex",
        "model" => "gpt-5.5-codex"
      }
    }

    @impl true
    def cmd(command, args, opts) do
      Agent.update(__MODULE__, fn state ->
        %{state | commands: state.commands ++ [{command, args}]}
      end)

      full_args = Enum.join(args, " ")

      cond do
        # S2 boot-time contract handshake (`Shuttle.Poller.init/1`, via
        # `Shuttle.Contract.check/1`). The mock reports the current expected
        # level by default — matching, not skewed — so tests that don't care
        # about S2 aren't silently quarantined by it. Tests that DO want a
        # skew set `:contract_level`/`:contract_exit` before starting the
        # poller — see the S2 tests.
        command == "felt" and match?(["shuttle", "contract"], args) ->
          level = Agent.get(__MODULE__, &Map.get(&1, :contract_level, "2"))
          {level, Agent.get(__MODULE__, &Map.get(&1, :contract_exit, 0))}

        # `felt shuttle agents resolve <name> ...` — the capture path's no-fiber
        # resolution. The daemon shells felt (registry owner) rather than
        # re-resolving; the mock returns felt's resolved.agent JSON shape. These
        # poller tests only exercise the default capture agent (claude-sonnet).
        command == "felt" and match?(["shuttle", "agents", "resolve" | _], args) ->
          name = Enum.at(args, 3)
          record = Map.get(@resolved_agents, name, @resolved_agents["claude-sonnet"])
          {Jason.encode!(record), 0}

        command == "felt" and match?(["shuttle", "agents" | _], args) ->
          {Jason.encode!(Map.values(@resolved_agents)), 0}

        command == "felt" and String.contains?(full_args, "ls") and
            Agent.get(__MODULE__, &Map.get(&1, :felt_ls_timeout, false)) ->
          {"felt #{full_args} timed out after 60000ms", :timeout}

        command == "felt" and String.contains?(full_args, "ls") ->
          delay_ms = Agent.get(__MODULE__, &Map.get(&1, :felt_ls_delay_ms, 0))
          if delay_ms > 0, do: Process.sleep(delay_ms)

          show_all =
            case Enum.find_index(args, &(&1 in ["-s", "--status"])) do
              nil -> false
              idx -> Enum.at(args, idx + 1) == "all"
            end

          fibers =
            Agent.get(__MODULE__, fn state ->
              entries = if state.felt_ls == [], do: Map.values(state.fibers), else: state.felt_ls

              if show_all do
                entries
              else
                Enum.filter(entries, fn fiber ->
                  Map.get(fiber, "status") in ["open", "active"]
                end)
              end
            end)

          json = Jason.encode!(Enum.map(fibers, &with_resolved_agent/1))
          warning? = Agent.get(__MODULE__, & &1.felt_ls_stderr_warning)

          if warning? and Keyword.get(opts, :stderr_to_stdout) do
            {"warning: failed to parse unrelated fiber\n" <> json, 0}
          else
            {json, 0}
          end

        command == "felt" and String.contains?(full_args, "show") and
            String.contains?(full_args, "--field shuttle") ->
          fiber_id = extract_fiber_id(args)
          shuttle = Agent.get(__MODULE__, & &1.shuttle)
          {Map.get(shuttle, fiber_id, ""), 0}

        command == "felt" and String.contains?(full_args, "show") ->
          # `felt show --json` rounds-trip-the-bytes (felt v1.0.4+): tool-owned
          # frontmatter namespaces like `shuttle:` and `tags:` appear as flat
          # top-level JSON keys, alongside the parsed fields. The mock keeps
          # the fiber map intact to mirror this.
          fiber_id = extract_fiber_id(args)
          fibers = Agent.get(__MODULE__, & &1.fibers)

          case Map.get(fibers, fiber_id) do
            nil -> {"fiber not found", 1}
            fiber -> {Jason.encode!(with_resolved_agent(fiber)), 0}
          end

        command == "tmux" and hd(args) == "has-session" ->
          session = Enum.at(args, 2)
          sessions = Agent.get(__MODULE__, & &1.tmux_sessions)

          if tmux_session_exists?(sessions, session) do
            {"", 0}
          else
            {"can't find session", 1}
          end

        command == "tmux" and hd(args) == "new-session" ->
          session = Enum.at(args, 3)
          add_tmux_session(session)
          delay_ms = Agent.get(__MODULE__, &Map.get(&1, :new_session_delay_ms, 0))
          if delay_ms > 0, do: Process.sleep(delay_ms)
          {"", 0}

        command == "tmux" and hd(args) == "kill-session" ->
          session = Enum.at(args, 2)

          case Agent.get(__MODULE__, &Map.get(&1, :kill_session_failure, false)) do
            {output, status} -> {output, status}
            false -> remove_tmux_session(session) && {"", 0}
          end

        command == "tmux" and hd(args) == "rename-session" ->
          ["rename-session", "-t", "=" <> old_name, new_name] = args

          Agent.update(__MODULE__, fn state ->
            if MapSet.member?(state.tmux_sessions, old_name) do
              sessions = state.tmux_sessions |> MapSet.delete(old_name) |> MapSet.put(new_name)
              %{state | tmux_sessions: sessions}
            else
              state
            end
          end)

          {"", 0}

        command == "tmux" and hd(args) == "ls" and
            Agent.get(__MODULE__, &Map.get(&1, :tmux_ls_timeout, false)) ->
          {"tmux ls timed out after 10000ms", :timeout}

        command == "tmux" and hd(args) == "ls" ->
          sessions = Agent.get(__MODULE__, & &1.tmux_sessions)
          output = sessions |> MapSet.to_list() |> Enum.join("\n")
          {output, 0}

        # `felt shuttle mark-runtime <id> [--handed-off-at ts] [--dispatched-at ts]
        # [--session s] [--run-id r] [--host h]` — felt's daemon-facing runtime
        # writer. Mirror the real CLI by folding the stamped flags into the
        # fiber's `shuttle:` map (the same surface put_shuttle_fields updates), so
        # a self-heal / conclude write is observable on the next poll.
        command == "felt" and match?(["shuttle", "mark-runtime", _id | _], args) ->
          [_shuttle, _mark, id | flags] = args

          fields =
            flags
            |> Enum.chunk_every(2)
            |> Enum.reduce(%{}, fn
              ["--handed-off-at", ts], acc -> Map.put(acc, "handed_off_at", ts)
              ["--dispatched-at", ts], acc -> Map.put(acc, "dispatched_at", ts)
              ["--session", s], acc -> Map.put(acc, "session_uuid", s)
              ["--run-id", r], acc -> Map.put(acc, "run_id", r)
              _, acc -> acc
            end)

          if fields != %{}, do: put_shuttle_fields(id, fields)
          {"", 0}

        true ->
          {"", 0}
      end
    end

    defp extract_fiber_id(args) do
      # args like ["show", "tests/haiku", "--json"] or
      # ["show", "tests/haiku", "--field", "shuttle"]
      args
      |> Enum.reject(&(&1 in ["show", "--json", "--field", "shuttle"]))
      |> List.first("")
    end

    defp with_resolved_agent(%{"shuttle" => shuttle} = fiber) when is_map(shuttle) do
      name = Map.get(shuttle, "agent") || "claude-sonnet"
      record = Map.get(@resolved_agents, name, @resolved_agents["claude-sonnet"])
      resolved = Map.merge(Map.get(shuttle, "resolved") || %{}, %{"agent" => record})
      %{fiber | "shuttle" => Map.put(shuttle, "resolved", resolved)}
    end

    defp with_resolved_agent(fiber), do: fiber

    defp tmux_session_exists?(sessions, "=" <> session), do: MapSet.member?(sessions, session)

    defp tmux_session_exists?(sessions, session) do
      Enum.any?(sessions, &(&1 == session or String.starts_with?(&1, session <> "/")))
    end
  end

  # ── Setup ──

  setup do
    start_supervised!(MockRunner)
    MockRunner.reset()

    # Isolate the per-host runtime markers (dispatch / handoff / re-arm) under a
    # throwaway SHUTTLE_DATA_DIR so continuation/orphan tests don't bleed across
    # each other or into the developer's real ~/.shuttle.
    prev_data_dir = System.get_env("SHUTTLE_DATA_DIR")

    data_dir =
      Path.join(System.tmp_dir!(), "shuttle-poller-markers-#{System.unique_integer([:positive])}")

    File.mkdir_p!(data_dir)
    System.put_env("SHUTTLE_DATA_DIR", data_dir)

    on_exit(fn ->
      restore_env("SHUTTLE_DATA_DIR", prev_data_dir)
      File.rm_rf!(data_dir)
    end)

    :ok
  end

  # Start a Poller OWNED BY ExUnit's per-test supervisor, so it is terminated
  # deterministically at the end of the test (before the next test runs).
  #
  # The bug this fixes: `Poller.start_link/1` links the poller to the *test
  # process*, but a test process exits `:normal`, and normal exits do NOT
  # propagate across links — so every poller SURVIVED its test as a zombie
  # ticker. Dozens accumulated over a run, all polling the single shared
  # MockRunner Agent + the /tmp/.felt store, dispatching and writing commands
  # after later tests' `reset()`. That polluted later tests (sessions/commands
  # they never created) and starved the scheduler (blowing the heartbeat-timing
  # margins) — the rotating, order-dependent flakiness. `start_supervised!`
  # hands the lifecycle to ExUnit; `restart: :temporary` so a poller that stops
  # itself mid-test (crash-recovery cases) is not auto-restarted. Returns
  # `{:ok, pid}` so existing `{:ok, poller} = ...` call sites are unchanged.
  defp start_poller!(opts) do
    pid =
      start_supervised!(%{
        id: make_ref(),
        start: {Shuttle.Poller, :start_link, [opts]},
        restart: :temporary
      })

    {:ok, pid}
  end

  # ── Helpers ──

  # Minimal shuttle: block YAML for a oneshot fiber ready for dispatch.
  @oneshot_shuttle "enabled: true\nkind: oneshot\n"

  defp make_fiber(id, attrs \\ %{}) do
    Map.merge(
      %{
        "id" => id,
        "name" => id,
        "status" => "active",
        "tags" => ["constitution"],
        "created_at" => "2026-04-28T00:00:00Z"
      },
      attrs
    )
  end

  # Ceiling ~3s (was ~500ms). wait_until returns the instant the condition holds,
  # so a generous ceiling costs passing assertions nothing — but the poll cycle is
  # a multi-hop async chain (tick → 20ms timer → run_poll_cycle → read Task →
  # :poll_world → apply → dispatch → spawn_tmux), and under CPU load (the full
  # suite, or a tight repeat loop) a tick that used to land in <500ms can slip
  # well past it. The tight ceiling was the dominant intrinsic-timing flake here.
  # Companion to wait_until for when the check IS the assertion (e.g. a pattern
  # match or a snapshot-shape assert). A fixed `Process.sleep` before such an
  # assert raced the async poll under load; this re-runs the assertion every 25ms
  # (~3s ceiling), catching its own failure, so it passes the instant the polled
  # state settles and costs nothing when it already has.
  defp assert_eventually(fun, attempts \\ 120) do
    fun.()
  rescue
    error in [ExUnit.AssertionError, MatchError] ->
      if attempts > 0 do
        Process.sleep(25)
        assert_eventually(fun, attempts - 1)
      else
        reraise(error, __STACKTRACE__)
      end
  end

  defp wait_until(fun, attempts \\ 120)
  defp wait_until(fun, 0), do: fun.()

  defp wait_until(fun, attempts) do
    if fun.() do
      true
    else
      Process.sleep(25)
      wait_until(fun, attempts - 1)
    end
  end

  defp felt_show_count do
    Enum.count(MockRunner.commands(), fn {cmd, args} ->
      cmd == "felt" and Enum.take(args, 1) == ["show"]
    end)
  end

  defp restore_env(key, nil), do: System.delete_env(key)
  defp restore_env(key, value), do: System.put_env(key, value)

  defp new_session_scripts do
    MockRunner.commands()
    |> Enum.filter(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)
    |> Enum.map(fn {_cmd, args} -> List.last(args) end)
  end

  # Mirror the dispatcher's at-spawn dispatch stamp: `session_uuid` +
  # `dispatched_at` into the fiber's `shuttle:` block. The optional `at` lets a
  # test back-date the dispatch so a later handoff can be ordered relative to it.
  defp write_dispatch_marker(id, session_id, at \\ DateTime.utc_now()) do
    MockRunner.put_shuttle_fields(id, %{
      "session_uuid" => session_id,
      "dispatched_at" => DateTime.to_iso8601(at)
    })
  end

  # Mirror the worker's `felt shuttle handoff`: stamp `shuttle.handed_off_at` in
  # RFC3339 UTC — the clean-exit signal the daemon compares against dispatched_at.
  defp write_handoff_marker(id, at \\ DateTime.utc_now()) do
    MockRunner.put_shuttle_fields(id, %{"handed_off_at" => DateTime.to_iso8601(at)})
  end

  # Inject the resolved occurrences felt computes for a standing role — the same
  # way the mock's `with_resolved_agent` injects resolved.agent. felt is the cron
  # authority (Stage 4b): it inlines `prev_due` (the catch-up dispatch signal —
  # most recent tick <= now) and `next_due` (display + the parseable-schedule /
  # validity signal), and the daemon reads them off `felt show -j` and parses no
  # cron. A `prev_due` after the role's last service makes it due; an old one
  # leaves it valid-but-sleeping. Without this a standing fiber resolves no
  # occurrence → it is treated as having an unparseable schedule (never due).
  defp set_resolved_occurrences(id, prev_due, next_due) do
    MockRunner.put_shuttle_fields(id, %{
      "resolved" => %{
        "prev_due" => DateTime.to_iso8601(prev_due),
        "next_due" => DateTime.to_iso8601(next_due)
      }
    })
  end

  # ── Tests ──

  test "poller discovers and dispatches eligible fibers" do
    # Use a fiber ID unique to this test to avoid collisions with sessions left
    # alive by other tests' long-lived Pollers/Watchers.
    fiber = make_fiber("tests/haiku-dispatch")
    MockRunner.set_fiber("tests/haiku-dispatch", fiber)
    MockRunner.set_shuttle("tests/haiku-dispatch", @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_1,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    # Trigger a poll cycle manually
    send(poller, {:tick, Poller.snapshot(poller) |> Map.get(:tick_token)})

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
           end)

    # Check snapshot shows running worker
    assert wait_until(fn ->
             length(Poller.snapshot(poller).eligible) == 1
           end)

    snap = Poller.snapshot(poller)
    assert length(snap.eligible) == 1
    assert hd(snap.eligible).fiber_id == "tests/haiku-dispatch"
  end

  test "poller skips fibers targeted at a different shuttle host" do
    fiber = make_fiber("tests/host-mismatch")
    MockRunner.set_fiber("tests/host-mismatch", fiber)
    MockRunner.set_shuttle("tests/host-mismatch", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_host_mismatch,
        runner: MockRunner,
        own_host_id: "local",
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(50)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    snap = Poller.snapshot(poller)
    assert snap.eligible == []
    assert snap.claimed_count == 0
  end

  test "poller dispatches fibers targeted at its own shuttle host" do
    fiber = make_fiber("tests/host-match")
    MockRunner.set_fiber("tests/host-match", fiber)
    MockRunner.set_shuttle("tests/host-match", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_host_match,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
           end)

    assert wait_until(fn ->
             snap = Poller.snapshot(poller)
             length(snap.eligible) == 1 and hd(snap.eligible).fiber_id == "tests/host-match"
           end)
  end

  # The Poller defaults `own_host_id` from a three-step precedence chain:
  # SHUTTLE_HOST env var → ~/.shuttle/host file → :inet.gethostname().
  # Explicit `own_host_id:` opts always win; these tests cover the
  # resolution chain that drives production daemons. There is intentionally
  # no Application-config step and no "local" fallback — see
  # Shuttle.Poller.own_host_id/0.
  test "poller resolves own_host_id from SHUTTLE_HOST env var when set" do
    prev = System.get_env("SHUTTLE_HOST")
    System.put_env("SHUTTLE_HOST", "candide")

    try do
      {:ok, poller} =
        start_poller!(
          name: :test_poller_env_host,
          runner: MockRunner,
          poll_interval_ms: 60_000,
          felt_stores: ["/tmp"]
        )

      assert Poller.snapshot(poller).host == "candide"
    after
      # Restore the env var the test suite started with so sibling tests
      # (and the SHUTTLE_HOST pin set by config/test.exs) keep working.
      if prev, do: System.put_env("SHUTTLE_HOST", prev), else: System.delete_env("SHUTTLE_HOST")
    end
  end

  test "poller resolves own_host_id from ~/.shuttle/host file when SHUTTLE_HOST unset" do
    prev = System.get_env("SHUTTLE_HOST")
    prev_file = System.get_env("SHUTTLE_HOST_FILE")
    System.delete_env("SHUTTLE_HOST")
    path = Path.join(System.tmp_dir!(), "shuttle-host-#{System.unique_integer([:positive])}")
    File.write!(path, "candide\n")
    System.put_env("SHUTTLE_HOST_FILE", path)

    try do
      {:ok, poller} =
        start_poller!(
          name: :test_poller_host_file,
          runner: MockRunner,
          poll_interval_ms: 60_000,
          felt_stores: ["/tmp"]
        )

      assert Poller.snapshot(poller).host == "candide"
    after
      File.rm(path)

      if prev_file,
        do: System.put_env("SHUTTLE_HOST_FILE", prev_file),
        else: System.delete_env("SHUTTLE_HOST_FILE")

      if prev, do: System.put_env("SHUTTLE_HOST", prev), else: System.delete_env("SHUTTLE_HOST")
    end
  end

  test "poller falls back to :inet.gethostname when SHUTTLE_HOST and host file are unset" do
    prev = System.get_env("SHUTTLE_HOST")
    prev_file = System.get_env("SHUTTLE_HOST_FILE")
    System.delete_env("SHUTTLE_HOST")
    # Point the host-file source at a path that does not exist so the chain
    # genuinely falls through to the OS hostname regardless of the dev
    # machine's real ~/.shuttle/host.
    System.put_env(
      "SHUTTLE_HOST_FILE",
      Path.join(System.tmp_dir!(), "shuttle-host-absent-#{System.unique_integer([:positive])}")
    )

    {:ok, hostname} = :inet.gethostname()
    expected = to_string(hostname)

    try do
      {:ok, poller} =
        start_poller!(
          name: :test_poller_gethostname,
          runner: MockRunner,
          poll_interval_ms: 60_000,
          felt_stores: ["/tmp"]
        )

      assert Poller.snapshot(poller).host == expected
    after
      if prev_file,
        do: System.put_env("SHUTTLE_HOST_FILE", prev_file),
        else: System.delete_env("SHUTTLE_HOST_FILE")

      if prev, do: System.put_env("SHUTTLE_HOST", prev)
    end
  end

  test "poller uses the shuttle felt listing for discovery" do
    fiber = make_fiber("tests/projected-discovery")
    MockRunner.set_fiber("tests/projected-discovery", fiber)
    MockRunner.set_shuttle("tests/projected-discovery", @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_projected_listing,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    # The poller uses felt's cheap path-carrying projection; broad listing is
    # only a fallback for older remote felt binaries.
    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "felt" and
                 args == [
                   "ls",
                   "--json",
                   "--has-field",
                   "shuttle",
                   "--json-field",
                   "id,uid,status,shuttle,path,modified_at,depends_on"
                 ]
             end)
           end)
  end

  test "poller caches document entries by uid and modified_at" do
    uid = "01JZ00000000000000000000CA"

    fiber =
      make_fiber("tests/cached-document", %{
        "uid" => uid,
        "modified_at" => "2026-06-06T01:00:00Z",
        "outcome" => "first"
      })

    MockRunner.set_fiber("tests/cached-document", fiber)
    MockRunner.set_shuttle("tests/cached-document", @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_document_cache,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: ["/tmp"]
      )

    assert wait_until(fn ->
             get_in(Poller.snapshot(poller), [:document_cache, "entries"]) == 1
           end)

    first_stats = Poller.snapshot(poller)[:document_cache]
    first_show_count = felt_show_count()

    assert %{"hits" => 0, "misses" => 1, "entries" => 1} = first_stats
    assert first_show_count == 1

    send(poller, :run_poll_cycle)

    assert wait_until(fn ->
             stats = Poller.snapshot(poller)[:document_cache]
             stats["hits"] == 1 and stats["misses"] == 0
           end)

    assert felt_show_count() == first_show_count

    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    assert [%{fiber: %{"id" => ^uid, "slug" => "tests/cached-document"}}] = body.fibers

    changed_fiber =
      make_fiber("tests/cached-document", %{
        "uid" => uid,
        "modified_at" => "2026-06-06T01:05:00Z",
        "name" => "changed document",
        "shuttle" => %{"enabled" => true, "kind" => "oneshot", "host" => "test-host"}
      })

    MockRunner.set_fiber("tests/cached-document", changed_fiber)
    send(poller, :run_poll_cycle)

    assert wait_until(fn ->
             stats = Poller.snapshot(poller)[:document_cache]
             stats["hits"] == 0 and stats["misses"] == 1
           end)

    assert felt_show_count() == first_show_count + 1
    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    assert [%{fiber: %{"id" => ^uid, "name" => "changed document"}}] = body.fibers
  end

  # The incident this guards: on an overloaded login node one bad `felt ls`
  # (timeout, transient failure) used to blank EVERY fiber on the host for the
  # tick — mass document-cache eviction, cards flapping in and out. A failed
  # listing is "world unknown", not "fibers gone": the poller must carry the
  # last-known candidates and serve them from cache without re-shelling felt.
  test "a failed felt listing carries last-known candidates instead of blanking the store" do
    uid = "01JZ00000000000000000000CB"

    fiber =
      make_fiber("tests/retained-document", %{
        "uid" => uid,
        "modified_at" => "2026-06-06T02:00:00Z"
      })

    MockRunner.set_fiber("tests/retained-document", fiber)
    MockRunner.set_shuttle("tests/retained-document", @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_retained_document,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: ["/tmp"]
      )

    assert wait_until(fn ->
             get_in(Poller.snapshot(poller), [:document_cache, "entries"]) == 1
           end)

    show_count = felt_show_count()

    # felt wedges: every listing (narrow projection AND the broad fallback)
    # now times out. The tick degrades by retaining the last-known candidate:
    # the card stays served, and the mtime-keyed cache reuses the entry
    # without re-shelling a felt that just timed out.
    MockRunner.set_felt_ls_timeout(true)
    send(poller, :run_poll_cycle)

    assert wait_until(fn ->
             stats = Poller.snapshot(poller)[:document_cache]
             stats["hits"] == 1 and stats["misses"] == 0 and stats["entries"] == 1
           end)

    assert felt_show_count() == show_count
    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    assert [%{fiber: %{"id" => ^uid, "slug" => "tests/retained-document"}}] = body.fibers

    # felt recovers: the live listing resumes and the same entry is served.
    MockRunner.set_felt_ls_timeout(false)
    send(poller, :run_poll_cycle)

    assert_eventually(fn ->
      assert {:ok, body} = Poller.cached_fiber_documents(poller)
      assert [%{fiber: %{"id" => ^uid, "slug" => "tests/retained-document"}}] = body.fibers
    end)
  end

  test "owner feed stamps serve-time runtime onto an owned fiber with a live worker" do
    uid = "01JZ00000000000000000000RT"

    fiber =
      make_fiber("tests/aloft", %{
        "uid" => uid,
        "modified_at" => "2026-06-08T01:00:00Z"
      })

    MockRunner.set_fiber("tests/aloft", fiber)
    MockRunner.set_shuttle("tests/aloft", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_stamp,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    # The fiber dispatches (lands in state.running) AND its document caches.
    assert wait_until(fn ->
             snap = Poller.snapshot(poller)

             length(snap.eligible) == 1 and
               get_in(snap, [:document_cache, "entries"]) >= 1
           end)

    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    assert [%{runtime: runtime} = entry] = body.fibers
    # Liveness joins by uid (rename-safe): the served row's fiber uid matches
    # the runtime_key under which state.running tracks the live worker.
    assert get_in(entry, [:fiber, "uid"]) == uid
    assert %{tmux_session: session, state: _state, started_at: started} = runtime
    assert is_binary(session)
    assert is_integer(started)
    # No activity source by default → no phase, but last_activity_at still
    # present (falls back to meta/started_at) so the field is never missing.
    refute Map.has_key?(runtime, :phase)
    assert is_integer(runtime.last_activity_at)
  end

  test "owner feed stamps the REAL last_activity_at, distinct from started_at" do
    uid = "01JZ00000000000000000000RA"

    fiber =
      make_fiber("tests/realactivity", %{
        "uid" => uid,
        "modified_at" => "2026-06-08T01:00:00Z"
      })

    MockRunner.set_fiber("tests/realactivity", fiber)
    MockRunner.set_shuttle("tests/realactivity", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_real_activity,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    assert wait_until(fn ->
             snap = Poller.snapshot(poller)
             length(snap.eligible) == 1 and get_in(snap, [:document_cache, "entries"]) >= 1
           end)

    # Discover the running worker's session and its started_at, then inject an
    # activity record whose last_event_at is deliberately 90s BEFORE started_at.
    assert {:ok, %{fibers: [%{runtime: %{tmux_session: session, started_at: started}}]}} =
             Poller.cached_fiber_documents(poller)

    last_event_at = started - 90_000

    Application.put_env(:shuttle, :waiting_phases_source, fn ->
      %{session => %{last_event_at: last_event_at, phase: "waiting"}}
    end)

    on_exit(fn -> Application.delete_env(:shuttle, :waiting_phases_source) end)

    assert {:ok, %{fibers: [%{runtime: runtime}]}} = Poller.cached_fiber_documents(poller)
    # The served last_activity_at is the tracker's real timestamp — NOT started_at.
    assert runtime.last_activity_at == last_event_at
    assert runtime.last_activity_at != runtime.started_at
    assert runtime.phase == "waiting"
  end

  test "owner feed stamps phase: waiting when the live worker's session is waiting for input" do
    uid = "01JZ00000000000000000000RW"

    fiber =
      make_fiber("tests/waiting", %{
        "uid" => uid,
        "modified_at" => "2026-06-08T01:00:00Z"
      })

    MockRunner.set_fiber("tests/waiting", fiber)
    MockRunner.set_shuttle("tests/waiting", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_waiting,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    assert wait_until(fn ->
             snap = Poller.snapshot(poller)

             length(snap.eligible) == 1 and
               get_in(snap, [:document_cache, "entries"]) >= 1
           end)

    # Discover the running worker's session, then inject it as waiting.
    assert {:ok, %{fibers: [%{runtime: %{tmux_session: session}}]}} =
             Poller.cached_fiber_documents(poller)

    Application.put_env(:shuttle, :waiting_phases_source, fn ->
      %{session => %{last_event_at: 1_700_000_000_000, phase: "waiting"}}
    end)

    on_exit(fn -> Application.delete_env(:shuttle, :waiting_phases_source) end)

    assert {:ok, %{fibers: [%{runtime: runtime}]}} = Poller.cached_fiber_documents(poller)
    assert runtime.phase == "waiting"
    assert runtime.last_activity_at == 1_700_000_000_000

    # The escalation phase stamps straight through the same path.
    Application.put_env(:shuttle, :waiting_phases_source, fn ->
      %{session => %{last_event_at: 1_700_000_000_000, phase: "attention"}}
    end)

    assert {:ok, %{fibers: [%{runtime: escalated}]}} = Poller.cached_fiber_documents(poller)
    assert escalated.phase == "attention"

    # Clearing the activity map drops the phase but keeps last_activity_at (the
    # meta/started_at fallback) — self-healing on the serve path.
    Application.put_env(:shuttle, :waiting_phases_source, fn -> %{} end)
    assert {:ok, %{fibers: [%{runtime: cleared}]}} = Poller.cached_fiber_documents(poller)
    refute Map.has_key?(cleared, :phase)
    assert is_integer(cleared.last_activity_at)
  end

  test "owner feed omits runtime for an owned fiber with no live worker" do
    uid = "01JZ00000000000000000000RX"

    fiber =
      make_fiber("tests/idle", %{
        "uid" => uid,
        "modified_at" => "2026-06-08T01:00:00Z"
      })

    MockRunner.set_fiber("tests/idle", fiber)
    MockRunner.set_shuttle("tests/idle", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_idle,
        runner: MockRunner,
        own_host_id: "candide",
        # No worker slots: the document caches but nothing runs, so no runtime.
        max_concurrent_workers: 0,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    assert wait_until(fn ->
             get_in(Poller.snapshot(poller), [:document_cache, "entries"]) >= 1
           end)

    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    assert [entry] = body.fibers
    refute Map.has_key?(entry, :runtime)
  end

  test "kill_session SIGKILLs a live worker and tears down runtime immediately, writing no status" do
    uid = "01JZ00000000000000000000KS"

    fiber =
      make_fiber("tests/killme", %{
        "uid" => uid,
        "modified_at" => "2026-06-08T01:00:00Z"
      })

    MockRunner.set_fiber("tests/killme", fiber)
    MockRunner.set_shuttle("tests/killme", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_kill_session,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    # Wait until the fiber is live (stamped with runtime on the owner feed).
    assert wait_until(fn ->
             case Poller.cached_fiber_documents(poller) do
               {:ok, %{fibers: [entry]}} -> Map.has_key?(entry, :runtime)
               _ -> false
             end
           end)

    {:ok, %{fibers: [live]}} = Poller.cached_fiber_documents(poller)
    session = get_in(live, [:runtime, :tmux_session])
    assert is_binary(session)

    # Kill by fiber id — owner-routed at the controller; here we hit the Poller
    # directly. Returns the session it killed.
    assert {:ok, ^session} = Poller.kill_session(poller, "tests/killme")

    # Runtime is gone NOW — not after the watcher's next poll. The fiber's
    # document status is untouched (no awaiting-review verdict written): the
    # owner feed still serves the row, just without a runtime stamp.
    assert wait_until(fn ->
             case Poller.cached_fiber_documents(poller) do
               {:ok, %{fibers: [entry]}} -> not Map.has_key?(entry, :runtime)
               _ -> false
             end
           end)

    {:ok, %{fibers: [after_kill]}} = Poller.cached_fiber_documents(poller)
    # status untouched by the kill (the drag's column write is the verdict).
    assert get_in(after_kill, [:fiber, "status"]) in [nil, "active", "open"]

    # Idempotent: killing again when nothing runs is a clean no-op.
    assert {:ok, :no_session} = Poller.kill_session(poller, "tests/killme")
  end

  test "kill_session treats tmux's \"session not found\" as a successful teardown" do
    uid = "01JZ00000000000000000000KN"

    fiber =
      make_fiber("tests/killme-gone", %{
        "uid" => uid,
        "modified_at" => "2026-06-08T01:00:00Z"
      })

    MockRunner.set_fiber("tests/killme-gone", fiber)
    MockRunner.set_shuttle("tests/killme-gone", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_kill_session_gone,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    assert wait_until(fn ->
             case Poller.cached_fiber_documents(poller) do
               {:ok, %{fibers: [entry]}} -> Map.has_key?(entry, :runtime)
               _ -> false
             end
           end)

    {:ok, %{fibers: [live]}} = Poller.cached_fiber_documents(poller)
    session = get_in(live, [:runtime, :tmux_session])

    # tmux itself reports the session is already gone (exit 1, "can't find
    # session") — the poller must still treat this as a successful kill and
    # tear down runtime tracking, not surface it as a failure.
    MockRunner.set_kill_session_failure(:not_found)
    assert {:ok, ^session} = Poller.kill_session(poller, "tests/killme-gone")

    assert wait_until(fn ->
             case Poller.cached_fiber_documents(poller) do
               {:ok, %{fibers: [entry]}} -> not Map.has_key?(entry, :runtime)
               _ -> false
             end
           end)
  end

  # Twin of the "session not found" test above for the two other tmux
  # "already gone" phrasings session_already_gone? must also treat as success:
  # a whole-server-down "no server running" and the per-session "no such
  # session". Each is its own test (not a loop) so a fresh MockRunner + poller
  # keeps them from cross-claiming each other's fiber.
  for {variant, uid_suffix, gone_output} <- [
        {:no_server, "K0", "\"no server running\""},
        {:no_such, "K1", "\"no such session\""}
      ] do
    test "kill_session treats tmux's #{gone_output} as a successful teardown" do
      variant = unquote(variant)
      fiber_id = "tests/killme-#{variant}"
      uid = "01JZ00000000000000000000#{unquote(uid_suffix)}"

      fiber =
        make_fiber(fiber_id, %{
          "uid" => uid,
          "modified_at" => "2026-06-08T01:00:00Z"
        })

      MockRunner.set_fiber(fiber_id, fiber)
      MockRunner.set_shuttle(fiber_id, "enabled: true\nkind: oneshot\nhost: candide\n")

      {:ok, poller} =
        start_poller!(
          name: :"test_poller_kill_session_#{variant}",
          runner: MockRunner,
          own_host_id: "candide",
          poll_interval_ms: 60_000,
          felt_stores: ["/tmp"]
        )

      send(poller, :run_poll_cycle)

      assert wait_until(fn ->
               case Poller.cached_fiber_documents(poller) do
                 {:ok, %{fibers: [entry]}} -> Map.has_key?(entry, :runtime)
                 _ -> false
               end
             end)

      {:ok, %{fibers: [live]}} = Poller.cached_fiber_documents(poller)
      session = get_in(live, [:runtime, :tmux_session])

      MockRunner.set_kill_session_failure(variant)
      assert {:ok, ^session} = Poller.kill_session(poller, fiber_id)

      assert wait_until(fn ->
               case Poller.cached_fiber_documents(poller) do
                 {:ok, %{fibers: [entry]}} -> not Map.has_key?(entry, :runtime)
                 _ -> false
               end
             end)
    end
  end

  test "kill_session surfaces a genuine tmux kill failure and leaves runtime tracking intact" do
    uid = "01JZ00000000000000000000KF"

    fiber =
      make_fiber("tests/killme-fail", %{
        "uid" => uid,
        "modified_at" => "2026-06-08T01:00:00Z"
      })

    MockRunner.set_fiber("tests/killme-fail", fiber)
    MockRunner.set_shuttle("tests/killme-fail", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_kill_session_fail,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    assert wait_until(fn ->
             case Poller.cached_fiber_documents(poller) do
               {:ok, %{fibers: [entry]}} -> Map.has_key?(entry, :runtime)
               _ -> false
             end
           end)

    state_before = :sys.get_state(poller)
    [{runtime_key, meta_before}] = Map.to_list(state_before.running)
    original_watcher_pid = meta_before.pid
    assert is_pid(original_watcher_pid) and Process.alive?(original_watcher_pid)

    # A genuine kill failure (session still alive, tmux refused): the ghost
    # worker keeps running, so tracking must NOT be torn down and the reply
    # must surface the failure rather than a false {:ok, ...}.
    MockRunner.set_kill_session_failure(true)
    assert {:error, reason} = Poller.kill_session(poller, "tests/killme-fail")
    assert reason =~ "tmux kill-session failed"

    {:ok, %{fibers: [still_live]}} = Poller.cached_fiber_documents(poller)
    assert Map.has_key?(still_live, :runtime)

    # `kill_session` stops the watcher BEFORE attempting the kill, so a
    # failed kill must re-arm a fresh watcher against the still-live
    # session — otherwise nobody observes its eventual exit until this
    # daemon restarts, a second flavor of ghost worker.
    state_after = :sys.get_state(poller)
    meta_after = Map.get(state_after.running, runtime_key)
    assert is_pid(meta_after.pid) and Process.alive?(meta_after.pid)
    refute meta_after.pid == original_watcher_pid
  end

  test "New session (force + resume_mode:fresh) CUTS an open session: marker stamped, live tmux killed, then dispatched fresh" do
    fiber_id = "tests/cut-open-session"
    uid = "01JZ00000000000000000000CT"

    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid, "status" => "active"}))

    MockRunner.set_shuttle(
      fiber_id,
      "kind: oneshot\nagent: claude-sonnet\nhost: test-host\n",
      "active"
    )

    # max_concurrent_workers: 0 silences the autonomous tick; explicit
    # dispatch_fiber/3 is not slot-gated, so the cut path is fully exercised
    # without the poll racing the two manual dispatches.
    {:ok, poller} =
      start_poller!(
        name: :test_poller_cut_open_session,
        runner: MockRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: ["/tmp"]
      )

    # First dispatch makes the fiber live (a fresh worker, a real tmux session).
    assert {:ok, first_session} =
             Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)

    assert Shuttle.Tmux.present?(MockRunner, first_session)

    before_cut = length(MockRunner.commands())

    # "New session" — a forced fresh dispatch against the now-live session. The
    # cut fires INSTEAD of bouncing off :already_running: marker + kill, fresh.
    assert {:ok, second_session} =
             Poller.dispatch_fiber(poller, fiber_id,
               force: true,
               ad_hoc: true,
               resume_mode: "fresh"
             )

    cut_commands = MockRunner.commands() |> Enum.drop(before_cut)

    marker_idx =
      Enum.find_index(cut_commands, fn
        {"felt", args} -> "mark-runtime" in args and "--handed-off-at" in args
        _ -> false
      end)

    kill_idx =
      Enum.find_index(cut_commands, fn
        {"tmux", ["kill-session", "-t", ^first_session]} -> true
        _ -> false
      end)

    new_idx =
      Enum.find_index(cut_commands, fn
        {"tmux", ["new-session" | _]} -> true
        _ -> false
      end)

    # The clean-exit marker was stamped, the live tmux was killed, and a fresh
    # session was spawned — all three happened.
    assert is_integer(marker_idx), "expected a felt mark-runtime --handed-off-at during the cut"
    assert is_integer(kill_idx), "expected the live tmux session to be killed during the cut"
    assert is_integer(new_idx), "expected a fresh tmux session after the cut"

    # Order is load-bearing: marker BEFORE kill (so a failed re-dispatch still
    # leaves the cut session clean), and the fresh spawn AFTER the kill.
    assert marker_idx < kill_idx
    assert new_idx > kill_idx

    # The fiber is live again under a fresh session (same canonical name).
    assert Shuttle.Tmux.present?(MockRunner, second_session)
  end

  test "Resume (force + resume_mode:previous) does NOT cut a live session — it refuses with :already_running" do
    fiber_id = "tests/resume-no-cut"
    uid = "01JZ00000000000000000000RC"

    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid, "status" => "active"}))

    MockRunner.set_shuttle(
      fiber_id,
      "kind: oneshot\nagent: claude-sonnet\nhost: test-host\n",
      "active"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resume_no_cut,
        runner: MockRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: ["/tmp"]
      )

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)
    before = length(MockRunner.commands())

    # Resume against a live session is refused — you don't resume what's already
    # running; only "fresh" cuts. The live transcript is the one Resume preserves.
    assert {:error, :already_running} =
             Poller.dispatch_fiber(poller, fiber_id,
               force: true,
               ad_hoc: true,
               resume_mode: "previous"
             )

    resume_commands = MockRunner.commands() |> Enum.drop(before)

    refute Enum.any?(resume_commands, fn
             {"felt", args} -> "mark-runtime" in args and "--handed-off-at" in args
             _ -> false
           end)

    refute Enum.any?(resume_commands, fn
             {"tmux", ["kill-session" | _]} -> true
             _ -> false
           end)

    # The live session is untouched.
    assert Shuttle.Tmux.present?(MockRunner, session)
  end

  test "snapshot remains responsive while poll cycle is reading felt" do
    fiber = make_fiber("tests/slow-felt-read")
    MockRunner.set_fiber("tests/slow-felt-read", fiber)
    MockRunner.set_shuttle("tests/slow-felt-read", @oneshot_shuttle)
    MockRunner.set_felt_ls_delay(1_000)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_slow_felt_snapshot,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "felt" and Enum.take(args, 2) == ["ls", "--json"]
             end)
           end)

    started_at_ms = System.monotonic_time(:millisecond)
    snap = Poller.snapshot(poller, 100)

    assert is_map(snap)
    assert System.monotonic_time(:millisecond) - started_at_ms < 100
  end

  test "poller skips closed fibers" do
    fiber = make_fiber("tests/closed", %{"status" => "closed"})
    MockRunner.set_fiber("tests/closed", fiber)
    MockRunner.set_shuttle("tests/closed", @oneshot_shuttle, "closed")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_2,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(50)

    commands = MockRunner.commands()

    refute Enum.any?(commands, fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "poller skips draft fibers" do
    fiber = make_fiber("tests/draft", %{"tags" => ["constitution", "draft"], "status" => "open"})
    MockRunner.set_fiber("tests/draft", fiber)

    # Draft = shuttle block present but enabled: false; status open (not yet committed to In flight).
    MockRunner.set_shuttle("tests/draft", "enabled: false\nkind: oneshot\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_3,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(50)

    commands = MockRunner.commands()

    refute Enum.any?(commands, fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "poller does NOT auto-dispatch a status:active pinned role with a DIRTY dispatch marker" do
    # The anti-hollow-relaunch invariant. A pinned role that was dispatched but
    # never handed off cleanly (dispatched_at present, no newer handed_off_at —
    # a mid-flight or dirty-dead marker) is NOT eligible for the autonomous tick:
    # tick_kind_eligible? gates pinned on deliberate_handoff_since_dispatch?,
    # which is false here. This is what severs the old shapepipe redispatch loop
    # (survey, find nothing, exit, re-dispatch). Force-dispatch still launches
    # it (below).
    fiber = make_fiber("tests/pinned-active", %{"status" => "active"})
    MockRunner.set_fiber("tests/pinned-active", fiber)
    MockRunner.set_shuttle("tests/pinned-active", "kind: pinned\nagent: claude-opus\n", "active")
    # A dirty marker: dispatched, never handed off → clean_handoff? is false.
    write_dispatch_marker("tests/pinned-active", "sess-pinned-active")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_pinned_active,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    # Flush the poll cycle through the GenServer mailbox.
    _ = Poller.snapshot(poller)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end),
           "the autonomous tick must not spawn a fresh worker for a dirty-marker pinned role"

    # But an explicit force-dispatch (the strip's "start"/"Resume" gesture) DOES
    # launch it — pinned roles are human-dispatch-startable, not never-dispatch.
    assert {:ok, _session} =
             Poller.dispatch_fiber(poller, "tests/pinned-active", force: true, ad_hoc: true)

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
           end)
  end

  test "poller does NOT auto-dispatch a status:active pinned role with NO runtime markers" do
    # The strict-predicate case. deliberate_handoff_since_dispatch? demands a
    # POSITIVE signal (both markers, handoff >= dispatch); a marker-less
    # `status: active` pinned fiber (hand-edited active, legacy pre-marker, or
    # runtime keys wiped) must sit idle until a human Resumes it — exactly the
    # old blanket-exclusion behavior. The lenient clean_handoff_since_dispatch?
    # defaults TRUE here (a resume-vs-fresh safety), so gating on it would
    # auto-dispatch a role no worker asked to relaunch.
    fiber = make_fiber("tests/pinned-markerless", %{"status" => "active"})
    MockRunner.set_fiber("tests/pinned-markerless", fiber)
    MockRunner.set_shuttle("tests/pinned-markerless", "kind: pinned\nagent: claude-opus\n", "active")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_pinned_markerless,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    _ = Poller.snapshot(poller)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end),
           "the autonomous tick must not spawn a worker for a marker-less pinned role"
  end

  test "poller DOES auto-redispatch a status:active pinned role after a CLEAN handoff" do
    # The unified-lifecycle other half: a pinned worker in a long autonomous arc
    # that ran `felt shuttle handoff` (stamping handed_off_at >= dispatched_at)
    # is deliberately asking for a fresh session. tick_kind_eligible? sees the
    # clean handoff and the tick re-dispatches a fresh worker — the arc continues
    # across clean sessions instead of going dark.
    fiber = make_fiber("tests/pinned-clean-handoff", %{"status" => "active"})
    MockRunner.set_fiber("tests/pinned-clean-handoff", fiber)
    MockRunner.set_shuttle("tests/pinned-clean-handoff", "kind: pinned\nagent: claude-opus\n", "active")

    # Dispatched, then a strictly-later clean handoff → clean_handoff? is true.
    base = DateTime.utc_now()
    write_dispatch_marker("tests/pinned-clean-handoff", "sess-clean", base)
    write_handoff_marker("tests/pinned-clean-handoff", DateTime.add(base, 60, :second))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_pinned_clean_handoff,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    _ = Poller.snapshot(poller)

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
           end),
           "a cleanly-handed-off pinned role must auto-redispatch a fresh worker"
  end

  test "poller does NOT auto-dispatch a PARKED (status:open) pinned role" do
    # Option D: status:open is the parked rest state on the strip. The existing
    # `status != "active"` gate skips it — no bespoke pinned branch. This is the
    # park half of the loop: dragging In-flight → strip writes active → open, and
    # the role stops looping.
    fiber = make_fiber("tests/pinned-parked", %{"status" => "open"})
    MockRunner.set_fiber("tests/pinned-parked", fiber)
    MockRunner.set_shuttle("tests/pinned-parked", "kind: pinned\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_pinned_parked,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(50)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    refute Enum.any?(Poller.snapshot(poller).eligible, &(&1.fiber_id == "tests/pinned-parked"))
  end

  test "a pinned worker exit parks the role back to the strip (status:open), no re-dispatch" do
    # A pinned worker's session ending (human killed it, crash, or clean exit)
    # PARKS the role back to the strip by writing active → open — it must NOT
    # stay stuck `active` with no live worker in In-flight, and must NOT relaunch.
    # This is the symmetric counterpart of a standing exit writing closed.
    # Reverting LifecycleStore.park / the handle_worker_exit pinned branch leaves
    # it active-but-dead; reverting filter_eligible's guard re-arms the loop.
    #
    # The exit handler routes through felt (LifecycleStore → FeltStores.resolve_
    # fiber), so the mock fiber must be felt-resolvable: point FELT_STORES at the
    # mock store the factory wrote to (/tmp/.felt). Without this a
    # park regression would silently no-op — masking whether the gate even fired.
    prev_loom = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", "/tmp")

    on_exit(fn ->
      if prev_loom,
        do: System.put_env("FELT_STORES", prev_loom),
        else: System.delete_env("FELT_STORES")
    end)

    fiber_id = "tests/pinned-exit-parks"
    leaf = fiber_id |> String.split("/") |> List.last()
    session = Dispatcher.session_name(fiber_id)
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: pinned\nagent: claude-opus\n", "active")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_pinned_exit_parks,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    new_sessions = fn ->
      Enum.count(MockRunner.commands(), fn {cmd, args} ->
        cmd == "tmux" and hd(args) == "new-session" and session in args
      end)
    end

    # First dispatch (a force-dispatch is how the strip's "start" gesture fires).
    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)
    assert new_sessions.() == 1

    # Worker session ends while the document is still active (it did NOT self-close).
    MockRunner.remove_tmux_session(session)
    send(poller, {:worker_exited, fiber_id, :normal_exit, false})
    # Flush the GenServer mailbox so the exit write lands before the disk read.
    _ = Poller.snapshot(poller)

    # The on-disk document is parked: active → open (back to the strip), and NOT
    # marked closed/awaiting (that's the standing closer, not the pinned one).
    doc = File.read!("/tmp/.felt/#{fiber_id}/#{leaf}.md")
    assert doc =~ ~r/status:\s*open/
    refute doc =~ ~r/status:\s*closed/
    refute doc =~ "closed-at"

    # No loop: the next poll does NOT re-dispatch (now status:open anyway, and
    # filter_eligible would exclude it even if active). Session count stays at 1.
    # it explicitly. (Reverting the pinned guard flips this to a second launch.)
    send(poller, :run_poll_cycle)
    _ = Poller.snapshot(poller)
    assert new_sessions.() == 1
  end

  test "a pinned worker CLEAN handoff leaves the role active and redispatches (no park)" do
    # The clean-handoff counterpart of the park test: a pinned worker that stamps
    # handed_off_at and exits is asking for a fresh session (long autonomous arc).
    # handle_worker_exit's pinned branch leaves the document `active` (does NOT
    # park to open), and the next tick re-dispatches a fresh worker.
    prev_loom = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", "/tmp")

    on_exit(fn ->
      if prev_loom,
        do: System.put_env("FELT_STORES", prev_loom),
        else: System.delete_env("FELT_STORES")
    end)

    fiber_id = "tests/pinned-clean-exit"
    leaf = fiber_id |> String.split("/") |> List.last()
    session = Dispatcher.session_name(fiber_id)
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: pinned\nagent: claude-opus\n", "active")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_pinned_clean_exit,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    new_sessions = fn ->
      Enum.count(MockRunner.commands(), fn {cmd, args} ->
        cmd == "tmux" and hd(args) == "new-session" and session in args
      end)
    end

    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)
    assert new_sessions.() == 1

    # The worker hands off cleanly (stamps handed_off_at strictly after dispatch),
    # then its session ends.
    write_handoff_marker(fiber_id, DateTime.add(DateTime.utc_now(), 60, :second))
    MockRunner.remove_tmux_session(session)
    send(poller, {:worker_exited, fiber_id, :normal_exit, false})
    _ = Poller.snapshot(poller)

    # The document stays active — NOT parked to open (that's the dirty-exit path).
    doc = File.read!("/tmp/.felt/#{fiber_id}/#{leaf}.md")
    assert doc =~ ~r/status:\s*active/
    refute doc =~ ~r/status:\s*open/

    # And the next autonomous tick re-dispatches a fresh worker (clean handoff →
    # tick_kind_eligible?), so the session count climbs to 2.
    send(poller, :run_poll_cycle)

    assert wait_until(fn -> new_sessions.() == 2 end),
           "a cleanly-handed-off pinned role must redispatch on the next tick"
  end

  test "a standing worker exit DOES close the role to awaiting-review (status:closed)" do
    # The complement of the pinned carve-out: a STANDING (cron) worker's exit
    # still marks the role awaiting, so the cron does not re-fire it this cycle.
    # This is what guards the gate against being broadened to skip standing too.
    prev_loom = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", "/tmp")

    on_exit(fn ->
      if prev_loom,
        do: System.put_env("FELT_STORES", prev_loom),
        else: System.delete_env("FELT_STORES")
    end)

    fiber_id = "tests/standing-exit-closes"
    leaf = fiber_id |> String.split("/") |> List.last()
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * *"
        tz: Europe/Paris
      """,
      "active"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_exit_closes,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)

    MockRunner.remove_tmux_session(Dispatcher.session_name(fiber_id))
    send(poller, {:worker_exited, fiber_id, :normal_exit, false})
    _ = Poller.snapshot(poller)

    doc = File.read!("/tmp/.felt/#{fiber_id}/#{leaf}.md")
    assert doc =~ ~r/status:\s*closed/
  end

  # Inject a running entry with a chosen start time, then deliver a worker exit —
  # the precise input the breaker keys on (a oneshot exit and its lifetime),
  # without the dispatch/watcher/resume machinery that makes a full
  # spawn→kill→resume loop nondeterministic under the mock runner.
  defp simulate_exit(poller, fiber_id, lifetime_seconds) do
    started = DateTime.add(DateTime.utc_now(), -lifetime_seconds, :second)

    :sys.replace_state(poller, fn state ->
      meta = %{
        fiber_id: fiber_id,
        session: Dispatcher.session_name(fiber_id),
        agent_id: "claude-sonnet",
        uid: nil,
        started_at: started,
        last_activity_at: started
      }

      %{
        state
        | running: Map.put(state.running, fiber_id, meta),
          claimed: MapSet.put(state.claimed, fiber_id)
      }
    end)

    send(poller, {:worker_exited, fiber_id, :normal_exit, false})
    # Synchronous call flushes the exit message (mailbox order) before we read.
    _ = Poller.snapshot(poller)
  end

  defp loop_blocked?(poller, fiber_id) do
    Enum.any?(Poller.snapshot(poller).blocked, fn b ->
      b.fiber_id == fiber_id and b.reason =~ "resume_loop"
    end)
  end

  test "resume-loop breaker pauses a oneshot whose workers keep dying instantly, and force-dispatch overrides it" do
    # The kill-and-resume churn: a still-active oneshot whose worker dies almost
    # immediately (stale/unresumable session, wrong project_dir, TCC-blocked cwd)
    # is re-dispatched every poll, dying again each time — observed as 125 resumes
    # of one fiber in a day. After @resume_loop_max_rapid_exits consecutive rapid
    # exits the breaker opens: the fiber goes ineligible (surfaced as `blocked`)
    # until a cooldown or a human force-dispatch. Reverting the eligible? guard or
    # note_worker_lifetime re-arms the infinite loop.
    fiber_id = "tests/resume-loop-breaker"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "active")

    # max_concurrent_workers: 0 disables the autonomous tick's dispatch (the
    # first poll fires at 0ms and would otherwise spawn a real worker mid-test);
    # explicit Poller.dispatch_fiber/3 is not slot-gated, so the breaker path is
    # still fully exercised.
    {:ok, poller} =
      start_poller!(
        name: :test_poller_resume_loop_breaker,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: ["/tmp"]
      )

    # Four rapid (0s-lifetime) exits — one short of tripping; breaker stays closed.
    for _ <- 1..4, do: simulate_exit(poller, fiber_id, 0)
    refute loop_blocked?(poller, fiber_id)

    # The fifth rapid exit opens the breaker: now blocked, and an autonomous
    # (non-force) dispatch is refused.
    simulate_exit(poller, fiber_id, 0)
    assert loop_blocked?(poller, fiber_id)
    assert {:error, _} = Poller.dispatch_fiber(poller, fiber_id, [])

    # A human force-dispatch is an explicit "go": it clears the breaker and spawns.
    assert {:ok, _} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    refute loop_blocked?(poller, fiber_id)
  end

  test "a healthy worker run resets the resume-loop breaker count" do
    # A long-lived run (≥ the rapid-exit threshold) is the system working: it must
    # zero the consecutive-rapid-exit count so a fiber that occasionally has a fast
    # exit between real work never trips.
    fiber_id = "tests/resume-loop-reset"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "active")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resume_loop_reset,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: ["/tmp"]
      )

    # 4 rapid exits — one short of tripping.
    for _ <- 1..4, do: simulate_exit(poller, fiber_id, 0)

    # A healthy run lands (lived well past the threshold): clears the count.
    simulate_exit(poller, fiber_id, 3600)

    # 4 more rapid exits still don't trip (the reset means it would take 5 fresh).
    for _ <- 1..4, do: simulate_exit(poller, fiber_id, 0)
    refute loop_blocked?(poller, fiber_id)
  end

  # ── Boot quarantine ──
  #
  # Restart is not dispatch authority: a just-(re)started daemon grants NO
  # autonomous dispatches of any kind (the crash-loop incident: each restart's
  # first poll dispatched every active, host-owned, workerless fiber). While
  # quarantined, the autonomous tick parks EVERY dispatchable candidate —
  # resumes included, since classifying on cached rows let stale rows escape;
  # release is pure manual. config/test.exs disables the quarantine globally,
  # so these tests opt back in via `boot_quarantine: true`.

  test "boot quarantine parks fresh launches and surfaces them as pending_launch" do
    fiber_id = "tests/quarantine-fresh"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_fresh,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"],
        boot_quarantine: true
      )

    send(poller, :run_poll_cycle)

    # Parked, not dispatched: the row lands in pending_launch with the
    # quarantine reason, and no tmux session is spawned.
    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id, reason: "boot quarantine — awaiting release"}] =
               Poller.snapshot(poller).pending_launch
    end)

    snap = Poller.snapshot(poller)
    assert snap.boot_quarantine == true
    assert snap.eligible == []

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    # The held state reaches the per-fiber feed (board indicator): parked_index
    # is keyed by fiber_id, and put_held stamps the matching feed row `held`.
    index = Poller.parked_index(poller)
    assert %{parked_at: _} = Map.get(index, fiber_id)

    assert %{held: true, held_since: _} =
             Snapshot.put_held(%{fiber: %{"id" => fiber_id}}, index)

    refute Map.has_key?(Snapshot.put_held(%{fiber: %{"id" => "tests/not-held"}}, index), :held)
  end

  test "boot quarantine parks an on-disk resume marker the daemon never observed running" do
    # A dispatched_at with no newer handed_off_at LOOKS like a dirty-death
    # resume, but the quarantine gate keys off runtime observation
    # (`was_running`), NOT the on-disk marker. This daemon never saw a live
    # worker for the fiber (no adopted session), so its marker is exactly the
    # stale-row case the earlier resume exemption let escape: it is parked, not
    # dispatched. Only work the daemon actually observed running auto-resumes
    # (see the was-running test below).
    fiber_id = "tests/quarantine-dirty-resume"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)
    write_dispatch_marker(fiber_id, "b1e0a3c2-0000-4000-8000-000000000001")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_resume,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"],
        boot_quarantine: true
      )

    send(poller, :run_poll_cycle)

    # Parked like any other candidate — no session spawned, quarantine intact.
    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id, reason: "boot quarantine — awaiting release"}] =
               Poller.snapshot(poller).pending_launch
    end)

    snap = Poller.snapshot(poller)
    assert snap.boot_quarantine == true
    assert snap.eligible == []

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "boot quarantine does NOT park work it observed running; a was-running fiber re-dispatches on exit" do
    # The core of the fix: in-flight work the daemon observed running under its
    # own uptime auto-resumes even while quarantined — only genuinely-fresh
    # launches are held. Field scenario reproduced: a oneshot whose worker was
    # adopted at boot, then exits mid-uptime, must re-dispatch, not park.
    fiber_id = "tests/quarantine-was-running"
    session = Dispatcher.session_name(fiber_id)
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)
    # Live worker present at boot → adopt_orphans adopts it (adoption runs
    # regardless of quarantine), so its runtime key enters the durable
    # `was_running` set.
    MockRunner.add_tmux_session(session)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_was_running,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"],
        boot_quarantine: true
      )

    # Adopted as running while quarantined (not parked): observed-running now
    # carries this fiber's key, and nothing is in pending_launch.
    assert_eventually(fn ->
      state = :sys.get_state(poller)
      assert MapSet.member?(state.was_running, fiber_id)
      assert Enum.any?(state.running, fn {_k, m} -> Map.get(m, :fiber_id) == fiber_id end)
    end)

    assert Poller.snapshot(poller).pending_launch == []

    # Worker exits mid-uptime; the next poll reconciles the missing session
    # (drops it from running, releases the claim) → the fiber is a candidate
    # again. Was-running membership survives the exit, so it re-dispatches.
    MockRunner.remove_tmux_session(session)
    send(poller, :run_poll_cycle)

    assert_eventually(fn ->
      assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
    end)

    snap = Poller.snapshot(poller)
    assert snap.boot_quarantine == true
    refute Enum.any?(snap.pending_launch, &(&1.fiber_id == fiber_id))
  end

  test "boot quarantine parks a due standing role (occurrences are fresh launches)" do
    fiber_id = "tests/quarantine-standing"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]}))

    MockRunner.set_shuttle(
      fiber_id,
      """
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "* * * * *"
        tz: Europe/Paris
      review:
        state: scheduled
      """
    )

    now = DateTime.utc_now()
    set_resolved_occurrences(fiber_id, now, DateTime.add(now, 60, :second))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_standing,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"],
        boot_quarantine: true
      )

    send(poller, :run_poll_cycle)

    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id}] = Poller.snapshot(poller).pending_launch
    end)

    assert Poller.snapshot(poller).eligible == []
  end

  test "quarantine parking is rebuilt every cycle even when all slots are full" do
    # Parking is dispatch-authority bookkeeping, not capacity accounting: the
    # parked map used to be rebuilt only inside the `available_slots > 0`
    # gate, so with slots full a closed fiber kept its stale pending_launch
    # row and newly-eligible work never surfaced. Rebuild must run every
    # cycle; only actual dispatching is slot-gated.
    fiber_id = "tests/quarantine-slots-full"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_slots_full,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: ["/tmp"],
        boot_quarantine: true
      )

    send(poller, :run_poll_cycle)

    # Parked despite zero slots — the bookkeeping runs regardless of capacity.
    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id}] = Poller.snapshot(poller).pending_launch
    end)

    # The fiber closes; the next cycle (slots still full) rebuilds the parked
    # map and the stale row drops out.
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "closed"}))
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle, "closed")
    send(poller, :run_poll_cycle)

    assert_eventually(fn ->
      assert Poller.snapshot(poller).pending_launch == []
    end)
  end

  test "releasing the boot quarantine dispatches the parked launches" do
    fiber_id = "tests/quarantine-release"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_release,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"],
        boot_quarantine: true
      )

    send(poller, :run_poll_cycle)

    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id}] = Poller.snapshot(poller).pending_launch
    end)

    # The human "go": clears the flag + parked set and ticks immediately, so
    # the fiber dispatches without waiting out the poll interval. Idempotent.
    assert :ok = Poller.release_boot_quarantine(poller)
    assert :ok = Poller.release_boot_quarantine(poller)

    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id}] = Poller.snapshot(poller).eligible
    end)

    snap = Poller.snapshot(poller)
    assert snap.boot_quarantine == false
    assert snap.pending_launch == []
  end

  test "force-dispatch bypasses the boot quarantine and does not clear it" do
    fiber_id = "tests/quarantine-force"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    # max_concurrent_workers: 0 disables the autonomous tick's dispatch;
    # explicit Poller.dispatch_fiber/3 is not slot-gated, so only the manual
    # path is exercised here.
    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_force,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: ["/tmp"],
        boot_quarantine: true
      )

    # First a poll parks it as a fresh launch (held): the autonomous tick's
    # parking is not slot-gated, so it runs even with 0 worker slots.
    send(poller, :run_poll_cycle)

    assert_eventually(fn ->
      assert %{parked_at: _} = Map.get(Poller.parked_index(poller), fiber_id)
    end)

    # The human clicked dispatch: honor the intent — but one manual "go" on one
    # fiber is not a bulk release; the quarantine stays up for everything else.
    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    assert Poller.snapshot(poller).boot_quarantine == true

    # Held clears the instant the worker exists — synchronously, not a poll cycle
    # later — so the card never co-renders the held and "aloft" pills.
    refute Map.has_key?(Poller.parked_index(poller), fiber_id)
  end

  # ── S2: boot-time CLI/daemon contract handshake ──
  #
  # `Shuttle.Poller.init/1` shells `felt shuttle contract` once and compares it
  # to `Shuttle.Contract.expected_level/0`. A mismatch (or unparseable/nonzero
  # exit — an old CLI where `contract` is unknown) rides the SAME dispatch gate
  # as boot quarantine: fresh launches park, already-observed work still
  # resumes, and the reason surfaces on `snapshot().contract` /
  # `pending_launch`. `config/test.exs` disables `boot_quarantine`, so these
  # tests exercise the skew gate in isolation from it.

  test "a matching contract level dispatches normally and reports ok in the snapshot" do
    MockRunner.set_contract_level("2")
    fiber_id = "tests/contract-match"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_contract_match,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert Poller.snapshot(poller).contract == %{expected: 2, observed: 2, ok: true, reason: nil}

    send(poller, :run_poll_cycle)

    assert_eventually(fn ->
      assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
    end)

    assert Poller.snapshot(poller).pending_launch == []
  end

  test "a mismatched contract level holds fresh launches and surfaces the skew" do
    MockRunner.set_contract_level("3")
    fiber_id = "tests/contract-mismatch"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_contract_mismatch,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    snap = Poller.snapshot(poller)

    assert %{expected: 2, observed: 3, ok: false, reason: reason} = snap.contract
    assert reason =~ "expected contract level 2"
    assert reason =~ "CLI reports 3"

    send(poller, :run_poll_cycle)

    # Held, not dispatched: parked as a pending_launch with the skew reason,
    # and no tmux session spawned — same shape as a boot-quarantine park.
    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id, reason: parked_reason}] =
               Poller.snapshot(poller).pending_launch

      assert parked_reason =~ "contract skew"
      assert parked_reason =~ "CLI reports 3"
    end)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "unparseable contract output (old CLI, unknown subcommand) is treated as skew, not a crash" do
    # Mirrors a pre-e1f65b1 CLI: `felt shuttle contract` is an unknown
    # subcommand, so real felt exits nonzero with its usage text on stdout —
    # exactly the shape the CLI's own doc-comment says must be treated as
    # "cannot determine the level", same as an explicit mismatch.
    MockRunner.set_contract_level("Error: unknown command \"contract\"", 1)
    fiber_id = "tests/contract-garbage"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_contract_garbage,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert %{expected: 2, ok: false} = Poller.snapshot(poller).contract

    send(poller, :run_poll_cycle)

    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id}] = Poller.snapshot(poller).pending_launch
    end)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "a contract skew does not strand work observed running; a was-running fiber still resumes" do
    # Same was-running exemption as boot quarantine: skew means "no NEW
    # autonomous work", not "abandon what's alive". A worker this daemon
    # observed running (adopted at boot) must still re-dispatch on exit.
    MockRunner.set_contract_level("3")
    fiber_id = "tests/contract-skew-was-running"
    session = Dispatcher.session_name(fiber_id)
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)
    MockRunner.add_tmux_session(session)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_contract_skew_was_running,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert_eventually(fn ->
      state = :sys.get_state(poller)
      assert MapSet.member?(state.was_running, fiber_id)
      assert Enum.any?(state.running, fn {_k, m} -> Map.get(m, :fiber_id) == fiber_id end)
    end)

    assert Poller.snapshot(poller).pending_launch == []

    MockRunner.remove_tmux_session(session)
    send(poller, :run_poll_cycle)

    assert_eventually(fn ->
      assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
    end)

    snap = Poller.snapshot(poller)
    refute snap.contract.ok
    refute Enum.any?(snap.pending_launch, &(&1.fiber_id == fiber_id))
  end

  test "poller does not dispatch a scheduled standing role before it is due" do
    fiber = make_fiber("tests/standing-sleeping", %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber("tests/standing-sleeping", fiber)

    # Slice 2: the dispatch gate is the cron schedule vs now (the stored
    # next_due_at no longer gates). A weekday-09:00 Paris schedule fires no tick
    # inside the poll window during a test run, so the role is not due. The future
    # next_due_at remains only to keep the display path (`due?`) reading
    # `scheduled`.
    MockRunner.set_shuttle(
      "tests/standing-sleeping",
      """
      enabled: true
      mode: standing
      schedule:
        kind: cron
        expr: "0 9 * * 1-5"
        timezone: Europe/Paris
      review:
        state: scheduled
      next_due_at: "2999-01-01T09:00:00+01:00"
      """
    )

    # Just serviced (a "worker dispatched" event at ~now): under the one due rule,
    # a role is due only once a scheduled occurrence elapses AFTER its last
    # service, so a freshly-serviced weekday-09:00 role is not due now. felt's
    # prev_due (the last weekday-09:00 tick) sits before this service; next_due is
    # the future tick → valid (so the snapshot reads "scheduled", not invalid).
    write_dispatch_marker("tests/standing-sleeping", "seed-recent")

    set_resolved_occurrences(
      "tests/standing-sleeping",
      ~U[2026-05-01 09:00:00Z],
      ~U[2999-01-01 09:00:00Z]
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_sleeping,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(50)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    assert [%{fiber_id: "tests/standing-sleeping", state: "scheduled"}] =
             Poller.snapshot(poller).standing_roles
  end

  test "poller surfaces a standing-role snapshot from the document (no runtime store)" do
    fiber_id = "tests/standing-lifecycle-persist"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber(fiber_id, fiber)

    # The standing role is read straight from the document (slice 6: no runtime
    # store). Phase is the schedule-derived label; awaiting/accepted are document
    # facts (status:closed/tempered), not stored.
    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      """
    )

    # Recently serviced ⇒ not due now (so it stays scheduled, not running). felt
    # resolves a valid schedule (last tick before this service, next in the
    # future) so the snapshot reads a genuine valid-but-sleeping role, not an
    # invalid one.
    write_dispatch_marker(fiber_id, "seed-recent")
    set_resolved_occurrences(fiber_id, ~U[2026-05-01 09:00:00Z], ~U[2999-01-01 09:00:00Z])

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_lifecycle_persist,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    # The schedule-derived snapshot state is scheduled or due (cron + now), never
    # a review-derived "review"/"accepted".
    assert wait_until(fn ->
             match?([%{fiber_id: ^fiber_id}], Poller.snapshot(poller).standing_roles)
           end)

    assert [%{fiber_id: ^fiber_id, state: state}] = Poller.snapshot(poller).standing_roles
    assert state in ["scheduled", "due"]
  end

  # A status:active standing role dispatches off the cron schedule, read straight
  # from the document (slice 6: no runtime overlay can wedge it). An every-minute
  # schedule is reliably due now regardless of wall-clock.
  test "a status:active standing role dispatches off the cron schedule" do
    fiber_id = "tests/standing-wedge"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "* * * * *"
        tz: Europe/Paris
      """
    )

    # An every-minute schedule's most recent tick is ~now; with no prior service
    # (last_serviced = created_at, old) that elapsed occurrence makes it due.
    now = DateTime.utc_now()
    set_resolved_occurrences(fiber_id, now, DateTime.add(now, 60, :second))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_wedge,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id, state: "running"}] = Poller.snapshot(poller).eligible
    end)
  end

  test "an awaiting-review (status:closed) standing role is NOT relaunched even with an elapsed occurrence" do
    # Cail's rule, the other half of catch-up: a role that ran is awaiting review
    # (status:closed) until a human tempers (accepts) it. Catch-up must never
    # resurrect it — eligible?'s status gate excludes closed before the due rule
    # is ever consulted. Every-minute schedule ⇒ an occurrence has certainly
    # elapsed since the fixed past created_at, so only the closed gate stops it.
    fiber_id = "tests/standing-awaiting-no-relaunch"

    MockRunner.set_fiber(
      fiber_id,
      make_fiber(fiber_id, %{"status" => "closed", "tags" => ["constitution", "standing"]})
    )

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "* * * * *"
        tz: Europe/Paris
      """,
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_awaiting_no_relaunch,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(50)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  # Awaiting is a DOCUMENT fact (status:closed + untempered), not a runtime-store
  # review row (slices 4/6). Action resolution reads the document straight — so
  # `accept-run` is available on a closed+untempered standing role (the kanban
  # "temper the weekly arXiv role" gesture re-arms it).
  test "actions reflect doc awaiting (status:closed + untempered) for a standing role" do
    fiber_id = "tests/standing-actions-overlay"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"], "status" => "closed"})
    MockRunner.set_fiber(fiber_id, fiber)

    # The document is the authority: status:closed with no `tempered` is the
    # awaiting signal. No review block anywhere.
    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      schedule:
        expr: "0 9 * * 1"
        tz: Europe/Paris
      """,
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_actions_overlay,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    query_opts = [felt_stores: ["/tmp"], runner: MockRunner]

    assert_eventually(fn ->
      {:ok, actions} = ActionQueries.actions_for(fiber_id, query_opts)
      ids = Enum.map(actions, &(Map.get(&1, :id) || Map.get(&1, "id")))
      assert "accept-run" in ids

      assert {:ok, %{id: "accept-run"}} =
               ActionQueries.resolve_action(fiber_id, "tempered", query_opts)
    end)
  end

  # Accepting a standing run through the Poller re-arms the felt document
  # (status:active, verdict cleared) and that re-arm survives the next poll —
  # there is no runtime cache to clobber it (slice 6). The document IS the truth.
  test "accept through the Poller re-arms the document and survives the next poll" do
    fiber_id = "tests/standing-accept-sticks"

    previous_loom_homes = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", "/tmp")

    on_exit(fn ->
      restore_env("FELT_STORES", previous_loom_homes)
    end)

    # Awaiting is a document fact (status:closed + untempered). accept re-arms it
    # from the doc schedule (status:active).
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"], "status" => "closed"})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      schedule:
        expr: "0 9 * * 1"
        tz: Europe/Paris
      """,
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_accept_sticks,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert {:ok, _output} = Poller.lifecycle_transition(poller, :accept, fiber_id, [])

    # The document is re-armed to status:active.
    armed = File.read!("/tmp/.felt/#{fiber_id}/standing-accept-sticks.md")
    assert armed =~ "status: active"

    send(poller, :run_poll_cycle)
    Process.sleep(75)

    # Still active after the poll — nothing clobbers the document back to awaiting.
    assert File.read!("/tmp/.felt/#{fiber_id}/standing-accept-sticks.md") =~ "status: active"
  end

  test "an accept that lands during a poll read is not clobbered when the poll completes" do
    # Regression for Symptom B of the poll-merge wedge: a standing-role `accept`
    # re-arms the felt document (status:active), but a poll Task already in flight
    # — snapshotted while the role was still the closed (awaiting) document —
    # must not revert the acceptance when it completes. The poll Task only reads;
    # the document is the single source of truth (slice 6), so the accept stands.
    fiber_id = "tests/standing-accept-during-poll"

    previous_loom_homes = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", "/tmp")

    on_exit(fn ->
      restore_env("FELT_STORES", previous_loom_homes)
    end)

    # Awaiting is a document fact (status:closed + untempered).
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"], "status" => "closed"})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      schedule:
        expr: "0 9 * * 1"
        tz: Europe/Paris
      """,
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_accept_during_poll,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    doc_path = "/tmp/.felt/#{fiber_id}/standing-accept-during-poll.md"

    # Hold the next poll inside its read-only felt walk; its snapshot still sees
    # the role as the closed (awaiting) document.
    MockRunner.set_felt_ls_delay(400)
    send(poller, :run_poll_cycle)

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "felt" and Enum.take(args, 2) == ["ls", "--json"]
             end)
           end)

    # Accept while the poll is still reading (the GenServer stays responsive).
    assert {:ok, _output} = Poller.lifecycle_transition(poller, :accept, fiber_id, [])
    assert File.read!(doc_path) =~ "status: active"

    # Let the held poll complete and apply against current state.
    Process.sleep(500)

    assert File.read!(doc_path) =~ "status: active",
           "a poll completing after the accept reverted the acceptance to awaiting"
  end

  test "direct ad-hoc dispatch creates an ad-hoc standing run before the schedule is due" do
    fiber_id = "tests/standing-force-now"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      review:
        state: scheduled
      next_due_at: "2999-01-01T09:00:00+01:00"
      """
    )

    # Recently serviced ⇒ the scheduler treats it as not-due, so a plain dispatch
    # is refused; only force/ad-hoc overrides (the point of this test).
    write_dispatch_marker(fiber_id, "seed-recent")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_force_now,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    # Enabled standing role whose schedule is far in the future: a plain
    # dispatch is refused as not-yet-due (force/ad_hoc overrides the schedule).
    assert {:error, {:not_eligible, :not_due_or_blocked}} =
             Poller.dispatch_fiber(poller, fiber_id, [])

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)
    assert session == Dispatcher.session_name(fiber_id)

    assert [%{fiber_id: ^fiber_id, state: "running", run_id: run_id}] =
             Poller.snapshot(poller).eligible

    assert String.starts_with?(run_id, "adhoc-")

    MockRunner.remove_tmux_session(Dispatcher.session_name(fiber_id))
    send(poller, {:worker_exited, fiber_id, :normal_exit, false})
    Process.sleep(50)

    send(poller, :run_poll_cycle)

    assert_eventually(fn ->
      new_session_count =
        MockRunner.commands()
        |> Enum.filter(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)
        |> length()

      assert new_session_count == 1
    end)
  end

  test "ad-hoc dispatch refuses an awaiting standing role only when NOT forced" do
    # Awaiting is felt-native (slice 5): status:closed + untempered. The awaiting
    # gate exists to stop the *autonomous poller* (non-forced ad_hoc) from
    # re-firing a role pending a human verdict. A forced ad_hoc dispatch is the
    # human's explicit "go" from the board (New session / Resume / drag) — it IS
    # the verdict, so it bypasses the gate and spawns (re-arming the doc on the
    # way; the re-arm itself is exercised in dispatch_integration_test against a
    # real felt home). The completed timestamp comes from closed-at.
    fiber_id = "tests/standing-awaiting-refuses-adhoc"

    fiber =
      make_fiber(fiber_id, %{
        "status" => "closed",
        "closed-at" => "2026-05-24T10:00:00Z",
        "tags" => ["constitution", "standing"]
      })

    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      """,
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_awaiting_refuses_adhoc,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    # Non-forced ad_hoc (the poller's own path) is still refused with the
    # awaiting marker, and never spawns.
    assert {:error, {:awaiting_review, "2026-05-24T10:00:00Z"}} =
             Poller.dispatch_fiber(poller, fiber_id, ad_hoc: true)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    # Forced ad_hoc (the human board action) bypasses the gate and spawns.
    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)

    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "actions/resolve read tmux-live running state, not a stale registry hit" do
    # C1-adjacent: :dispatch reconciles against tmux before reading state.running,
    # but :actions and :resolve_action used to read the registry raw. So in the
    # window after a worker's session dies (before the poll tick reconciles), a
    # drag→inFlight resolved to `pause` for a worker that no longer exists — and
    # invoke (which reconciles) then 409s. The read legs now derive `running?`
    # from a live tmux check (`live_running?`), matching the dispatch leg —
    # without the eviction side effects (those stay on the poll/dispatch path).
    fiber_id = "tests/reconcile-dead-session"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_reconcile_dead_session,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    # Let the initial poll auto-dispatch the eligible fiber and settle, so the
    # worker is in state.running and no further poll cycle is queued behind the
    # read legs below. (Driving dispatch via `force:` here instead would race
    # the initial poll's reconcile, which — landing after the kill — would
    # re-dispatch the fiber and re-create a live session.)
    session = Dispatcher.session_name(fiber_id)
    assert wait_until(fn -> Poller.worker_status(poller, fiber_id) != nil end)

    query_opts = [felt_stores: ["/tmp"], runner: MockRunner]

    # While the session is live, the running branch is read: inFlight → pause.
    assert {:ok, %{id: "pause"}} = ActionQueries.resolve_action(fiber_id, "inFlight", query_opts)

    # Kill the tmux session WITHOUT a poll tick or :worker_exited message.
    MockRunner.remove_tmux_session(session)

    # The read legs now see the session is gone (live tmux check), so the fiber
    # reads idle and inFlight resolves to a fresh dispatch (not pause). The
    # discriminator is the inFlight resolution — `pause` is in the idle
    # availability set too (drafts→pause), so we assert on resolve, not the set.
    assert {:ok, %{id: "dispatch-ad-hoc"}} =
             ActionQueries.resolve_action(fiber_id, "inFlight", query_opts)

    {:ok, actions} = ActionQueries.actions_for(fiber_id, query_opts)
    ids = Enum.map(actions, &(Map.get(&1, :id) || Map.get(&1, "id")))
    assert "dispatch-ad-hoc" in ids
  end

  test "forced non-ad-hoc standing dispatch keeps scheduled run context for resume" do
    fiber_id = "tests/standing-force-scheduled"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      review:
        state: scheduled
      next_due_at: "2999-01-01T09:00:00+01:00"
      """
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_force_scheduled,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true)

    assert [%{fiber_id: ^fiber_id, state: "running", run_id: run_id}] =
             Poller.snapshot(poller).eligible

    refute String.starts_with?(run_id, "adhoc-")
    assert String.starts_with?(run_id, "29990101T080000")
  end

  test "forced standing dispatch honors just-filed resume intent before next scheduled window" do
    fiber_id = "tests/standing-force-resume-before-window"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      """
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_force_resume_before_window,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    # The prior run's session id lives in the per-host dispatch marker; a forced
    # resume reads it from there. The resume directive (`resume_mode: "previous"`)
    # now rides the dispatch call as a transient parameter (STORE 3), not a
    # persisted felt review-comment — so there is no since-window to scope and the
    # "morning-post blocked for days" pathology cannot recur.
    write_dispatch_marker(fiber_id, "stored-standing-session-id")

    assert {:ok, _session} =
             Poller.dispatch_fiber(poller, fiber_id, force: true, resume_mode: "previous")

    script_path = new_session_scripts() |> List.last()
    assert script_path, "expected at least one new-session script"
    script = File.read!(script_path)

    assert script =~ "--resume"
    assert script =~ "stored-standing-session-id"
  end

  test "force-dispatch runs a closed fiber while leaving its status untouched" do
    # Manual "New session" / "Resume" buttons on a closed kanban card must
    # spawn a worker even though the fiber is closed (composted/tempered).
    # The Poller's force path bypasses the status check; the Dispatcher's
    # check_not_closed honors `force: true`. Status itself is *not* reopened
    # — closed fibers stay closed; the worker just runs against the current
    # outcome.
    fiber_id = "tests/closed-force"
    fiber = make_fiber(fiber_id, %{"status" => "closed"})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      "enabled: true\nkind: oneshot\nagent: claude-sonnet\n",
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_force_closed,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    # Without force, a closed fiber is not eligible — and the reason now names
    # the cause (closed) so the kanban can say "reopen it first".
    assert {:error, {:not_eligible, :closed}} = Poller.dispatch_fiber(poller, fiber_id, [])
    # With force, the same fiber dispatches.
    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    assert session == Dispatcher.session_name(fiber_id)
  end

  test "force-dispatch runs a draft fiber (status: open)" do
    # A draft (status: open) is not auto-dispatched (slice 5: status is the sole
    # gate, no enabled flag) but is still available for explicit manual launch —
    # the click is the override.
    fiber_id = "tests/disabled-force"
    fiber = make_fiber(fiber_id, %{"status" => "open"})
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_force_disabled,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert {:error, {:not_eligible, :disabled}} = Poller.dispatch_fiber(poller, fiber_id, [])
    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true)
  end

  test "force-dispatch still refuses fibers pinned to a different host" do
    # Host is a real hardware constraint — we can't conjure a worker on
    # another machine. Force relaxes intent, not topology.
    fiber_id = "tests/wrong-host-force"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      "enabled: true\nkind: oneshot\nagent: claude-sonnet\nhost: some-other-machine\n"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_force_wrong_host,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    # The refusal now NAMES the cause: the fiber is homed elsewhere, carrying
    # both its declared host and this daemon's own id. The kanban surfaces this
    # as "homed on <host>, can only run there" instead of the misleading
    # "disabled, not yet due, or closed" — the Bug-3 fix.
    assert {:error, {:not_eligible, {:homed_elsewhere, "some-other-machine", "test-host"}}} =
             Poller.dispatch_fiber(poller, fiber_id, force: true)
  end

  test "force-dispatch still refuses human-worker fibers" do
    # Human-worker fibers have no machine to spawn against. Even under
    # force, dispatch is a no-op (success without a tmux session).
    fiber_id = "tests/human-worker-force"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, "enabled: true\nkind: oneshot\nagent: human\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_force_human,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    # Human-worker fibers short-circuit to {:ok, "human"} before the
    # eligibility check runs (the API does not start a tmux session for
    # them); force does not change that.
    assert {:ok, "human"} = Poller.dispatch_fiber(poller, fiber_id, force: true)
  end

  test "poller dispatches a due standing role with run context and does not hot-loop after exit" do
    # Uses new-format "kind: standing" (vs legacy "mode: standing") to test backward compat.
    fiber = make_fiber("tests/standing-due", %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber("tests/standing-due", fiber)

    # Slice 2: due-ness is computed from the cron schedule + now, not a stored
    # next_due_at. `* * * * *` fires every minute, so a tick always lands inside
    # the poll window → the role is due now, deterministically.
    MockRunner.set_shuttle(
      "tests/standing-due",
      """
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "* * * * *"
        tz: Europe/Paris
      review:
        state: scheduled
      """
    )

    # `* * * * *`'s most recent tick is ~now; with no prior service it is due.
    now = DateTime.utc_now()
    set_resolved_occurrences("tests/standing-due", now, DateTime.add(now, 60, :second))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_due,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    assert_eventually(fn ->
      assert [%{fiber_id: "tests/standing-due", state: "running", run_id: run_id}] =
               Poller.snapshot(poller).eligible

      assert is_binary(run_id)
    end)

    # Simulate the worker exit. In production the exit handler's standing branch
    # writes status:closed to the felt document (mark_standing_awaiting) BEFORE it
    # releases the claim, so no poll after the exit ever sees the role armed. The
    # MockRunner's `felt ls` reads its in-memory map, not the on-disk write
    # mark_awaiting performs, so mirror that document close here — atomically with
    # the exit — to reproduce the production ordering. With an every-minute cron,
    # this closed-state is the ONLY thing preventing immediate re-dispatch (slice
    # 2 dropped the completed_standing_runs MapSet): the `active → closed → active`
    # document transition is the sole per-cycle gate.
    MockRunner.set_shuttle(
      "tests/standing-due",
      """
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "* * * * *"
        tz: Europe/Paris
      """,
      "closed"
    )

    MockRunner.remove_tmux_session(Dispatcher.session_name("tests/standing-due"))
    send(poller, {:worker_exited, "tests/standing-due", :normal_exit, false})
    Process.sleep(50)

    refute Enum.any?(Poller.snapshot(poller).retrying, &(&1.fiber_id == "tests/standing-due"))

    send(poller, :run_poll_cycle)

    assert_eventually(fn ->
      new_session_count =
        MockRunner.commands()
        |> Enum.filter(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)
        |> length()

      assert new_session_count == 1
    end)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "felt" and Enum.take(args, 2) == ["standing", "review"]
           end)
  end

  # Slice 4: a stale stored next_due_at no longer fires the role — due-ness is
  # cron-computed against the poll window (the morning-post-drift rule). A role
  # whose only past tick fell outside the window is not dispatched, and its
  # snapshot is a valid schedule-derived state (no review/accepted validation).
  test "poller does not dispatch a standing role whose stored next_due is stale" do
    fiber = make_fiber("tests/standing-stale", %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber("tests/standing-stale", fiber)

    MockRunner.set_shuttle(
      "tests/standing-stale",
      """
      enabled: true
      mode: standing
      schedule:
        kind: cron
        expr: "0 9 * * 1-5"
        timezone: Europe/Paris
      next_due_at: "2000-01-03T09:00:00+01:00"
      """
    )

    # Recently serviced ⇒ not due now (what gates is "has an occurrence elapsed
    # since last service"). felt's prev_due (the last real tick) sits before this
    # service; next_due is the future tick → valid (validation_errors empty) but
    # not due. The legacy flat next_due_at above is now inert — felt's resolved
    # occurrences are the source.
    write_dispatch_marker("tests/standing-stale", "seed-recent")

    set_resolved_occurrences(
      "tests/standing-stale",
      ~U[2026-05-01 09:00:00Z],
      ~U[2999-01-01 09:00:00Z]
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_stale,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(50)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    assert [%{fiber_id: "tests/standing-stale", state: state, validation_errors: []}] =
             Poller.snapshot(poller).standing_roles

    assert state in ["scheduled", "due"]
  end

  # Slice 4: the snapshot state is schedule-derived (scheduled/due/dormant/
  # running), never a review-derived "review"/"accepted". Awaiting/accepted are
  # document facts the kanban classifier reads from status/tempered.
  test "snapshot standing state is schedule-derived, not review-derived" do
    sleeping = make_fiber("tests/standing-review", %{"tags" => ["constitution", "standing"]})

    paused =
      make_fiber("tests/standing-accepted", %{
        "status" => "open",
        "tags" => ["constitution", "standing"]
      })

    MockRunner.set_fiber("tests/standing-review", sleeping)
    MockRunner.set_fiber("tests/standing-accepted", paused)

    # A leftover review block is ignored (slice 5: no review axis); the role reads
    # scheduled (its next weekday-09:00 tick is in the future).
    MockRunner.set_shuttle(
      "tests/standing-review",
      """
      mode: standing
      schedule:
        kind: cron
        expr: "0 9 * * 1-5"
        timezone: Europe/Paris
      """
    )

    # Recently serviced ⇒ not due ⇒ stays "scheduled" (not dispatched/"running").
    # felt resolves a valid schedule (prev before service, next in the future) so
    # the snapshot reads a genuine "valid but sleeping", not an invalid role.
    write_dispatch_marker("tests/standing-review", "seed-recent")

    set_resolved_occurrences(
      "tests/standing-review",
      ~U[2026-05-01 09:00:00Z],
      ~U[2999-01-01 09:00:00Z]
    )

    # A draft role (status: open) still reads scheduled in the schedule-derived
    # snapshot — paused/draft is a document fact (status), surfaced by the kanban
    # classifier from the document, not a StandingRole phase (slice 5).
    MockRunner.set_shuttle(
      "tests/standing-accepted",
      """
      mode: standing
      schedule:
        kind: cron
        expr: "0 9 * * 1-5"
        timezone: Europe/Paris
      """,
      "open"
    )

    # A draft (status: open) still resolves a valid schedule; its last tick is in
    # the past (outside the 90s display window) so it reads "scheduled".
    set_resolved_occurrences(
      "tests/standing-accepted",
      ~U[2026-05-01 09:00:00Z],
      ~U[2999-01-01 09:00:00Z]
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_snapshot_states,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    assert wait_until(fn ->
             length(Poller.snapshot(poller).standing_roles) == 2
           end)

    roles = Poller.snapshot(poller).standing_roles
    assert Enum.find(roles, &(&1.fiber_id == "tests/standing-review")).state == "scheduled"
    assert Enum.find(roles, &(&1.fiber_id == "tests/standing-accepted")).state == "scheduled"
  end

  test "poller respects dependency satisfaction" do
    dep = make_fiber("tests/dep", %{"tempered" => false, "tags" => []})
    fiber = make_fiber("tests/dependent", %{"depends_on" => ["tests/dep"]})

    MockRunner.set_fiber("tests/dependent", fiber)
    MockRunner.set_fiber("tests/dep", dep)
    MockRunner.set_shuttle("tests/dependent", @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_4,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(50)

    commands = MockRunner.commands()

    refute Enum.any?(commands, fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session" and
               Enum.member?(args, Dispatcher.session_name("tests/dependent"))
           end)
  end

  test "poller skips untracked fibers" do
    fiber = make_fiber("tests/untracked", %{"status" => "untracked"})
    MockRunner.set_fiber("tests/untracked", fiber)
    MockRunner.set_shuttle("tests/untracked", @oneshot_shuttle, "untracked")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_untracked,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(50)

    commands = MockRunner.commands()

    refute Enum.any?(commands, fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "poller dispatches when dependencies are tempered" do
    dep = make_fiber("tests/dep", %{"tempered" => true})
    fiber = make_fiber("tests/dependent", %{"depends_on" => [%{"id" => "tests/dep"}]})

    MockRunner.set_fiber("tests/dependent", fiber)
    MockRunner.set_fiber("tests/dep", dep)
    MockRunner.set_shuttle("tests/dependent", @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_5,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    assert_eventually(fn ->
      commands = MockRunner.commands()

      assert Enum.any?(commands, fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
    end)
  end

  test "poller does not double-dispatch" do
    fiber = make_fiber("tests/haiku-dedup")
    MockRunner.set_fiber("tests/haiku-dedup", fiber)
    MockRunner.set_shuttle("tests/haiku-dedup", @oneshot_shuttle)
    MockRunner.add_tmux_session(Dispatcher.session_name("tests/haiku-dedup"))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_6,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(50)

    # Should not create a new session
    new_session_count =
      MockRunner.commands()
      |> Enum.filter(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)
      |> length()

    assert new_session_count == 0
  end

  test "poller re-dispatches a still-active oneshot after its worker exits (retry collapsed into poll loop)" do
    # Retries collapsed into the poll loop (slice 6): when a multi-session
    # oneshot worker exits but its document is still status:active, the claim is
    # released and the next poll re-picks it (status:active + no live session →
    # eligible) and starts a fresh session.
    fiber = make_fiber("tests/haiku-retry")
    MockRunner.set_fiber("tests/haiku-retry", fiber)
    MockRunner.set_shuttle("tests/haiku-retry", @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_7,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    # Dispatch
    send(poller, :run_poll_cycle)

    assert_eventually(fn ->
      snap1 = Poller.snapshot(poller)
      assert length(snap1.eligible) == 1
    end)

    # Simulate worker exit (tmux session dies). The claim is released; the fiber
    # is no longer running and no longer retrying (the retry queue is gone).
    MockRunner.remove_tmux_session(Dispatcher.session_name("tests/haiku-retry"))
    send(poller, {:worker_exited, "tests/haiku-retry", :normal_exit, false})

    assert_eventually(fn ->
      snap2 = Poller.snapshot(poller)
      assert length(snap2.eligible) == 0
      assert snap2.retrying == []
    end)

    # The next poll re-dispatches it: a second new-session call.
    send(poller, :run_poll_cycle)

    assert wait_until(
             fn ->
               MockRunner.commands()
               |> Enum.count(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)
               |> Kernel.==(2)
             end,
             80
           )
  end

  test "running snapshot keys the in-memory registry and rows by intrinsic uid" do
    fiber_id = "tests/running-uid-keyed"
    uid = "01KTCA2CWXBSNHETE66MXKPVE7"

    fiber = make_fiber(fiber_id, %{"uid" => uid})
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_running_uid_keyed,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, [])

    # The in-memory running registry is keyed by uid (slice 3/6).
    state = :sys.get_state(poller)
    assert Map.has_key?(state.running, uid)
    refute Map.has_key?(state.running, fiber_id)

    # Slice 7: no separate `:runtime` index. The live worker rides the
    # `eligible` row, which carries both the intrinsic uid (the join key) and the
    # felt address (the display/CLI handle).
    snap = Poller.snapshot(poller)
    refute Map.has_key?(snap, :runtime)

    assert [%{fiber_id: ^fiber_id, uid: ^uid, state: "running"}] = snap.eligible
  end

  test "force-dispatch honors resume_mode: previous dispatch param (unified resume path)" do
    # The old kanban-modal flow had two separate paths: "New session"
    # (ad-hoc, force-fresh) and "Resume" (a special accept-then-dispatch
    # dance via felt shuttle resume). Under unified force semantics, BOTH
    # buttons carry resume_mode on the dispatch call and dispatch with
    # force: true. resolve_resume_intent honors the carried resume_mode
    # regardless of dispatch context (oneshot, standing scheduled, standing
    # ad-hoc).
    fiber_id = "tests/force-resume-unified"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: oneshot
      agent: claude-sonnet
      """
    )

    # The prior session id lives in the per-host dispatch marker the daemon wrote
    # at spawn (the only structured session-id home). resume_mode rides the
    # dispatch call (STORE 3), not a persisted review-comment.
    write_dispatch_marker(fiber_id, "stored-session-id")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_force_resume_unified,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    # An explicit force-dispatch carrying resume_mode: "previous" produces a
    # --resume invocation against the dispatch marker's session id, not a fresh
    # new-session.
    _ = Poller.dispatch_fiber(poller, fiber_id, force: true, resume_mode: "previous")

    assert wait_until(fn -> new_session_scripts() != [] end)

    script = new_session_scripts() |> List.last() |> File.read!()

    assert script =~ "--resume"
    assert script =~ "stored-session-id"
  end

  test "poller continuation RESUMES a oneshot that died without a handoff marker" do
    # The resume-on-no-handoff fix. A multi-session oneshot's autonomous
    # continuation: a dispatch marker (with the session id) is on file but there
    # is NO worker-authored handoff marker after it — so the previous session
    # died mid-thought (the remote-machine kill case), and the dispatch must
    # RESUME the transcript rather than loop a fresh, context-less worker.
    fiber_id = "tests/continuation-died"

    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n")

    write_dispatch_marker(fiber_id, "old-session-id")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_continuation_died,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    assert wait_until(fn -> new_session_scripts() != [] end, 80)

    script = new_session_scripts() |> List.last() |> File.read!()
    assert script =~ "--resume"
    assert script =~ "old-session-id"
  end

  test "poller continuation re-dispatches FRESH when the worker left a clean handoff" do
    # The clean-close half: a handoff marker written at or after the last dispatch
    # marks an intentional handoff, so the continuation starts fresh and the next
    # worker reads the `## Status` block (the intentional loop, unchanged).
    fiber_id = "tests/continuation-handoff"

    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n")

    # Back-date the dispatch so the handoff (now) is unambiguously >= dispatch.
    write_dispatch_marker(
      fiber_id,
      "old-session-id",
      DateTime.add(DateTime.utc_now(), -60, :second)
    )

    write_handoff_marker(fiber_id)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_continuation_handoff,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    assert wait_until(fn -> new_session_scripts() != [] end, 80)

    script = new_session_scripts() |> List.last() |> File.read!()
    assert script =~ "Fiber: #{fiber_id}"
    refute script =~ "--resume"
    refute script =~ "old-session-id"
  end

  test "poller releases claim when worker exits and fiber is closed" do
    # Use a fiber ID unique to this test — shared names (like "tests/haiku") can
    # collide with sessions left over from other tests' Pollers/Watchers.
    fiber = make_fiber("tests/haiku-close")
    MockRunner.set_fiber("tests/haiku-close", fiber)
    MockRunner.set_shuttle("tests/haiku-close", @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_8,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    # Dispatch
    send(poller, :run_poll_cycle)
    Process.sleep(100)

    # Close the fiber
    MockRunner.set_fiber("tests/haiku-close", %{fiber | "status" => "closed"})
    MockRunner.remove_tmux_session(Dispatcher.session_name("tests/haiku-close"))
    send(poller, {:worker_exited, "tests/haiku-close", :normal_exit, false})

    assert_eventually(fn ->
      snap = Poller.snapshot(poller)
      assert snap.claimed_count == 0
      assert length(snap.retrying) == 0
    end)
  end

  test "poller adopts orphan tmux sessions on startup" do
    MockRunner.set_shuttle("tests/orphan", @oneshot_shuttle)
    MockRunner.add_tmux_session(Dispatcher.session_name("tests/orphan"))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_9,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert_eventually(fn ->
      snap = Poller.snapshot(poller)
      assert length(snap.eligible) == 1
      assert hd(snap.eligible).fiber_id == "tests/orphan"
    end)
  end

  test "poller adopts a uid-carrying fiber's worker under the new uid-keyed session" do
    fiber_id = "tests/orphan-uid"
    uid = "01KTHDNZS287ZSSG8X8V59XKWB"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid}))
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)
    MockRunner.add_tmux_session(Dispatcher.session_name(fiber_id, uid))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_orphan_uid,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert_eventually(fn ->
      snap = Poller.snapshot(poller)
      assert Enum.any?(snap.eligible, &(&1.fiber_id == fiber_id and &1.state == "running"))
    end)
  end

  test "poller adopts uid workers when felt ls writes warnings to stderr" do
    fiber_id = "life/french/daily-practice"
    uid = "01KTHDNZS287ZSSG8X8V59XKWB"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid, "status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: pinned\nagent: claude-opus\n", "active")
    MockRunner.set_felt_ls_stderr_warning(true)
    MockRunner.add_tmux_session(Dispatcher.session_name(fiber_id, uid))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_orphan_stderr_warning,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert_eventually(fn ->
      snap = Poller.snapshot(poller)

      assert Enum.any?(snap.eligible, &(&1.fiber_id == fiber_id and &1.state == "running"))
    end)
  end

  test "poller adopts a uid-carrying fiber's LEGACY-named worker (dual-recognition)" do
    # A worker launched before the uid-keyed cutover is live under the legacy
    # leaf-only name. The owning daemon must still recognize and adopt it after
    # an upgrade, so the deploy order is safe and live legacy workers aren't
    # abandoned.
    fiber_id = "tests/orphan-legacy"
    uid = "01KTHDNZS287ZSSG8X8V59XKWC"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid}))
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)
    # Live session carries the LEGACY name, not the uid-keyed one.
    MockRunner.add_tmux_session(Dispatcher.session_name(fiber_id))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_orphan_legacy,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert_eventually(fn ->
      snap = Poller.snapshot(poller)
      assert Enum.any?(snap.eligible, &(&1.fiber_id == fiber_id and &1.state == "running"))
    end)
  end

  test "poller adopts a live orphan session for a looping pinned role (no duplicate dispatch)" do
    # Regression for the daemon-restart-drops-all-adoptions bug. After a restart,
    # `candidate_session_lookup` must record the fiber_id for a session name seen
    # exactly once — every uid-keyed name is unique to one fiber. A `Map.update/4`
    # misuse inserted the default grouped sets VERBATIM (the update fun is not
    # applied to the default), so a single-occurrence session kept empty sets,
    # resolved to nil, and the live worker was never adopted.
    #
    # A looping pinned role (Option D: status:active dispatches) with a live
    # worker must be adopted as running — NOT duplicate-dispatched by the loop —
    # whether via `candidate_session_lookup` or the dispatch→:already_running
    # adopt. The field symptom this guards: operator/morning-post showing at-rest
    # on the board while a live worker existed.
    fiber_id = "tests/pinned-orphan"
    uid = "01KTHDNZS287ZSSG8X8V59XKWD"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid, "status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: pinned\n", "active")
    MockRunner.add_tmux_session(Dispatcher.session_name(fiber_id, uid))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_pinned_orphan,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert_eventually(fn ->
      snap = Poller.snapshot(poller)

      assert Enum.any?(snap.eligible, &(&1.fiber_id == fiber_id and &1.state == "running")),
             "a resting pinned role with a live orphan session must be adopted as running"
    end)
  end

  # Retries collapsed into the poll loop (slice 6): a status:active oneshot whose
  # worker died while the daemon was down has no live tmux session, so it is
  # simply eligible again — the next poll re-dispatches it. There is no separate
  # "resurrection" path or retry row to assert; the contract is that a fresh
  # session is spawned.
  test "poller re-dispatches a status:active oneshot whose worker died while the daemon was down" do
    fiber_id = "tests/orphan-dispatched-dead"

    MockRunner.set_shuttle(fiber_id, """
    kind: oneshot
    agent: claude-sonnet
    """)

    # A prior dispatch is recorded in the dispatch marker but no tmux session is alive.
    write_dispatch_marker(fiber_id, "577af64b-644a-4733-9e6a-f60d86b6941f")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resurrect_orphan,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
           end)

    assert Enum.any?(Poller.snapshot(poller).eligible, &(&1.fiber_id == fiber_id))
  end

  # Regression for the 2026-05-30 incident: a cineca/candide restart resurrected
  # Mac-owned Portolan constitutions locally because the orphan path never read
  # `host`. The poll path uses the strict ownership predicate — a fiber owned by
  # another host is never dispatched here.
  test "poller does not dispatch a foreign-host oneshot whose worker is dead" do
    fiber_id = "tests/orphan-foreign-host"

    MockRunner.set_shuttle(fiber_id, """
    kind: oneshot
    host: some-other-machine
    """)

    write_dispatch_marker(fiber_id, "577af64b-644a-4733-9e6a-f60d86b6941f")

    # own_host_id is the default "test-host", which does not equal
    # "some-other-machine".
    {:ok, poller} =
      start_poller!(
        name: :test_poller_resurrect_foreign_host,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(150)

    snap = Poller.snapshot(poller)
    assert snap.claimed_count == 0

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  # The project_dir disqualifier applies to the poll path: a checkout that does
  # not exist on this host means the worker can't run here, owned or not.
  test "poller does not dispatch an active oneshot whose declared project_dir is missing" do
    fiber_id = "tests/orphan-missing-project-dir"

    MockRunner.set_shuttle(fiber_id, """
    kind: oneshot
    host: test-host
    project_dir: /nonexistent/path/shuttle-orphan-missing
    """)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resurrect_missing_project_dir,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(150)

    snap = Poller.snapshot(poller)
    assert snap.eligible == []
    assert snap.claimed_count == 0

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  # The poll path: an absent host: is unowned everywhere (no nil-wildcard).
  # This is the failure mode that, before the cutover, made the wrong daemon
  # grab single-host work. Distinct from the wrong-host case (host present but
  # mismatched) — here host is structurally absent.
  test "poller treats a host-less fiber as ineligible (absent host is unowned)" do
    fiber_id = "tests/host-absent"

    # Write the .md file directly (discovery walks files), bypassing the
    # factory's host injection so the block genuinely has no host: key —
    # exercising the literal "absent host" branch. The fiber is discovered
    # (it carries a shuttle block) but unowned, hence ineligible everywhere.
    dir_path = Path.join(["/tmp/.felt", fiber_id <> ".md"])
    File.mkdir_p!(Path.dirname(dir_path))

    File.write!(dir_path, """
    ---
    status: active
    shuttle:
      enabled: true
      kind: oneshot
      agent: claude-sonnet
    ---
    body
    """)

    fiber = make_fiber(fiber_id)

    MockRunner.set_fiber(
      fiber_id,
      Map.put(fiber, "shuttle", %{
        "enabled" => true,
        "kind" => "oneshot",
        "agent" => "claude-sonnet"
      })
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_host_absent,
        runner: MockRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(50)

    snap = Poller.snapshot(poller)
    assert snap.eligible == []
    assert snap.claimed_count == 0

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  after
    File.rm_rf!(Path.join(["/tmp/.felt", "tests/host-absent.md"]))
  end

  test "poller marks an armed standing role awaiting when its worker died while the daemon was down" do
    # Slice 6 dead-orphan handling on the tmux-scan substrate: a standing role
    # whose document is armed (status:active, no verdict) but whose tmux session
    # is gone never fired handle_worker_exit (daemon was down across the exit), so
    # the poll-scan marks it awaiting (status:closed) — never re-dispatched, never
    # re-fired off the schedule mid-cycle.
    fiber_id = "tests/standing-dead-orphan"

    previous_loom_homes = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", "/tmp")
    on_exit(fn -> restore_env("FELT_STORES", previous_loom_homes) end)

    # A far-future schedule so the role is NOT cron-due — the only thing that
    # could touch it is the dead-orphan marker, not a scheduled dispatch.
    MockRunner.set_shuttle(fiber_id, """
    kind: standing
    agent: claude-sonnet
    schedule:
      expr: "0 9 1 1 *"
      tz: Europe/Paris
    """)

    # The marker discriminator: a dispatch marker with no handoff (and no re-arm)
    # after it marks this as a daemon-down-across-exit dead orphan.
    write_dispatch_marker(fiber_id, "dead-session-uuid")

    doc_path = "/tmp/.felt/#{fiber_id}/standing-dead-orphan.md"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_dead_orphan,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    assert wait_until(fn -> File.read!(doc_path) =~ "status: closed" end, 80)

    # No worker was spawned — the role was marked awaiting, not dispatched.
    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "poller self-heals (does not close) a standing role whose markers are time-inverted" do
    # Regression: a run whose `handed_off_at` is EARLIER than its `dispatched_at`
    # is physically impossible (you can't hand off before you're dispatched), so
    # the markers are corrupt — NOT a genuine "dispatched, never handed off"
    # orphan. The dead-orphan predicate misreads the inversion as an orphan and,
    # with no live tmux session, force-closes a healthy `status: active` role on
    # every poll. The reconciler must instead SELF-HEAL: stamp handed_off_at=now
    # (concluding the phantom run) and leave the role armed.
    fiber_id = "tests/standing-inverted-markers"

    previous_loom_homes = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", "/tmp")
    on_exit(fn -> restore_env("FELT_STORES", previous_loom_homes) end)

    MockRunner.set_shuttle(fiber_id, """
    kind: standing
    agent: claude-sonnet
    schedule:
      expr: "0 9 1 1 *"
      tz: Europe/Paris
    """)

    # Dispatch at T, handoff 94ms BEFORE T — the observed inversion.
    dispatched = DateTime.utc_now()
    write_dispatch_marker(fiber_id, "inverted-session-uuid", dispatched)
    write_handoff_marker(fiber_id, DateTime.add(dispatched, -94, :millisecond))

    doc_path = "/tmp/.felt/#{fiber_id}/standing-inverted-markers.md"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_inverted,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    # Self-heal fired: a `felt shuttle mark-runtime --handed-off-at` write was
    # issued to conclude the phantom run.
    assert wait_until(
             fn ->
               Enum.any?(MockRunner.commands(), fn {cmd, args} ->
                 cmd == "felt" and match?(["shuttle", "mark-runtime" | _], args) and
                   "--handed-off-at" in args
               end)
             end,
             80
           )

    # The document was NEVER closed — the role stays armed.
    assert File.read!(doc_path) =~ "status: active"
    refute File.read!(doc_path) =~ "status: closed"

    # No worker was spawned.
    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "poller PARKS (never self-heals) a dead pinned role whose markers are time-inverted" do
    # Regression for the pinned relaunch loop: an inverted pair (handed_off_at
    # earlier than dispatched_at) is NOT corrupt — it is the ordinary shape of
    # any re-dispatched role, because the PREVIOUS run's handoff stamp persists
    # under the new dispatch's newer dispatched_at. The standing-only self-heal
    # (stamp handed_off_at=now) applied to a pinned dirty death MANUFACTURES the
    # pinned autonomous relaunch trigger (deliberate_handoff_since_dispatch?),
    # looping the role forever: heal → dispatch → dirty death → heal → …
    # A dead pinned role must fall through to the park branch (status: open),
    # with no handoff stamp and no fresh dispatch.
    fiber_id = "tests/pinned-inverted-markers"

    previous_loom_homes = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", "/tmp")
    on_exit(fn -> restore_env("FELT_STORES", previous_loom_homes) end)

    MockRunner.set_shuttle(fiber_id, """
    kind: pinned
    agent: claude-sonnet
    """)

    # A prior run's handoff, then a newer dispatch that died dirty (no live
    # session): handed_off_at < dispatched_at.
    dispatched = DateTime.utc_now()
    write_dispatch_marker(fiber_id, "pinned-inverted-uuid", dispatched)
    write_handoff_marker(fiber_id, DateTime.add(dispatched, -3600, :second))

    doc_path = "/tmp/.felt/#{fiber_id}/pinned-inverted-markers.md"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_pinned_inverted,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    # Parked back to the strip.
    assert wait_until(fn -> File.read!(doc_path) =~ "status: open" end, 80)

    # No self-heal write: stamping handed_off_at would arm the relaunch trigger.
    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "felt" and match?(["shuttle", "mark-runtime" | _], args) and
               "--handed-off-at" in args
           end)

    # And no fresh worker was spawned.
    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "poller leaves a scheduled standing role armed when a dead ADHOC extra-run is its last run" do
    # Fix #2: a force-dispatched ad-hoc extra-run that dies dirty (daemon down
    # across its exit) must NOT close the SCHEDULED standing role to awaiting —
    # that would disrupt the cron cadence and force a human temper. A COMPLETED
    # ad-hoc run reaches awaiting-review through handle_worker_exit, not this
    # reconciler, so leaving a crashed ad-hoc run's role armed is safe.
    fiber_id = "tests/standing-dead-adhoc"

    previous_loom_homes = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", "/tmp")
    on_exit(fn -> restore_env("FELT_STORES", previous_loom_homes) end)

    MockRunner.set_shuttle(fiber_id, """
    kind: standing
    agent: claude-sonnet
    schedule:
      expr: "0 9 1 1 *"
      tz: Europe/Paris
    """)

    # Plausible-but-orphaned markers (dispatched, NO handoff — a genuine dirty
    # death, not an inversion) carrying an ad-hoc run_id.
    write_dispatch_marker(fiber_id, "dead-adhoc-uuid")
    MockRunner.put_shuttle_fields(fiber_id, %{"run_id" => "adhoc-1751558400000"})

    doc_path = "/tmp/.felt/#{fiber_id}/standing-dead-adhoc.md"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_dead_adhoc,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(150)

    # The scheduled role's document is untouched: still armed, never closed.
    assert File.read!(doc_path) =~ "status: active"
    refute File.read!(doc_path) =~ "status: closed"

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "a wedged tmux ls does not mark live standing roles dead" do
    # `tmux ls` timing out means the session list is UNKNOWN, not empty.
    # Reading it as "no sessions" mass-marked every armed standing role
    # awaiting (status:closed — a fiber WRITE) off a single wedged scan.
    # Uncertainty counts as present (Shuttle.Tmux): the dead-orphan pass must
    # skip the tick and let the next healthy scan decide.
    fiber_id = "tests/standing-tmux-wedged"

    previous_loom_homes = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", "/tmp")
    on_exit(fn -> restore_env("FELT_STORES", previous_loom_homes) end)

    # Same shape as the dead-orphan case — armed, dispatched, un-exited, not
    # cron-due — except tmux cannot answer.
    MockRunner.set_shuttle(fiber_id, """
    kind: standing
    agent: claude-sonnet
    schedule:
      expr: "0 9 1 1 *"
      tz: Europe/Paris
    """)

    write_dispatch_marker(fiber_id, "wedged-session-uuid")

    doc_path = "/tmp/.felt/#{fiber_id}/standing-tmux-wedged.md"

    # MockRunner is reset per test, so the wedge does not bleed across tests.
    MockRunner.set_tmux_ls_timeout(true)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_tmux_wedged,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(200)

    # The role's document is untouched: still armed, never flipped to closed.
    assert File.read!(doc_path) =~ "status: active"
    refute File.read!(doc_path) =~ "status: closed"
  end

  test "poller does not re-dispatch a closed oneshot whose worker is dead" do
    fiber_id = "tests/closed-with-session"

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: oneshot
      agent: claude-sonnet
      """,
      "closed"
    )

    write_dispatch_marker(fiber_id, "closed-uuid")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_closed_not_resurrected,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(150)

    # Closed is the don't-re-fire gate: no new session is spawned.
    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "poller clears stale running state when the tmux session disappears" do
    fiber_id = "tests/missing-running-session"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_missing_running_session,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, [])
    assert session == Dispatcher.session_name(fiber_id)

    MockRunner.remove_tmux_session(session)
    send(poller, :run_poll_cycle)

    # The poll must clear the dead-session running entry, record it as an
    # orphan, and recover the fiber by re-dispatching it. Whether the fiber is
    # *currently* in `running` is a transient: the watcher for the now-dead
    # session fires a late `{:worker_exited}` that flips it toward a retry, and
    # the retry re-dispatches again — so "running right now" flaps on watcher
    # timing. The stable invariants are the orphan record and that a second
    # dispatch happened, so assert those instead of catching the flap.
    #
    # Ceiling 1200 (~30s), not the file's 80-attempt (~2s) norm: this assert
    # needs the reconcile-then-redispatch round trip to land TWICE over —
    # once implicitly (the initial manual dispatch already happened), once via
    # the full async tick→Task→:poll_world→apply_poll_cycle→dispatch chain
    # this test's single `send(poller, :run_poll_cycle)` triggers. On a shared,
    # variably-loaded machine this occasionally took >10s wall-clock (not
    # stuck — every observed run eventually resolved, just slower under a
    # transient load spike), so the margin is generous on purpose:
    # `wait_until` returns the instant the condition holds, so this costs
    # nothing beyond the ~10ms round trip on the common, unloaded path.
    assert wait_until(
             fn ->
               snap = Poller.snapshot(poller)

               new_session_count =
                 MockRunner.commands()
                 |> Enum.count(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)

               Enum.any?(snap.orphans, &(&1.fiber_id == fiber_id)) and new_session_count >= 2
             end,
             1200
           )

    snap = Poller.snapshot(poller)

    assert [
             %{
               fiber_id: ^fiber_id,
               tmux_session: ^session,
               reason: "missing_tmux_session"
             }
             | _
           ] = snap.orphans
  end

  test "poller re-adopts a live tmux worker on restart (running is tmux-derived)" do
    # Daemon state is derived and disposable (slice 6: no runtime store). After a
    # restart the live tmux session is re-adopted by adopt_orphans, so the worker
    # is tracked again — running work survives because tmux owns the process.
    fiber_id = "tests/runtime-rehydrate-live"

    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_rehydrate_live_1,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, [])
    assert Enum.any?(Poller.snapshot(poller).eligible, &(&1.fiber_id == fiber_id))

    GenServer.stop(poller)

    # The tmux session is still alive (the MockRunner tracks it across the
    # GenServer restart) — the restarted poller re-adopts it from the tmux scan.
    {:ok, restarted} =
      start_poller!(
        name: :test_poller_runtime_rehydrate_live_2,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert wait_until(fn ->
             Poller.snapshot(restarted).eligible
             |> Enum.any?(&(&1.fiber_id == fiber_id and &1.tmux_session == session))
           end)
  end

  test "poller does not track a worker whose tmux session disappeared while daemon was down" do
    # No runtime store to rehydrate from (slice 6): a restart re-scans tmux, and
    # a dead session is simply absent — nothing is tracked as running, and the
    # still-active fiber is re-dispatched fresh on the next poll.
    fiber_id = "tests/runtime-rehydrate-missing"

    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_rehydrate_missing_1,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, [])

    GenServer.stop(poller)
    MockRunner.remove_tmux_session(session)

    {:ok, restarted} =
      start_poller!(
        name: :test_poller_runtime_rehydrate_missing_2,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    # The dead session is not adopted: the restarted poller has no running entry
    # for this fiber.
    state = :sys.get_state(restarted)
    refute Map.has_key?(state.running, fiber_id)
    refute Enum.any?(state.running, fn {_k, m} -> Map.get(m, :fiber_id) == fiber_id end)
  end

  test "poller clears stale parent running state when only a child session exists" do
    fiber_id = "tests/prefix-parent"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_prefix_parent,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, [])
    MockRunner.remove_tmux_session(session)
    MockRunner.add_tmux_session(session <> "/child")

    assert {:ok, ^session} = Poller.dispatch_fiber(poller, fiber_id, [])

    assert Enum.any?(MockRunner.commands(), fn
             {"tmux", ["has-session", "-t", target]} -> target == "=" <> session
             _ -> false
           end)
  end

  test "poller uses shuttle.project_dir as work_dir when it exists" do
    project_dir =
      Path.join(System.tmp_dir!(), "shuttle-test-proj-#{System.unique_integer([:positive])}")

    File.mkdir_p!(project_dir)

    fiber = make_fiber("tests/project-dir-fiber")
    MockRunner.set_fiber("tests/project-dir-fiber", fiber)

    MockRunner.set_shuttle("tests/project-dir-fiber", """
    enabled: true
    kind: oneshot
    project_dir: #{project_dir}
    """)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_project_dir,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)

    # tmux args: ["new-session", "-d", "-s", session, "-c", work_dir, "bash", "-l", script]
    # work_dir is at index 5
    assert_eventually(fn ->
      {_, args} =
        Enum.find(MockRunner.commands(), fn {cmd, args} ->
          cmd == "tmux" and hd(args) == "new-session"
        end)

      assert Enum.at(args, 5) == project_dir
    end)
  after
    File.rm_rf(Path.join(System.tmp_dir!(), "shuttle-test-proj-*"))
  end

  test "poller disqualifies (does not downgrade) a fiber whose declared project_dir is missing" do
    # A declared project_dir absent on this host means the checkout lives on
    # another machine. The pre-cutover behavior downgraded the worker cwd to a
    # felt store and dispatched anyway (native-desktop misdispatch root cause
    # #2); the cutover makes it *ineligible* — disqualify, don't downgrade.
    # host: test-host matches so the only disqualifier under test is the dir.
    fiber = make_fiber("tests/missing-project-dir")
    MockRunner.set_fiber("tests/missing-project-dir", fiber)

    MockRunner.set_shuttle("tests/missing-project-dir", """
    enabled: true
    kind: oneshot
    host: test-host
    project_dir: /nonexistent/path/shuttle-test-missing
    """)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_missing_project_dir,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, :run_poll_cycle)
    Process.sleep(100)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    assert Poller.snapshot(poller).eligible == []
  end

  test "poller adopts orphan sessions with literal hyphenated fiber ids" do
    fiber_id = "ai-futures/shuttle/constitution-shuttle-standalone"
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "codex"]})

    MockRunner.set_fiber(
      fiber_id,
      Map.put(fiber, "shuttle", %{
        "enabled" => true,
        "kind" => "oneshot",
        "agent" => "claude-sonnet",
        "host" => "test-host"
      })
    )

    MockRunner.add_tmux_session(Dispatcher.session_name(fiber_id))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_10,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert_eventually(fn ->
      snap = Poller.snapshot(poller)
      assert [%{fiber_id: ^fiber_id, tmux_session: session}] = snap.eligible
      assert session == Dispatcher.session_name(fiber_id)
    end)
  end

  # Regression: a fiber with a shuttle: block but *no* constitution tag must be
  # discovered and dispatched. This is the core invariant from the cutover —
  # the block is the source of truth, not the tag.
  test "poller discovers and dispatches a fiber with shuttle block but no constitution tag" do
    fiber_id = "tests/untagged-shuttle"
    fiber = make_fiber(fiber_id, %{"tags" => []})
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_untagged_shuttle,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    send(poller, {:tick, Poller.snapshot(poller) |> Map.get(:tick_token)})

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
           end)

    assert wait_until(fn ->
             Poller.snapshot(poller).eligible
             |> Enum.any?(&(&1.fiber_id == fiber_id))
           end)
  end

  test "dispatch_fiber waits past the default GenServer timeout for slow successful dispatches" do
    fiber_id = "tests/slow-api-dispatch"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)
    MockRunner.set_new_session_delay(5_250)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_slow_dispatch,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    started_at_ms = System.monotonic_time(:millisecond)

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, [])

    elapsed_ms = System.monotonic_time(:millisecond) - started_at_ms
    assert elapsed_ms >= 5_000
    assert session == Dispatcher.session_name(fiber_id)
    assert Poller.snapshot(poller).eligible |> Enum.any?(&(&1.fiber_id == fiber_id))
  end

  # ── Multi-host tests ──
  #
  # These tests exercise the multi-felt-store path directly against the file
  # system; they bypass MockRunner's in-memory fiber store and write real
  # .felt/ directories instead. They use `resolve_fiber_host/2` (the public
  # GenServer call) to verify host_for_fiber resolution without depending on
  # dispatch (which requires the full OTP tree).

  # Helper: write a minimal fiber .md file with a shuttle: block into
  # <host>/.felt/<id>/<basename>.md so read_fiber_shuttle_block can find it.
  defp write_fiber_file(host, fiber_id, shuttle_yaml \\ "enabled: true\nkind: oneshot\n") do
    felt_dir = Path.join(host, ".felt")
    segments = String.split(fiber_id, "/")
    basename = List.last(segments)
    dir_path = Path.join([felt_dir | segments] ++ ["#{basename}.md"])
    File.mkdir_p!(Path.dirname(dir_path))

    indented =
      shuttle_yaml
      |> String.trim()
      |> String.split("\n")
      |> Enum.map_join("\n", &("  " <> &1))

    File.write!(dir_path, "---\nstatus: active\nshuttle:\n#{indented}\n---\nbody\n")
    dir_path
  end

  test "resolve_fiber_host finds a fiber in the first configured host" do
    host_a =
      Path.join(System.tmp_dir!(), "shuttle-multi-host-a-#{System.unique_integer([:positive])}")

    host_b =
      Path.join(System.tmp_dir!(), "shuttle-multi-host-b-#{System.unique_integer([:positive])}")

    File.mkdir_p!(host_a)
    File.mkdir_p!(host_b)

    write_fiber_file(host_a, "tests/fiber-in-a")

    {:ok, poller} =
      start_poller!(
        name: :test_multi_host_resolve_a,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [host_a, host_b]
      )

    assert {:ok, ^host_a} = Poller.resolve_fiber_host(poller, "tests/fiber-in-a")
  after
    Enum.each(
      Path.wildcard(Path.join(System.tmp_dir!(), "shuttle-multi-host-*")),
      &File.rm_rf/1
    )
  end

  test "resolve_fiber_host finds a fiber in the second configured host" do
    host_a =
      Path.join(System.tmp_dir!(), "shuttle-multi-host-a-#{System.unique_integer([:positive])}")

    host_b =
      Path.join(System.tmp_dir!(), "shuttle-multi-host-b-#{System.unique_integer([:positive])}")

    File.mkdir_p!(host_a)
    File.mkdir_p!(host_b)

    write_fiber_file(host_b, "tests/fiber-in-b")

    {:ok, poller} =
      start_poller!(
        name: :test_multi_host_resolve_b,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [host_a, host_b]
      )

    assert {:ok, ^host_b} = Poller.resolve_fiber_host(poller, "tests/fiber-in-b")
  after
    Enum.each(
      Path.wildcard(Path.join(System.tmp_dir!(), "shuttle-multi-host-*")),
      &File.rm_rf/1
    )
  end

  test "resolve_fiber_host returns :not_found for an unknown fiber" do
    host_a =
      Path.join(System.tmp_dir!(), "shuttle-multi-host-a-#{System.unique_integer([:positive])}")

    File.mkdir_p!(host_a)

    {:ok, poller} =
      start_poller!(
        name: :test_multi_host_not_found,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [host_a]
      )

    assert {:error, :not_found} = Poller.resolve_fiber_host(poller, "tests/no-such-fiber")
  after
    Enum.each(
      Path.wildcard(Path.join(System.tmp_dir!(), "shuttle-multi-host-*")),
      &File.rm_rf/1
    )
  end

  test "first-configured host wins for ID collisions" do
    host_a =
      Path.join(System.tmp_dir!(), "shuttle-multi-host-a-#{System.unique_integer([:positive])}")

    host_b =
      Path.join(System.tmp_dir!(), "shuttle-multi-host-b-#{System.unique_integer([:positive])}")

    File.mkdir_p!(host_a)
    File.mkdir_p!(host_b)

    # Same fiber ID in both hosts
    write_fiber_file(host_a, "tests/collision-fiber")
    write_fiber_file(host_b, "tests/collision-fiber")

    {:ok, poller} =
      start_poller!(
        name: :test_multi_host_collision,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [host_a, host_b]
      )

    # host_a is first-configured → wins
    assert {:ok, ^host_a} = Poller.resolve_fiber_host(poller, "tests/collision-fiber")
  after
    Enum.each(
      Path.wildcard(Path.join(System.tmp_dir!(), "shuttle-multi-host-*")),
      &File.rm_rf/1
    )
  end

  test "bust_fiber_host_cache allows re-resolution after a fiber moves" do
    host_a =
      Path.join(System.tmp_dir!(), "shuttle-multi-host-a-#{System.unique_integer([:positive])}")

    host_b =
      Path.join(System.tmp_dir!(), "shuttle-multi-host-b-#{System.unique_integer([:positive])}")

    File.mkdir_p!(host_a)
    File.mkdir_p!(host_b)

    path_a = write_fiber_file(host_a, "tests/movable-fiber")

    {:ok, poller} =
      start_poller!(
        name: :test_multi_host_bust,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [host_a, host_b]
      )

    # Initially resolves to host_a
    assert {:ok, ^host_a} = Poller.resolve_fiber_host(poller, "tests/movable-fiber")

    # "Move" the fiber to host_b (delete from a, write to b)
    File.rm_rf!(Path.dirname(path_a))
    write_fiber_file(host_b, "tests/movable-fiber")

    # Cache still returns host_a without busting
    assert {:ok, ^host_a} = Poller.resolve_fiber_host(poller, "tests/movable-fiber")

    # After bust, re-probes the file system → host_b
    :ok = Poller.bust_fiber_host_cache(poller, "tests/movable-fiber")
    assert {:ok, ^host_b} = Poller.resolve_fiber_host(poller, "tests/movable-fiber")
  after
    Enum.each(
      Path.wildcard(Path.join(System.tmp_dir!(), "shuttle-multi-host-*")),
      &File.rm_rf/1
    )
  end

  test "subdirectory symlink: loom-walks-into-project subtree skipped" do
    # Mirrors loom→lightcone topology: physical .felt lives in host_b
    # (project-canonical, like lightcone). host_a (loom) symlinks INTO
    # host_b's tree at .felt/ai-futures/lightcone. Walking host_a should
    # NOT enumerate the symlinked subtree — host_b enumerates canonically.
    # This is load-bearing: if loom enumerates the lightcone fiber under
    # its loom-relative id, dispatch later runs `felt -C ~/loom show
    # ai-futures/lightcone/...` which fails (loom's index doesn't have
    # the entry) and dispatch silently never happens.
    host_a =
      Path.join(
        System.tmp_dir!(),
        "shuttle-multi-host-loom-#{System.unique_integer([:positive])}"
      )

    host_b =
      Path.join(
        System.tmp_dir!(),
        "shuttle-multi-host-lightcone-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(Path.join(host_a, ".felt/ai-futures"))
    File.mkdir_p!(host_b)

    # The real fiber file is rooted in host_b's .felt/, accessible via the
    # project-canonical id `lightcone-ui/myst-as-ast/dual-branch`.
    write_fiber_file(host_b, "lightcone-ui/myst-as-ast/dual-branch")

    # host_a (loom) symlinks INTO host_b's tree, so the same physical file
    # is reachable as host_a/.felt/ai-futures/lightcone/lightcone-ui/.../dual-branch.md.
    File.ln_s!(
      Path.join(host_b, ".felt"),
      Path.join([host_a, ".felt", "ai-futures", "lightcone"])
    )

    {:ok, poller} =
      start_poller!(
        name: :test_subdir_symlink_skip,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [host_a, host_b]
      )

    # The fiber should resolve to host_b (canonical), not host_a (symlink view).
    assert {:ok, ^host_b} =
             Poller.resolve_fiber_host(poller, "lightcone-ui/myst-as-ast/dual-branch")

    snap = Poller.snapshot(poller)
    candidate_ids = Enum.map(snap.eligible, & &1.fiber_id)

    refute "ai-futures/lightcone/lightcone-ui/myst-as-ast/dual-branch" in candidate_ids,
           "loom-relative symlink-aliased id leaked into eligible: #{inspect(candidate_ids)}"
  after
    Enum.each(
      Path.wildcard(Path.join(System.tmp_dir!(), "shuttle-multi-host-*")),
      &File.rm_rf/1
    )
  end

  test "host with symlinked .felt/ skipped entirely" do
    # Mirrors project-cities-on-loom topology: project's `.felt/` is a
    # symlink into loom's tree. Walking the project host should skip
    # everything — loom enumerates the same files canonically.
    loom =
      Path.join(
        System.tmp_dir!(),
        "shuttle-multi-host-loom-#{System.unique_integer([:positive])}"
      )

    project =
      Path.join(
        System.tmp_dir!(),
        "shuttle-multi-host-project-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(loom)
    File.mkdir_p!(project)

    # Physical fiber rooted in loom under ai-futures/portolan/.
    write_fiber_file(loom, "ai-futures/portolan/kanban-modal")

    # Project's .felt/ symlinks into loom's ai-futures/portolan/ subdir,
    # so the same kanban-modal.md is reachable as project/.felt/kanban-modal/.
    File.ln_s!(
      Path.join([loom, ".felt", "ai-futures", "portolan"]),
      Path.join(project, ".felt")
    )

    {:ok, poller} =
      start_poller!(
        name: :test_symlinked_felt_skipped,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [loom, project]
      )

    # The fiber resolves to loom (canonical), not project (symlinked .felt).
    assert {:ok, ^loom} = Poller.resolve_fiber_host(poller, "ai-futures/portolan/kanban-modal")

    snap = Poller.snapshot(poller)
    candidate_ids = Enum.map(snap.eligible, & &1.fiber_id)

    refute "kanban-modal" in candidate_ids,
           "project-symlink alias surfaced: #{inspect(candidate_ids)}"
  after
    Enum.each(
      Path.wildcard(Path.join(System.tmp_dir!(), "shuttle-multi-host-*")),
      &File.rm_rf/1
    )
  end

  test "resolve_fiber_host fallback ignores symlinked project view after cache bust" do
    loom =
      Path.join(
        System.tmp_dir!(),
        "shuttle-multi-host-loom-#{System.unique_integer([:positive])}"
      )

    project =
      Path.join(
        System.tmp_dir!(),
        "shuttle-multi-host-project-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(loom)
    File.mkdir_p!(project)

    write_fiber_file(loom, "ai-futures/portolan/kanban-modal")

    File.ln_s!(
      Path.join([loom, ".felt", "ai-futures", "portolan"]),
      Path.join(project, ".felt")
    )

    {:ok, poller} =
      start_poller!(
        name: :test_symlinked_felt_cache_bust,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [loom, project]
      )

    :ok = Poller.bust_fiber_host_cache(poller, "ai-futures/portolan/kanban-modal")

    assert {:ok, ^loom} = Poller.resolve_fiber_host(poller, "ai-futures/portolan/kanban-modal")
  after
    Enum.each(
      Path.wildcard(Path.join(System.tmp_dir!(), "shuttle-multi-host-*")),
      &File.rm_rf/1
    )
  end

  test "snapshot includes felt_stores list" do
    {:ok, poller} =
      start_poller!(
        name: :test_multi_host_snap,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp/host-one", "/tmp/host-two"]
      )

    snap = Poller.snapshot(poller)
    assert snap.felt_stores == ["/tmp/host-one", "/tmp/host-two"]
  end

  test "poller reads configured hosts from persisted registration" do
    config_path =
      Path.join(
        System.tmp_dir!(),
        "shuttle-felt-stores-poller-#{System.unique_integer([:positive])}.json"
      )

    original_file = System.get_env("FELT_STORES_FILE")
    original_homes = System.get_env("FELT_STORES")

    System.put_env("FELT_STORES_FILE", config_path)
    System.delete_env("FELT_STORES")
    File.mkdir_p!(Path.dirname(config_path))

    File.write!(
      config_path,
      Jason.encode!(%{"version" => 1, "felt_stores" => ["/tmp/host-a", "/tmp/host-b"]})
    )

    on_exit(fn ->
      File.rm(config_path)

      case original_file do
        nil -> System.delete_env("FELT_STORES_FILE")
        value -> System.put_env("FELT_STORES_FILE", value)
      end

      case original_homes do
        nil -> System.delete_env("FELT_STORES")
        value -> System.put_env("FELT_STORES", value)
      end
    end)

    {:ok, poller} =
      start_poller!(
        name: :test_registered_felt_stores,
        runner: MockRunner,
        poll_interval_ms: 60_000
      )

    assert Poller.snapshot(poller).felt_stores == ["/tmp/host-a", "/tmp/host-b"]
  end

  test "poller refreshes configured hosts when the persisted registration changes" do
    config_path =
      Path.join(
        System.tmp_dir!(),
        "shuttle-felt-stores-refresh-#{System.unique_integer([:positive])}.json"
      )

    original_file = System.get_env("FELT_STORES_FILE")
    original_homes = System.get_env("FELT_STORES")

    System.put_env("FELT_STORES_FILE", config_path)
    System.delete_env("FELT_STORES")
    File.mkdir_p!(Path.dirname(config_path))
    File.write!(config_path, Jason.encode!(%{"version" => 1, "felt_stores" => ["/tmp/host-a"]}))

    on_exit(fn ->
      File.rm(config_path)

      case original_file do
        nil -> System.delete_env("FELT_STORES_FILE")
        value -> System.put_env("FELT_STORES_FILE", value)
      end

      case original_homes do
        nil -> System.delete_env("FELT_STORES")
        value -> System.put_env("FELT_STORES", value)
      end
    end)

    {:ok, poller} =
      start_poller!(
        name: :test_refresh_registered_felt_stores,
        runner: MockRunner,
        poll_interval_ms: 60_000
      )

    assert Poller.snapshot(poller).felt_stores == ["/tmp/host-a"]

    File.write!(config_path, Jason.encode!(%{"version" => 1, "felt_stores" => ["/tmp/host-c"]}))
    send(poller, :run_poll_cycle)

    assert_eventually(fn ->
      assert Poller.snapshot(poller).felt_stores == ["/tmp/host-c"]
    end)
  end

  # ── Claim (write-and-claim) ──

  test "claim registers a live external session: rename, runtime, exit handling" do
    id = "tests/claim-me"
    MockRunner.set_fiber(id, make_fiber(id, %{"uid" => "01CLAIMUID"}))
    MockRunner.set_shuttle(id, @oneshot_shuttle)
    MockRunner.add_tmux_session("capture-abc123")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_claim,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert {:ok, %{session: session}} =
             Poller.claim_session(poller, id, "capture-abc123", session_uuid: "uuid-claim-1")

    # Renamed to the canonical worker name — indistinguishable from a dispatch.
    assert session == "claim-me-01CLAIMUID-shuttle"

    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "rename-session"
           end)

    snap = Poller.snapshot(poller)
    assert Enum.any?(snap.eligible, &(&1.fiber_id == id))

    # The claim shelled `felt shuttle mark-runtime` to stamp the session uuid into
    # the fiber's `shuttle.runtime` block (felt owns the nesting — Stage 5), so
    # resume / continuation can recover it. The daemon's contract is the verb it
    # issues; felt's own suite covers that the verb nests correctly.
    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "felt" and match?(["shuttle", "mark-runtime" | _], args) and
               "--session" in args and "uuid-claim-1" in args
           end)

    new_sessions_before =
      Enum.count(MockRunner.commands(), fn {cmd, args} ->
        cmd == "tmux" and hd(args) == "new-session" and Enum.at(args, 3) == session
      end)

    # Exit handling works exactly as for a dispatched active oneshot: the dead
    # session is noticed by reconciliation, the stale running entry clears, and
    # the same poll tick retries the active fiber under its canonical name.
    MockRunner.remove_tmux_session(session)
    send(poller, :run_poll_cycle)

    assert wait_until(
             fn ->
               Enum.count(MockRunner.commands(), fn {cmd, args} ->
                 cmd == "tmux" and hd(args) == "new-session" and Enum.at(args, 3) == session
               end) > new_sessions_before and
                 Enum.any?(Poller.snapshot(poller).eligible, &(&1.fiber_id == id))
             end,
             80
           )
  end

  test "claim refuses unknown fibers, dead sessions, and double claims" do
    id = "tests/claim-guards"
    MockRunner.set_fiber(id, make_fiber(id, %{"uid" => "01GUARDUID"}))
    # host: other-host keeps the boot poll from AUTO-dispatching this active fiber
    # — which would claim it first and race the manual claim_session calls below.
    # claim_session is host-agnostic (do_claim_session/register_claimed_session
    # never check host), so every guard under test still fires.
    MockRunner.set_shuttle(id, "enabled: true\nkind: oneshot\nhost: other-host\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_claim_guards,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    # Session not live in tmux.
    assert {:error, :session_not_found} =
             Poller.claim_session(poller, id, "capture-dead", [])

    # Fiber unknown.
    MockRunner.add_tmux_session("capture-live01")

    assert {:error, :not_found} =
             Poller.claim_session(poller, "tests/no-such-fiber", "capture-live01", [])

    # First claim wins; a different session claiming the same fiber is refused.
    assert {:ok, %{session: canonical}} = Poller.claim_session(poller, id, "capture-live01", [])
    MockRunner.add_tmux_session("capture-live02")
    assert {:error, :already_running} = Poller.claim_session(poller, id, "capture-live02", [])

    # Idempotent retry: re-claiming with the original (now-renamed-away) name
    # or with the canonical name returns the registered session, not an error —
    # a lost claim response must be retryable with the same body.
    assert {:ok, %{session: ^canonical}} = Poller.claim_session(poller, id, "capture-live01", [])
    assert {:ok, %{session: ^canonical}} = Poller.claim_session(poller, id, canonical, [])
  end

  test "claim refuses closed fibers" do
    id = "tests/claim-closed"
    MockRunner.set_fiber(id, make_fiber(id, %{"status" => "closed"}))
    MockRunner.set_shuttle(id, @oneshot_shuttle, "closed")
    MockRunner.add_tmux_session("capture-closed1")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_claim_closed,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert {:error, :closed} = Poller.claim_session(poller, id, "capture-closed1", [])
  end

  # ── Capture (spawn-without-constitution) ──

  test "capture spawns a tmux session from a free-text prompt" do
    {:ok, poller} =
      start_poller!(
        name: :test_poller_capture,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp"]
      )

    assert {:ok, %{session: "capture-" <> _ = session, agent_id: "claude-sonnet"}} =
             Poller.capture(poller, "build me a thing", work_dir: "/tmp")

    # Right tmux command: detached session under the capture name, rooted in
    # the requested project dir — the last free boundary before a real agent.
    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session" and
               Enum.at(args, 3) == session and Enum.at(args, 5) == "/tmp"
           end)

    # Pre-claim, the capture session is invisible to the shuttle-session
    # machinery (not `-shuttle`-suffixed): a poll does not adopt or kill it.
    send(poller, :run_poll_cycle)
    Process.sleep(50)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "kill-session" and Enum.at(args, 2) =~ "capture-"
           end)
  end
end
