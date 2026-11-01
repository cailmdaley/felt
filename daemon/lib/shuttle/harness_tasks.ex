defmodule Shuttle.HarnessTasks do
  @moduledoc "Harness-owned checklists and incremental Codex plan reads for the live worker projection."

  alias Shuttle.{FileTail, HarnessPaths, Transcript}
  @statuses ~w(pending in_progress completed)

  @doc "Read one conversation, returning its ordered tasks and the next transcript cursor."
  def read(cli, session, previous \\ %{}, opts \\ []) do
    if Transcript.valid_session?(session) do
      case cli do
        cli when cli in ["claude", "claude-code"] -> {claude(session, opts), %{}}
        "codex" -> codex(session, previous, opts)
        _ -> {[], %{}}
      end
    else
      {[], %{}}
    end
  end

  defp claude(session, opts) do
    Path.join([HarnessPaths.claude_tasks_root(opts), session, "*.json"])
    |> Path.wildcard()
    |> Enum.flat_map(fn path ->
      with {:ok, bytes} <- File.read(path),
           {:ok, %{"id" => id, "subject" => subject, "status" => status} = task} <-
             Jason.decode(bytes),
           true <- is_binary(id) and is_binary(subject) and status in @statuses do
        [%{id: id, subject: subject, status: status, activeForm: active_form(task["activeForm"])}]
      else
        _ -> []
      end
    end)
    |> Enum.uniq_by(& &1.id)
    |> Enum.sort_by(&order(&1.id))
  end

  defp active_form(text) when is_binary(text), do: text
  defp active_form(_), do: nil

  defp order(id) do
    case Integer.parse(id) do
      {n, ""} -> {0, n, id}
      _ -> {1, 0, id}
    end
  end

  defp codex(session, previous, opts) do
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
end
