defmodule Shuttle.SessionResumeTest do
  @moduledoc """
  `Shuttle.SessionResume` and the `/attach` resume leg: the resume command per
  harness (built by the dispatcher's own builder), the working directory read
  from each transcript, the `resume-<uuid>` tmux name, find-before-start, and
  the local vs remote (ssh) attach — with tmux, felt and kitty stubbed.
  """
  use ExUnit.Case, async: false
  import Shuttle.Test.ApiConn
  import Shuttle.Test.EnvHelpers
  import Phoenix.ConnTest

  alias Shuttle.SessionResume
  alias Shuttle.Test.StubPostClient

  @endpoint ShuttleWeb.Endpoint

  @claude "b8586ace-8ce7-4152-a16c-cffa73822756"
  @codex "01a0c993-6157-7cf2-88c5-c1df7f55c426"
  @pi "01a042f4-6b7f-7f79-9c6c-8140ffd0126c"
  @nocwd "fef866ba-b397-4277-a01b-16fcecc2b256"

  # Scripted runner: `tmux has-session` answers per `:running`, the registry
  # resolves the agents below, everything else succeeds. Records every call.
  defmodule Runner do
    use Agent

    @agents %{
      "claude-opus" => %{
        "id" => "claude-opus",
        "cli" => "claude",
        "wrapper" => "claude",
        "model" => "opus",
        "effort" => "medium",
        "extra_flags" => "--permission-mode auto",
        "headless" => true
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

    def cmd(command, args, _opts) do
      Agent.update(
        __MODULE__,
        &Map.update!(&1, :calls, fn calls -> calls ++ [{command, args}] end)
      )

      case {command, args} do
        {"tmux", ["has-session" | _]} ->
          if Agent.get(__MODULE__, & &1.running), do: {"", 0}, else: {"can't find session", 1}

        {"felt", ["shuttle", "agents", "resolve", id, "--json"]} ->
          case @agents[id] do
            nil -> {"unknown agent #{id}", 1}
            agent -> {Jason.encode!(agent), 0}
          end

        _ ->
          {"", 0}
      end
    end
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
            "agent" => "claude-opus",
            "at" => 1
          },
          %{"session" => @codex, "harness" => "codex", "agent" => "codex-luna", "at" => 2},
          %{"session" => @pi, "harness" => "pi", "at" => 3}
        ],
        "",
        &(Jason.encode!(Map.merge(&1, %{"fiber" => "f", "uid" => "U", "kind" => "dispatch"})) <>
            "\n")
      )
    )

    env = %{
      "SHUTTLE_CLAUDE_PROJECTS_DIR" => Path.join(root, "claude"),
      "SHUTTLE_CODEX_SESSIONS_DIR" => Path.join(root, "codex"),
      "SHUTTLE_PI_SESSIONS_DIR" => Path.join(root, "pi"),
      "SHUTTLE_SESSIONS_FILE" => ledger
    }

    prior = Map.new(env, fn {key, _} -> {key, System.get_env(key)} end)
    Enum.each(env, fn {key, value} -> System.put_env(key, value) end)

    start_supervised!(Runner)
    start_supervised!(StubKitty)
    Application.put_env(:shuttle, :session_resume_runner, Runner)
    Application.put_env(:shuttle, :kitty_impl, StubKitty)
    Application.put_env(:shuttle, :os_type, {:unix, :linux})

    on_exit(fn ->
      File.rm_rf(root)
      Application.delete_env(:shuttle, :session_resume_runner)
      Application.delete_env(:shuttle, :kitty_impl)
      Application.delete_env(:shuttle, :os_type)

      Enum.each(prior, fn
        {key, nil} -> System.delete_env(key)
        {key, value} -> System.put_env(key, value)
      end)
    end)

    {:ok, project: project}
  end

  describe "plan/2" do
    test "claude resumes with the ledger's agent, as the dispatcher would, and never headless", %{
      project: project
    } do
      assert {:ok, plan} = SessionResume.plan(@claude, runner: Runner)
      assert plan.tmux == "resume-" <> @claude
      assert plan.agent == "claude-opus"
      assert plan.cwd == project

      assert plan.command ==
               "claude --model 'opus' --effort 'medium' --permission-mode auto --resume '#{@claude}'"
    end

    test "codex resumes with its subcommand, in the rollout's cwd", %{project: project} do
      assert {:ok, plan} = SessionResume.plan(@codex, runner: Runner)
      assert plan.cwd == project

      assert plan.command ==
               "codex --model 'gpt-6-luna' -c model_reasoning_effort='max' --approve-for-me resume '#{@codex}'"
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

    test "a malformed id is a 400" do
      post(api_conn(), "/api/v1/attach", Jason.encode!(%{"session" => "x; rm -rf /"}))
      |> json_response(400)

      assert StubKitty.opened() == []
    end

    test "a remote session is started on its host, then attached over that host's ssh path" do
      start_supervised!(StubPostClient)
      prior_client = Application.get_env(:shuttle, :write_forward_client)
      prior_remotes = Application.get_env(:shuttle, :remotes)
      Application.put_env(:shuttle, :write_forward_client, StubPostClient)
      Application.put_env(:shuttle, :remotes, [%{name: "hub-a", port: 4001, ssh: "hub-a-login"}])

      on_exit(fn ->
        restore_app_env(:write_forward_client, prior_client)
        restore_app_env(:remotes, prior_remotes)
      end)

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
