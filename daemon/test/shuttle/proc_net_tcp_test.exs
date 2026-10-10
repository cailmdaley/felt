defmodule Shuttle.ProcNetTcpTest do
  use ExUnit.Case, async: true

  alias Shuttle.ProcNetTcp

  @fixture_root Path.expand("../fixtures/proc_net_tcp", __DIR__)
  @loopback {127, 0, 0, 1}

  defp lookup(data, port), do: ProcNetTcp.lookup_data(data, @loopback, port, @loopback, 4000)

  test "matches IPv4 loopback only in the host's native byte order" do
    data = File.read!(Path.join(@fixture_root, "tcp"))

    {native_port, native_uid, other_port} =
      case :erlang.system_info(:endian) do
        :little -> {54_321, 1234, 54_322}
        :big -> {54_322, 2345, 54_321}
      end

    assert lookup(data, native_port) == {:ok, native_uid}
    # The opposite-order row decodes to 1.0.0.127 and must not match 127.0.0.1.
    assert lookup(data, other_port) == {:error, :no_row}
  end

  test "matches IPv4-mapped loopback only in the host's native byte order" do
    data = File.read!(Path.join(@fixture_root, "tcp6"))

    {native_port, native_uid, other_port} =
      case :erlang.system_info(:endian) do
        :little -> {54_323, 3456, 54_324}
        :big -> {54_324, 4567, 54_323}
      end

    assert lookup(data, native_port) == {:ok, native_uid}
    assert lookup(data, other_port) == {:error, :no_row}
  end

  test "matches a row whose hex fields are lowercase" do
    data = Path.join(@fixture_root, "tcp") |> File.read!() |> String.downcase()

    {native_port, native_uid} =
      case :erlang.system_info(:endian) do
        :little -> {54_321, 1234}
        :big -> {54_322, 2345}
      end

    assert lookup(data, native_port) == {:ok, native_uid}
  end

  test "reports no row when the client row is absent" do
    data = File.read!(Path.join(@fixture_root, "tcp"))

    assert lookup(data, 54_325) == {:error, :no_row}
  end

  test "reports no row when the proc table files are missing" do
    proc_root = Path.join(System.tmp_dir!(), "missing-proc-#{System.unique_integer([:positive])}")

    refute ProcNetTcp.readable?(proc_root)

    assert ProcNetTcp.lookup(
             %{address: @loopback, port: 54_321},
             "tcp://127.0.0.1:4000",
             proc_root
           ) == {:error, :no_row}
  end

  # The row filter, exercised on rows built here rather than in a fixture: the
  # variables that matter are `st`, `uid` and `inode`, and building the row
  # makes the native-byte-order address a detail of the helper instead of a
  # fixture the reader has to decode. See ProcNetTcp's "Which TCP states carry
  # a uid" and "A row whose socket was closed".
  describe "row filter" do
    @header "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

    defp native_loopback_hex do
      case :erlang.system_info(:endian) do
        :little -> "0100007F"
        :big -> "7F000001"
      end
    end

    # One client-side row: local = loopback:port, remote = loopback:4000.
    defp row(state, uid, port, inode \\ 10_001) do
      addr = native_loopback_hex()
      port_hex = port |> Integer.to_string(16) |> String.pad_leading(4, "0") |> String.upcase()

      "   0: #{addr}:#{port_hex} #{addr}:0FA0 #{state} 00000000:00000000 " <>
        "00:00000000 00000000 #{uid}        0 #{inode} 1 0000000000000000 100 0 0 10 0\n"
    end

    defp table(rows), do: @header <> Enum.join(rows)

    test "a half-closed client is resolved, not refused" do
      # FIN_WAIT1/FIN_WAIT2 is where an ordinary `Connection: close` client sits
      # by the time the plug reads the table; refusing these was the live bug.
      for state <- ~w(04 05) do
        assert lookup(table([row(state, 4242, 54_401)]), 54_401) == {:ok, 4242}
      end
    end

    test "the closing states still name a live owned socket" do
      for state <- ~w(08 09 0B) do
        assert lookup(table([row(state, 4242, 54_402)]), 54_402) == {:ok, 4242}
      end
    end

    test "a client that closed its socket is reported as closed, never as uid 0" do
      # Rows as a 5.14 kernel prints an orphaned client: the process closed its
      # descriptor while the request was still queued, and the draining socket
      # reads uid 0, inode 0. Read as a uid, it refused the daemon's own
      # timed-out worker as "uid 0" — and would admit anyone on a root daemon.
      for state <- ~w(04 05 08 09 0B) do
        assert lookup(table([row(state, 0, 54_403, 0)]), 54_403) == {:error, :peer_closed}
      end

      # The inode decides, not the uid: a nonzero uid on an inode-0 row is
      # still nobody's.
      assert lookup(table([row("05", 4242, 54_403, 0)]), 54_403) == {:error, :peer_closed}
    end

    test "TIME_WAIT and SYN_RECV have no owning socket" do
      # A timewait entry is an `inet_timewait_sock` and a SYN_RECV entry a
      # request sock; the kernel prints uid 0 and inode 0 for both.
      for state <- ~w(06 03) do
        assert lookup(table([row(state, 0, 54_404, 0)]), 54_404) == {:error, :peer_closed}
      end
    end

    test "states outside the owned set are not connections with an owner" do
      assert lookup(table([row("03", 4242, 54_405)]), 54_405) == {:error, :no_row}
      assert lookup(table([row("0A", 4242, 54_405)]), 54_405) == {:error, :no_row}
    end

    test "an owned row wins over an orphaned row for the same four-tuple" do
      # A reused ephemeral port: the previous connection still drains while the
      # new one is established.
      rows = [row("05", 0, 54_406, 0), row("01", 4242, 54_406)]

      assert lookup(table(rows), 54_406) == {:ok, 4242}
      assert lookup(table(Enum.reverse(rows)), 54_406) == {:ok, 4242}
    end

    test "an owned row in tcp6 wins over an orphaned row in tcp" do
      proc_root = Path.join(System.tmp_dir!(), "proc-#{System.unique_integer([:positive])}")
      File.mkdir_p!(Path.join(proc_root, "net"))
      on_exit(fn -> File.rm_rf!(proc_root) end)

      File.write!(Path.join([proc_root, "net", "tcp"]), table([row("05", 0, 54_407, 0)]))
      File.write!(Path.join([proc_root, "net", "tcp6"]), table([row("01", 4242, 54_407)]))

      assert ProcNetTcp.lookup(
               %{address: @loopback, port: 54_407},
               "tcp://127.0.0.1:4000",
               proc_root
             ) == {:ok, 4242}
    end

    test "a lowercase state still matches" do
      data = table([row("05", 4242, 54_408)]) |> String.downcase()

      assert lookup(data, 54_408) == {:ok, 4242}
    end
  end
end
