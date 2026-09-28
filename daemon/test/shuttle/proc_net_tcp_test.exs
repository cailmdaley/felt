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

  test "matches a row whose hex fields are lowercase" do
    data = Path.join(@fixture_root, "tcp") |> File.read!() |> String.downcase()

    {native_port, native_uid} =
      case :erlang.system_info(:endian) do
        :little -> {54_321, 1234}
        :big -> {54_322, 2345}
      end

    assert ProcNetTcp.uid_from_data(data, @loopback, native_port, @loopback, 4000) == native_uid
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

  # The state filter, exercised on rows built here rather than in a fixture: the
  # only variable that matters is `st`, and building the row makes the
  # native-byte-order address a detail of the helper instead of a fixture the
  # reader has to decode. See ProcNetTcp's "Which TCP states carry a uid".
  describe "TCP state filter" do
    @header "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

    defp native_loopback_hex do
      case :erlang.system_info(:endian) do
        :little -> "0100007F"
        :big -> "7F000001"
      end
    end

    # One client-side row: local = loopback:port, remote = loopback:4000.
    defp row(state, uid, port) do
      addr = native_loopback_hex()
      port_hex = port |> Integer.to_string(16) |> String.pad_leading(4, "0") |> String.upcase()

      @header <>
        "   0: #{addr}:#{port_hex} #{addr}:0FA0 #{state} 00000000:00000000 " <>
        "00:00000000 00000000 #{uid}        0 10001 1 0000000000000000 100 0 0 10 0\n"
    end

    test "a half-closed client is resolved, not refused" do
      # FIN_WAIT1/FIN_WAIT2 is where an ordinary `Connection: close` client sits
      # by the time the plug reads the table; refusing these was the live bug.
      for state <- ~w(04 05) do
        assert ProcNetTcp.uid_from_data(row(state, 4242, 54_401), @loopback, 54_401, @loopback, 4000) ==
                 4242
      end
    end

    test "the closing states still name a live owned socket" do
      for state <- ~w(08 09 0B) do
        assert ProcNetTcp.uid_from_data(row(state, 4242, 54_402), @loopback, 54_402, @loopback, 4000) ==
                 4242
      end
    end

    test "TIME_WAIT is never trusted, even though it reads uid 0" do
      # A timewait entry has no owning socket, so the kernel prints uid 0 for
      # every one. Trusting it would authorize every peer on a root daemon.
      assert ProcNetTcp.uid_from_data(row("06", 0, 54_403), @loopback, 54_403, @loopback, 4000) ==
               nil

      # Not merely "uid 0 is not the daemon's uid": the state is rejected before
      # the uid is ever compared, so a fabricated non-zero uid changes nothing.
      assert ProcNetTcp.uid_from_data(row("06", 4242, 54_403), @loopback, 54_403, @loopback, 4000) ==
               nil
    end

    test "SYN_RECV and LISTEN are not connections with an owner" do
      assert ProcNetTcp.uid_from_data(row("03", 4242, 54_404), @loopback, 54_404, @loopback, 4000) ==
               nil

      assert ProcNetTcp.uid_from_data(row("0A", 4242, 54_405), @loopback, 54_405, @loopback, 4000) ==
               nil
    end

    test "a lowercase state still matches" do
      data = row("05", 4242, 54_406) |> String.downcase()

      assert ProcNetTcp.uid_from_data(data, @loopback, 54_406, @loopback, 4000) == 4242
    end
  end
end
