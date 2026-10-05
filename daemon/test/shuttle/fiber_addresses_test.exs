defmodule Shuttle.FiberAddressesTest do
  use ExUnit.Case, async: false

  alias Shuttle.FiberAddresses

  defp uid(n), do: "01JZ" <> String.pad_leading(Integer.to_string(n), 22, "0")

  test "a poll replaces the poller's addresses and outranks a learned one" do
    FiberAddresses.learn(uid(1), "/store", "learned/one")
    FiberAddresses.put_polled(%{uid(1) => {"/store", "polled/one"}, uid(2) => {"/store", "two"}})
    assert FiberAddresses.lookup(uid(1)) == {"/store", "polled/one"}

    FiberAddresses.put_polled(%{uid(2) => {"/store", "two"}})
    assert FiberAddresses.lookup(uid(1)) == {"/store", "learned/one"}
    assert FiberAddresses.lookup(uid(2)) == {"/store", "two"}
  end

  test "UIDs are matched in either case, and other ids have no address" do
    FiberAddresses.learn(String.downcase(uid(3)), "/store", "three")
    assert FiberAddresses.lookup(uid(3)) == {"/store", "three"}
    assert FiberAddresses.lookup(String.downcase(uid(3))) == {"/store", "three"}
    assert FiberAddresses.lookup("tests/three") == nil
  end

  test "learned addresses are dropped once the table is full" do
    for n <- 100..20_100, do: FiberAddresses.learn(uid(n), "/store", "f#{n}")
    assert :ets.info(:shuttle_fiber_addresses, :size) <= 20_000
    assert FiberAddresses.lookup(uid(20_100)) == {"/store", "f20100"}
  end
end
