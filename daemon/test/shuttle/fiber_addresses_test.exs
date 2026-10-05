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
    assert :ets.info(:shuttle_fiber_addresses_learned, :size) <= 20_000
    assert FiberAddresses.lookup(uid(20_100)) == {"/store", "f20100"}
  end

  test "polled addresses never count toward the learned cap" do
    FiberAddresses.put_polled(Map.new(30_000..50_100, &{uid(&1), {"/store", "p#{&1}"}}))
    FiberAddresses.learn(uid(7), "/store", "seven")
    FiberAddresses.learn(uid(8), "/store", "eight")
    assert FiberAddresses.lookup(uid(7)) == {"/store", "seven"}
    assert FiberAddresses.lookup(uid(8)) == {"/store", "eight"}
    FiberAddresses.put_polled(%{})
  end
end
