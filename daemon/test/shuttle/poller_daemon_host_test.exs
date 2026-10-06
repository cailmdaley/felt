defmodule Shuttle.PollerDaemonHostTest do
  # sync: overwrites the VM-wide daemon identity (`Poller.freeze_daemon_host_id!/1`
  # writes the `{:shuttle_own_host_id, :daemon}` persistent_term every
  # `Poller.own_host_id/0` caller reads).
  use ExUnit.Case, async: false

  alias Shuttle.Poller
  alias Shuttle.Test.FeltStoreRunner, as: MockRunner
  alias Shuttle.Test.Env

  setup do
    MockRunner.start!()
    MockRunner.reset()
    mock_felt_root = MockRunner.felt_root()
    on_exit(fn -> File.rm_rf(mock_felt_root) end)
    :ok
  end

  test "the daemon identity is resolved once; every later read is shell-free" do
    key = {:shuttle_own_host_id, :daemon}
    prev = :persistent_term.get(key, nil)

    on_exit(fn ->
      if prev, do: :persistent_term.put(key, prev), else: :persistent_term.erase(key)
    end)

    Env.delete_env("SHUTTLE_HOST")
    MockRunner.set_host_json(~s({"id": "candide"}))

    asks = fn ->
      Enum.count(MockRunner.commands(), &(&1 == {"shuttle", ["host", "--json"]}))
    end

    before = asks.()

    assert Poller.freeze_daemon_host_id!(runner: MockRunner) == "candide"
    assert asks.() == before + 1

    # No Poller holds this name, so reads fall through to the daemon slot —
    # as every request does in the boot window before the Poller starts.
    MockRunner.set_host_json(~s({"id": "renamed"}))

    for _ <- 1..50 do
      assert Poller.own_host_id(:no_poller_by_this_name) == "candide"
      assert Poller.daemon_host_id() == "candide"
    end

    assert asks.() == before + 1
  end
end
