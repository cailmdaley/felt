defmodule Shuttle.Harness.Pi do
  @moduledoc """
  Pi. Its conversation id is reported after launch, by the session file it
  writes in the working directory's folder under the sessions root; the
  prompt is an argument and effort a `:level` suffix on the model. Pi's hooks
  name no idle turn and its transcript no interrupt.
  """

  @behaviour Shuttle.Harness

  alias Shuttle.{Agents, HarnessPaths, TranscriptUsage}

  @impl true
  def name, do: "pi"
  @impl true
  def ledger_name, do: "pi"
  @impl true
  def binary, do: "pi"
  @impl true
  def idle_signal?, do: false
  @impl true
  def interrupts?, do: false
  @impl true
  def receiver_succession?, do: true
  @impl true
  def resume_fallback, do: :recapture
  @impl true
  def identity, do: "reported"
  @impl true
  def takes_paste?, do: false

  # Never stdin: piped stdin switches pi from interactive to print mode, so the
  # prompt is the positional `[messages...]` argument.
  @impl true
  def launch_command(agent, prompt, _opts),
    do: "#{agent.wrapper} #{flags(agent)} #{Agents.shell_escape(prompt)}"

  # A UUID prefix is enough for `--session`.
  @impl true
  def resume_command(agent, session_id, prompt, _opts) do
    base = "#{agent.wrapper} #{flags(agent)} --session #{Agents.shell_escape(session_id)}"
    if prompt == "", do: base, else: "#{base} #{Agents.shell_escape(prompt)}"
  end

  defp flags(agent) do
    model =
      case {agent.model, Agents.effort(agent)} do
        {model, effort} when is_binary(model) and is_binary(effort) -> "#{model}:#{effort}"
        {model, _} -> model
      end

    Agents.flags(agent, model: model)
  end

  # Candidates are sorted newest first by their ISO-stamped basenames; the
  # first line is a `session` header naming the id, cwd and start time.
  @impl true
  def find_session(work_dir, dispatched_after, opts) do
    dir = HarnessPaths.pi_sessions_dir(work_dir)

    case Shuttle.FS.ls(dir) do
      {:ok, files} -> files |> Enum.sort(:desc) |> Enum.map(&Path.join(dir, &1))
      {:error, _} -> []
    end
    |> Shuttle.Harness.scan_session_files(&header/1, work_dir, dispatched_after, opts)
  end

  defp header(%{"type" => "session"} = event), do: {:ok, event}
  defp header(_), do: :error

  @impl true
  def transcript_root(opts), do: HarnessPaths.pi_sessions_root(opts)

  @impl true
  def transcript_globs(session, opts),
    do: [Path.join(HarnessPaths.pi_sessions_root(opts), "*/*#{session}.jsonl")]

  @impl true
  def usage_entries(%{"type" => type} = record) when type in ["compaction", "context_edit"],
    do: [TranscriptUsage.reset(record, nil)]

  def usage_entries(%{"type" => "message", "message" => %{"role" => "assistant"} = message} = r) do
    case message do
      %{"stopReason" => reason} when reason in ["error", "aborted"] ->
        []

      %{"usage" => %{} = u} ->
        context = TranscriptUsage.sum([u["input"], u["cacheRead"], u["cacheWrite"]])

        [
          %{
            kind: :usage,
            at: TranscriptUsage.time(r),
            context: context,
            cached: TranscriptUsage.count(u["cacheRead"])
          }
        ]

      _ ->
        []
    end
  end

  def usage_entries(_record), do: []

  @impl true
  def turn_record(_record), do: nil

  @impl true
  def tasks(_session, _previous, _opts), do: {[], %{}}

  @impl true
  def transcript_cwd(path),
    do: Shuttle.Transcript.head_values(path, ["cwd"]) |> Enum.find(&is_binary/1)
end
