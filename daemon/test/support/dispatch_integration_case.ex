defmodule Shuttle.Test.DispatchIntegrationCase do
  @moduledoc """
  The case template for the dispatch integration suites
  (`test/shuttle/dispatch_integration_*_test.exs`): content and Shuttle
  commands reach the real `felt` and `shuttle` binaries through
  `IntegrationRunner`, scoped to a temporary store, while `tmux` is answered
  from an in-memory session set. The suites skip where either binary is absent.
  """

  use ExUnit.CaseTemplate

  import ExUnit.Assertions
  import ExUnit.Callbacks
  import Shuttle.Test.TranscriptHelpers
  alias Shuttle.{Dispatcher, Poller}
  alias Shuttle.Test.FiberUid
  import Shuttle.Test.PollerHelpers

  using do
    quote do
      import Shuttle.Test.TranscriptHelpers
      alias Shuttle.{Dispatcher, Poller}
      alias Shuttle.Test.FiberUid
      import Shuttle.Test.PollerHelpers
      alias Shuttle.Test.DispatchIntegrationCase.IntegrationRunner
      alias Shuttle.Test.DispatchIntegrationCase.RealRexRunner
      alias Shuttle.Test.DispatchIntegrationCase.PausedListingRunner
      alias Shuttle.Test.DispatchIntegrationCase.ScopedAPI
      alias Shuttle.Test.DispatchIntegrationCase.TransportRunner

      unless System.find_executable("felt") && System.find_executable("shuttle") do
        @moduletag skip: "felt and shuttle binaries are required for this CLI integration suite"
      end

      import Shuttle.Test.DispatchIntegrationCase
    end
  end

  # ── Integration Runner ─────────────────────────────────────────────────────
  # Passes content and Shuttle commands to their owning real CLI, scoped to a
  # temporary store. Intercepts `tmux` calls with an in-memory session set.
  # One instance per test, found through the test's scope, so the module can
  # be injected as a runner into Dispatcher.

  defmodule IntegrationRunner do
    import Shuttle.Test.TmuxSessions

    @behaviour Shuttle.Runner

    use Agent

    def start_link(_ \\ []) do
      Agent.start_link(fn -> %{felt_store: "", commands: [], tmux_sessions: MapSet.new()} end)
    end

    defp server, do: Shuttle.Test.Env.server!(__MODULE__)

    def reset(felt_store) do
      Agent.update(server(), fn _ ->
        %{felt_store: felt_store, commands: [], tmux_sessions: MapSet.new()}
      end)
    end

    def add_tmux_session(session),
      do: Agent.update(server(), &%{&1 | tmux_sessions: MapSet.put(&1.tmux_sessions, session)})

    def remove_tmux_session(session),
      do: Agent.update(server(), &%{&1 | tmux_sessions: MapSet.delete(&1.tmux_sessions, session)})

    def commands, do: Agent.get(server(), & &1.commands)
    def tmux_sessions, do: Agent.get(server(), & &1.tmux_sessions)

    # The process scan's answers, in order; the last one repeats. Defaults to
    # no processes.
    def set_ps_results(results) when is_list(results) and results != [],
      do: Agent.update(server(), &Map.put(&1, :ps_results, results))

    @impl true
    def cmd(command, args, opts) when command in ["felt", "shuttle"] do
      felt_store = Agent.get(server(), & &1.felt_store)

      Agent.update(server(), fn s ->
        %{s | commands: s.commands ++ [{command, args}]}
      end)

      # Scope unqualified commands to the test store; -C is already part of
      # Shuttle lifecycle calls that need an explicit store root.
      opts =
        if match?(["-C", _store | _], args),
          do: opts,
          else: Keyword.put_new(opts, :cd, felt_store)

      # The integration adapter exercises lifecycle commands against the real
      # CLI, while the daemon/CLI contract level is supplied by the test build.
      if command == "shuttle" and List.last(args) == "contract" do
        {Integer.to_string(Shuttle.Contract.expected_level()), 0}
      else
        # Run as the test's scope sees it: scoped PATH and env reach the real CLIs.
        if "scan-changes" in args do
          Shuttle.Runner.Default.cmd(command, args, opts)
        else
          Shuttle.Env.cmd(command, args, Keyword.delete(opts, :timeout_ms))
        end
      end
    end

    def cmd("tmux", ["has-session", "-t", session], _opts) do
      Agent.update(server(), fn s ->
        %{s | commands: s.commands ++ [{"tmux", ["has-session", "-t", session]}]}
      end)

      sessions = Agent.get(server(), & &1.tmux_sessions)
      if tmux_session_exists?(sessions, session), do: {"", 0}, else: {"can't find session", 1}
    end

    def cmd("tmux", ["new-session" | _] = args, _opts) do
      # args = ["new-session", "-d", "-s", session, "-c", work_dir, "bash", "-l", script_path]
      session = Enum.at(args, 3)

      Agent.update(server(), fn s ->
        %{
          s
          | commands: s.commands ++ [{"tmux", args}],
            tmux_sessions: MapSet.put(s.tmux_sessions, session)
        }
      end)

      {"", 0}
    end

    def cmd("ps", args, _opts) do
      Agent.get_and_update(server(), fn s ->
        s = %{s | commands: s.commands ++ [{"ps", args}]}

        case Map.get(s, :ps_results, [{"", 0}]) do
          [last] -> {last, s}
          [next | rest] -> {next, Map.put(s, :ps_results, rest)}
        end
      end)
    end

    def cmd(cmd, args, _opts) do
      Agent.update(server(), fn s -> %{s | commands: s.commands ++ [{cmd, args}]} end)
      {"", 0}
    end
  end

  # The integration runner with its terminal's input made visible: every text
  # pasted into a worker's terminal (`pastes/0`) and every session's run
  # script as it started (`launched/0`) is kept, and a gate armed by `gate/1`
  # stops the first paste or launch at the terminal, before it happens, and
  # tells the test which process holds it there.
  defmodule TransportRunner do
    @behaviour Shuttle.Runner
    alias Shuttle.Test.DispatchIntegrationCase.IntegrationRunner

    def start!(owner) do
      Shuttle.Test.Env.start_scoped!(
        %{
          id: __MODULE__,
          start:
            {Agent, :start_link, [fn -> %{owner: owner, pastes: [], launched: [], gate: nil} end]}
        },
        __MODULE__
      )
    end

    defp server, do: Shuttle.Test.Env.server!(__MODULE__)

    def pastes, do: Agent.get(server(), &Enum.reverse(&1.pastes))
    def launched, do: Agent.get(server(), &Enum.reverse(&1.launched))

    def gate(kind) when kind in [:paste, :launch],
      do: Agent.update(server(), &%{&1 | gate: kind})

    @impl true
    def cmd("tmux", ["load-buffer", "-b", _buffer, path] = args, opts) do
      hold(:paste)
      text = File.read!(path)
      Agent.update(server(), &%{&1 | pastes: [text | &1.pastes]})
      IntegrationRunner.cmd("tmux", args, opts)
    end

    def cmd("tmux", ["new-session" | _] = args, opts) do
      hold(:launch)
      script = File.read!(List.last(args))
      Agent.update(server(), &%{&1 | launched: [script | &1.launched]})
      IntegrationRunner.cmd("tmux", args, opts)
    end

    # A session the daemon closes ends.
    def cmd("tmux", ["kill-session", "-t", target] = args, opts) do
      IntegrationRunner.cmd("tmux", args, opts)

      IntegrationRunner.remove_tmux_session(
        target
        |> String.trim_leading("=")
        |> String.trim_trailing(":")
      )

      {"", 0}
    end

    # The terminal's sessions outlive a daemon, and the next one lists them.
    def cmd("tmux", ["ls", "-F", "\#{session_name}"] = args, opts) do
      IntegrationRunner.cmd("tmux", args, opts)
      {Enum.join(IntegrationRunner.tmux_sessions(), "\n"), 0}
    end

    def cmd(command, args, opts), do: IntegrationRunner.cmd(command, args, opts)

    # A held transport never resumes: the process holding it is killed.
    defp hold(kind) do
      owner =
        Agent.get_and_update(server(), fn
          %{gate: ^kind, owner: owner} = state -> {owner, %{state | gate: nil}}
          state -> {nil, state}
        end)

      if owner do
        send(owner, {:transport_held, kind, self()})
        Process.sleep(:infinity)
      end
    end
  end

  defmodule RealRexRunner do
    def cmd("tmux", args, opts) do
      # The mixed-backend secondary has its own socket, never the operator's.
      Shuttle.Runner.Default.cmd(
        "tmux",
        ["-S", Shuttle.Env.app(:rex_test_tmux_socket) | args],
        opts
      )
    end

    def cmd(command, args, opts) when command in ["felt", "shuttle"],
      do: IntegrationRunner.cmd(command, args, opts)

    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  # Mirror of Go lifecycle_test.go's writeFiber: writes a fiber markdown file
  # at host/.felt/<id segments>/<basename>.md so `felt show --json` can find it.
  # Plants a fiber file. Frontmatter without an `id:` gets `FiberUid.for(id)`,
  # as every real fiber carries an intrinsic id.
  defmodule PausedListingRunner do
    @behaviour Shuttle.Runner
    def cmd(command, args, opts) do
      result = Shuttle.Test.DispatchIntegrationCase.IntegrationRunner.cmd(command, args, opts)

      if command == "shuttle" and "ls" in args do
        {gate, owner} = Shuttle.Env.app(:discovery_listing_gate)

        if Agent.get_and_update(gate, &{&1, false}) do
          send(owner, {:listing_observed, self()})
          receive do: (:continue_listing -> :ok)
        end
      end

      result
    end
  end

  # ── Setup ──────────────────────────────────────────────────────────────────

  setup do
    Shuttle.Test.Env.start_scoped!(IntegrationRunner)
    test = self()
    host = mk_tmp_felt_store()
    IntegrationRunner.reset(host)

    # Isolate the per-host runtime markers (dispatch / handoff / re-arm) under a
    # throwaway SHUTTLE_DATA_DIR — the substrate that replaced felt history. The
    # dispatcher writes the dispatch marker keyed by the fiber's runtime key (its
    # uid); resume reads it back.
    data_dir =
      Path.join(System.tmp_dir!(), "shuttle-int-markers-#{System.unique_integer([:positive])}")

    File.mkdir_p!(data_dir)
    Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", data_dir)

    # The session ledger lands under the same throwaway data dir, so each test
    # reads only its own pairings. test_helper.exs pins a suite-wide
    # SHUTTLE_SESSIONS_FILE (to keep the suite out of the real ~/.shuttle) and
    # that wins over SHUTTLE_DATA_DIR — drop it here so the per-test dir applies.
    Shuttle.Test.Env.delete_env("SHUTTLE_SESSIONS_FILE")

    on_exit(fn ->
      # The session-UUID capture runs as a supervised background task and can
      # still be backfilling (fiber marker, session ledger) when the test's
      # assertion is already satisfied — a straggler writing into host/data_dir
      # makes the recursive deletes below race a recreate ("file already
      # exists"). Kill and await this test's tasks before sweeping.
      for pid <- Task.Supervisor.children(Shuttle.TaskSupervisor),
          {:dictionary, dictionary} <- [Process.info(pid, :dictionary)],
          test in Keyword.get(dictionary, :"$callers", []) do
        ref = Process.monitor(pid)
        Process.exit(pid, :kill)

        assert_receive {:DOWN, ^ref, :process, _, _}
      end

      # The backfill shells the real felt CLI as an OS process; killing the
      # BEAM task above cannot stop a felt already mid-write, and a recreate
      # during a recursive delete raises "file already exists". Retry the
      # sweep — the straggler finishes within milliseconds.
      rm_rf_retry(host)
      rm_rf_retry(data_dir)
    end)

    {:ok, host: host}
  end

  # rm_rf with retries: tolerates a concurrent writer briefly recreating
  # entries mid-delete (raises only if the dir still cannot be removed after
  # the writer has had ample time to finish).
  def rm_rf_retry(path, attempts \\ 10)

  def rm_rf_retry(path, 1), do: File.rm_rf!(path)

  def rm_rf_retry(path, attempts) do
    File.rm_rf!(path)
  rescue
    File.Error ->
      Process.sleep(100)
      rm_rf_retry(path, attempts - 1)
  end

  # Every session-ledger line this test's dispatches recorded, oldest first.
  def read_ledger do
    Shuttle.SessionLedger.read_since(0)
  end

  # ── Continuation helpers (the felt-history replacement) ──

  # Mirror the dispatcher's at-spawn stamp: `session_uuid` + `dispatched_at`
  # into the fiber's `shuttle.runtime` block (the real .md under `host`), by
  # shelling the REAL `shuttle mark-runtime` — the actual production
  # write path (C5: it nests under shuttle.runtime, a two-level shape
  # hand-rolled text surgery can't produce here — shelling the CLI can). `at` lets a
  # test order a later handoff against it. The fiber must already exist
  # (write_fiber).
  def ago(seconds), do: DateTime.add(DateTime.utc_now(), -seconds, :second)

  def write_dispatch_marker(_host, id, session_id, at \\ DateTime.utc_now()) do
    {_output, 0} =
      IntegrationRunner.cmd(
        "shuttle",
        [
          "mark-runtime",
          id,
          "--dispatched-at",
          DateTime.to_iso8601(at),
          "--session",
          session_id
        ],
        []
      )

    :ok
  end

  # Mirror the worker's `shuttle handoff`: stamp `shuttle.runtime.handed_off_at`
  # in RFC3339 UTC (via the real `shuttle mark-runtime`) — the clean-exit
  # signal the daemon compares against dispatched_at.
  def write_handoff_marker(_host, id, at \\ DateTime.utc_now()) do
    {_output, 0} =
      IntegrationRunner.cmd(
        "shuttle",
        [
          "mark-runtime",
          id,
          "--handed-off-at",
          DateTime.to_iso8601(at),
          "--thread-exit-verb",
          "handed off"
        ],
        []
      )

    :ok
  end

  def sync_poll_cycle!(poller) do
    assert eventually(fn -> not :sys.get_state(poller).poll_check_in_progress end)
    cycles = :sys.get_state(poller).poll_cycles
    send(poller, :run_poll_cycle)
    assert eventually(fn -> :sys.get_state(poller).poll_cycles > cycles end)
  end

  # An armed standing constitution whose schedule ticks this minute and whose
  # last run dispatched ten minutes ago without handing off.
  def seed_due_standing(host, opts \\ []) do
    id = "tests/standing-due"
    now = DateTime.utc_now()

    write_fiber(host, id, """
    ---
    name: Standing due
    status: active
    shuttle:
      kind: standing
      host: test-host
      agent: claude-sonnet
      project_dir: "#{host}"
      schedule:
        expr: "#{now.minute} #{now.hour} * * *"
        tz: UTC
    ---
    A standing responsibility.
    """)

    write_dispatch_marker(
      host,
      id,
      "12345678-1234-4000-8000-123456789abc",
      DateTime.add(now, -600, :second)
    )

    write_transcript("12345678-1234-4000-8000-123456789abc", 60)

    if Keyword.get(opts, :older_handoff) do
      {_, 0} =
        IntegrationRunner.cmd(
          "shuttle",
          [
            "mark-runtime",
            id,
            "--handed-off-at",
            DateTime.to_iso8601(DateTime.add(now, -1200, :second))
          ],
          []
        )
    end

    Shuttle.Test.Env.put_env("SHUTTLE_STORES", host)
    id
  end

  def check_standing_handoff_exit(host, observed) do
    id = seed_due_standing(host)

    {:ok, poller} =
      start_poller!(runner: IntegrationRunner, poll_interval_ms: 600_000, felt_stores: [host])

    sync_poll_cycle!(poller)
    state = :sys.get_state(poller)
    %{pid: watcher, session: session} = state.running[Poller.running_key(state, id)]

    {_, 0} = IntegrationRunner.cmd("shuttle", ["handoff", id], [])
    handed_off = File.read!(fiber_file(host, id))
    IntegrationRunner.remove_tmux_session(session)
    if observed, do: send(poller, {:worker_exited, id, watcher, session, :normal_exit})
    # The system call is a mailbox barrier behind the exit notification.
    :sys.get_state(poller)
    for _ <- 1..3, do: sync_poll_cycle!(poller)
    assert File.read!(fiber_file(host, id)) == handed_off
    assert read_frontmatter(host, id)["status"] == "active"

    assert Enum.count(IntegrationRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and "new-session" in args
           end) == 1
  end

  def assert_same_instant(left, right) do
    {:ok, left, _} = DateTime.from_iso8601(left)
    {:ok, right, _} = DateTime.from_iso8601(right)
    assert DateTime.compare(left, right) == :eq
  end

  def fiber_file(host, id) do
    Path.join([host, ".felt", id, "#{List.last(String.split(id, "/"))}.md"])
  end

  # ── Helpers ────────────────────────────────────────────────────────────────

  # Mirror of Go lifecycle_test.go's withTempHost: creates a temp directory
  # with a .felt/ subdirectory so `felt -C <host> show <id>` can find fibers.
  def mk_tmp_felt_store do
    host =
      Path.join(System.tmp_dir!(), "shuttle-inttest-#{System.unique_integer([:positive])}")

    File.mkdir_p!(Path.join(host, ".felt"))
    host
  end

  def write_fiber(host, id, content) do
    parts = String.split(id, "/")
    basename = List.last(parts)
    dir = Path.join([host, ".felt"] ++ parts)
    File.mkdir_p!(dir)

    content =
      case String.trim(content) do
        "---\n" <> rest = trimmed ->
          if Regex.match?(~r/^id:/m, rest),
            do: trimmed,
            else: "---\nid: #{FiberUid.for(id)}\n" <> rest

        trimmed ->
          trimmed
      end

    File.write!(Path.join(dir, "#{basename}.md"), content <> "\n")
  end

  # Reads back a fiber's frontmatter from disk (host/.felt/<id>/<basename>.md),
  # the surface a daemon write like a run's conclusion lands on.
  def read_frontmatter(host, id) do
    parts = String.split(id, "/")
    basename = List.last(parts)
    path = Path.join([host, ".felt"] ++ parts ++ ["#{basename}.md"])
    [_, fm, _] = File.read!(path) |> String.split("---", parts: 3)
    YamlElixir.read_from_string!(fm)
  end

  def write_resume_fiber(host, id, opts) do
    agent = Keyword.fetch!(opts, :agent)
    session = Keyword.get(opts, :session)

    write_fiber(host, id, """
    ---
    name: Resume matrix #{agent}
    status: active
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: #{agent}
    ---
    A fiber used by the resume matrix.
    """)

    # The session id lives in the per-host dispatch marker (the only structured
    # session-id home). Stamped through felt on the fiber itself.
    if session, do: write_dispatch_marker(host, id, session)
  end

  # `SHUTTLE_CODEX_SESSIONS_DIR` overrides the sessions ROOT; the YYYY/MM/DD
  # fan-out still applies under it, so tests exercise the real day layout.
  def put_codex_sessions_root(root) do
    File.mkdir_p!(root)
    Shuttle.Test.Env.put_env("SHUTTLE_CODEX_SESSIONS_DIR", root)

    root
  end

  def codex_day_dir(root, offset, opts \\ []) do
    date = Date.add(Shuttle.HarnessPaths.local_today(), offset)

    dir =
      Path.join([
        root,
        Integer.to_string(date.year),
        String.pad_leading(Integer.to_string(date.month), 2, "0"),
        String.pad_leading(Integer.to_string(date.day), 2, "0")
      ])

    if Keyword.get(opts, :create, true), do: File.mkdir_p!(dir)
    dir
  end

  def write_codex_session(session_dir, filename, uuid, cwd, timestamp, prompt) do
    session_meta =
      Jason.encode!(%{
        "timestamp" => timestamp,
        "type" => "session_meta",
        "payload" => %{
          "id" => uuid,
          "timestamp" => timestamp,
          "cwd" => cwd
        }
      })

    user_turn =
      Jason.encode!(%{
        "timestamp" => timestamp,
        "type" => "response_item",
        "payload" => %{
          "type" => "message",
          "role" => "user",
          "content" => [%{"type" => "input_text", "text" => prompt}]
        }
      })

    File.write!(Path.join(session_dir, filename), session_meta <> "\n" <> user_turn <> "\n")
  end

  # ── Inbox helpers: constitutions, a Poller's polls, the real hook ──────────

  # A constitution in `host` with `frontmatter`; the store is the scope's only
  # one, so the real CLIs and the daemon both find it.
  def constitution(host, id, frontmatter) do
    write_fiber(host, id, """
    ---
    name: Inbox #{id}
    #{frontmatter}
    ---
    A constitution messages reach.
    """)

    Shuttle.Test.Env.put_env("SHUTTLE_STORES", host)
    id
  end

  def oneshot(host, id, status, extra \\ "") do
    constitution(host, id, """
    status: #{status}
    #{extra}
    shuttle:
      kind: oneshot
      host: test-host
      agent: claude-sonnet
      project_dir: "#{host}"
    """)
  end

  # An armed standing constitution between runs: active, its next tick hours
  # away and its last one served, so only a message starts it. `shuttle`
  # adds lines to its `shuttle:` block, indented as they belong there.
  def armed(host, id, shuttle \\ "") do
    later = DateTime.add(DateTime.utc_now(), 6 * 3600, :second)

    constitution(host, id, """
    status: active
    shuttle:
    #{shuttle}  kind: standing
      host: test-host
      agent: claude-sonnet
      project_dir: "#{host}"
      schedule:
        expr: "#{later.minute} #{later.hour} * * *"
        tz: UTC
    """)

    write_dispatch_marker(host, id, "12345678-1234-4000-8000-000000000042", ago(120))
    write_handoff_marker(host, id, ago(60))
    id
  end

  # How many sessions the in-memory tmux started for `id`.
  def launches(id) do
    session = FiberUid.session(id)

    Enum.count(IntegrationRunner.commands(), fn {cmd, args} ->
      cmd == "tmux" and "new-session" in args and session in args
    end)
  end

  # A Poller over `host` that has run its boot cycle and the work it handed off.
  def poller!(host, opts \\ []) do
    {:ok, poller} =
      start_poller!(
        Keyword.merge(
          [runner: IntegrationRunner, poll_interval_ms: 600_000, felt_stores: [host]],
          opts
        )
      )

    await_boot_cycle!(poller)
    drain!(poller)
    poller
  end

  # The daemon dies: `processes` (a request in flight, say) and then the
  # Poller, its delivery tasks and its worker watchers are killed outright, as
  # a hard kill would end them, with nothing settled or cleaned up. Terminal
  # sessions outlive it, as they outlive a real daemon.
  def kill_daemon!(poller, processes \\ []) do
    tasks =
      for pid <- Task.Supervisor.children(Shuttle.TaskSupervisor),
          {:dictionary, dict} <- [Process.info(pid, :dictionary)],
          poller in Keyword.get(dict, :"$callers", []),
          do: pid

    watchers =
      for {_, pid, _, _} <- DynamicSupervisor.which_children(Shuttle.WatcherSupervisor),
          is_pid(pid),
          match?(%{poller: ^poller}, safe_state(pid)),
          do: pid

    Enum.each(processes ++ [poller | tasks] ++ watchers, &kill!/1)
  end

  def kill!(pid) do
    ref = Process.monitor(pid)
    Process.exit(pid, :kill)
    assert_receive {:DOWN, ^ref, :process, ^pid, _}
  end

  defp safe_state(pid) do
    :sys.get_state(pid, 5_000)
  catch
    :exit, _ -> nil
  end

  # A poll, then the inbox work it hands to a task.
  def poll!(poller) do
    sync_poll_cycle!(poller)
    drain!(poller)
  end

  def drain!(poller) do
    :sys.get_state(poller, :infinity)

    for pid <- Task.Supervisor.children(Shuttle.TaskSupervisor),
        {:dictionary, dict} <- [Process.info(pid, :dictionary)],
        poller in Keyword.get(dict, :"$callers", []) do
      ref = Process.monitor(pid)
      assert_receive {:DOWN, ^ref, :process, ^pid, _}, 60_000
    end

    :sys.get_state(poller, :infinity)
  end

  # The real `shuttle hook event` for Claude session `uuid`: what the session
  # is offered. `frame` adds hook-input fields, such as a prompt's `prompt`;
  # `hook_env` is the hook's own environment, which by default writes no board
  # or event rows.
  def hook!(
        uuid,
        event \\ "UserPromptSubmit",
        frame \\ %{},
        hook_env \\ [{"SHUTTLE_BOARD", "off"}, {"SHUTTLE_EVENTS", "off"}]
      ) do
    frame =
      Map.merge(
        %{session_id: uuid, hook_event_name: event, harness: "claude", cwd: "/"},
        frame
      )

    input = Path.join(System.tmp_dir!(), "hook-#{System.unique_integer([:positive])}.json")
    File.write!(input, Jason.encode!(frame) <> "\n")

    # The hook runs under a short-lived stand-in for the harness, a process
    # that is not a shell, so its registration names no process the test's
    # later CLI calls descend from: those are not this session speaking.
    harness =
      "import subprocess, sys; " <>
        "sys.exit(subprocess.call(sys.argv[2:], stdin=open(sys.argv[1])))"

    {output, 0} =
      Shuttle.Env.cmd("python3", ["-I", "-c", harness, input, cli(), "hook", "event"],
        env: hook_env
      )

    File.rm(input)
    output
  end

  defp cli, do: Shuttle.Env.find_executable("shuttle")

  # A stand-in for a harness process that lives as long as its session (until
  # the test ends): the hooks it runs (`harness_hook!/4`) register it as the
  # session's receiver, so the session's hook registration stays live. `env`
  # is the harness's own environment, such as its messaging socket.
  def start_harness!(env \\ []) do
    script = """
    import subprocess, sys
    for line in sys.stdin:
        out = subprocess.run([sys.argv[1], "hook", "event"], stdin=open(line.strip()), capture_output=True).stdout
        sys.stdout.write(out.hex() + "\\n")
        sys.stdout.flush()
    """

    port_env =
      for {name, value} <- Shuttle.Env.child_env() ++ env,
          do: {String.to_charlist(name), if(value, do: String.to_charlist(value), else: false)}

    Port.open({:spawn_executable, Shuttle.Env.find_executable("python3")}, [
      :binary,
      {:line, 16_000_000},
      args: ["-I", "-c", script, cli()],
      env: port_env
    ])
  end

  def harness_hook!(harness, uuid, event, frame \\ %{}) do
    frame =
      Map.merge(
        %{session_id: uuid, hook_event_name: event, harness: "claude", cwd: "/"},
        frame
      )

    input = Path.join(System.tmp_dir!(), "hook-#{System.unique_integer([:positive])}.json")
    File.write!(input, Jason.encode!(frame) <> "\n")
    Port.command(harness, input <> "\n")
    assert_receive {^harness, {:data, {:eol, hex}}}
    File.rm(input)
    Base.decode16!(hex, case: :lower)
  end

  # ── A test daemon's HTTP API and the real CLI against it ───────────────────

  defmodule ScopedAPI do
    @moduledoc false
    @behaviour Plug
    def init(owner), do: owner

    def call(conn, owner) do
      Shuttle.Env.adopt_callers([owner])
      ShuttleWeb.Endpoint.call(conn, ShuttleWeb.Endpoint.init([]))
    end
  end

  # Serves this test's daemon (its Poller and scope) on a loopback port and
  # points the real CLIs at it, with a home and an events file of the test's
  # own. Answers the events file the CLIs and the daemon write board rows to.
  def serve_api!(host) do
    home = Path.join(host, "home")
    File.mkdir_p!(home)
    Shuttle.Test.Env.put_env("HOME", home)
    events = Path.join(host, "events.jsonl")
    Shuttle.Test.Env.put_env("SHUTTLE_EVENTS_FILE", events)
    serve_api!()
    events
  end

  def serve_api! do
    api =
      start_supervised!(
        {Bandit, plug: {ScopedAPI, self()}, port: 0, ip: {127, 0, 0, 1}, startup_log: false},
        id: make_ref()
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(api)
    url = "http://127.0.0.1:#{port}"
    Shuttle.Test.Env.put_env("SHUTTLE_DAEMON_URL", url)
    url
  end

  # A request to this test's daemon's HTTP API, as the board sends it:
  # answers the status and decoded body.
  def post_api(path, body) do
    conn =
      Phoenix.ConnTest.build_conn(:post, path, Jason.encode!(body))
      |> Map.merge(%{host: "127.0.0.1", port: 4000})
      |> Plug.Conn.put_req_header("accept", "application/json")
      |> Plug.Conn.put_req_header("content-type", "application/json")
      |> ShuttleWeb.Endpoint.call(ShuttleWeb.Endpoint.init([]))

    {conn.status, Jason.decode!(conn.resp_body)}
  end

  # The same request from a process of its own, which answers the test with
  # `{:answered, pid, answer}` unless it is killed first. Answers its pid.
  def post_api_async(path, body) do
    test = self()

    spawn(fn ->
      Shuttle.Env.adopt_callers([test])
      send(test, {:answered, self(), post_api(path, body)})
    end)
  end

  # The real `shuttle` CLI as a sender runs it, in this test's scope: answers
  # its combined output and exit status.
  def shuttle(args, opts \\ []) do
    Shuttle.Env.cmd(
      Shuttle.Env.find_executable("shuttle"),
      args,
      Keyword.merge([stderr_to_stdout: true], opts)
    )
  end

  # The family-board rows the real CLIs wrote to this test's events file.
  def board_rows(events) do
    case File.read(events) do
      {:ok, text} ->
        text
        |> String.split("\n", trim: true)
        |> Enum.map(&Jason.decode!/1)
        |> Enum.filter(&(&1["type"] == "board"))

      {:error, :enoent} ->
        []
    end
  end

  # A ceiling of ~30 s, reached only when the condition never holds: a passing
  # test returns as soon as it does, however loaded the machine.
  def eventually(fun, attempts \\ 600)

  def eventually(fun, attempts) when attempts > 0 do
    if fun.() do
      true
    else
      Process.sleep(50)
      eventually(fun, attempts - 1)
    end
  end

  def eventually(_fun, 0), do: false

  # Finds the tmux new-session command recorded by IntegrationRunner and reads
  # the run-script tempfile that was passed to `bash -l`. The script contains
  # the agent command, banners, and (for resume) the dismiss block.
  def read_run_script do
    {_, args} =
      IntegrationRunner.commands()
      |> Enum.find(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)

    File.read!(List.last(args))
  end
end
