defmodule Shuttle.ClaudeMailRecoveryTest do
  use ExUnit.Case, async: true
  alias Shuttle.{ClaudeMailRecovery, Test.Env}

  defmodule Runner do
    def run(args, opts) do
      send(Shuttle.Env.app(:mail_recovery_test_pid), {:recover, self(), args, opts})

      receive do
        :complete -> {:ok, ""}
        {:result, result} -> result
      end
    end
  end

  test "boot and restart recover from disk, and one observation cannot delay another wake" do
    Env.put_app_env(:mail_recovery_test_pid, self())

    pid =
      Env.start_scoped!({ClaudeMailRecovery, name: nil, runner: Runner, interval_ms: 60_000})

    assert_receive {:recover, first, ["claude-mail-recover"], [timeout_ms: 32_000]}
    send(pid, :recover)
    assert_receive {:recover, second, ["claude-mail-recover"], _}
    refute first == second
    send(first, :complete)
    send(second, :complete)
    stop_supervised!(ClaudeMailRecovery)

    Env.start_scoped!({ClaudeMailRecovery, name: nil, runner: Runner, interval_ms: 60_000})

    assert_receive {:recover, third, ["claude-mail-recover"], _}
    send(third, :complete)
  end

  test "command failures and timeouts finish normally and leave subsequent ticks usable" do
    Env.put_app_env(:mail_recovery_test_pid, self())
    pid = Env.start_scoped!({ClaudeMailRecovery, name: nil, runner: Runner, interval_ms: 60_000})

    for result <- [
          {:command_error, 1, "preflight unavailable"},
          {:command_error, :timeout, "expired"},
          {:error, :unavailable}
        ] do
      assert_receive {:recover, task, ["claude-mail-recover"], _}
      ref = Process.monitor(task)

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          send(task, {:result, result})
          assert_receive {:DOWN, ^ref, :process, ^task, :normal}
        end)

      assert log =~ "Claude mail recovery"
      send(pid, :recover)
    end

    assert_receive {:recover, task, _, _}
    send(task, :complete)
  end

  test "production recovery ticks every second" do
    Env.put_app_env(:mail_recovery_test_pid, self())
    pid = Env.start_scoped!({ClaudeMailRecovery, name: nil, runner: Runner})
    assert_receive {:recover, first, _, _}
    assert :sys.get_state(pid).interval_ms == 1_000
    send(first, :complete)
  end
end
