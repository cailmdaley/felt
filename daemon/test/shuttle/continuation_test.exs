defmodule Shuttle.ContinuationTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Shuttle.Continuation

  alias Shuttle.Test.RecordingRunner

  # Non-zero exit — proves the writers are best-effort (return {:error,_}, no raise).
  defmodule FailingRunner do
    @behaviour Shuttle.Runner
    @impl true
    def cmd(_command, _args, _opts), do: {"boom", 1}
  end

  describe "transcript warmth" do
    @session "0883ade1-08e0-4457-94c6-7ac12137eb0f"

    test "transcript_stat resolves the harness file and reads its mtime" do
      root = Path.join(System.tmp_dir!(), "continuation-#{System.unique_integer([:positive])}")
      on_exit(fn -> File.rm_rf!(root) end)
      path = Path.join([root, "-proj", "#{@session}.jsonl"])
      File.mkdir_p!(Path.dirname(path))
      File.write!(path, "{}\n")
      File.touch!(path, 1_700_000_000)

      assert %{path: ^path, mtime: ~U[2023-11-14 22:13:20Z]} =
               Continuation.transcript_stat(@session, root: root, pi_root: root, codex_root: root)

      assert Continuation.transcript_stat(
               "11111111-2222-3333-4444-555555555555",
               root: root,
               pi_root: root,
               codex_root: root
             ) == nil
    end

    test "warm? compares the transcript's age to the window" do
      now = ~U[2026-06-20 19:00:00Z]
      t = fn age -> %{path: "/t", mtime: DateTime.add(now, -age, :second)} end

      assert Continuation.warm?(t.(0), now, 60)
      assert Continuation.warm?(t.(60), now, 60)
      refute Continuation.warm?(t.(61), now, 60)
      refute Continuation.warm?(nil, now, 60)
      assert Continuation.warm_window_s() == 45 * 60
    end
  end

  describe "nested-only readers" do
    @timestamps ["2026-01-01T00:00:00Z", "2026-06-21T12:00:00Z", "2026-06-21T13:00:00Z"]

    defp runtime_keys do
      optional_map(%{
        "dispatched_at" => member_of(@timestamps),
        "handed_off_at" => member_of(@timestamps),
        "session_uuid" => member_of(["flat-uuid", "nested-uuid", ""]),
        "run_id" => member_of(["adhoc-1", "2026-06-21T12:00", ""])
      })
    end

    # Every runtime reader consults `shuttle.runtime` alone: the same keys flat
    # on the `shuttle:` block never supply, shadow or complete a value, and a
    # missing or non-map `runtime` reads as no continuation state at all.
    property "readers see only the nested runtime map, never its flat siblings" do
      check all(
              flat <- runtime_keys(),
              runtime <- one_of([constant(:absent), member_of(["oops", nil, 42]), runtime_keys()]),
              max_runs: 100
            ) do
        nested_only = if is_map(runtime), do: runtime, else: %{}
        block = if runtime == :absent, do: flat, else: Map.put(flat, "runtime", runtime)
        fiber = %{"shuttle" => Map.put(block, "kind", "oneshot")}
        without_flat = %{"shuttle" => %{"runtime" => nested_only}}
        row = "flat #{inspect(flat)}, runtime #{inspect(runtime)}"

        assert Continuation.dispatched_at(fiber) == timestamp(nested_only["dispatched_at"]), row
        assert Continuation.handed_off_at(fiber) == timestamp(nested_only["handed_off_at"]), row

        assert Continuation.resumable_session_id(fiber) == present(nested_only["session_uuid"]),
               row

        assert Continuation.run_id(fiber) == present(nested_only["run_id"]), row

        assert Continuation.clean_handoff_since_dispatch?(fiber) ==
                 Continuation.clean_handoff_since_dispatch?(without_flat),
               row

        assert Continuation.deliberate_handoff_since_dispatch?(fiber) ==
                 Continuation.deliberate_handoff_since_dispatch?(without_flat),
               row
      end
    end

    defp timestamp(nil), do: nil

    defp timestamp(iso) do
      {:ok, dt, 0} = DateTime.from_iso8601(iso)
      dt
    end

    defp present(value) when value in [nil, ""], do: nil
    defp present(value), do: value

    test "clean_handoff?: nested handoff >= nested dispatch → fresh" do
      fiber = %{
        "shuttle" => %{
          "runtime" => %{
            "dispatched_at" => "2026-06-21T12:00:00Z",
            "handed_off_at" => "2026-06-21T13:00:00Z"
          }
        }
      }

      assert Continuation.clean_handoff_since_dispatch?(fiber)
    end

    test "deliberate_handoff?: absent dispatched_at is NOT deliberate (strict default inverts)" do
      # The strict sibling exists precisely because the two decisions want
      # opposite defaults on missing markers: resume-vs-fresh defaults fresh
      # (clean_handoff? → true), dispatch-vs-don't defaults don't (this → false).
      fiber = %{"shuttle" => %{}}
      assert Continuation.clean_handoff_since_dispatch?(fiber)
      refute Continuation.deliberate_handoff_since_dispatch?(fiber)
    end

    test "deliberate_handoff?: dispatch with no handoff → false; handoff >= dispatch → true" do
      dirty = %{"shuttle" => %{"runtime" => %{"dispatched_at" => "2026-06-21T12:00:00Z"}}}
      refute Continuation.deliberate_handoff_since_dispatch?(dirty)

      handed = %{
        "shuttle" => %{
          "runtime" => %{
            "dispatched_at" => "2026-06-21T12:00:00Z",
            "handed_off_at" => "2026-06-21T13:00:00Z"
          }
        }
      }

      assert Continuation.deliberate_handoff_since_dispatch?(handed)
    end
  end

  describe "write_dispatch / mark_handed_off shell `shuttle mark-runtime`" do
    setup do
      {:ok, _} = RecordingRunner.start()
      :ok
    end

    test "write_dispatch passes --dispatched-at/--session/--run-id with -C store" do
      :ok =
        Continuation.write_dispatch(RecordingRunner, "/loom", "demo/task", %{
          session_uuid: "uuid-1",
          run_id: "RUN-1",
          dispatched_at: "2026-06-21T12:00:00Z"
        })

      assert [{"shuttle", args, opts}] = RecordingRunner.calls()
      assert ["-C", "/loom", "mark-runtime", "demo/task" | rest] = args
      assert "--dispatched-at" in rest and "2026-06-21T12:00:00Z" in rest
      assert "--session" in rest and "uuid-1" in rest
      assert "--run-id" in rest and "RUN-1" in rest
      refute Keyword.has_key?(opts, :cd)
    end

    test "write_dispatch omits --session/--run-id when empty but still stamps --dispatched-at" do
      :ok =
        Continuation.write_dispatch(RecordingRunner, "/loom", "demo/task", %{session_uuid: nil})

      assert [{"shuttle", args, _}] = RecordingRunner.calls()
      refute "--session" in args
      refute "--run-id" in args
      assert "--dispatched-at" in args
    end

    test "mark_handed_off passes --handed-off-at without a --host override" do
      :ok = Continuation.mark_handed_off(RecordingRunner, "/loom", "demo/task")

      assert [{"shuttle", args, _}] = RecordingRunner.calls()
      assert ["-C", "/loom", "mark-runtime", "demo/task" | rest] = args
      assert "--handed-off-at" in rest
      # Shuttle resolves its own host from local state, so the daemon does not
      # pass an explicit --host override.
      refute "--host" in rest
    end

    test "a missing store or fiber_id is a no-op (reads as a fresh dispatch)" do
      assert Continuation.write_dispatch(RecordingRunner, "", "demo/task", %{}) == :ok
      assert Continuation.write_dispatch(RecordingRunner, "/loom", "", %{}) == :ok
      assert Continuation.mark_handed_off(RecordingRunner, "", "x") == :ok
      assert RecordingRunner.calls() == []
    end
  end

  test "write_dispatch is best-effort: a non-zero Shuttle exit returns {:error,_}, never raises" do
    assert {:error, _} = Continuation.write_dispatch(FailingRunner, "/loom", "demo/task", %{})
  end
end
