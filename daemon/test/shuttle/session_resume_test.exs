defmodule Shuttle.SessionResumeTest do
  @moduledoc """
  `Shuttle.SessionResume` and the `/attach` resume leg: the resume command per
  harness (built by the dispatcher's own builder), the working directory read
  from each transcript, the `resume-<uuid>` tmux name, find-before-start, and
  the local vs remote (ssh) attach — with tmux, felt and kitty stubbed.
  """
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest

  alias Shuttle.SessionResume
  alias Shuttle.Test.{Env, StubPostClient}

  @endpoint ShuttleWeb.Endpoint

  @claude "b8586ace-8ce7-4152-a16c-cffa73822756"
  @codex "01a0c993-6157-7cf2-88c5-c1df7f55c426"
  @pi "01a042f4-6b7f-7f79-9c6c-8140ffd0126c"
  @nocwd "fef866ba-b397-4277-a01b-16fcecc2b256"

  defmodule App do
    def read_thread(id), do: {:ok, %{"id" => id, "status" => %{"type" => "idle"}}}

    def resume_thread(id, opts) do
      send(self(), {:native_resume, id})
      send(self(), {:native_resume_options, id, opts})
      {:ok, %{"id" => id}}
    end
  end

  # Scripted runner: `tmux has-session` answers per `:running`, the registry
  # resolves the agents below, everything else succeeds. Records every call.
  defmodule Runner do
    use Agent

    @agents %{
      "claude-opus-headless" => %{
        "id" => "claude-opus-headless",
        "cli" => "claude",
        "wrapper" => "claude",
        "model" => "opus",
        "effort" => "medium",
        "extra_flags" => "--permission-mode auto",
        "headless" => true,
        "env" => %{"CLAUDE_CODE_PROMPT_CACHE_TTL" => "5m"}
      },
      "codex-luna" => %{
        "id" => "codex-luna",
        "cli" => "codex",
        "wrapper" => "codex",
        "model" => "gpt-6-luna",
        "effort" => "max",
        "extra_flags" => "--approve-for-me"
      }
    }

    def start_link(_ \\ []),
      do: Agent.start_link(fn -> %{calls: [], running: false} end, name: __MODULE__)

    def calls, do: Agent.get(__MODULE__, & &1.calls)
    def set_running(running), do: Agent.update(__MODULE__, &Map.put(&1, :running, running))
    def set_duplicate(dup), do: Agent.update(__MODULE__, &Map.put(&1, :duplicate, dup))
    def set_ps(result), do: Agent.update(__MODULE__, &Map.put(&1, :ps, result))
    def set_agent_patch(patch), do: Agent.update(__MODULE__, &Map.put(&1, :agent_patch, patch))

    def cmd(command, args, _opts) do
      Agent.update(
        __MODULE__,
        &Map.update!(&1, :calls, fn calls -> calls ++ [{command, args}] end)
      )

      case {command, args} do
        {"tmux", ["has-session" | _]} ->
          if Agent.get(__MODULE__, & &1.running), do: {"", 0}, else: {"can't find session", 1}

        {"shuttle", ["agents", "resolve", id, "--json"]} ->
          case @agents[id] do
            nil ->
              {"unknown agent #{id}", 1}

            agent ->
              {Jason.encode!(
                 Map.merge(agent, Agent.get(__MODULE__, &Map.get(&1, :agent_patch, %{})))
               ), 0}
          end

        {"ps", _} ->
          Agent.get(__MODULE__, &Map.get(&1, :ps, {"", 0}))

        {"tmux", ["new-session" | _]} ->
          if Agent.get(__MODULE__, &Map.get(&1, :duplicate)),
            do: {"duplicate session: resume-x", 1},
            else: {"", 0}

        _ ->
          {"", 0}
      end
    end
  end

  defmodule RexRunner do
    def cmd("/bin/echo", args, opts), do: Shuttle.Test.FakeRex.cmd("/bin/echo", args, opts)
    def cmd(command, args, opts), do: Runner.cmd(command, args, opts)
  end

  defmodule StubKitty do
    use Agent
    def start_link(_ \\ []), do: Agent.start_link(fn -> [] end, name: __MODULE__)
    def opened, do: Agent.get(__MODULE__, & &1)

    def open(session, host) do
      Agent.update(__MODULE__, &(&1 ++ [{session, host}]))
      :ok
    end
  end

  setup do
    root = Path.join(System.tmp_dir!(), "shuttle_resume_#{System.unique_integer([:positive])}")
    project = Path.join(root, "work/my project")
    File.mkdir_p!(project)

    claude_dir = Path.join([root, "claude", SessionResume.claude_slug(project)])
    codex_dir = Path.join(root, "codex/2026/09/27")
    pi_dir = Path.join(root, "pi/--work--")
    Enum.each([claude_dir, codex_dir, pi_dir], &File.mkdir_p!/1)

    # Claude: an earlier record in another directory is not where the session
    # is filed; the one whose encoding matches the project directory is.
    File.write!(
      Path.join(claude_dir, "#{@claude}.jsonl"),
      Enum.map_join(
        [
          %{"type" => "mode"},
          %{"type" => "user", "cwd" => "/somewhere/else"},
          %{"type" => "user", "cwd" => project}
        ],
        "",
        &(Jason.encode!(&1) <> "\n")
      )
    )

    File.write!(Path.join(claude_dir, "#{@nocwd}.jsonl"), ~s({"type":"user"}\n))

    File.write!(
      Path.join(codex_dir, "rollout-2026-09-27T10-00-00-#{@codex}.jsonl"),
      Jason.encode!(%{"type" => "session_meta", "payload" => %{"id" => @codex, "cwd" => project}}) <>
        "\n"
    )

    File.write!(
      Path.join(pi_dir, "2026-09-27T10-00-00-000Z_#{@pi}.jsonl"),
      Jason.encode!(%{"type" => "session", "id" => @pi, "cwd" => project}) <> "\n"
    )

    ledger = Path.join(root, "sessions.jsonl")

    File.write!(
      ledger,
      Enum.map_join(
        [
          %{
            "session" => @claude,
            "harness" => "claude-code",
            "agent" => "claude-opus-headless",
            "at" => 1
          },
          %{"session" => @codex, "harness" => "codex", "agent" => "codex-luna", "at" => 2},
          %{"session" => @pi, "harness" => "pi", "at" => 3}
        ],
        "",
        &(Jason.encode!(
            Map.merge(&1, %{
              "fiber" => "f",
              "uid" => "U",
              "kind" => "dispatch",
              "host" => Shuttle.Poller.own_host_id()
            })
          ) <>
            "\n")
      )
    )

    env = %{
      "SHUTTLE_CLAUDE_PROJECTS_DIR" => Path.join(root, "claude"),
      "SHUTTLE_CODEX_SESSIONS_DIR" => Path.join(root, "codex"),
      "SHUTTLE_PI_SESSIONS_DIR" => Path.join(root, "pi"),
      "SHUTTLE_UI_DIST" => Path.join(root, "ui"),
      "SHUTTLE_SESSIONS_FILE" => ledger
    }

    Enum.each(env, fn {key, value} -> Env.put_env(key, value) end)

    start_supervised!(Runner)
    start_supervised!(StubKitty)
    Env.put_app_env(:codex_app_client, App)
    Env.put_app_env(:app_workers_dir, Path.join(root, "app-workers"))
    Env.put_app_env(:session_resume_runner, Runner)
    Env.put_app_env(:session_resume_live, fn -> [] end)
    Env.put_app_env(:opener_impl, StubKitty)
    Env.put_app_env(:os_type, {:unix, :linux})

    on_exit(fn -> File.rm_rf(root) end)

    {:ok, project: project}
  end

  describe "plan/2" do
    test "claude resumes with the ledger's agent, as the dispatcher would, and never headless", %{
      project: project
    } do
      assert {:ok, plan} = SessionResume.plan(@claude, runner: Runner)
      assert plan.tmux == "resume-" <> @claude
      assert plan.agent == "claude-opus-headless"
      assert plan.cwd == project

      assert plan.command ==
               "CLAUDE_CODE_PROMPT_CACHE_TTL='5m' claude --model 'opus' --effort 'medium' --permission-mode auto --resume '#{@claude}'"
    end

    test "codex resumes with its subcommand, in the rollout's cwd", %{project: project} do
      assert {:ok, plan} = SessionResume.plan(@codex, runner: Runner)
      assert plan.cwd == project

      assert plan.command ==
               "env -u TMUX -u TMUX_PANE codex --remote 'unix://#{Shuttle.CodexApp.Transport.default_socket()}' -C '#{project}' resume '#{@codex}'"
    end

    test "pi with no ledgered agent resumes with the bare CLI, in its header's cwd", %{
      project: project
    } do
      assert {:ok, plan} = SessionResume.plan(@pi, runner: Runner)
      assert plan.agent == "pi"
      assert plan.cwd == project
      assert plan.command =~ ~r/^pi +--session '#{@pi}'$/
    end

    test "a transcript with no usable cwd, or none at all, is refused" do
      assert {:error, reason} = SessionResume.plan(@nocwd, runner: Runner)
      assert reason =~ "no working directory"

      assert {:error, reason} =
               SessionResume.plan("11111111-2222-3333-4444-555555555555", runner: Runner)

      assert reason =~ "no transcript"
      assert {:error, _} = SessionResume.plan("not-a-uuid", runner: Runner)
    end
  end

  describe "prepare/2" do
    test "starts a detached tmux session in the cwd, running the resume script", %{
      project: project
    } do
      assert {:ok, %{tmux_session: tmux, created: true}} =
               SessionResume.prepare(@claude, runner: Runner)

      assert tmux == "resume-" <> @claude

      assert [{"tmux", ["new-session", "-d", "-s", ^tmux, "-c", ^project, "bash", "-l", script]}] =
               Enum.filter(Runner.calls(), &match?({"tmux", ["new-session" | _]}, &1))

      assert Path.basename(script) =~ ~r/^shuttle-run-resume-#{@claude}\.\d+\.sh$/

      body = File.read!(script)
      assert body =~ "unset ROOTDIR"
      assert body =~ "tmux list-clients -t '#{tmux}'"
      assert body =~ "--resume '#{@claude}' || {"
      File.rm(script)
    end

    test "a resume already running is found, not started twice" do
      Runner.set_running(true)

      assert {:ok, %{tmux_session: _, created: false}} =
               SessionResume.prepare(@claude, runner: Runner)

      refute Enum.any?(Runner.calls(), &match?({"tmux", ["new-session" | _]}, &1))
    end
  end

  describe "Rex primary" do
    @describetag :tmp_dir

    setup %{tmp_dir: dir} do
      Env.put_app_env(:terminal_backend, Shuttle.Terminal.Rex)
      Env.put_app_env(:fake_rex, start_supervised!(Shuttle.Test.FakeRex))
      Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
      Env.put_env("SHUTTLE_DATA_DIR", dir)
      File.ln_s!(System.find_executable("id"), Path.join(dir, "id"))
      File.write!(Path.join(dir, "tmux"), "#!/bin/sh\nexit 1\n")
      File.chmod!(Path.join(dir, "tmux"), 0o755)
      Env.put_env("PATH", dir)
      :ok
    end

    test "historical resume launches in Rex with its environment and no client wait" do
      assert {:ok, %{tmux_session: name, created: true}} =
               SessionResume.prepare(@pi, runner: RexRunner)

      assert name == "resume-" <> @pi
      body = rex_script()
      assert body =~ "unset TMUX TMUX_PANE"
      assert body =~ "export PATH="
      assert body =~ "--session '#{@pi}'"
      refute body =~ "list-clients"
      refute Enum.any?(Runner.calls(), &match?({"tmux", ["new-session" | _]}, &1))
    end

    test "a concurrent launch inside the facade reuses the resume" do
      Env.put_app_env(:fake_rex_hook, fn
        "session.list" ->
          count = Process.get(:rex_resume_probes, 0) + 1
          Process.put(:rex_resume_probes, count)

          if count == 2 do
            Shuttle.Test.FakeRex.sessions(%{
              "session:concurrent" => %{
                label: "resume-" <> @pi,
                blocks: [%{"block_id" => "block:concurrent", "label" => "resume-" <> @pi}]
              }
            })
          end

        _ ->
          :ok
      end)

      assert {:ok, %{tmux_session: "resume-" <> @pi, created: false}} =
               SessionResume.prepare(@pi, runner: RexRunner)

      refute Enum.any?(Shuttle.Test.FakeRex.calls(), fn {_, argv, _} ->
               "session.create" in argv
             end)
    end

    test "a pre-flip tmux resume is reused rather than duplicated in Rex" do
      Runner.set_running(true)
      assert {:ok, %{created: false}} = SessionResume.prepare(@pi, runner: RexRunner)

      refute Enum.any?(Shuttle.Test.FakeRex.calls(), fn {_, argv, _} ->
               "session.create" in argv
             end)
    end

    test "owned Codex viewers launch in Rex and keep the exact native thread endpoint", %{
      project: project
    } do
      assert :ok =
               Shuttle.AppWorkers.put(%{
                 "session_uuid" => @codex,
                 "thread_id" => @codex,
                 "active" => true,
                 "surface" => "cli",
                 "launch_state" => "running",
                 "agent_id" => "codex-luna",
                 "cwd" => project,
                 "terminal_wrapper" => "codex",
                 "backend_host" => Shuttle.Poller.own_host_id(),
                 "backend_endpoint" => Shuttle.CodexApp.Transport.default_socket()
               })

      assert {:ok, %{tmux_session: name, created: true}} =
               SessionResume.prepare(@codex, runner: RexRunner)

      assert name == "codex-terminal-" <> @codex
      assert_received {:native_resume, @codex}
      body = rex_script()
      assert body =~ "unset TMUX TMUX_PANE"
      assert body =~ "export PATH="
      assert body =~ "--remote 'unix://#{Shuttle.CodexApp.Transport.default_socket()}'"
      assert body =~ "resume '#{@codex}'"
      refute body =~ "list-clients"
      refute Enum.any?(Runner.calls(), &match?({"tmux", ["new-session" | _]}, &1))
    end
  end

  defp rex_script do
    assert [{_, _, opts}] =
             Enum.filter(Shuttle.Test.FakeRex.calls(), fn {_, argv, _} ->
               "session.create" in argv
             end)

    spec = Jason.decode!(opts[:input])
    ["bash", "-l", path] = hd(spec["initial_windows"])["layout"]["block"]["options"]["command"]
    on_exit(fn -> File.rm(path) end)
    File.read!(path)
  end

  describe "never a second process on a live worker's transcript" do
    test "prepare refuses a session a worker is running, and starts nothing" do
      assert {:error, {:live, reason}} =
               SessionResume.prepare(@claude, runner: Runner, live_sessions: fn -> [@claude] end)

      assert reason =~ "running worker"
      assert Runner.calls() == []
    end

    test "prepare refuses a session a process tmux cannot see still holds" do
      Runner.set_ps(
        {"""
           700     1 tmux: server
           812   700 bash -l /tmp/shuttle-run-9859.sh
           813   812 claude --resume #{@claude}
         """, 0}
      )

      assert {:error, {:live, reason}} = SessionResume.prepare(@claude, runner: Runner)
      assert reason =~ "pid 813"
      assert reason =~ "kill -USR1 700"
      refute Enum.any?(Runner.calls(), &match?({"tmux", ["new-session" | _]}, &1))
    end

    test "prepare refuses when the process scan cannot run" do
      Runner.set_ps({"ps: boom", 1})

      assert {:error, reason} = SessionResume.prepare(@claude, runner: Runner)
      assert reason =~ "could not check"
      refute Enum.any?(Runner.calls(), &match?({"tmux", ["new-session" | _]}, &1))
    end

    test "both routes answer 409" do
      Env.put_app_env(:session_resume_live, fn -> [@codex] end)

      for route <- ["/api/v1/attach", "/api/v1/sessions/resume"] do
        assert %{"error" => reason} =
                 post(api_conn(), route, Jason.encode!(%{"session" => @codex}))
                 |> json_response(409)

        assert reason =~ "attach"
      end

      assert StubKitty.opened() == []
    end
  end

  test "historical Codex rejects unsupported env and flags before loading its thread" do
    for {patch, diagnostic} <- [
          {%{"env" => %{"PER_WORKER_ENV" => "cannot-honor"}}, "per-worker agent env"},
          {%{"extra_flags" => "--unsupported-config"}, "extra_flags"}
        ] do
      Runner.set_agent_patch(patch)

      assert {:error, message} =
               SessionResume.prepare(@codex, runner: Runner, live_sessions: fn -> [] end)

      assert message =~ diagnostic
      refute_received {:native_resume, _}

      refute Enum.any?(Runner.calls(), fn {cmd, args} ->
               cmd == "tmux" and "new-session" in args
             end)
    end
  end

  test "historical Codex uses dispatch protocol options for supported approval presets" do
    for {preset, expected} <- [
          {"--approve-for-me",
           [
             approval_policy: "on-request",
             approvals_reviewer: "auto_review",
             sandbox: "workspace-write"
           ]},
          {"--not-so-yolo",
           [
             approval_policy: "on-request",
             approvals_reviewer: "auto_review",
             sandbox: "workspace-write"
           ]},
          {"--dangerously-bypass-approvals-and-sandbox",
           [approval_policy: "never", approvals_reviewer: nil, sandbox: "danger-full-access"]}
        ] do
      Runner.set_agent_patch(%{
        "extra_flags" => preset,
        "developer_instructions" => "AGENT_ONLY_MARKER"
      })

      assert {:ok, plan} = SessionResume.plan(@codex, runner: Runner)
      assert Keyword.fetch!(plan.backend_opts, :developer_instructions) == nil
      assert plan.backend_opts[:model] == "gpt-6-luna"
      assert plan.backend_opts[:effort] == "max"
      for {key, value} <- expected, do: assert(plan.backend_opts[key] == value)

      assert {:ok, %{created: true}} =
               SessionResume.prepare(@codex, runner: Runner, live_sessions: fn -> [] end)

      assert_received {:native_resume_options, @codex, native_opts}
      assert Keyword.fetch!(native_opts, :developer_instructions) == nil
      assert byte_size(Keyword.fetch!(native_opts, :sender_capability)) == 64

      assert Keyword.delete(native_opts, :sender_capability) ==
               Keyword.delete(plan.backend_opts, :sender_capability)

      assert plan.command =~ "--remote 'unix://"
      refute plan.command =~ preset
    end
  end

  test "History imports a stopped embedded conversation with its exact ID and durable endpoint" do
    assert {:ok, %{tmux_session: "resume-" <> @codex}} =
             SessionResume.prepare(@codex, runner: Runner, live_sessions: fn -> [] end)

    assert_received {:native_resume, @codex}
    refute_received {:native_resume, _}
    assert {:ok, record} = Shuttle.AppWorkers.get(@codex)
    assert record["backend_host"] == Shuttle.Poller.own_host_id()
    assert record["backend_endpoint"] == Shuttle.CodexApp.Transport.default_socket()
    assert record["thread_id"] == @codex
    assert record["active"] == false
  end

  test "History rejects a shared rollout without host execution provenance" do
    File.rm!(Shuttle.SessionLedger.default_path())

    assert {:error, message} =
             SessionResume.prepare(@codex, runner: Runner, live_sessions: fn -> [] end)

    assert message =~ "embedded_origin_unverified"
    refute_received {:native_resume, _}
    assert {:error, :not_found} = Shuttle.AppWorkers.get(@codex)
  end

  test "History accepts an old embedded ledger row in the rotated file" do
    ledger = Shuttle.SessionLedger.default_path()
    File.rename!(ledger, ledger <> ".1")
    File.write!(ledger, "")

    assert {:ok, %{created: true}} =
             SessionResume.prepare(@codex, runner: Runner, live_sessions: fn -> [] end)

    assert_received {:native_resume, @codex}
  end

  test "History refuses unknown holder scans before any native call" do
    Runner.set_ps({"scan failed", 1})

    assert {:error, message} =
             SessionResume.prepare(@codex, runner: Runner, live_sessions: fn -> [] end)

    assert message =~ "could not check"
    refute_received {:native_resume, _}
  end

  test "historical Codex refuses malformed ownership before native resume" do
    File.mkdir_p!(Shuttle.AppWorkers.root())
    path = Path.join(Shuttle.AppWorkers.root(), @codex <> ".json")

    for {bytes, reason} <- [
          {"null", :ownership_record_unreadable},
          {Jason.encode!(%{"session_uuid" => "other", "thread_id" => "other"}),
           :session_owner_mismatch}
        ] do
      File.write!(path, bytes)

      assert {:error, ^reason} =
               SessionResume.prepare(@codex, runner: Runner, live_sessions: fn -> [] end)

      refute_received {:native_resume, _}
      assert File.read!(path) == bytes
    end
  end

  test "historical owned Codex refuses another endpoint before native resume" do
    assert :ok =
             Shuttle.AppWorkers.put(%{
               "session_uuid" => @codex,
               "thread_id" => @codex,
               "active" => false,
               "backend_host" => Shuttle.Poller.own_host_id(),
               "backend_endpoint" => "/another-owner.sock"
             })

    assert {:error, :app_endpoint_changed} =
             SessionResume.prepare(@codex, runner: Runner, live_sessions: fn -> [] end)

    refute_received {:native_resume, _}
  end

  test "historical Codex refuses an embedded holder before native resume" do
    Runner.set_ps({"1234 1 codex resume #{@codex}\n", 0})

    assert {:error, {:live, message}} =
             SessionResume.prepare(@codex, runner: Runner, live_sessions: fn -> [] end)

    assert message =~ "1234"
    refute_received {:native_resume, _}
  end

  test "durably owned historical Codex does not confuse an App Server identity with an embedded holder" do
    :ok =
      Shuttle.AppWorkers.put(%{
        "session_uuid" => @codex,
        "thread_id" => @codex,
        "active" => false,
        "backend_host" => Shuttle.Poller.own_host_id(),
        "backend_endpoint" => Shuttle.CodexApp.Transport.default_socket()
      })

    Runner.set_ps({"1234 1 codex --remote unix:///control.sock resume #{@codex}\n", 0})

    assert {:ok, %{tmux_session: "resume-" <> @codex, created: true}} =
             SessionResume.prepare(@codex, runner: Runner, live_sessions: fn -> [] end)

    assert_received {:native_resume, @codex}
  end

  test "a double click that races tmux's duplicate-session error is the session, not a failure" do
    Runner.set_duplicate(true)

    assert {:ok, %{created: false, tmux_session: tmux}} =
             SessionResume.prepare(@pi, runner: Runner)

    assert tmux == "resume-" <> @pi
  end

  describe "POST /api/v1/attach with a session" do
    test "a local session resumes here and the tab attaches to it" do
      body =
        post(api_conn(), "/api/v1/attach", Jason.encode!(%{"session" => @codex}))
        |> json_response(200)

      assert body == %{"attached" => true, "session" => "resume-" <> @codex}
      assert StubKitty.opened() == [{"resume-" <> @codex, nil}]
    end

    test "a live worker's tmux session still attaches as before" do
      post(
        api_conn(),
        "/api/v1/attach",
        Jason.encode!(%{"tmux_session" => "debug-U-shuttle", "shuttle_host" => "hub-a"})
      )
      |> json_response(200)

      assert StubKitty.opened() == [{"debug-U-shuttle", "hub-a"}]
      assert Runner.calls() == []
    end

    test "nothing to resume is a 422 and opens no tab" do
      assert %{"error" => reason} =
               post(api_conn(), "/api/v1/attach", Jason.encode!(%{"session" => @nocwd}))
               |> json_response(422)

      assert reason =~ "no working directory"
      assert StubKitty.opened() == []
    end

    test "a non-string host is a 400, and an unknown one is named" do
      post(api_conn(), "/api/v1/attach", Jason.encode!(%{"session" => @pi, "shuttle_host" => 7}))
      |> json_response(400)

      assert %{"error" => reason} =
               post(
                 api_conn(),
                 "/api/v1/attach",
                 Jason.encode!(%{"session" => @pi, "shuttle_host" => "nowhere"})
               )
               |> json_response(422)

      assert reason =~ "unknown origin \"nowhere\""
      assert StubKitty.opened() == []
    end

    test "a malformed id is a 400" do
      post(api_conn(), "/api/v1/attach", Jason.encode!(%{"session" => "x; rm -rf /"}))
      |> json_response(400)

      assert StubKitty.opened() == []
    end

    test "a remote session is started on its host, then attached over that host's ssh path" do
      StubPostClient.start!()
      Env.put_app_env(:write_forward_client, StubPostClient)
      Env.put_app_env(:remotes, [%{name: "hub-a", port: 4001, ssh: "hub-a-login"}])

      StubPostClient.set_response(
        {:ok, 200, Jason.encode!(%{"tmux_session" => "resume-" <> @pi, "created" => true})}
      )

      body =
        post(
          api_conn(),
          "/api/v1/attach",
          Jason.encode!(%{"session" => @pi, "shuttle_host" => "hub-a"})
        )
        |> json_response(200)

      assert body["session"] == "resume-" <> @pi
      assert StubPostClient.last().url =~ "/api/v1/sessions/resume"
      assert Jason.decode!(StubPostClient.last().body) == %{"session" => @pi}
      # Nothing is started here: the transcript is the remote's.
      assert Runner.calls() == []
      assert StubKitty.opened() == [{"resume-" <> @pi, "hub-a"}]
      # And the tab's command is the ssh attach Kitty builds for that host.
      assert Shuttle.Kitty.attach_command("resume-" <> @pi, "hub-a") ==
               {:ok, ["ssh", "-tt", "hub-a-login", "tmux", "attach", "-t", "=resume-" <> @pi]}

      StubPostClient.set_response(
        {:ok, 404, Jason.encode!(%{"errors" => %{"detail" => "Not Found"}})}
      )

      assert %{"error" => reason} =
               post(
                 api_conn(),
                 "/api/v1/attach",
                 Jason.encode!(%{"session" => @pi, "shuttle_host" => "hub-a"})
               )
               |> json_response(502)

      assert reason =~ "deploy"

      StubPostClient.set_response({:ok, 422, Jason.encode!(%{"error" => "no transcript"})})

      assert %{"error" => "hub-a: no transcript"} =
               post(
                 api_conn(),
                 "/api/v1/attach",
                 Jason.encode!(%{"session" => @pi, "shuttle_host" => "hub-a"})
               )
               |> json_response(422)
    end
  end

  test "POST /api/v1/sessions/resume starts the resume on this host only" do
    assert %{"tmux_session" => tmux, "created" => true} =
             post(api_conn(), "/api/v1/sessions/resume", Jason.encode!(%{"session" => @pi}))
             |> json_response(200)

    assert tmux == "resume-" <> @pi
    assert StubKitty.opened() == []
  end
end
