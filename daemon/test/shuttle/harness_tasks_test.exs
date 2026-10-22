defmodule Shuttle.HarnessTasksTest do
  use ExUnit.Case, async: true
  alias Shuttle.HarnessTasks
  @moduletag :tmp_dir
  @session "aabbccdd-0000-4000-8000-000000000001"

  test "Claude reads real task files, orders numeric ids and tolerates missing or malformed records",
       %{tmp_dir: root} do
    opts = [tasks_root: root]
    assert {[], %{}} = HarnessTasks.read("claude", @session, %{}, opts)
    dir = Path.join(root, @session)
    File.mkdir_p!(dir)

    for {id, status} <- [{"10", "completed"}, {"2", "in_progress"}, {"1", "pending"}] do
      File.write!(
        Path.join(dir, id <> ".json"),
        Jason.encode!(%{
          id: id,
          subject: "Task #{id}",
          description: "detail",
          activeForm: "Doing #{id}",
          status: status,
          blocks: [],
          blockedBy: []
        })
      )
    end

    File.write!(Path.join(dir, "broken.json"), "{")
    File.write!(Path.join(dir, "not-a-task.json"), "[]")

    File.write!(
      Path.join(dir, "deleted.json"),
      Jason.encode!(%{id: "3", subject: "Gone", status: "deleted"})
    )

    assert {[
              %{id: "1", subject: "Task 1", status: "pending", activeForm: "Doing 1"},
              %{id: "2", subject: "Task 2", status: "in_progress", activeForm: "Doing 2"},
              %{id: "10", subject: "Task 10", status: "completed", activeForm: "Doing 10"}
            ], %{}} = HarnessTasks.read("claude", @session, %{}, opts)

    File.rm!(Path.join(dir, "2.json"))
    {tasks, _} = HarnessTasks.read("claude", @session, %{}, opts)
    assert Enum.map(tasks, & &1.id) == ["1", "10"]
    assert {[], %{}} = HarnessTasks.read("claude", "../escape", %{}, opts)
    assert {[], %{}} = HarnessTasks.read("pi", @session, %{}, opts)
  end

  test "Codex follows complete transcript lines and projects only the latest valid plan", %{
    tmp_dir: root
  } do
    opts = [codex_root: root, root: Path.join(root, "claude"), pi_root: Path.join(root, "pi")]
    assert {[], missing} = HarnessTasks.read("codex", @session, %{}, opts)
    path = Path.join(root, "2026/01/01/rollout-session-#{@session}.jsonl")
    File.mkdir_p!(Path.dirname(path))

    File.write!(
      path,
      plan([{"First", "pending"}]) <> plan([{"Latest", "in_progress"}, {"Verify", "pending"}])
    )

    assert {[
              %{id: "1", subject: "Latest", status: "in_progress", activeForm: nil},
              %{id: "2", subject: "Verify", status: "pending"}
            ], cursor} = HarnessTasks.read("codex", @session, missing, opts)

    assert {_same, ^cursor} = HarnessTasks.read("codex", @session, cursor, opts)

    File.write!(
      path,
      ("{bad}\n" <> plan([{"Complete", "completed"}])) |> String.trim_trailing("\n"),
      [:append]
    )

    assert {[%{subject: "Latest"}, %{subject: "Verify"}], partial} =
             HarnessTasks.read("codex", @session, cursor, opts)

    File.write!(path, "\n", [:append])

    assert {[%{subject: "Complete", status: "completed"}], complete} =
             HarnessTasks.read("codex", @session, partial, opts)

    File.write!(path, plan([]), [:append])
    assert {[], cleared} = HarnessTasks.read("codex", @session, complete, opts)
    # Replacing the rollout discards its cursor even when the replacement grows.
    File.rename!(path, path <> ".old")
    File.write!(path, plan([{"Replaced", "pending"}]))

    assert {[%{subject: "Replaced"}], replaced} =
             HarnessTasks.read("codex", @session, cleared, opts)

    File.write!(path, "")
    assert {[], truncated} = HarnessTasks.read("codex", @session, replaced, opts)
    File.rm!(path)
    assert {[], _} = HarnessTasks.read("codex", @session, truncated, opts)
  end

  defp plan(steps) do
    arguments =
      Jason.encode!(%{
        plan: Enum.map(steps, fn {step, status} -> %{step: step, status: status} end)
      })

    Jason.encode!(%{
      type: "response_item",
      payload: %{type: "function_call", name: "update_plan", arguments: arguments}
    }) <> "\n"
  end
end
