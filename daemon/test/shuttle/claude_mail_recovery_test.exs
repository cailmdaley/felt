defmodule Shuttle.ClaudeMailRecoveryTest do
  use ExUnit.Case, async: true
  alias Shuttle.{ClaudeMailRecovery, Test.Env}

  defmodule Runner do
    def run(args, opts) do
      send(Shuttle.Env.app(:mail_recovery_test_pid), {:recover, self(), args, opts})

      receive do
        {:result, result} -> result
        :crash -> exit(:staged_failure)
      end
    end
  end

  defp start(opts \\ []) do
    Env.put_app_env(:mail_recovery_test_pid, self())
    Env.start_scoped!({ClaudeMailRecovery, [name: nil, runner: Runner, sweep_ms: 60_000] ++ opts})
  end

  test "boot, queued receipts and restart recover without overlapping passes" do
    pid = start()
    assert_receive {:recover, first, ["claude-mail-recover"], [timeout_ms: 32_000]}
    for _ <- 1..5, do: ClaudeMailRecovery.queued(pid)
    :sys.get_state(pid)
    refute_receive {:recover, _, _, _}, 30
    send(first, {:result, {:ok, ~s({"pending":false})}})
    assert_receive {:recover, second, _, _}
    send(second, {:result, {:ok, ~s({"pending":false})}})
    stop_supervised!(ClaudeMailRecovery)

    start()
    assert_receive {:recover, third, _, _}
    send(third, {:result, {:ok, ~s({"pending":false})}})
  end

  test "only pending automatic mail gets fast ticks; idle recovery waits for a receipt or sweep" do
    pid = start(interval_ms: 20)
    assert_receive {:recover, first, _, _}
    send(first, {:result, {:ok, ~s({"pending":true})}})
    assert_receive {:recover, second, _, _}
    send(second, {:result, {:ok, ~s({"pending":false})}})
    refute_receive {:recover, _, _, _}, 80
    ClaudeMailRecovery.queued(pid)
    assert_receive {:recover, third, _, _}
    send(third, {:result, {:ok, ~s({"pending":false})}})
  end

  test "errors retain fast recovery for unrelated pending mail" do
    pid = start(interval_ms: 20)
    assert_receive {:recover, first, _, _}

    last =
      Enum.reduce(
        [
          {:command_error, 1, "sender unavailable"},
          {:command_error, :timeout, "expired"},
          {:error, :unavailable},
          {:ok, ~s({"pending":true,"error":"sender A unavailable, B pending"})},
          :crash
        ],
        first,
        fn result, task ->
          log =
            ExUnit.CaptureLog.capture_log(fn ->
              send(task, if(result == :crash, do: :crash, else: {:result, result}))
              assert_receive {:recover, next, _, _}
              send(self(), {:next_recovery, next})
            end)

          assert log =~ "Claude mail recovery"
          assert_receive {:next_recovery, next}
          next
        end
      )

    send(last, {:result, {:ok, ~s({"pending":false})}})
    assert eventually(fn -> :sys.get_state(pid).task == nil end)
    refute_receive {:recover, _, _, _}, 80
  end

  @tag :tmp_dir
  test "the production runner executes the real recovery CLI in a private mailbox", %{
    tmp_dir: tmp
  } do
    data = Path.join(tmp, "data")
    File.mkdir_p!(data)
    Env.put_env("SHUTTLE_DATA_DIR", data)
    Env.put_env("SHUTTLE_HOST", "mail-probe")
    Env.put_env("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
    Env.put_env("HOME", tmp)
    assert {:ok, output} = Shuttle.CLI.run(["claude-mail-recover"], timeout_ms: 32_000)
    assert %{"pending" => false} = Jason.decode!(output)

    # A live-context-only entry cannot schedule native recovery.
    dir = Path.join([data, "mailboxes", "claude", "session", "pending"])
    File.mkdir_p!(dir)

    File.write!(
      Path.join(dir, "context.json"),
      Jason.encode!(%{
        request: %{
          address: "shuttle://mail-probe/claude/session",
          text: "passive",
          message_id: "passive",
          wake: false
        },
        queued_at: System.system_time(:nanosecond)
      })
    )

    pid = Env.start_scoped!({ClaudeMailRecovery, name: nil, sweep_ms: 60_000})
    assert eventually(fn -> :sys.get_state(pid).task == nil end)
    assert File.exists?(Path.join(dir, "context.json"))
    assert :sys.get_state(pid).timer == nil
    stop_supervised!(ClaudeMailRecovery)

    # Recovery executes a real preflight, returns its unsent entry to pending,
    # and supplies the daemon with a durable follow-up signal.
    auto = Path.join(dir, "automatic.json")

    File.write!(
      auto,
      Jason.encode!(%{
        request: %{
          address: "shuttle://mail-probe/claude/session",
          text: "automatic",
          message_id: "automatic",
          context_if_busy: true,
          from: "shuttle://peer/pi/sender"
        },
        queued_at: System.system_time(:nanosecond) - 31_000_000_000
      })
    )

    assert {:ok, output} = Shuttle.CLI.run(["claude-mail-recover"], timeout_ms: 32_000)
    assert %{"pending" => true} = Jason.decode!(output)
    assert %{"fallback" => %{"attempts" => 1}} = auto |> File.read!() |> Jason.decode!()

    pid =
      Env.start_scoped!({ClaudeMailRecovery, name: nil, interval_ms: 60_000, sweep_ms: 60_000})

    assert eventually(fn ->
             state = :sys.get_state(pid)
             state.task == nil and state.timer != nil
           end)

    assert %{"fallback" => %{"attempts" => 2}} = auto |> File.read!() |> Jason.decode!()
    stop_supervised!(ClaudeMailRecovery)

    # A failed terminal notice for A must not hide the follow-up signal for B.
    other = Path.join(dir, "other.json")

    File.write!(
      other,
      auto
      |> File.read!()
      |> Jason.decode!()
      |> Map.delete("fallback")
      |> put_in(["request", "message_id"], "other")
      |> Jason.encode!()
    )

    assert {:ok, output} = Shuttle.CLI.run(["claude-mail-recover"], timeout_ms: 32_000)
    assert %{"pending" => true, "error" => error} = Jason.decode!(output)
    assert error != ""
    assert %{"fallback" => %{"attempts" => 1}} = other |> File.read!() |> Jason.decode!()
  end

  defp eventually(check, attempts \\ 1_500)
  defp eventually(_check, 0), do: false

  defp eventually(check, attempts) do
    if check.() do
      true
    else
      Process.sleep(20)
      eventually(check, attempts - 1)
    end
  end
end
