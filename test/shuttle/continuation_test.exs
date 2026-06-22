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

  describe "nested-OR-flat readers" do
    test "nested runtime wins over the flat legacy keys" do
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

    test "falls back to a flat key when its nested counterpart is absent" do
      fiber = %{
        "shuttle" => %{
          "dispatched_at" => "2026-01-01T00:00:00Z",
          "handed_off_at" => "2026-01-02T00:00:00Z",
          "runtime" => %{"session_uuid" => "nested-uuid"}
        }
      }

      assert Continuation.dispatched_at(fiber) == ~U[2026-01-01 00:00:00Z]
      assert Continuation.handed_off_at(fiber) == ~U[2026-01-02 00:00:00Z]
      assert Continuation.resumable_session_id(fiber) == "nested-uuid"
    end

    test "reads flat keys when there is no runtime sub-map (un-migrated fiber)" do
      fiber = %{
        "shuttle" => %{"dispatched_at" => "2026-01-01T00:00:00Z", "session_uuid" => "flat"}
      }

      assert Continuation.dispatched_at(fiber) == ~U[2026-01-01 00:00:00Z]
      assert Continuation.resumable_session_id(fiber) == "flat"
    end

    test "tolerates a degenerate (non-map) runtime value, falling back to flat" do
      fiber = %{"shuttle" => %{"dispatched_at" => "2026-01-01T00:00:00Z", "runtime" => "oops"}}
      assert Continuation.dispatched_at(fiber) == ~U[2026-01-01 00:00:00Z]
    end

    test "clean_handoff?: a fresh NESTED dispatch shadows a stale FLAT handoff → resume" do
      # The mixed-on-disk transition state: a redispatch wrote nested
      # dispatched_at; the prior run's flat handed_off_at is older → not clean.
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

    test "mark_handed_off passes --handed-off-at and --host (no re-entrant resolution)" do
      :ok = Continuation.mark_handed_off(RecordingRunner, "/loom", "demo/task")

      assert [{"felt", args, _}] = RecordingRunner.calls()
      assert ["shuttle", "mark-runtime", "demo/task" | rest] = args
      assert "--handed-off-at" in rest
      # --host carries this daemon's authoritative own_host_id so felt's ownership
      # guard never calls back to /api/v1/state (the re-entrancy blocker).
      assert "--host" in rest
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
