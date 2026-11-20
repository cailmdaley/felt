defmodule Shuttle.Harness.Antigravity do
  @moduledoc """
  Google's Antigravity CLI (`agy`). Its conversation id is reported after
  launch, by the SessionStart hook its felt plugin turns into a `session_start`
  line on the event stream (`shuttle hook antigravity`); agy cannot be handed
  an id. The prompt is `-i`'s argument, effort is the model slug's suffix
  (`gemini-4-neon-high`), and `--settings` answers the first-run questions for
  this session only. It reads `AGENTS.md`/`GEMINI.md`, not `CLAUDE.md`.
  """

  @behaviour Shuttle.Harness

  alias Shuttle.{Agents, EventStream, FileTail, HarnessPaths, TranscriptUsage}

  # The stream tail read for a conversation's session start.
  @events_tail_bytes 4_194_304

  @impl true
  def name, do: "antigravity"
  @impl true
  def ledger_name, do: "antigravity"
  @impl true
  def binary, do: "agy"
  @impl true
  def idle_signal?, do: true
  @impl true
  def interrupts?, do: false
  # A resumed conversation keeps its id in a new process and fires no
  # SessionStart, so its events join by id alone, as Codex's do.
  @impl true
  def receiver_succession?, do: false
  @impl true
  def resume_fallback, do: :none
  @impl true
  def identity, do: "reported"
  @impl true
  def takes_paste?, do: true
  @impl true
  def resume_args(session), do: ["--conversation", session]

  @impl true
  def launch_command(agent, prompt, opts),
    do: "#{agent.wrapper} #{flags(agent, opts)} -i #{Agents.shell_escape(prompt)}"

  @impl true
  def resume_command(agent, session_id, prompt, opts) do
    base =
      "#{agent.wrapper} #{flags(agent, opts)} --conversation #{Agents.shell_escape(session_id)}"

    if prompt == "", do: base, else: "#{base} -i #{Agents.shell_escape(prompt)}"
  end

  defp flags(agent, opts) do
    model =
      case {agent.model, Agents.effort(agent)} do
        {model, effort} when is_binary(model) and is_binary(effort) -> "#{model}-#{effort}"
        {model, _} -> model
      end

    "#{Agents.flags(agent, model: model)} --settings #{Agents.shell_escape(Jason.encode!(settings(opts)))}"
  end

  # Per-session settings, never written to agy's own settings file: no
  # alternate screen (the terminal backend keeps scrollback), the working
  # directory trusted, and artifacts never held for review.
  defp settings(opts) do
    trusted = for dir <- [Keyword.get(opts, :work_dir)], is_binary(dir), do: dir

    Jason.OrderedObject.new([
      {"altScreenMode", "never"},
      {"trustedWorkspaces", trusted},
      {"artifactReviewPolicy", "always-proceed"}
    ])
  end

  # The newest `session_start` this harness reported in `work_dir` since the
  # dispatch, whose conversation carries the dispatch prompt's fiber line.
  @impl true
  def find_session(work_dir, dispatched_after, opts) do
    since = DateTime.to_unix(dispatched_after, :millisecond) - 5_000
    fiber_id = Keyword.fetch!(opts, :fiber_id)

    session_starts()
    |> Enum.find_value(:error, fn
      %{"sessionId" => id, "cwd" => cwd, "timestamp" => at}
      when is_binary(id) and is_binary(cwd) and is_integer(at) and at >= since ->
        if Shuttle.Harness.same_directory?(cwd, work_dir) and mentions?(id, fiber_id),
          do: {:ok, id}

      _ ->
        nil
    end)
  end

  # This harness's session starts on the event stream, newest first: the live
  # file's tail, then (read only when the caller gets that far) the rotated
  # file's. Only lines naming a session start are decoded.
  defp session_starts do
    live = EventStream.default_events_file()

    [live, EventStream.rotated(live)]
    |> Stream.flat_map(fn path ->
      {lines, _whole?} = FileTail.last_lines(path, @events_tail_bytes)
      Enum.reverse(lines)
    end)
    |> Stream.filter(&String.contains?(&1, "session_start"))
    |> Stream.map(&EventStream.decode/1)
    |> Stream.filter(&match?(%{"type" => "session_start", "harness" => "antigravity"}, &1))
  end

  defp mentions?(id, fiber_id) do
    Enum.any?(transcript_globs(id, []), fn pattern ->
      pattern
      |> Shuttle.FS.wildcard()
      |> Enum.any?(fn path ->
        case Shuttle.FS.read(path) do
          {:ok, content} -> Shuttle.Harness.names_fiber?(content, fiber_id)
          _ -> false
        end
      end)
    end)
  end

  @impl true
  def transcript_root(opts), do: HarnessPaths.antigravity_brain_root(opts)

  # The untruncated transcript first, the truncated copy when it stands alone.
  @impl true
  def transcript_globs(session, opts) do
    logs =
      Path.join([HarnessPaths.antigravity_brain_root(opts), session, ".system_generated", "logs"])

    [Path.join(logs, "transcript_full.jsonl"), Path.join(logs, "transcript.jsonl")]
  end

  # A model step counts its fresh input and its cache reads apart.
  @impl true
  def usage_entries(
        %{"source" => "MODEL", "type" => "PLANNER_RESPONSE", "input_tokens" => input} = step
      ) do
    read = step["cache_read_tokens"]

    [
      %{
        kind: :usage,
        at: TranscriptUsage.time(%{"timestamp" => step["created_at"]}),
        context: TranscriptUsage.sum([input, read || 0]),
        cached: TranscriptUsage.count(read)
      }
    ]
  end

  def usage_entries(_step), do: []

  @impl true
  def turn_record(_step), do: nil

  @impl true
  def tasks(_session, _previous, _opts), do: {[], %{}}

  # The transcript records no working directory; the conversation's session
  # start on the event stream does.
  @impl true
  def transcript_cwd(path) do
    id = path |> Path.dirname() |> Path.dirname() |> Path.dirname() |> Path.basename()

    Enum.find_value(session_starts(), fn
      %{"sessionId" => ^id, "cwd" => cwd} when is_binary(cwd) and cwd != "" -> cwd
      _ -> nil
    end)
  end
end
