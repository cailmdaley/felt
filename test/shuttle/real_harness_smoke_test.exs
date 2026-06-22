defmodule Shuttle.RealHarnessSmokeTest do
  use ExUnit.Case, async: false

  @moduletag :integration
  @moduletag timeout: 60_000

  @enable_env "SHUTTLE_REAL_HARNESS_SMOKE"
  @prompt_sentinel "SHUTTLE_SMOKE_PROMPT_SHOULD_NOT_APPEAR"
  @agent_ids [
    {"claude-sonnet", "claude"},
    {"codex", "codex"},
    {"pi-deepseek-flash", "pi"}
  ]

  unless System.get_env(@enable_env) in ["1", "true", "yes"] do
    @moduletag skip: "set #{@enable_env}=1 to launch real Claude/Codex/Pi harness smoke tests"
  end

  command_available? = fn wrapper ->
    case System.cmd("bash", ["-lc", "type -t #{wrapper} >/dev/null"], stderr_to_stdout: true) do
      {_, 0} -> true
      _ -> false
    end
  end

  for {agent_id, wrapper} <- @agent_ids do
    if command_available?.(wrapper) do
      @tag agent_id: agent_id
      test "#{wrapper} opens to an idle tmux surface without a prompt", %{agent_id: agent_id} do
        agent = agent!(agent_id)
        run_idle_smoke(agent)
      end
    else
      @tag skip: "#{wrapper} is not available in bash -l"
      test "#{wrapper} opens to an idle tmux surface without a prompt" do
        :ok
      end
    end
  end

  defp run_idle_smoke(agent) do
    session = "shuttle-harness-smoke-#{agent.cli}-#{System.unique_integer([:positive])}"
    artifact_dir = artifact_dir(agent.id)
    work_dir = Path.join(artifact_dir, "work")
    capture_path = Path.join(artifact_dir, "capture.txt")
    command = idle_command(agent)

    File.mkdir_p!(work_dir)
    on_exit(fn -> kill_session(session) end)

    before_snapshot = evidence_snapshot(agent.cli)

    refute command =~ @prompt_sentinel
    refute command =~ "<<<"

    try do
      start_session!(session, work_dir, command)

      capture =
        session
        |> wait_for_idle_capture!()
        |> tap(&File.write!(capture_path, &1))

      refute capture =~ @prompt_sentinel

      kill_session(session)
      refute tmux_session?(session), "expected smoke-owned tmux session to be gone"

      after_snapshot = evidence_snapshot(agent.cli)
      changed = changed_evidence(before_snapshot, after_snapshot)
      changed_for_work_dir = evidence_for_work_dir(agent.cli, changed, work_dir)
      prompt_evidence = prompt_evidence_files(agent.cli, changed, changed_for_work_dir)

      assert_no_prompt_sentinel(prompt_evidence)

      IO.puts("""

      [real harness smoke] #{agent.id}
        command: #{command}
        capture: #{capture_path}
        signature: #{capture_signature(capture)}
        changed evidence files: #{length(changed)}
        changed evidence files for work dir: #{length(changed_for_work_dir)}
      """)
    after
      kill_session(session)
    end
  end

  # felt owns the registry now; the smoke derives each agent's wrapper/model from
  # `felt shuttle agents --json` (the same source the daemon serves at
  # /api/v1/agents). This is the opt-in real-harness path, so a live felt is
  # already a precondition — flunk loudly if the verb or the id is missing.
  defp agent!(agent_id) do
    records =
      case System.cmd("felt", ["shuttle", "agents", "--json"], stderr_to_stdout: true) do
        {output, 0} -> Jason.decode!(output)
        {output, status} -> flunk("felt shuttle agents --json exited #{status}: #{output}")
      end

    record =
      Enum.find(records, &(&1["id"] == agent_id)) ||
        flunk("expected agent #{agent_id} in `felt shuttle agents --json`")

    %{
      id: record["id"],
      cli: record["cli"],
      wrapper: record["wrapper"],
      provider: record["provider"],
      model: record["model"],
      extra_flags: record["extra_flags"]
    }
  end

  defp idle_command(agent) do
    [
      agent.wrapper,
      flag("--provider", agent.provider),
      flag("--model", agent.model),
      agent.extra_flags
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.join(" ")
  end

  defp flag(_name, nil), do: nil
  defp flag(name, value), do: "#{name} #{shell_escape(value)}"

  defp shell_escape(value) do
    value
    |> String.replace("'", "'\\''")
    |> then(&"'#{&1}'")
  end

  defp artifact_dir(agent_id) do
    stamp =
      DateTime.utc_now()
      |> DateTime.to_iso8601(:basic)
      |> String.replace(["Z", ":"], "")

    Path.join(["_build", "test", "shuttle_harness_smoke", "#{agent_id}-#{stamp}"])
  end

  defp start_session!(session, work_dir, command) do
    args = ["new-session", "-d", "-s", session, "-c", work_dir, "bash", "-lc", "exec #{command}"]

    case System.cmd("tmux", args, stderr_to_stdout: true) do
      {_, 0} ->
        :ok

      {output, code} ->
        flunk("tmux new-session failed with #{code}: #{String.trim(output)}")
    end
  end

  defp wait_for_idle_capture!(session) do
    deadline = System.monotonic_time(:millisecond) + 15_000
    wait_for_idle_capture(session, deadline, "", 0)
  end

  defp wait_for_idle_capture(session, deadline, previous, stable_count) do
    unless tmux_session?(session) do
      flunk("tmux session #{session} exited before an idle surface was captured")
    end

    capture = capture_pane(session)
    normalized = normalize_capture(capture)
    next_stable = if normalized != "" and normalized == previous, do: stable_count + 1, else: 0

    cond do
      idle_signature?(normalized) or next_stable >= 2 ->
        normalized

      System.monotonic_time(:millisecond) >= deadline ->
        flunk("""
        timed out waiting for #{session} to reach an idle surface

        Last capture:
        #{normalized}
        """)

      true ->
        Process.sleep(500)
        wait_for_idle_capture(session, deadline, normalized, next_stable)
    end
  end

  defp idle_signature?(capture) do
    capture =~ ~r/(Claude|Codex|pi|Ask|Message|prompt|approval|session|cwd|workdir)/i
  end

  defp capture_pane(session) do
    case System.cmd("tmux", ["capture-pane", "-t", session, "-p", "-S", "-200"],
           stderr_to_stdout: true
         ) do
      {output, 0} -> output
      {output, _} -> output
    end
  end

  defp normalize_capture(capture) do
    capture
    |> String.replace(~r{\e\[[0-9;?]*[ -/]*[@-~]}, "")
    |> String.replace(~r/\e\].*?(\a|\e\\)/s, "")
    |> String.split("\n")
    |> Enum.map(&String.trim_trailing/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.join("\n")
    |> String.trim()
  end

  defp capture_signature(capture) do
    capture
    |> String.split("\n")
    |> Enum.take(5)
    |> Enum.join(" / ")
  end

  defp kill_session(session) do
    System.cmd("tmux", ["kill-session", "-t", session], stderr_to_stdout: true)
    :ok
  end

  defp tmux_session?(session) do
    case System.cmd("tmux", ["has-session", "-t", session], stderr_to_stdout: true) do
      {_, 0} -> true
      _ -> false
    end
  end

  defp evidence_snapshot(cli) do
    cli
    |> evidence_patterns()
    |> Enum.flat_map(&Path.wildcard/1)
    |> Enum.filter(&File.regular?/1)
    |> Map.new(fn path ->
      stat = File.stat!(path, time: :posix)
      {path, {stat.size, stat.mtime}}
    end)
  end

  defp evidence_patterns("claude") do
    home = System.user_home!()

    [
      Path.join([home, ".claude", "projects", "**", "*.jsonl"]),
      Path.join([home, ".claude", "*.json"]),
      Path.join([home, ".claude", "statsig", "**", "*"])
    ]
  end

  defp evidence_patterns("codex") do
    [Path.join([System.user_home!(), ".codex", "sessions", "**", "*.jsonl"])]
  end

  defp evidence_patterns("pi") do
    [Path.join([System.user_home!(), ".pi", "agent", "sessions", "**", "*.jsonl"])]
  end

  defp evidence_patterns(_cli), do: []

  defp changed_evidence(before_snapshot, after_snapshot) do
    after_snapshot
    |> Enum.filter(fn {path, stat} -> Map.get(before_snapshot, path) != stat end)
    |> Enum.map(fn {path, _stat} -> path end)
  end

  defp evidence_for_work_dir(cli, paths, work_dir) when cli in ["codex", "pi"] do
    Enum.filter(paths, fn path ->
      case File.read(path) do
        {:ok, content} ->
          content
          |> String.split("\n", parts: 2)
          |> List.first("")
          |> Jason.decode()
          |> case do
            {:ok, event} -> Path.expand(Map.get(event, "cwd", "")) == Path.expand(work_dir)
            _ -> false
          end

        _ ->
          false
      end
    end)
  end

  defp evidence_for_work_dir(_cli, _paths, _work_dir), do: []

  defp prompt_evidence_files(cli, _changed, changed_for_work_dir) when cli in ["codex", "pi"] do
    changed_for_work_dir
  end

  defp prompt_evidence_files(_cli, changed, _changed_for_work_dir), do: changed

  defp assert_no_prompt_sentinel(paths) do
    leaked =
      Enum.filter(paths, fn path ->
        case File.read(path) do
          {:ok, content} -> String.contains?(content, @prompt_sentinel)
          _ -> false
        end
      end)

    assert leaked == [], "prompt sentinel appeared in evidence files: #{inspect(leaked)}"
  end
end
