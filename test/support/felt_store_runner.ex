defmodule Shuttle.Test.FeltStoreRunner do
  @moduledoc """
  A `Shuttle.Runner` that simulates a live felt store: fiber files are really
  written under a throwaway root, and `felt ls` / `felt show` / `felt shuttle
  *` / `tmux *` are answered from Agent state.

  This is the runner for tests that need the daemon to actually discover,
  dispatch, and reconcile — `PollerTest` and `APIControllerTest`. Tests that
  only need a scripted response queue or a fixture table (`DispatcherTest`,
  `RemoteRegistryTest`, `WorkerWatcherTest`) keep their own local mocks; those
  are different abstractions that happen to share this behaviour.

  Globally named, so start it from a NON-async module.
  """

  import Shuttle.Test.TmuxSessions

  @behaviour Shuttle.Runner

  use Agent

  def start_link(_ \\ []) do
    # Each runner gets its own throwaway store root under a unique temp
    # dir rather than the shared global `/tmp/.felt` — on a shared box, a
    # concurrent user's `/tmp/.felt` (or its own leftover state) must never
    # be read from or `rm -rf`'d by this suite.
    root =
      Path.join(System.tmp_dir!(), "shuttle-felt-store-mock-#{System.unique_integer([:positive])}")

    File.mkdir_p!(Path.join(root, ".felt"))

    Agent.start_link(
      fn ->
        %{
          felt_root: root,
          commands: [],
          tmux_sessions: MapSet.new(),
          fibers: %{},
          shuttle: %{},
          felt_ls_stderr_warning: false,
          felt_ls_delay_ms: 0,
          new_session_delay_ms: 0
        }
      end,
      name: __MODULE__
    )
  end

  # The store root (the directory containing `.felt/`) this run's MockRunner
  # writes fiber files under — pass this to `felt_stores:` / `FELT_STORES`
  # instead of the old hardcoded `/tmp`.
  def felt_root, do: Agent.get(__MODULE__, & &1.felt_root)

  # `<felt_root>/.felt` — replaces the old hardcoded `/tmp/.felt`.
  def felt_dir, do: Path.join(felt_root(), ".felt")

  def reset do
    # Remove any fiber files written by set_shuttle so tests start clean.
    File.rm_rf(felt_dir())
    File.mkdir_p!(felt_dir())

    Agent.update(__MODULE__, fn state ->
      %{
        felt_root: state.felt_root,
        commands: [],
        tmux_sessions: MapSet.new(),
        fibers: %{},
        shuttle: %{},
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
    # Computed OUTSIDE the Agent.update closure: felt_dir/0 itself calls
    # back into this same Agent, and a GenServer can't call itself from
    # inside its own callback (deadlocks as "process attempted to call
    # itself"). Only used as a fallback, so the eager call is harmless when
    # an existing/explicit path already wins below.
    fallback_path = synth_path(felt_dir(), id)

    Agent.update(__MODULE__, fn state ->
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

    dir = felt_dir()
    segments = String.split(id, "/")
    basename = List.last(segments)
    dir_path = Path.join([dir | segments] ++ ["#{basename}.md"])
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

  def set_felt_ls_stderr_warning(enabled),
    do: Agent.update(__MODULE__, &Map.put(&1, :felt_ls_stderr_warning, enabled))

  # Simulate a host where the agent's wrapper resolves to nothing in a login
  # bash — the dispatcher's preflight probe (`bash -lc "type -t -- '<word>'"`)
  # then exits non-zero, and the dispatch is refused before any tmux spawn.
  def set_wrapper_missing(enabled),
    do: Agent.update(__MODULE__, &Map.put(&1, :wrapper_missing, enabled))

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
      Agent.update(
        __MODULE__,
        &(&1 |> Map.put(:contract_level, level) |> Map.put(:contract_exit, exit_status))
      )

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
      # The dispatcher's wrapper preflight. Resolves by default so every other
      # test dispatches as before; `set_wrapper_missing(true)` makes the login
      # shell find nothing, the shape a real missing wrapper produces.
      command == "bash" and match?(["-lc", _], args) ->
        if Agent.get(__MODULE__, &Map.get(&1, :wrapper_missing, false)) do
          {"", 1}
        else
          {"file\n", 0}
        end

      command == "felt" and match?(["shuttle", "contract"], args) ->
        level = Agent.get(__MODULE__, &Map.get(&1, :contract_level, "2"))
        {level, Agent.get(__MODULE__, &Map.get(&1, :contract_exit, 0))}

      # `felt shuttle agents resolve <name> ...` — the capture path's no-fiber
      # resolution. The daemon shells felt (registry owner) rather than
      # re-resolving; the mock returns felt's resolved.agent JSON shape.
      #
      # The bare `felt shuttle agents --json` listing is deliberately NOT
      # answered: it falls through to `{"", 0}`, felt's "verb absent / old
      # felt" shape, which is the degradation AgentsController must survive.
      command == "felt" and match?(["shuttle", "agents", "resolve" | _], args) ->
        name = Enum.at(args, 3)
        record = Map.get(@resolved_agents, name, @resolved_agents["claude-sonnet"])
        {Jason.encode!(record), 0}

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
            entries = Map.values(state.fibers)

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
end
