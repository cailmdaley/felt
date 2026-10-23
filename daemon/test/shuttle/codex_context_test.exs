defmodule Shuttle.CodexContextTest do
  use ExUnit.Case, async: true

  alias Shuttle.{Agents, CodexContext, Dispatcher}
  alias Shuttle.Test.Env

  setup_all do
    root = Path.join(System.tmp_dir!(), "codex-context-cli-#{System.unique_integer([:positive])}")
    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf!(root) end)
    repo = Path.expand("../../..", __DIR__)

    for cli <- ["felt", "shuttle"] do
      {output, status} =
        System.cmd("go", ["build", "-o", Path.join(root, cli), "./cmd/#{cli}"],
          cd: repo,
          stderr_to_stdout: true
        )

      assert status == 0, output
    end

    {:ok, bin: root, repo: repo}
  end

  setup %{bin: bin} do
    root =
      Path.join(System.tmp_dir!(), "codex-context-case-#{System.unique_integer([:positive])}")

    File.mkdir_p!(Path.join(root, ".felt"))
    File.mkdir_p!(Path.join(root, "home/.codex"))
    on_exit(fn -> File.rm_rf!(root) end)
    Env.put_env("HOME", Path.join(root, "home"))
    Env.put_env("CODEX_HOME", Path.join(root, "home/.codex"))
    Env.put_env("SHUTTLE_AGENTS_FILE", Path.join(root, "agents.json"))
    Env.put_env("PATH", bin <> ":" <> Shuttle.Env.get("PATH"))
    {:ok, root: root}
  end

  test "read-only plaintext context uses the worker checkout, not a parent session or store", %{
    root: root
  } do
    File.write!(
      Path.join(root, ".felt/example.md"),
      "---\nname: WORKER_STORE_MARKER\nstatus: open\n---\n"
    )

    File.write!(Path.join(root, "home/.codex/WAKE.md"), "WAKE_MARKER")

    for key <- ~w(CODEX_THREAD_ID TMUX SHUTTLE_FIBER_PATH),
        do: Env.put_env(key, "parent-identity")

    before = Path.wildcard(Path.join(root, "**/*"), match_dot: true)

    assert {:ok, opts} =
             CodexContext.prepare(
               %{developer_instructions: "AGENT_MARKER"},
               root,
               [developer_instructions: "DISPATCH_MARKER"],
               :fresh
             )

    text = opts[:developer_instructions]
    assert text =~ "# Felt Workflow Context"
    assert text =~ "WORKER_STORE_MARKER"
    assert text =~ "WAKE_MARKER"
    assert text =~ "AGENT_MARKER\n\nDISPATCH_MARKER"
    refute text =~ "hookSpecificOutput"
    refute text =~ "parent-identity"
    assert Path.wildcard(Path.join(root, "**/*"), match_dot: true) == before
  end

  test "resume without explicit instructions preserves native context without reading producers",
       %{root: root} do
    File.mkdir_p!(Path.join(root, "home/.codex/WAKE.md"))

    assert {:ok, opts} =
             CodexContext.prepare(%{developer_instructions: "AGENT_MARKER"}, root, [], :resume)

    assert is_nil(opts[:developer_instructions])
    agent = %{model: "probe-model", effort: nil, developer_instructions: "AGENT_MARKER"}
    assert is_nil(Dispatcher.codex_options(agent, root, opts)[:developer_instructions])
  end

  test "explicit resume instructions retain the worker context producers", %{root: root} do
    File.write!(Path.join(root, "home/.codex/WAKE.md"), "WAKE_MARKER")

    assert {:ok, opts} =
             CodexContext.prepare(
               %{developer_instructions: "AGENT_MARKER"},
               root,
               [developer_instructions: "DISPATCH_MARKER"],
               :resume
             )

    assert opts[:developer_instructions] =~ "WAKE_MARKER\n\n# Felt Workflow Context"
    assert opts[:developer_instructions] =~ "AGENT_MARKER\n\nDISPATCH_MARKER"
  end

  test "unreadable wake or unavailable context generator refuses rather than silently dropping context",
       %{root: root} do
    path = Path.join(root, "home/.codex/WAKE.md")
    File.mkdir_p!(path)

    assert {:error, {:codex_context_unavailable, {:wake, _}}} =
             CodexContext.prepare(%{}, root, [], :fresh)

    File.rmdir!(path)
    Env.put_env("PATH", Path.join(root, "absent-bin"))

    assert {:error, {:codex_context_unavailable, {:felt_session, 127}}} =
             CodexContext.prepare(%{}, root, [], :fresh)
  end

  test "shipped Codex records and Go effort overrides render unchanged managed options", %{
    root: root,
    repo: repo
  } do
    builtins =
      File.read!(Path.join(repo, "internal/shuttle/agents.builtin.json")) |> Jason.decode!()

    configs = [
      {"codex-sol", "gpt-sol", "low"},
      {"codex-luna", "gpt-luna", "max"},
      {"codex-astra", "gpt-astra", "medium"}
    ]

    for {id, model, effort} <- configs do
      record = Enum.find(builtins, &(&1["id"] == id))
      assert record["model"] == model
      assert record["default_effort"] == effort
      assert record["extra_flags"] == "--approve-for-me"
    end

    releases = %{
      "gpt-sol" => "gpt-6.1-sol",
      "gpt-luna" => "gpt-6-luna",
      "gpt-astra" => "gpt-6-astra"
    }

    cache = %{models: Enum.map(Map.values(releases), &%{slug: &1, visibility: "list"})}
    File.write!(Path.join(root, "home/.codex/models_cache.json"), Jason.encode!(cache))

    for overridden <- [false, true] do
      if overridden do
        overrides = Map.new(configs, fn {id, _, _} -> {id, %{"default_effort" => "high"}} end)

        File.write!(
          Path.join(root, "agents.json"),
          Jason.encode!(%{version: 1, overrides: overrides})
        )
      end

      for {id, model, default_effort} <- configs do
        assert {:ok, agent} =
                 Dispatcher.resolve_agent_axes(id, nil, false, Shuttle.Runner.Default)

        effort = if overridden, do: "high", else: default_effort
        assert :ok = Dispatcher.validate_codex_agent(agent)
        assert agent.model == releases[model]
        assert agent.effort == effort
        options = Dispatcher.codex_options(agent, root, felt_store: root)
        assert options[:model] == releases[model]
        assert options[:effort] == effort
        assert options[:approval_policy] == "on-request"
        assert options[:approvals_reviewer] == "auto_review"
        assert options[:sandbox] == "workspace-write"

        assert {:ok, selected} =
                 Dispatcher.resolve_agent_axes(id, "medium", false, Shuttle.Runner.Default)

        assert selected.effort == "medium"
      end
    end
  end

  test "Go registry projects developer instructions through resolve and show", %{root: root} do
    File.write!(
      Path.join(root, "agents.json"),
      Jason.encode!(%{
        version: 1,
        agents: [
          %{
            id: "context-agent",
            cli: "codex",
            model: "probe-model",
            developer_instructions: "AGENT_MARKER"
          }
        ]
      })
    )

    assert {:ok, agent} =
             Dispatcher.resolve_agent_axes("context-agent", nil, false, Shuttle.Runner.Default)

    assert agent.developer_instructions == "AGENT_MARKER"

    File.write!(
      Path.join(root, ".felt/worker.md"),
      "---\nname: Worker\nshuttle:\n  agent: context-agent\n  kind: oneshot\n---\n"
    )

    {output, 0} =
      Shuttle.Runner.Default.cmd("shuttle", ["-C", root, "show", "worker", "--json"], [])

    resolved = get_in(Jason.decode!(output), ["shuttle", "resolved", "agent"])
    assert Agents.from_resolved(resolved).developer_instructions == "AGENT_MARKER"
  end

  test "arbitrary CLI flags and per-worker environments are refused, not ignored" do
    agent = %{env: %{}, extra_flags: nil}

    for flag <- [
          "--resume thread-id",
          "--session thread-id",
          "--model other",
          "-c developer_instructions=hello",
          "--config model=other",
          "--approve-for-me --model other",
          ~s(--approve-for-me --config developer_instructions="Keep all whitespace.\n  Second line."),
          ~s|--approve-for-me -c developer_instructions="$(touch should-not-execute)"|
        ] do
      assert {:error, {:invalid_axes, message}} =
               Dispatcher.validate_codex_agent(%{agent | extra_flags: flag})

      assert message =~ "not arbitrary extra_flags"
    end

    assert {:error, {:invalid_axes, message}} =
             Dispatcher.validate_codex_agent(%{agent | env: %{"CUSTOM" => "value"}})

    assert message =~ "App Server environment"

    for flag <- [
          nil,
          "",
          "--approve-for-me",
          "--not-so-yolo",
          "--dangerously-bypass-approvals-and-sandbox"
        ] do
      assert :ok = Dispatcher.validate_codex_agent(%{agent | extra_flags: flag})
    end
  end
end
