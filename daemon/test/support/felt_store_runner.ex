defmodule Shuttle.Test.FeltStoreRunner do
  @moduledoc """
  A `Shuttle.Runner` that simulates a live felt store: fiber files are really
  written under a throwaway root, and both CLIs plus `tmux *` are answered
  from Agent state.

  This is the runner for tests that need the daemon to actually discover,
  dispatch, and reconcile — `PollerTest` and `APIControllerTest`. Tests that
  only need a scripted response queue or a fixture table (`DispatcherTest`,
  `RemoteRegistryTest`, `WorkerWatcherTest`) keep their own local mocks; those
  are different abstractions that happen to share this behaviour.

  One instance per test: `start!/0` starts it under the test supervisor and
  registers it in the test's scope (`Shuttle.Test.Env.start_scoped!/1`); the
  daemon processes the test starts (a Poller and its tasks) find the same
  instance through `$ancestors`/`$callers`.
  """

  import Shuttle.Test.TmuxSessions

  @behaviour Shuttle.Runner

  use Agent

  @doc "Start this test's instance (see the moduledoc); returns its pid."
  def start!, do: Shuttle.Test.Env.start_scoped!(__MODULE__)

  defp server, do: Shuttle.Test.Env.server!(__MODULE__)

  def start_link(_ \\ []) do
    # Each runner gets its own throwaway store root under a unique temp
    # dir rather than the shared global `/tmp/.felt` — on a shared box, a
    # concurrent user's `/tmp/.felt` (or its own leftover state) must never
    # be read from or `rm -rf`'d by this suite.
    root =
      Path.join(
        System.tmp_dir!(),
        "shuttle-felt-store-mock-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(Path.join(root, ".felt"))

    Agent.start_link(fn ->
      %{
        felt_root: root,
        commands: [],
        tmux_sessions: MapSet.new(),
        fibers: %{},
        shuttle: %{},
        ls_stderr_warning: false,
        ls_delay_ms: 0,
        new_session_delay_ms: 0
      }
    end)
  end

  # The store root (the directory containing `.felt/`) this run's MockRunner
  # writes fiber files under — pass this to `felt_stores:` / `SHUTTLE_STORES`
  # rather than relying on the operator's configured stores.
  def felt_root, do: Agent.get(server(), & &1.felt_root)

  # `<felt_root>/.felt`.
  def felt_dir, do: Path.join(felt_root(), ".felt")

  def reset do
    # Remove any fiber files written by set_shuttle so tests start clean.
    File.rm_rf(felt_dir())
    File.mkdir_p!(felt_dir())

    Agent.update(server(), fn state ->
      %{
        felt_root: state.felt_root,
        commands: [],
        tmux_sessions: MapSet.new(),
        fibers: %{},
        shuttle: %{},
        ls_stderr_warning: false,
        ls_delay_ms: 0,
        new_session_delay_ms: 0
      }
    end)
  end

  # Carry a felt-style absolute `path` so the poller's store-ownership check
  # (which reads felt's `path`) sees the fiber as rooted in `/tmp`. Preserves
  # an existing path when `set_shuttle` already wrote one, and synthesizes the
  # canonical `<id>/<leaf>.md` shape otherwise, mirroring real felt's output.
  def set_fiber(id, fiber) do
    # Computed OUTSIDE the Agent.update closure: felt_dir/0 itself calls
    # back into this same Agent, and a GenServer can't call itself from
    # inside its own callback (deadlocks as "process attempted to call
    # itself"). Only used as a fallback, so the eager call is harmless when
    # an existing/explicit path already wins below.
    fallback_path = synth_path(felt_dir(), id)

    Agent.update(server(), fn state ->
      existing_path = get_in(state.fibers, [id, "path"])
      path = Map.get(fiber, "path") || existing_path || fallback_path
      put_in(state.fibers[id], Map.put(fiber, "path", path))
    end)
  end

  defp synth_path(dir, id) do
    leaf = id |> String.split("/") |> List.last()
    realpath(Path.join([dir, id, "#{leaf}.md"]))
  end

  # Write a real .md file carrying the given shuttle: block and felt status so
  # the poller can discover host ownership from the filesystem while reading
  # Shuttle data through the mocked `shuttle ls` / `shuttle show` JSON surfaces.
  # The status defaults to "active" — pass an explicit value for tests that
  # verify eligibility gates (closed, untracked, etc.).
  def set_shuttle(id, yaml, status \\ "active") do
    # Every installed block carries an explicit `host:` equal to the owning
    # daemon's own_host_id. The factory mirrors that: a block whose YAML
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

    # Armed installs carry a `project_dir`, and a forced start refuses a block
    # without one. The factory stamps the store root — a directory that exists —
    # so generic dispatch tests start their workers where they always have. A
    # test about a missing directory writes `project_dir: ""`, which wins.
    yaml =
      if Regex.match?(~r/^\s*project_dir\s*:/m, yaml) do
        yaml
      else
        String.trim_trailing(yaml) <> "\nproject_dir: #{felt_root()}\n"
      end

    dir = felt_dir()
    segments = String.split(id, "/")
    basename = List.last(segments)
    dir_path = Path.join([dir | segments] ++ ["#{basename}.md"])
    File.mkdir_p!(Path.dirname(dir_path))
    indented = yaml |> String.trim() |> String.split("\n") |> Enum.map_join("\n", &("  " <> &1))

    # The file carries the same intrinsic id as the in-memory fiber, so a real
    # felt reading it (the document reader) sees the uid the mock serves. A
    # fiber set up with `"uid" => nil` stays id-less on disk too.
    uid =
      case fiber(id) do
        nil -> Shuttle.Test.FiberUid.for(id)
        existing -> Map.get(existing, "uid")
      end

    id_line = if uid, do: "id: #{uid}\n", else: ""
    File.write!(dir_path, "---\n#{id_line}status: #{status}\nshuttle:\n#{indented}\n---\nbody\n")

    # Mirror real felt: carry the absolute, symlink-resolved on-disk `path`.
    # The poller reads this `path` to decide store ownership; the Shuttle
    # response carries this metadata.
    carried_path = realpath(dir_path)

    shuttle_block =
      case YamlElixir.read_from_string(yaml) do
        {:ok, data} when is_map(data) -> data
        _ -> %{}
      end

    Agent.update(server(), fn state ->
      fiber =
        state.fibers
        |> Map.get(id, %{
          "id" => id,
          "uid" => uid,
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
  # poller reads these from the Shuttle fiber response, so updating the map is
  # what continuation and orphan readers see on the next poll.
  #
  # Runtime-key fields nest under `shuttle.runtime`, matching Shuttle's
  # `mark-runtime` writer. Any non-runtime key in `fields` still merges at the
  # top level.
  @runtime_key_names ~w(dispatched_at session_uuid handed_off_at run_id)

  def put_shuttle_fields(id, fields) do
    {runtime_fields, config_fields} = Map.split(fields, @runtime_key_names)

    Agent.update(server(), fn state ->
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
  def fiber(id), do: Agent.get(server(), &Map.get(&1.fibers, id))

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

  def set_ls_stderr_warning(enabled),
    do: Agent.update(server(), &Map.put(&1, :ls_stderr_warning, enabled))

  # Simulate a host where the agent's wrapper resolves to nothing in a login
  # bash — the dispatcher's preflight probe (`bash -lc "type -t -- '<word>'"`)
  # then exits non-zero, and the dispatch is refused before any tmux spawn.
  def set_wrapper_missing(enabled),
    do: Agent.update(server(), &Map.put(&1, :wrapper_missing, enabled))

  # Simulate a host with NO tmux server at all — `tmux ls` answers with tmux's
  # own absence message, the positive evidence `Shuttle.TmuxServer.presence/1`
  # requires before it will refuse a dispatch on macOS.
  def set_tmux_server_missing(enabled),
    do: Agent.update(server(), &Map.put(&1, :tmux_server_missing, enabled))

  # Simulate a listing timeout while `shuttle show` remains responsive, so the
  # poller's last-known-candidate retention path is exercised.
  def set_listing_timeout(enabled),
    do: Agent.update(server(), &Map.put(&1, :listing_timeout, enabled))

  def set_ls_delay(ms),
    do: Agent.update(server(), &Map.put(&1, :ls_delay_ms, ms))

  # Hold the next `felt`/`shuttle ls` until the caller releases it: the
  # listing process sends `{:ls_held, reader}` to the caller of `hold_ls/0`
  # and waits for `:release_ls`. One-shot; later listings run as usual. A
  # test that holds a poll read this way knows exactly when it is in flight.
  def hold_ls do
    holder = self()
    Agent.update(server(), &Map.put(&1, :ls_hold, holder))
  end

  # Simulate a wedged tmux: `tmux ls` returns the bounded runner's timeout
  # shape. The session list is then UNKNOWN — the poller must skip its
  # destructive/reconciling scans, never read it as "no sessions".
  def set_tmux_ls_timeout(enabled),
    do: Agent.update(server(), &Map.put(&1, :tmux_ls_timeout, enabled))

  # What the process scan (`ps -o pid=,ppid=,args= -U <uid>`,
  # `Shuttle.WorkerProcess`) answers. Defaults to no processes.
  def set_ps_result(result),
    do: Agent.update(server(), &Map.put(&1, :ps_result, result))

  # A worker that outlives `tmux kill-session`: after the next successful kill,
  # the killed session's run script stays in the process scan for `scans` more
  # `ps` calls, or — with `:until_signalled` — until a `kill` names its pid.
  def set_worker_linger(scans),
    do: Agent.update(server(), &Map.put(&1, :worker_linger, scans))

  @linger_pid 4242

  def add_tmux_session(session),
    do: Agent.update(server(), &%{&1 | tmux_sessions: MapSet.put(&1.tmux_sessions, session)})

  def remove_tmux_session(session),
    do: Agent.update(server(), &%{&1 | tmux_sessions: MapSet.delete(&1.tmux_sessions, session)})

  def set_new_session_delay(ms),
    do: Agent.update(server(), &Map.put(&1, :new_session_delay_ms, ms))

  # Force `tmux kill-session` to fail. The message atoms mimic tmux's own
  # "session/server already gone" exits — every one of these kill_session must
  # still treat as success: `:not_found`/`:no_such` are per-session phrasings,
  # `:no_server` is tmux with no server at all. Any boolean value simulates a
  # genuine kill failure (e.g. a zombie process tmux couldn't reap).
  def set_kill_session_failure(:not_found),
    do:
      Agent.update(
        server(),
        &Map.put(&1, :kill_session_failure, {"can't find session: nope", 1})
      )

  def set_kill_session_failure(:no_such),
    do:
      Agent.update(
        server(),
        &Map.put(&1, :kill_session_failure, {"no such session: shuttle-x", 1})
      )

  def set_kill_session_failure(:no_server),
    do:
      Agent.update(
        server(),
        &Map.put(&1, :kill_session_failure, {"no server running on /tmp/tmux-501/default", 1})
      )

  def set_kill_session_failure(enabled) when is_boolean(enabled),
    do:
      Agent.update(
        server(),
        &Map.put(&1, :kill_session_failure, enabled && {"tmux: hung up", 1})
      )

  # S2: override what `shuttle contract` reports, for tests exercising
  # the boot-time contract handshake. Must be called BEFORE the poller
  # starts (init/1 probes once, synchronously). `level` is the raw stdout
  # string (a mismatched integer, or garbage to exercise "unparseable");
  # `exit_status` defaults to 0 (a nonzero exit is a separate skew shape).
  def set_contract_level(level, exit_status \\ 0) when is_binary(level),
    do:
      Agent.update(
        server(),
        &(&1 |> Map.put(:contract_level, level) |> Map.put(:contract_exit, exit_status))
      )

  # What `shuttle host --json` answers, for tests that clear SHUTTLE_HOST
  # so the Poller asks Shuttle for its identity. `output` is the raw stdout;
  # a nonzero `exit_status` is Shuttle refusing (for example, a malformed host file).
  def set_host_json(output, exit_status \\ 0) when is_binary(output),
    do:
      Agent.update(
        server(),
        &(&1 |> Map.put(:host_json, output) |> Map.put(:host_exit, exit_status))
      )

  def commands, do: Agent.get(server(), & &1.commands)

  # What `shuttle reopen` answers: `{output, exit_status}`. Unset, a reopen
  # succeeds silently without touching the fiber.
  def set_reopen_result(output, exit_status),
    do: Agent.update(server(), &Map.put(&1, :reopen_result, {output, exit_status}))

  # Shuttle inlines a resolved `shuttle.resolved.agent` on fiber reads and serves
  # the registry through `shuttle agents [resolve]`. The daemon consumes those
  # records without resolving names itself, so the mock synthesizes them — keyed
  # off the block's `agent` name (default claude-sonnet). Only the
  # command-rendering keys matter (id/cli/wrapper/model); axes are absent here.
  # Defined before `cmd` so the attribute is in scope where the Shuttle resolve
  # branch reads it.
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
    Agent.update(server(), fn state ->
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
      # The dispatcher's wrapper preflight. Resolves by default so every other
      # test dispatches as before; `set_wrapper_missing(true)` makes the login
      # shell find nothing, the shape a real missing wrapper produces.
      command == "bash" and match?(["-lc", _], args) ->
        if Agent.get(server(), &Map.get(&1, :wrapper_missing, false)) do
          {"", 1}
        else
          {"file\n", 0}
        end

      command == "shuttle" and args == ["contract"] ->
        level =
          Agent.get(
            server(),
            &Map.get(&1, :contract_level, Integer.to_string(Shuttle.Contract.expected_level()))
          )

        {level, Agent.get(server(), &Map.get(&1, :contract_exit, 0))}

      # `shuttle [-C s] accept|resume <id> --local` — shuttle's
      # lifecycle writer. Mirror its document effect on both surfaces (the
      # fiber map `shuttle ls`/`show` answer from, and the real file): a pinned
      # accept re-parks to `status: open`, everything else re-arms to `active`;
      # the verdict and closed-at clear; a standing re-arm concludes the run.
      command == "shuttle" and lifecycle_write?(args) ->
        [verb, id, "--local"] = drop_cli_store(args)
        apply_lifecycle_write(verb, id)
        {"#{verb} #{id}\n", 0}

      # `shuttle resolve-dir <raw>`: like the CLI, expand `$VARS` and `~` and
      # print the path when it is a directory here; refuse otherwise.
      command == "shuttle" and match?(["resolve-dir", _], args) ->
        resolved = args |> List.last() |> expand_env() |> Path.expand()

        if File.dir?(resolved),
          do: {resolved <> "\n", 0},
          else: {"project dir \"#{resolved}\": stat #{resolved}: no such file or directory\n", 1}

      # `shuttle reopen <id> [--project-dir <raw>] [--conclude-run] --local`:
      # answers the result a test set; else, like the CLI, expands a given
      # directory once, refuses one that is not a directory, and saves it as it
      # arms the fiber — concluding a standing role's run only under
      # --conclude-run.
      command == "shuttle" and match?(["reopen" | _], drop_cli_store(args)) ->
        case Agent.get(server(), &Map.get(&1, :reopen_result)) do
          nil ->
            ["reopen", id | flags] = drop_cli_store(args)

            case Enum.drop_while(flags, &(&1 != "--project-dir")) do
              ["--project-dir", raw | _] ->
                dir = raw |> expand_env() |> Path.expand()

                if File.dir?(dir) do
                  put_shuttle_fields(id, %{"project_dir" => dir})
                  apply_lifecycle_write("reopen", id, "--conclude-run" in flags)
                  {"", 0}
                else
                  {"project dir \"#{dir}\": stat #{dir}: no such file or directory\n", 1}
                end

              _ ->
                {"", 0}
            end

          result ->
            result
        end

      command == "shuttle" and args == ["host", "--json"] ->
        Agent.get(server(), fn state ->
          {Map.get(state, :host_json, ~s({"id": "mock-host"})), Map.get(state, :host_exit, 0)}
        end)

      # `shuttle agents resolve <name> ...` — the capture path's no-fiber
      # resolution. The daemon shells Shuttle (registry owner) rather than
      # re-resolving; the mock returns Shuttle's resolved.agent JSON shape.
      #
      # The bare `shuttle agents --json` listing is deliberately NOT
      # answered: it falls through to `{"", 0}`, the malformed-output shape
      # that AgentsController must survive.
      command == "shuttle" and match?(["agents", "resolve" | _], args) ->
        name = Enum.at(args, 2)
        record = Map.get(@resolved_agents, name, @resolved_agents["claude-sonnet"])
        {Jason.encode!(record), 0}

      command in ["felt", "shuttle"] and String.contains?(full_args, "ls") and
          Agent.get(server(), &Map.get(&1, :listing_timeout, false)) ->
        {"#{command} #{full_args} timed out after 60000ms", :timeout}

      command in ["felt", "shuttle"] and String.contains?(full_args, "ls") ->
        case Agent.get_and_update(server(), &Map.pop(&1, :ls_hold)) do
          holder when is_pid(holder) ->
            send(holder, {:ls_held, self()})
            receive do: (:release_ls -> :ok)

          nil ->
            delay_ms = Agent.get(server(), &Map.get(&1, :ls_delay_ms, 0))
            if delay_ms > 0, do: Process.sleep(delay_ms)
        end

        show_all =
          case Enum.find_index(args, &(&1 in ["-s", "--status"])) do
            nil -> false
            idx -> Enum.at(args, idx + 1) == "all"
          end

        fibers =
          Agent.get(server(), fn state ->
            entries = Map.values(state.fibers)

            if show_all do
              entries
            else
              Enum.filter(entries, fn fiber ->
                Map.get(fiber, "status") in ["open", "active"]
              end)
            end
          end)

        json = Jason.encode!(Enum.map(fibers, &for_cli(command, &1)))
        warning? = Agent.get(server(), & &1.ls_stderr_warning)

        if warning? and Keyword.get(opts, :stderr_to_stdout) do
          {"warning: failed to parse unrelated fiber\n" <> json, 0}
        else
          {json, 0}
        end

      command in ["felt", "shuttle"] and String.contains?(full_args, "show") and
          String.contains?(full_args, "--field shuttle") ->
        fiber_id = extract_fiber_id(args)
        shuttle = Agent.get(server(), & &1.shuttle)
        {Map.get(shuttle, fiber_id, ""), 0}

      command in ["felt", "shuttle"] and String.contains?(full_args, "show") ->
        # `shuttle show --json` includes the resolved Shuttle facet alongside
        # the parsed fiber fields. The mock returns the corresponding fiber map.
        fiber_id = extract_fiber_id(args)
        fibers = Agent.get(server(), & &1.fibers)

        case Map.get(fibers, fiber_id) do
          nil -> {"fiber not found", 1}
          fiber -> {Jason.encode!(for_cli(command, fiber)), 0}
        end

      command == "ps" ->
        Agent.get_and_update(server(), fn state ->
          case Map.get(state, :lingering) do
            {session, scans} when scans == :until_signalled or scans > 0 ->
              line = "#{@linger_pid} 1 bash -l /tmp/shuttle-run-#{session}.1.sh\n"
              left = if is_integer(scans), do: {session, scans - 1}, else: {session, scans}
              {{line, 0}, Map.put(state, :lingering, left)}

            _ ->
              {Map.get(state, :ps_result, {"", 0}), state}
          end
        end)

      command == "kill" ->
        Agent.update(server(), &Map.delete(&1, :lingering))
        {"", 0}

      command == "tmux" and hd(args) == "has-session" ->
        session = Enum.at(args, 2)
        sessions = Agent.get(server(), & &1.tmux_sessions)

        if tmux_session_exists?(sessions, session) do
          {"", 0}
        else
          {"can't find session", 1}
        end

      command == "tmux" and hd(args) == "new-session" ->
        session = Enum.at(args, 3)
        add_tmux_session(session)
        delay_ms = Agent.get(server(), &Map.get(&1, :new_session_delay_ms, 0))
        if delay_ms > 0, do: Process.sleep(delay_ms)
        {"", 0}

      command == "tmux" and hd(args) == "kill-session" ->
        session = Enum.at(args, 2)

        case Agent.get(server(), &Map.get(&1, :kill_session_failure, false)) do
          {output, status} ->
            # An absence answer means the session really is gone from tmux.
            if Shuttle.Tmux.absence_message?(output), do: remove_tmux_session(session)
            {output, status}

          false ->
            remove_tmux_session(session)

            Agent.update(server(), fn state ->
              case Map.pop(state, :worker_linger) do
                {nil, state} -> state
                {scans, state} -> Map.put(state, :lingering, {session, scans})
              end
            end)

            {"", 0}
        end

      command == "tmux" and hd(args) == "rename-session" ->
        ["rename-session", "-t", "=" <> old_name, new_name] = args

        Agent.update(server(), fn state ->
          if MapSet.member?(state.tmux_sessions, old_name) do
            sessions = state.tmux_sessions |> MapSet.delete(old_name) |> MapSet.put(new_name)
            %{state | tmux_sessions: sessions}
          else
            state
          end
        end)

        {"", 0}

      command == "tmux" and hd(args) == "ls" and
          Agent.get(server(), &Map.get(&1, :tmux_ls_timeout, false)) ->
        {"tmux ls timed out after 10000ms", :timeout}

      command == "tmux" and hd(args) == "ls" and
          Agent.get(server(), &Map.get(&1, :tmux_server_missing, false)) ->
        {"error connecting to /tmp/tmux-501/default (No such file or directory)", 1}

      command == "tmux" and hd(args) == "ls" ->
        sessions = Agent.get(server(), & &1.tmux_sessions)
        output = sessions |> MapSet.to_list() |> Enum.join("\n")
        {output, 0}

      # `shuttle mark-runtime <id> [--handed-off-at ts] [--dispatched-at ts]
      # [--session s] [--run-id r] [--host h]` — Shuttle's daemon-facing runtime
      # writer. Fold the stamped flags into the
      # fiber's `shuttle:` map (the same surface put_shuttle_fields updates), so
      # a self-heal / conclude write is observable on the next poll.
      command == "shuttle" and match?(["mark-runtime", _id | _], drop_cli_store(args)) ->
        [_mark, id | flags] = drop_cli_store(args)

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

  defp expand_env(raw),
    do: Regex.replace(~r/\$(\w+)/, raw, fn _, name -> Shuttle.Env.get(name, "") end)

  defp lifecycle_write?(args),
    do: match?([verb, _id, "--local"] when verb in ["accept", "resume"], drop_cli_store(args))

  defp drop_cli_store(["-C", _store | rest]), do: rest
  defp drop_cli_store(args), do: args

  defp apply_lifecycle_write(verb, id, conclude? \\ true) do
    fiber = fiber(id) || %{"id" => id, "shuttle" => %{}}
    kind = get_in(fiber, ["shuttle", "kind"])
    status = if verb == "accept" and kind == "pinned", do: "open", else: "active"

    if conclude? and kind == "standing",
      do: put_shuttle_fields(id, %{"handed_off_at" => DateTime.to_iso8601(DateTime.utc_now())})

    Agent.update(server(), fn state ->
      update_in(state.fibers[id], fn fiber ->
        fiber |> Map.put("status", status) |> Map.drop(["tempered", "closed-at"])
      end)
    end)

    with path when is_binary(path) <- Map.get(fiber, "path"),
         {:ok, text} <- File.read(path) do
      File.write!(
        path,
        Regex.replace(~r/^status: \S+$/m, text, "status: #{status}", global: false)
      )
    end
  end

  defp extract_fiber_id(args) do
    # args like ["-C", store, "show", "tests/haiku", "--json"] or
    # ["show", "tests/haiku", "--field", "shuttle"]
    args
    |> drop_cli_store()
    |> Enum.reject(&(&1 in ["show", "--json", "--field", "shuttle"]))
    |> List.first("")
  end

  defp for_cli("shuttle", fiber), do: with_resolved_agent(fiber)
  defp for_cli("felt", fiber), do: without_resolved_agent(fiber)

  defp without_resolved_agent(%{"shuttle" => shuttle} = fiber) when is_map(shuttle) do
    %{fiber | "shuttle" => Map.delete(shuttle, "resolved")}
  end

  defp without_resolved_agent(fiber), do: fiber

  defp with_resolved_agent(%{"shuttle" => shuttle} = fiber) when is_map(shuttle) do
    name = Map.get(shuttle, "agent") || "claude-sonnet"
    record = Map.get(@resolved_agents, name, @resolved_agents["claude-sonnet"])
    resolved = Map.merge(Map.get(shuttle, "resolved") || %{}, %{"agent" => record})
    %{fiber | "shuttle" => Map.put(shuttle, "resolved", resolved)}
  end

  defp with_resolved_agent(fiber), do: fiber
end
