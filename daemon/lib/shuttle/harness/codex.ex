defmodule Shuttle.Harness.Codex do
  @moduledoc """
  OpenAI's Codex CLI. Its conversation id is reported after launch, by the
  rollout file it writes under the date-fanned sessions root; the prompt is
  an argument, effort is `-c model_reasoning_effort`, and an agent record's
  developer instructions become `-c developer_instructions`.
  """

  @behaviour Shuttle.Harness

  alias Shuttle.{Agents, FileTail, HarnessPaths, Transcript, TranscriptUsage}

  @statuses ~w(pending in_progress completed)

  @impl true
  def name, do: "codex"
  @impl true
  def ledger_name, do: "codex"
  @impl true
  def binary, do: "codex"
  @impl true
  def idle_signal?, do: true
  @impl true
  def interrupts?, do: true
  # Codex conversation ids stay stable across receivers, and one receiver can
  # host distinct threads, so its events join by id alone.
  @impl true
  def receiver_succession?, do: false
  @impl true
  def resume_fallback, do: :none
  @impl true
  def identity, do: "reported"
  @impl true
  def takes_paste?, do: true

  @impl true
  def launch_command(agent, prompt, _opts),
    do: invocation(agent.wrapper, "#{flags(agent)} #{Agents.shell_escape(prompt)}")

  @impl true
  def resume_command(agent, session_id, prompt, _opts) do
    args = "#{flags(agent)} resume #{Agents.shell_escape(session_id)}"
    args = if prompt == "", do: args, else: "#{args} #{Agents.shell_escape(prompt)}"
    invocation(agent.wrapper, args)
  end

  # Codex's terminal startup probes tmux. Clearing the pane variables prevents
  # those optional probes from waiting on the parent terminal's tmux server.
  # `env` also executes the PATH program directly, so a login-shell function
  # cannot shadow it.
  defp invocation(wrapper, args), do: "env -u TMUX -u TMUX_PANE #{wrapper} #{args}"

  defp flags(agent) do
    effort = Agents.effort(agent)

    instructions =
      case agent[:developer_instructions] do
        text when is_binary(text) and text != "" ->
          "-c " <> Agents.shell_escape("developer_instructions=" <> Jason.encode!(text))

        _ ->
          nil
      end

    Agents.flags(agent,
      effort: effort && "-c model_reasoning_effort=#{Agents.shell_escape(effort)}",
      instructions: instructions
    )
  end

  # The rollout's first line is a `session_meta` record naming the id, cwd
  # and start time.
  @impl true
  def find_session(work_dir, dispatched_after, opts) do
    HarnessPaths.codex_session_dirs(since: dispatched_after)
    |> Enum.flat_map(fn dir ->
      case Shuttle.FS.ls(dir) do
        {:ok, files} -> files |> Enum.sort(:desc) |> Enum.map(&Path.join(dir, &1))
        {:error, _} -> []
      end
    end)
    |> Shuttle.Harness.scan_session_files(&header/1, work_dir, dispatched_after, opts)
  end

  defp header(%{"type" => "session_meta", "payload" => payload}), do: {:ok, payload}
  defp header(_), do: :error

  @impl true
  def transcript_root(opts), do: HarnessPaths.codex_sessions_root(opts)

  @impl true
  def transcript_globs(session, opts), do: [HarnessPaths.codex_session_glob(session, opts)]

  @impl true
  def usage_entries(%{"type" => "compacted"} = record), do: [TranscriptUsage.reset(record, nil)]

  def usage_entries(%{"type" => "event_msg", "payload" => %{"type" => type} = payload} = r) do
    case {type, payload} do
      {"context_compacted", _} ->
        [TranscriptUsage.reset(r, nil)]

      {"token_count", %{"info" => %{"last_token_usage" => %{} = usage} = info}} ->
        [usage(r, usage, info)]

      _ ->
        []
    end
  end

  def usage_entries(_record), do: []

  defp usage(record, usage, info) do
    # A compaction reset reports a retained total with no measured input or output.
    reset_only? =
      usage["input_tokens"] == 0 and usage["output_tokens"] == 0 and
        (TranscriptUsage.count(usage["total_tokens"]) || 0) > 0

    %{
      kind: :usage,
      at: TranscriptUsage.time(record),
      context: if(!reset_only?, do: TranscriptUsage.count(usage["input_tokens"])),
      window: TranscriptUsage.count(info["model_context_window"]),
      cached: if(!reset_only?, do: TranscriptUsage.count(usage["cached_input_tokens"]))
    }
  end

  # The human's interrupt is an `event_msg` of type `turn_aborted`.
  @impl true
  def turn_record(%{"type" => "event_msg", "payload" => %{"type" => type} = payload} = record) do
    cond do
      type == "turn_aborted" ->
        Shuttle.InterruptWatcher.interrupted(
          "#{payload["turn_id"]}@#{record["timestamp"]}",
          record["timestamp"]
        )

      type in ["task_started", "task_complete", "user_message", "agent_message"] ->
        :other

      true ->
        nil
    end
  end

  def turn_record(_record), do: nil

  # Codex's task list is the latest `update_plan` call in the rollout, read
  # incrementally from where the previous read stopped.
  @impl true
  def tasks(session, previous, opts) do
    path = previous[:path] || Transcript.path(session, opts)
    inode = if path, do: FileTail.inode(path)
    same? = path != nil and path == previous[:path] and inode == previous[:inode]

    {lines, offset, inode, tasks} =
      if same? do
        case FileTail.advance(path, previous.offset) do
          {:append, lines, offset} -> {lines, offset, inode, previous.tasks}
          {:reset, _} -> snapshot(path)
          :noop -> {[], previous.offset, inode, previous.tasks}
        end
      else
        snapshot(path)
      end

    tasks = Enum.reduce(lines, tasks, &plan/2)
    {tasks, %{path: path, offset: offset, inode: inode, tasks: tasks}}
  end

  defp snapshot(nil), do: {[], 0, nil, []}

  defp snapshot(path) do
    {lines, offset, inode} = FileTail.snapshot(path)
    {lines, offset, inode, []}
  end

  defp plan(line, tasks) do
    with {:ok,
          %{
            "type" => "response_item",
            "payload" => %{"type" => "function_call", "name" => name, "arguments" => arguments}
          }} <- Jason.decode(line),
         true <- name in ["update_plan", "functions.update_plan"],
         {:ok, %{"plan" => steps}} when is_list(steps) <- decode_arguments(arguments),
         true <- Enum.all?(steps, &valid_step?/1) do
      steps
      |> Enum.with_index(1)
      |> Enum.map(fn {step, index} ->
        %{id: to_string(index), subject: step["step"], status: step["status"], activeForm: nil}
      end)
    else
      _ -> tasks
    end
  end

  defp decode_arguments(arguments) when is_binary(arguments), do: Jason.decode(arguments)
  defp decode_arguments(_), do: :error

  defp valid_step?(%{"step" => step, "status" => status}),
    do: is_binary(step) and status in @statuses

  defp valid_step?(_), do: false

  @impl true
  def transcript_cwd(path),
    do: Shuttle.Transcript.head_values(path, ["payload", "cwd"]) |> Enum.find(&is_binary/1)
end
