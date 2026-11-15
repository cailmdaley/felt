defmodule Shuttle.MessagingRecordedTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.PollerHelpers
  alias Shuttle.Test.{Env, FeltStoreRunner}

  defmodule Runner do
    def cmd("shuttle", ["message", "--local", "--json", "--request-json", "--recorded"], opts) do
      request = Jason.decode!(opts[:input])
      send(Shuttle.Env.app(:recorded_test_pid), {:transport, request})

      {Jason.encode!(%{
         message_id: request["message_id"],
         address: request["address"],
         status: "submitted",
         transport: "codex-terminal"
       }), 0}
    end

    def cmd(command, args, opts), do: FeltStoreRunner.cmd(command, args, opts)
  end

  test "recorded pulse transport resolves local to the frozen host and bypasses receipts" do
    FeltStoreRunner.start!()

    {:ok, poller} =
      start_poller!(
        runner: FeltStoreRunner,
        felt_stores: [FeltStoreRunner.felt_root()],
        poll_interval_ms: 60_000
      )

    await_boot_cycle!(poller)
    Env.put_app_env(:felt_runner, Runner)
    Env.put_app_env(:recorded_test_pid, self())
    host = Shuttle.Poller.own_host_id()

    assert {:ok, 200, %{"status" => "submitted"}} =
             Shuttle.Messaging.send_recorded(%{
               "address" => "shuttle://local/codex/session",
               "message_id" => "pulse-reserved-tick",
               "text" => "tick",
               "from" => "shuttle",
               "wake" => true,
               "idle_only" => true
             })

    assert_receive {:transport, %{"address" => address, "idle_only" => true}}
    assert address == "shuttle://#{host}/codex/session"
  end
end
