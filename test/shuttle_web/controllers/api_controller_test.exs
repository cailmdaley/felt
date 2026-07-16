defmodule ShuttleWeb.APIControllerTest do
  @moduledoc """
  Tests for the Stage 5 Agent-API REST endpoints.
  """

  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  alias Shuttle.Poller
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
          new_session_delay_ms: 0
        }
      end)
    end

    # Carry a felt-style absolute `path` so the poller's store-ownership check
    # (which reads felt's `path`) sees the fiber as rooted in `/tmp`. Mirrors
    # real felt, which now emits `path` on every listed/shown fiber.
    def set_fiber(id, fiber) do
      Agent.update(__MODULE__, fn state ->
        existing_path = get_in(state.fibers, [id, "path"])
        path = Map.get(fiber, "path") || existing_path || synth_path(id)
        put_in(state.fibers[id], Map.put(fiber, "path", path))
      end)
    end

    defp synth_path(id) do
      leaf = id |> String.split("/") |> List.last()
      # Resolve with the SAME resolver the poller uses for store ownership, so
      # the carried path agrees on every OS (macOS /tmp → /private/tmp; Linux
      # /tmp stays /tmp). A hardcoded rewrite passed only on macOS.
      path = Path.expand(Path.join(["/tmp/.felt", id, "#{leaf}.md"]))

      case Shuttle.Realpath.resolve(path) do
        {:ok, resolved} -> resolved
        {:error, _} -> path
      end
    end

    # Write a real .md file carrying the given shuttle: block and felt status so
    # that walk_shuttle_fibers (the file-walk discovery path) can find it.
    def set_shuttle(id, yaml, status \\ "active") do
      # Post-cutover every installed block carries an explicit host: equal to
      # the owning daemon's own_host_id (strict eligibility, no nil-wildcard).
      # Stamp the test daemon's identity ("test-host", from SHUTTLE_HOST in
      # config/test.exs) when the YAML omits host:, so generic dispatch tests
      # stay eligible. Host-specific tests pass an explicit host: line.
      yaml =
        if Regex.match?(~r/^\s*host\s*:/m, yaml),
          do: yaml,
          else: String.trim_trailing(yaml) <> "\nhost: test-host\n"

      felt_dir = "/tmp/.felt"
      segments = String.split(id, "/")
      basename = List.last(segments)
      dir_path = Path.join([felt_dir | segments] ++ ["#{basename}.md"])
      File.mkdir_p!(Path.dirname(dir_path))
      indented = yaml |> String.trim() |> String.split("\n") |> Enum.map_join("\n", &("  " <> &1))
      File.write!(dir_path, "---\nstatus: #{status}\nshuttle:\n#{indented}\n---\nbody\n")

      shuttle_block =
        case YamlElixir.read_from_string(yaml) do
          {:ok, data} when is_map(data) -> data
          _ -> %{}
        end

      carried_path = synth_path(id)

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

    # Kept for backward compat; discovery now walks files for shuttle: blocks.
    def set_felt_ls(fibers), do: Agent.update(__MODULE__, &%{&1 | felt_ls: fibers})

    def add_tmux_session(session),
      do: Agent.update(__MODULE__, &%{&1 | tmux_sessions: MapSet.put(&1.tmux_sessions, session)})

    def remove_tmux_session(session),
      do:
        Agent.update(__MODULE__, &%{&1 | tmux_sessions: MapSet.delete(&1.tmux_sessions, session)})

    def set_new_session_delay(ms),
      do: Agent.update(__MODULE__, &Map.put(&1, :new_session_delay_ms, ms))

    def commands, do: Agent.get(__MODULE__, & &1.commands)

    @impl true
    def cmd(command, args, _opts) do
      Agent.update(__MODULE__, fn state ->
        %{state | commands: state.commands ++ [{command, args}]}
      end)

      full_args = Enum.join(args, " ")

      cond do
        # S2 boot-time contract handshake (`Shuttle.Poller.init/1`). Always
        # matches — these tests don't exercise S2, they exercise the API
        # surface with a Poller that must actually dispatch.
        command == "felt" and match?(["shuttle", "contract"], args) ->
          {"2", 0}

        command == "felt" and String.contains?(full_args, "ls") ->
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

          {Jason.encode!(Enum.map(fibers, &with_resolved_agent/1)), 0}

        command == "felt" and String.contains?(full_args, "show") and
            String.contains?(full_args, "--field shuttle") ->
          fiber_id = extract_fiber_id(args)
          shuttle = Agent.get(__MODULE__, & &1.shuttle)
          {Map.get(shuttle, fiber_id, ""), 0}

        command == "felt" and String.contains?(full_args, "show") ->
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
          remove_tmux_session(session)
          {"", 0}

        command == "tmux" and hd(args) == "ls" ->
          sessions = Agent.get(__MODULE__, & &1.tmux_sessions)
          output = sessions |> MapSet.to_list() |> Enum.join("\n")
          {output, 0}

        true ->
          {"", 0}
      end
    end

    defp extract_fiber_id(args) do
      args
      |> Enum.reject(&(&1 in ["show", "--json", "--field", "shuttle"]))
      |> List.first("")
    end

    # Real felt inlines a resolved `shuttle.resolved.agent` on every fiber with a
    # shuttle facet (felt show -j); the daemon reads that record and no longer
    # resolves names itself, so the mock synthesizes it from the block's `agent`
    # name (default claude-sonnet). Only the rendering keys matter here.
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
      }
    }

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

  # POST transport stub for the cross-host /transition forward test. Records the
  # last (url, body) it was asked to POST and replays a scripted response, so the
  # forward leg is exercised without a real tunnel. Implements `post/4` only —
  # the read `get/2` callback isn't needed here, so it doesn't declare the
  # behaviour (which would warn about the missing required `get/2`).
  defmodule StubPostClient do
    use Agent

    def start_link(_ \\ []),
      do:
        Agent.start_link(
          fn -> %{response: nil, get_response: {:error, :not_set}, last: nil, last_get: nil} end,
          name: __MODULE__
        )

    def set_response(response), do: Agent.update(__MODULE__, &Map.put(&1, :response, response))

    def set_get_response(response),
      do: Agent.update(__MODULE__, &Map.put(&1, :get_response, response))

    def last, do: Agent.get(__MODULE__, & &1.last)
    def last_get, do: Agent.get(__MODULE__, & &1.last_get)

    def get(url, _timeout_ms) do
      Agent.update(__MODULE__, &Map.put(&1, :last_get, %{url: url}))
      Agent.get(__MODULE__, & &1.get_response)
    end

    def post(url, body, _content_type, _timeout_ms) do
      Agent.update(__MODULE__, &Map.put(&1, :last, %{url: url, body: body}))
      Agent.get(__MODULE__, & &1.response)
    end
  end

  # ── Setup ──

  setup do
    previous_action_runner = Application.get_env(:shuttle, :action_query_runner)
    Application.put_env(:shuttle, :action_query_runner, MockRunner)

    on_exit(fn ->
      restore_app_env(:action_query_runner, previous_action_runner)
    end)

    start_supervised!(MockRunner)
    MockRunner.reset()

    start_supervised!(
      {Poller, runner: MockRunner, poll_interval_ms: 600_000, felt_stores: ["/tmp"]}
    )

    Process.sleep(50)
    :ok
  end

  # Minimal shuttle: block YAML for a oneshot fiber ready for dispatch.
  @oneshot_shuttle "enabled: true\nkind: oneshot\n"

  defp api_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

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

  defp with_actions_host do
    previous = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", "/tmp")

    on_exit(fn ->
      case previous do
        nil -> System.delete_env("FELT_STORES")
        value -> System.put_env("FELT_STORES", value)
      end
    end)
  end

  defp restore_app_env(key, nil), do: Application.delete_env(:shuttle, key)
  defp restore_app_env(key, value), do: Application.put_env(:shuttle, key, value)

  # Re-trigger the poll until a condition holds. A bare `send(Shuttle.Poller,
  # :run_poll_cycle)` is DROPPED when a poll is already in flight (the
  # `poll_check_in_progress` guard), and a fixed Process.sleep after it raced the
  # async poll cycle — so a state-reading assertion that depended on the poll
  # having dispatched flaked under load. Re-sending each iteration (~3s ceiling)
  # guarantees a poll lands and the state settles; returns the instant it does.
  defp poll_until(fun, attempts \\ 120) do
    cond do
      fun.() ->
        true

      attempts <= 0 ->
        flunk("poll_until: condition never held")

      true ->
        send(Shuttle.Poller, :run_poll_cycle)
        Process.sleep(25)
        poll_until(fun, attempts - 1)
    end
  end

  # ── GET /api/v1/workers/:fiber_id ──

  test "returns running worker info" do
    fiber = make_fiber("tests/haiku")
    MockRunner.set_fiber("tests/haiku", fiber)
    MockRunner.set_shuttle("tests/haiku", @oneshot_shuttle)

    assert poll_until(fn ->
             Jason.decode!(get(api_conn(), "/api/v1/workers/tests/haiku").resp_body)["running"] ==
               true
           end)

    conn = get(api_conn(), "/api/v1/workers/tests/haiku")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["running"] == true
    assert body["fiber_id"] == "tests/haiku"
    assert body["agent"] == "claude-sonnet"
    assert body["runtime_seconds"] >= 0
  end

  test "GET /api/v1/agents degrades to []/200 when felt's agents verb is unavailable" do
    # The registry is felt-owned now: the controller shells `felt shuttle agents
    # --json` through Shuttle.Felt.run. Route that shell-out at MockRunner (the
    # `:felt_runner` seam), whose fall-through returns `{"", 0}` — felt emitted
    # nothing parseable as a JSON array, the "verb absent / old felt" shape. The
    # controller must degrade to an empty list with 200 (the board's picker falls
    # back to free-text), never crash the request. Without the seam this asserted
    # `== []` only on a box where felt happened to be absent — a real felt on PATH
    # returned the live registry and the test flapped.
    previous_felt_runner = Application.get_env(:shuttle, :felt_runner)
    Application.put_env(:shuttle, :felt_runner, MockRunner)
    on_exit(fn -> restore_app_env(:felt_runner, previous_felt_runner) end)

    conn = get(api_conn(), "/api/v1/agents")
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == []
  end

  test "returns not running for idle fiber" do
    conn = get(api_conn(), "/api/v1/workers/tests/idle")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["running"] == false
    assert body["fiber_id"] == "tests/idle"
  end

  # ── POST /api/v1/dispatch ──

  test "dispatches a fiber via API" do
    fiber = make_fiber("tests/api-dispatch")
    MockRunner.set_fiber("tests/api-dispatch", fiber)
    MockRunner.set_shuttle("tests/api-dispatch", @oneshot_shuttle)

    conn =
      post(
        api_conn(),
        "/api/v1/dispatch",
        Jason.encode!(%{
          "fiber_id" => "tests/api-dispatch",
          "notify_on_exit" => true
        })
      )

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["dispatched"] == true
    assert body["fiber_id"] == "tests/api-dispatch"
    assert body["tmux_session"] == Dispatcher.session_name("tests/api-dispatch")
    assert body["notify_on_exit"] == true
    assert body["channel_topic"] == "shuttle:worker:tests/api-dispatch"
  end

  test "dispatch returns 409 for already running fiber" do
    fiber = make_fiber("tests/api-dispatch-2")
    MockRunner.set_fiber("tests/api-dispatch-2", fiber)
    MockRunner.add_tmux_session(Dispatcher.session_name("tests/api-dispatch-2"))

    conn =
      post(
        api_conn(),
        "/api/v1/dispatch",
        Jason.encode!(%{
          "fiber_id" => "tests/api-dispatch-2"
        })
      )

    assert conn.status == 409
    body = Jason.decode!(conn.resp_body)
    assert body["dispatched"] == false
    assert body["reason"] == "already_running"
  end

  test "dispatch 409 includes the live tmux session when the poller tracks it" do
    fiber_id = "tests/api-dispatch-live"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    assert {:ok, session} = Poller.dispatch_fiber(fiber_id, [])

    conn =
      post(
        api_conn(),
        "/api/v1/dispatch",
        Jason.encode!(%{
          "fiber_id" => fiber_id
        })
      )

    assert conn.status == 409
    body = Jason.decode!(conn.resp_body)
    assert body["dispatched"] == false
    assert body["reason"] == "already_running"
    assert body["tmux_session"] == session
  end

  test "dispatch clears stale in-memory running state when tmux session is gone" do
    fiber_id = "tests/api-stale-running"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)

    assert {:ok, session} = Poller.dispatch_fiber(fiber_id, [])
    MockRunner.remove_tmux_session(session)

    conn =
      post(
        api_conn(),
        "/api/v1/dispatch",
        Jason.encode!(%{
          "fiber_id" => fiber_id
        })
      )

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["dispatched"] == true
    assert body["fiber_id"] == fiber_id
    assert body["tmux_session"] == session
  end

  test "dispatch returns 200 for slow successful dispatches past the default call timeout" do
    fiber_id = "tests/api-slow-dispatch"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, @oneshot_shuttle)
    MockRunner.set_new_session_delay(5_250)

    started_at_ms = System.monotonic_time(:millisecond)

    conn =
      post(
        api_conn(),
        "/api/v1/dispatch",
        Jason.encode!(%{
          "fiber_id" => fiber_id
        })
      )

    elapsed_ms = System.monotonic_time(:millisecond) - started_at_ms

    assert elapsed_ms >= 5_000
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["dispatched"] == true
    assert body["fiber_id"] == fiber_id
    assert body["tmux_session"] == Dispatcher.session_name(fiber_id)
  end

  test "dispatch returns 400 without fiber_id" do
    conn = post(api_conn(), "/api/v1/dispatch", Jason.encode!(%{}))
    assert conn.status == 400
    body = Jason.decode!(conn.resp_body)
    assert body["error"] == "fiber_id is required"
  end

  test "HTTP ad-hoc dispatch of an awaiting standing role re-arms and runs (no longer 422)" do
    # Awaiting is felt-native (slice 5): status:closed + untempered. The HTTP
    # /dispatch path folds ad_hoc into force (`force: force or ad_hoc`), so an
    # explicit dispatch IS the human verdict: it bypasses the awaiting gate,
    # re-arms the doc, and spawns — instead of the old 422 that told the user to
    # `felt shuttle accept/resume` first. (The autonomous poller, which calls
    # dispatch_fiber in-process with ad_hoc and NOT force, is still gated — see
    # PollerTest "ad-hoc dispatch refuses an awaiting standing role only when NOT
    # forced".)
    fiber_id = "tests/api-awaiting-refuses-adhoc"

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

    conn =
      post(
        api_conn(),
        "/api/v1/dispatch",
        Jason.encode!(%{
          "fiber_id" => fiber_id,
          "ad_hoc" => true
        })
      )

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["dispatched"] == true
    assert body["fiber_id"] == fiber_id
  end

  # ── POST /api/v1/transition ──

  # The unified write-plane: one call resolves the kanban target to an action
  # AND invokes it (no separate resolve leg). A closed oneshot dragged to the
  # tempered column resolves to close-tempered and shells the offline writer —
  # threading --felt-store through the extracted Transition pipeline.
  @tag :capture_log
  test "transition resolves the target and invokes in one call (local)" do
    with_actions_host()

    MockRunner.set_shuttle(
      "tests/transition-local",
      "enabled: true\nkind: oneshot\nreview:\n  state: awaiting\n",
      "closed"
    )

    stub_dir =
      Path.join(
        System.tmp_dir!(),
        "shuttle-transition-stub-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(stub_dir)
    argv_log = Path.join(stub_dir, "argv.log")
    real_felt = System.find_executable("felt") || "felt"

    # The transition pipeline shells the real felt to resolve the store/target,
    # THEN shells `felt shuttle <verb>` for the write. Capture only the `shuttle`
    # subcommand (logging its verb + flags, the `shuttle` prefix dropped) and
    # delegate everything else to the real felt — so resolution still works and
    # the log holds just the write's argv.
    File.write!(Path.join(stub_dir, "felt"), """
    #!/usr/bin/env bash
    if [ "$1" = shuttle ]; then
      printf '%s\\n' "${@:2}" >> "#{argv_log}"
      exit 0
    fi
    exec "#{real_felt}" "$@"
    """)

    File.chmod!(Path.join(stub_dir, "felt"), 0o755)

    previous_path = System.get_env("PATH")
    System.put_env("PATH", "#{stub_dir}:#{previous_path}")

    on_exit(fn ->
      if previous_path, do: System.put_env("PATH", previous_path), else: System.delete_env("PATH")
      File.rm_rf!(stub_dir)
    end)

    conn =
      post(
        api_conn(),
        "/api/v1/transition",
        Jason.encode!(%{fiber_id: "tests/transition-local", target: "tempered"})
      )

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["invoked"] == true
    assert body["action"] == "close-tempered"
    assert body["target"] == "tempered"

    captured = argv_log |> File.read!() |> String.split("\n", trim: true)
    assert Enum.take(captured, 2) == ["--felt-store", "/tmp"]
    assert "close" in captured
    assert "--tempered=true" in captured
  end

  test "transition for an unknown target returns 400" do
    with_actions_host()
    MockRunner.set_shuttle("tests/transition-bad-target", @oneshot_shuttle)

    conn =
      post(
        api_conn(),
        "/api/v1/transition",
        Jason.encode!(%{fiber_id: "tests/transition-bad-target", target: "nowhere"})
      )

    assert conn.status == 400
    body = Jason.decode!(conn.resp_body)
    assert body["error"] == "unknown_target"
    assert body["invoked"] == false
  end

  test "transition for an unknown fiber returns 404" do
    with_actions_host()

    conn =
      post(
        api_conn(),
        "/api/v1/transition",
        Jason.encode!(%{fiber_id: "tests/transition-missing", target: "drafts"})
      )

    assert conn.status == 404
    body = Jason.decode!(conn.resp_body)
    assert body["error"] == "not_found"
    assert body["invoked"] == false
  end

  # A remote-owned fiber: the local daemon forwards to the OWNING remote's
  # /transition over the tunnel and relays its response verbatim, re-stamped with
  # the origin the caller routed to. The forwarded payload carries no origin (so
  # the remote runs its own local branch); only fiber_id + target cross the wire.
  test "transition forwards a remote-owned fiber to the owning daemon" do
    start_supervised!(StubPostClient)

    StubPostClient.set_response(
      {:ok, 200,
       Jason.encode!(%{
         "fiber_id" => "tests/remote-work",
         "target" => "drafts",
         "origin" => "local",
         "action" => "pause",
         "invoked" => true
       })}
    )

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: "candide", url: "http://localhost:4001"}])
    Application.put_env(:shuttle, :write_forward_client, StubPostClient)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)

    conn =
      post(
        api_conn(),
        "/api/v1/transition",
        Jason.encode!(%{
          fiber_id: "tests/remote-work",
          target: "drafts",
          origin: "candide"
        })
      )

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["invoked"] == true
    assert body["action"] == "pause"
    # Origin re-stamped to what the caller routed to, not the remote's "local".
    assert body["origin"] == "candide"

    # Forwarded to the owning remote's /transition, fiber_id + target only.
    last = StubPostClient.last()
    assert last.url == "http://localhost:4001/api/v1/transition"
    forwarded = Jason.decode!(last.body)
    assert forwarded == %{"fiber_id" => "tests/remote-work", "target" => "drafts"}
  end

  test "successful remote transition refreshes the cached remote fiber feed" do
    start_supervised!(StubPostClient)

    StubPostClient.set_response(
      {:ok, 200,
       Jason.encode!(%{
         "fiber_id" => "tests/remote-work",
         "target" => "tempered",
         "origin" => "local",
         "action" => "close-tempered",
         "invoked" => true
       })}
    )

    StubPostClient.set_get_response(
      {:ok,
       Jason.encode!(%{
         "host" => "cineca",
         "fibers" => [
           %{
             "path" => "tests/remote-work/remote-work.md",
             "fiber" => %{
               "id" => "tests/remote-work",
               "name" => "Remote work",
               "status" => "closed",
               "tempered" => true
             }
           }
         ]
       })}
    )

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: "cineca", url: "http://localhost:4002"}])
    Application.put_env(:shuttle, :write_forward_client, StubPostClient)

    start_supervised!(
      {Shuttle.RemoteFiberRegistry,
       remotes: [%Shuttle.Remote{name: "cineca", url: "http://localhost:4002"}],
       client: StubPostClient,
       auto_poll: false}
    )

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)

    conn =
      post(
        api_conn(),
        "/api/v1/transition",
        Jason.encode!(%{
          fiber_id: "tests/remote-work",
          target: "tempered",
          origin: "cineca"
        })
      )

    assert conn.status == 200
    assert StubPostClient.last_get().url == "http://localhost:4002/api/v1/fibers?shuttle=true"

    assert %{"cineca" => %{stale: false, fibers: [%{"fiber" => %{"tempered" => true}}]}} =
             Shuttle.RemoteFiberRegistry.feeds()
  end

  test "transition relays a remote owner's error status" do
    start_supervised!(StubPostClient)

    StubPostClient.set_response(
      {:ok, 409, Jason.encode!(%{"invoked" => false, "error" => "action_not_available"})}
    )

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: "cineca", url: "http://localhost:4002"}])
    Application.put_env(:shuttle, :write_forward_client, StubPostClient)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)

    conn =
      post(
        api_conn(),
        "/api/v1/transition",
        Jason.encode!(%{fiber_id: "tests/remote-err", target: "tempered", origin: "cineca"})
      )

    assert conn.status == 409
    body = Jason.decode!(conn.resp_body)
    assert body["invoked"] == false
    assert body["error"] == "action_not_available"
    assert body["origin"] == "cineca"
  end

  # ── Owner-routing for the non-drag write verbs (Shuttle.OriginRouter) ──
  #
  # The kanban posts tag/horizon edits, promote/requeue lifecycle, and the
  # dispatch directive (user_message + resume_mode, STORE 3) directly to Shuttle,
  # carrying the `origin` the composite board stamped. A remote-owned card
  # forwards to the owning daemon's IDENTICAL endpoint over the tunnel (origin
  # stripped, so the owner runs its own local branch) and relays the response
  # verbatim — the same one-hop shape /transition uses, via the shared forwarder.

  defp stub_forward(remote_name, remote_url, response) do
    start_supervised!(StubPostClient)
    StubPostClient.set_response(response)

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: remote_name, url: remote_url}])
    Application.put_env(:shuttle, :write_forward_client, StubPostClient)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)
  end

  test "felt-edit forwards a remote-owned card to the owning daemon" do
    stub_forward("candide", "http://localhost:4001", {:ok, 200, "edited"})

    conn =
      post(
        api_conn(),
        "/api/v1/felt-edit",
        Jason.encode!(%{fiber_id: "tests/remote-card", origin: "candide", add: ["idea"]})
      )

    assert conn.status == 200
    assert conn.resp_body == "edited"

    last = StubPostClient.last()
    assert last.url == "http://localhost:4001/api/v1/felt-edit"
    # origin stripped so the owner treats the fiber as local; the rest crosses.
    assert Jason.decode!(last.body) == %{"fiber_id" => "tests/remote-card", "add" => ["idea"]}
  end

  test "lifecycle forwards a remote-owned card to the owning daemon" do
    stub_forward("candide", "http://localhost:4001", {:ok, 200, "paused"})

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{action: "pause", fiber: "tests/remote-card", origin: "candide"})
      )

    assert conn.status == 200
    assert conn.resp_body == "paused"

    last = StubPostClient.last()
    assert last.url == "http://localhost:4001/api/v1/lifecycle"
    assert Jason.decode!(last.body) == %{"action" => "pause", "fiber" => "tests/remote-card"}
  end

  test "dispatch forwards a remote-owned card and relays its JSON" do
    stub_forward(
      "candide",
      "http://localhost:4001",
      {:ok, 200, Jason.encode!(%{"dispatched" => true, "fiber_id" => "tests/remote-card"})}
    )

    conn =
      post(
        api_conn(),
        "/api/v1/dispatch",
        Jason.encode!(%{fiber_id: "tests/remote-card", origin: "candide"})
      )

    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["dispatched"] == true

    last = StubPostClient.last()
    assert last.url == "http://localhost:4001/api/v1/dispatch"
    assert Jason.decode!(last.body) == %{"fiber_id" => "tests/remote-card"}
  end

  test "dispatch owner-routes the STORE-3 user_message + resume_mode intact" do
    # STORE 3: the user's directive + continuation mode ride the dispatch call
    # (replacing the old file-a-review-comment-then-dispatch two-step). For a
    # remote-owned card they must owner-route to the owning daemon's /dispatch
    # with origin stripped — the body otherwise verbatim.
    stub_forward(
      "cineca",
      "http://localhost:4002",
      {:ok, 200, Jason.encode!(%{"dispatched" => true, "fiber_id" => "tests/remote-card"})}
    )

    conn =
      post(
        api_conn(),
        "/api/v1/dispatch",
        Jason.encode!(%{
          fiber_id: "tests/remote-card",
          origin: "cineca",
          user_message: "talk to me first",
          resume_mode: "previous"
        })
      )

    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["dispatched"] == true

    last = StubPostClient.last()
    assert last.url == "http://localhost:4002/api/v1/dispatch"
    # origin stripped; user_message + resume_mode survive the hop.
    assert Jason.decode!(last.body) == %{
             "fiber_id" => "tests/remote-card",
             "user_message" => "talk to me first",
             "resume_mode" => "previous"
           }
  end

  test "felt-edit relays a tunnel failure as 502" do
    stub_forward("candide", "http://localhost:4001", {:error, :econnrefused})

    conn =
      post(
        api_conn(),
        "/api/v1/felt-edit",
        Jason.encode!(%{fiber_id: "tests/remote-card", origin: "candide", add: ["x"]})
      )

    assert conn.status == 502
    assert conn.resp_body =~ "forward to candide failed"
  end

  test "an unknown origin falls through to local — no forward, local arbitrates" do
    stub_forward("candide", "http://localhost:4001", {:ok, 200, "should-not-be-used"})

    # origin "ghost" matches no configured remote → :local. The fiber isn't in
    # the local store, so the local branch returns a clean not-found rather than
    # forwarding anywhere.
    conn =
      post(
        api_conn(),
        "/api/v1/felt-edit",
        Jason.encode!(%{fiber_id: "tests/nonexistent", origin: "ghost", add: ["x"]})
      )

    assert conn.status == 400
    assert conn.resp_body =~ "fiber not found"
    # The forwarder was never touched — no silent mis-route to the wrong host.
    assert StubPostClient.last() == nil
  end

  # ── GET /api/v1/state ──

  test "state returns full orchestrator state" do
    uid = "01KTCA2CWXBSNHETE66MXKPVE7"
    fiber = make_fiber("tests/state", %{"uid" => uid})
    MockRunner.set_fiber("tests/state", fiber)
    MockRunner.set_shuttle("tests/state", @oneshot_shuttle)

    send(Shuttle.Poller, :run_poll_cycle)
    Process.sleep(100)

    conn = get(api_conn(), "/api/v1/state")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["host"] != nil
    assert is_list(body["eligible"])
    assert is_list(body["running_detail"])

    # Slice 7: no separate `:runtime` index. Liveness rides the `eligible` rows
    # — each carries the intrinsic uid, the live tmux session, and run state, so
    # a consumer reads running-ness off the row instead of joining against a
    # parallel runtime overlay (which the cutover deleted with the store).
    refute Map.has_key?(body, "runtime")

    expected_session = "state-#{uid}-shuttle"

    assert [
             %{
               "fiber_id" => "tests/state",
               "uid" => ^uid,
               "state" => "running",
               "tmux_session" => ^expected_session
             }
           ] = body["eligible"]

    assert is_list(body["waiters"])
  end

  test "state degrades to JSON when the poller is unavailable" do
    :sys.suspend(Shuttle.Poller)

    try do
      conn = get(api_conn(), "/api/v1/state")
      assert conn.status == 503
      body = Jason.decode!(conn.resp_body)
      assert body["error"] == "poller_unavailable"
      assert is_binary(body["host"])
      assert is_list(body["running_detail"])
    after
      :sys.resume(Shuttle.Poller)
    end
  end

  # ── GET /api/v1/state/composite ──

  test "composite returns local snapshot plus per-origin remote snapshots" do
    # Spin up a RemoteRegistry with a stub client so the composite
    # endpoint has remote data to merge in. The client returns a fake
    # candide snapshot that lists tests/work-on-candide as running.
    defmodule CompositeStubClient do
      @behaviour Shuttle.RemoteRegistry.Client

      @impl true
      def get("http://localhost:4001/api/v1/state", _timeout) do
        body =
          Jason.encode!(%{
            "host" => "candide",
            "eligible" => [%{"fiber_id" => "tests/work-on-candide"}],
            "blocked" => [],
            "retrying" => []
          })

        {:ok, body}
      end

      def get(_url, _timeout), do: {:error, :no_stub}
    end

    # Controller calls Shuttle.RemoteRegistry.snapshots/0, which routes
    # to the default-named GenServer. Start one under the default name
    # for this test (the test config disables auto-start so this name
    # is free until we claim it).
    start_supervised!({
      Shuttle.RemoteRegistry,
      remotes: [
        %Shuttle.Remote{name: "candide", url: "http://localhost:4001"}
      ],
      client: CompositeStubClient,
      tick_interval_ms: 60_000
    })

    :ok = Shuttle.RemoteRegistry.poll_now()

    conn = get(api_conn(), "/api/v1/state/composite")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert is_map(body["local"])
    assert is_list(body["local"]["eligible"])

    assert is_map(body["remotes"])
    candide = body["remotes"]["candide"]
    assert candide != nil
    assert candide["stale"] == false
    assert candide["last_polled_at"] != nil
    assert candide["last_error"] == nil
    assert is_map(candide["snapshot"])
    assert candide["snapshot"]["host"] == "candide"
    assert candide["recovery"]["state"] == "healthy"
    assert candide["recovery"]["attempt"] == 0
  end

  test "composite degrades remote snapshots when the remote registry is unavailable" do
    start_supervised!({
      Shuttle.RemoteRegistry,
      remotes: [
        %Shuttle.Remote{name: "candide", url: "http://localhost:4001"}
      ],
      tick_interval_ms: 60_000
    })

    :sys.suspend(Shuttle.RemoteRegistry)

    try do
      conn = get(api_conn(), "/api/v1/state/composite")
      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["remotes"]["_registry"]["stale"] == true
      assert body["remotes"]["_registry"]["last_error"] != nil
      assert body["remotes"]["_registry"]["recovery"]["state"] == "unavailable"
    after
      :sys.resume(Shuttle.RemoteRegistry)
    end
  end

  test "composite degrades gracefully when no RemoteRegistry is running" do
    # No RemoteRegistry started under the default name; controller
    # should still return a valid composite shape.
    conn = get(api_conn(), "/api/v1/state/composite")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert is_map(body["local"])
    assert body["remotes"] == %{}
  end

  test "composite degrades local snapshot when the poller is unavailable" do
    :sys.suspend(Shuttle.Poller)

    try do
      conn = get(api_conn(), "/api/v1/state/composite")
      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["local"]["error"] == "poller_unavailable"
      assert body["remotes"] == %{}
    after
      :sys.resume(Shuttle.Poller)
    end
  end

  # ── GET /api/v1/agents ──

  # NOTE (Stage 4a): the former "agents returns the registry as a JSON array"
  # test was deleted. `GET /api/v1/agents` now shells `felt shuttle agents
  # --json` (felt owns the registry); its CONTENTS — non-empty list, a flagged
  # default — are felt's responsibility, verified felt-side, and the verb is not
  # guaranteed live in `mix test`. The controller's only daemon-side contract is
  # "200 + bare array, degrading to [] when felt is unavailable" — and a test
  # asserting that would still depend on the live verb to distinguish the two,
  # so the route's content is left to felt's own suite.

  # ── GET /api/v1/version ──

  test "version returns the daemon build-info shape" do
    conn = get(api_conn(), "/api/v1/version")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert is_binary(body["git_sha"])
    assert is_binary(body["git_short_sha"])
    assert is_binary(body["built_at"])
    assert body["mix_vsn"] == Shuttle.version()

    if body["git_sha"] != "unknown" do
      assert String.length(body["git_short_sha"]) == 7
      assert String.starts_with?(body["git_sha"], body["git_short_sha"])
    end
  end
end
