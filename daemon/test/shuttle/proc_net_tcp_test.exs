defmodule Shuttle.ProcNetTcpTest do
  use ExUnit.Case, async: true

  alias Shuttle.ProcNetTcp

  @fixture_root Path.expand("../fixtures/proc_net_tcp", __DIR__)
  @loopback {127, 0, 0, 1}

  test "matches IPv4 loopback only in the host's native byte order" do
    data = File.read!(Path.join(@fixture_root, "tcp"))

    {native_port, native_uid, other_port} =
      case :erlang.system_info(:endian) do
        :little -> {54_321, 1234, 54_322}
        :big -> {54_322, 2345, 54_321}
      end

    assert ProcNetTcp.uid_from_data(data, @loopback, native_port, @loopback, 4000) == native_uid
    # The opposite-order row decodes to 1.0.0.127 and must not match 127.0.0.1.
    assert ProcNetTcp.uid_from_data(data, @loopback, other_port, @loopback, 4000) == nil
  end

  test "matches IPv4-mapped loopback only in the host's native byte order" do
    data = File.read!(Path.join(@fixture_root, "tcp6"))

    {native_port, native_uid, other_port} =
      case :erlang.system_info(:endian) do
        :little -> {54_323, 3456, 54_324}
        :big -> {54_324, 4567, 54_323}
      end

    assert ProcNetTcp.uid_from_data(data, @loopback, native_port, @loopback, 4000) == native_uid
    assert ProcNetTcp.uid_from_data(data, @loopback, other_port, @loopback, 4000) == nil
  end

  test "returns nil when the established client row is absent" do
    data = File.read!(Path.join(@fixture_root, "tcp"))

    assert ProcNetTcp.uid_from_data(data, @loopback, 54_325, @loopback, 4000) == nil
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
