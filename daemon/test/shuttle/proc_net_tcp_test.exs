defmodule Shuttle.ProcNetTcpTest do
  use ExUnit.Case, async: true

  alias Shuttle.ProcNetTcp

  @fixture_root Path.expand("../fixtures/proc_net_tcp", __DIR__)
  @loopback {127, 0, 0, 1}

  test "matches the client row when the proc IPv4 address is little-endian" do
    data = File.read!(Path.join(@fixture_root, "tcp"))

    assert ProcNetTcp.uid_from_data(data, @loopback, 54_321, @loopback, 4000) == 1234
  end

  test "matches the client row when the proc IPv4 address is big-endian" do
    data = File.read!(Path.join(@fixture_root, "tcp"))

    assert ProcNetTcp.uid_from_data(data, @loopback, 54_322, @loopback, 4000) == 2345
  end

  test "matches an IPv4-mapped loopback peer in tcp6" do
    data = File.read!(Path.join(@fixture_root, "tcp6"))

    assert ProcNetTcp.uid_from_data(data, @loopback, 54_323, @loopback, 4000) == 3456
  end

  test "returns nil when the established client row is absent" do
    data = File.read!(Path.join(@fixture_root, "tcp"))

    assert ProcNetTcp.uid_from_data(data, @loopback, 54_324, @loopback, 4000) == nil
  end

  test "returns nil when the proc table files are missing" do
    proc_root = Path.join(System.tmp_dir!(), "missing-proc-#{System.unique_integer([:positive])}")

    refute ProcNetTcp.readable?(proc_root)

    assert ProcNetTcp.peer_uid(
             %{address: @loopback, port: 54_321},
             "tcp://127.0.0.1:4000",
             proc_root
           ) == nil
  end
end
