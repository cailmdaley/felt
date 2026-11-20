defmodule Shuttle.Harness.Claude do
  @moduledoc """
  Claude Code. The daemon assigns the conversation id (`--session-id`), the
  prompt arrives on stdin, and effort is `--effort`. Its transcript is one
  JSONL file per conversation under the projects root, with task lists kept
  beside it in the tasks root.
  """

  @behaviour Shuttle.Harness

  alias Shuttle.{Agents, HarnessPaths, TranscriptUsage}

  @statuses ~w(pending in_progress completed)

  @impl true
  def name, do: "claude"
  @impl true
  def ledger_name, do: "claude-code"
  @impl true
  def binary, do: "claude"
  @impl true
  def idle_signal?, do: true
  @impl true
  def interrupts?, do: true
  @impl true
  def receiver_succession?, do: true
  @impl true
  def resume_fallback, do: :fresh
  @impl true
  def identity, do: "assigned"
  @impl true
  def takes_paste?, do: false

  # Claude may be a shell function sourced by bash -l, so the wrapper runs as
  # the script's command word. The prompt goes in on stdin.
  @impl true
  def launch_command(agent, prompt, opts) do
    session_flag =
      case Keyword.get(opts, :session_id) do
        nil -> ""
        id -> "--session-id #{Agents.shell_escape(id)} "
      end

    "#{agent.wrapper} #{session_flag}#{flags(agent)} <<< #{Agents.shell_escape(prompt)}"
  end

  @impl true
  def resume_command(agent, session_id, prompt, _opts) do
    base = "#{agent.wrapper} #{flags(agent)} --resume #{Agents.shell_escape(session_id)}"
    if prompt == "", do: base, else: "#{base} <<< #{Agents.shell_escape(prompt)}"
  end

  defp flags(agent) do
    effort = Agents.effort(agent)

    Agents.flags(agent,
      headless: agent[:headless] == true,
      effort: effort && "--effort #{Agents.shell_escape(effort)}"
    )
  end

  @impl true
  def find_session(_work_dir, _dispatched_after, _opts), do: :error

  @impl true
  def transcript_root(opts), do: HarnessPaths.claude_projects_root(opts)

  @impl true
  def transcript_globs(session, opts),
    do: [Path.join(HarnessPaths.claude_projects_root(opts), "*/#{session}.jsonl")]

  @impl true
  def usage_entries(%{"isSidechain" => true}), do: []

  def usage_entries(%{"type" => "system", "subtype" => "compact_boundary"} = record),
    do: [
      TranscriptUsage.reset(
        record,
        TranscriptUsage.count(record["compactMetadata"]["postTokens"])
      )
    ]

  # A `<synthetic>` record is Claude Code's own stand-in reply; no model read a prompt for it.
  def usage_entries(%{"type" => "assistant", "message" => %{"model" => "<synthetic>"}}), do: []

  def usage_entries(%{"type" => "assistant", "message" => %{"usage" => %{} = u}} = r) do
    read = u["cache_read_input_tokens"]
    write = u["cache_creation_input_tokens"]

    [
      %{
        kind: :usage,
        at: TranscriptUsage.time(r),
        context: TranscriptUsage.sum([u["input_tokens"], read, write]),
        cached: TranscriptUsage.count(read),
        cache: %{
          read: TranscriptUsage.count(read) || 0,
          write: TranscriptUsage.count(write) || 0,
          hour_write: TranscriptUsage.count(u["cache_creation"]["ephemeral_1h_input_tokens"]) || 0
        }
      }
    ]
  end

  def usage_entries(_record), do: []

  # The human's interrupt is a user entry whose text opens
  # `[Request interrupted by user`.
  @impl true
  def turn_record(%{"isSidechain" => true}), do: nil

  def turn_record(%{"type" => "user", "message" => %{"content" => content}} = record) do
    if interrupt_text?(content) and is_binary(record["uuid"]),
      do: Shuttle.InterruptWatcher.interrupted(record["uuid"], record["timestamp"]),
      else: :other
  end

  def turn_record(%{"type" => "assistant"}), do: :other
  def turn_record(_record), do: nil

  defp interrupt_text?(content) when is_binary(content),
    do: String.starts_with?(content, "[Request interrupted by user")

  defp interrupt_text?([%{"type" => "text", "text" => text} | _]), do: interrupt_text?(text)
  defp interrupt_text?(_content), do: false

  # Claude Code keeps a conversation's task list as one JSON file per task.
  @impl true
  def tasks(session, _previous, opts) do
    tasks =
      Path.join([HarnessPaths.claude_tasks_root(opts), session, "*.json"])
      |> Shuttle.FS.wildcard()
      |> Enum.flat_map(fn path ->
        with {:ok, bytes} <- Shuttle.FS.read(path),
             {:ok, %{"id" => id, "subject" => subject, "status" => status} = task} <-
               Jason.decode(bytes),
             true <- is_binary(id) and is_binary(subject) and status in @statuses do
          [
            %{
              id: id,
              subject: subject,
              status: status,
              activeForm: active_form(task["activeForm"])
            }
          ]
        else
          _ -> []
        end
      end)
      |> Enum.uniq_by(& &1.id)
      |> Enum.sort_by(&order(&1.id))

    {tasks, %{}}
  end

  defp active_form(text) when is_binary(text), do: text
  defp active_form(_), do: nil

  defp order(id) do
    case Integer.parse(id) do
      {n, ""} -> {0, n, id}
      _ -> {1, 0, id}
    end
  end

  # The first cwd whose project-directory name is the transcript's own: a
  # conversation that changed directory records others later.
  @impl true
  def transcript_cwd(path) do
    slug = path |> Path.dirname() |> Path.basename()

    Shuttle.Transcript.head_values(path, ["cwd"])
    |> Enum.find(fn cwd -> is_binary(cwd) and slug(cwd) == slug end)
  end

  @doc "Claude Code's project-directory name for a working directory."
  def slug(cwd), do: String.replace(cwd, ~r/[^A-Za-z0-9]/, "-")
end
