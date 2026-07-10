defmodule Shuttle.ContinuationTest do
  # async: false — the writer tests share a named recording Agent.
  use ExUnit.Case, async: false

  alias Shuttle.Continuation

  # Records every felt invocation, returns success — lets us assert the daemon
  # shells the right `felt shuttle mark-runtime` command without running felt.
  defmodule RecordingRunner do
    @behaviour Shuttle.Runner

    def start do
      case Agent.start_link(fn -> [] end, name: __MODULE__) do
        {:ok, pid} -> {:ok, pid}
        {:error, {:already_started, pid}} -> Agent.update(pid, fn _ -> [] end) && {:ok, pid}
      end
    end

    @impl true
    def cmd(command, args, opts) do
      Agent.update(__MODULE__, &(&1 ++ [{command, args, opts}]))
      {"", 0}
    end

    def calls, do: Agent.get(__MODULE__, & &1)
  end

  # Non-zero exit — proves the writers are best-effort (return {:error,_}, no raise).
  defmodule FailingRunner do
    @behaviour Shuttle.Runner
    @impl true
    def cmd(_command, _args, _opts), do: {"boom", 1}
  end

  describe "nested-only readers (C5 — the flat fallback is retired)" do
    test "reads the nested runtime block, ignoring flat legacy siblings entirely" do
      fiber = %{
        "shuttle" => %{
          "kind" => "oneshot",
          "dispatched_at" => "2026-01-01T00:00:00Z",
          "session_uuid" => "flat-uuid",
          "runtime" => %{
            "dispatched_at" => "2026-06-21T12:00:00Z",
            "session_uuid" => "nested-uuid"
          }
        }
      }

      assert Continuation.dispatched_at(fiber) == ~U[2026-06-21 12:00:00Z]
      assert Continuation.resumable_session_id(fiber) == "nested-uuid"
    end

    test "does NOT fall back to a flat key when its nested counterpart is absent" do
      fiber = %{
        "shuttle" => %{
          "dispatched_at" => "2026-01-01T00:00:00Z",
          "handed_off_at" => "2026-01-02T00:00:00Z",
          "runtime" => %{"session_uuid" => "nested-uuid"}
        }
      }

      refute Continuation.dispatched_at(fiber)
      refute Continuation.handed_off_at(fiber)
      assert Continuation.resumable_session_id(fiber) == "nested-uuid"
    end

    test "an un-migrated fiber (flat keys, no runtime sub-map at all) reads as having no continuation state" do
      fiber = %{
        "shuttle" => %{"dispatched_at" => "2026-01-01T00:00:00Z", "session_uuid" => "flat"}
      }

      refute Continuation.dispatched_at(fiber)
      refute Continuation.resumable_session_id(fiber)
    end

    test "tolerates a degenerate (non-map) runtime value, reading as absent rather than falling back to flat" do
      fiber = %{"shuttle" => %{"dispatched_at" => "2026-01-01T00:00:00Z", "runtime" => "oops"}}
      refute Continuation.dispatched_at(fiber)
    end

    test "clean_handoff?: a nested dispatch with only a FLAT handoff reads as no handoff → resume" do
      # C5: the flat handed_off_at is invisible now (no fallback) — a nested
      # dispatched_at with nothing nested under handed_off_at reads as "never
      # handed off since this dispatch", same conclusion as before the
      # fallback was retired, but for the right reason now (absent, not
      # shadowed-because-flat).
      fiber = %{
        "shuttle" => %{
          "handed_off_at" => "2026-01-02T00:00:00Z",
          "runtime" => %{"dispatched_at" => "2026-06-21T12:00:00Z"}
        }
      }

      refute Continuation.clean_handoff_since_dispatch?(fiber)
    end

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

  describe "write_dispatch / mark_handed_off shell `felt shuttle mark-runtime`" do
    setup do
      {:ok, _} = RecordingRunner.start()
      :ok
    end

    test "write_dispatch passes --dispatched-at/--session/--run-id and cd: store" do
      :ok =
        Continuation.write_dispatch(RecordingRunner, "/loom", "demo/task", %{
          session_uuid: "uuid-1",
          run_id: "RUN-1",
          dispatched_at: "2026-06-21T12:00:00Z"
        })

      assert [{"felt", args, opts}] = RecordingRunner.calls()
      assert ["shuttle", "mark-runtime", "demo/task" | rest] = args
      assert "--dispatched-at" in rest and "2026-06-21T12:00:00Z" in rest
      assert "--session" in rest and "uuid-1" in rest
      assert "--run-id" in rest and "RUN-1" in rest
      assert Keyword.get(opts, :cd) == "/loom"
    end

    test "write_dispatch omits --session/--run-id when empty but still stamps --dispatched-at" do
      :ok =
        Continuation.write_dispatch(RecordingRunner, "/loom", "demo/task", %{session_uuid: nil})

      assert [{"felt", args, _}] = RecordingRunner.calls()
      refute "--session" in args
      refute "--run-id" in args
      assert "--dispatched-at" in args
    end

    test "mark_handed_off passes --handed-off-at (no --host override — C1)" do
      :ok = Continuation.mark_handed_off(RecordingRunner, "/loom", "demo/task")

      assert [{"felt", args, _}] = RecordingRunner.calls()
      assert ["shuttle", "mark-runtime", "demo/task" | rest] = args
      assert "--handed-off-at" in rest
      # Post-S1/C1, felt's own resolveOwnHost is pure local state, so the
      # daemon no longer hands it an explicit --host override.
      refute "--host" in rest
    end

    test "a missing store or fiber_id is a no-op (reads as a fresh dispatch)" do
      assert Continuation.write_dispatch(RecordingRunner, "", "demo/task", %{}) == :ok
      assert Continuation.write_dispatch(RecordingRunner, "/loom", "", %{}) == :ok
      assert Continuation.mark_handed_off(RecordingRunner, "", "x") == :ok
      assert RecordingRunner.calls() == []
    end
  end

  test "write_dispatch is best-effort: a non-zero felt exit returns {:error,_}, never raises" do
    assert {:error, _} = Continuation.write_dispatch(FailingRunner, "/loom", "demo/task", %{})
  end
end
