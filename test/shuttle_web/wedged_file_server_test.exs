defmodule ShuttleWeb.WedgedFileServerTest do
  @moduledoc """
  The board must load, and files must still be served, while a felt store is
  parked on a macOS consent dialog.

  The stand-in for the dialog is a writer-less FIFO: `open(2)` blocks in the
  kernel until somebody shows up, and a `File.read/1` on one parks
  `:file_server_2` — the single GenServer every `File.*` call in the VM goes
  through. That is the wedge the real incident produced, one layer down from the
  store walk.

  **This test speaks HTTP over a real socket on purpose.** `Phoenix.ConnTest`
  routes through `Plug.Adapters.Test.Conn`, whose `send_file/6` reads the file
  with `File.stat!/1` and `File.open!/3` — so the two endpoints that matter most
  here would appear wedged under the test adapter and are not under Bandit,
  which stats with `:file.read_file_info/2` `:raw` and sends with a raw
  `:file.open/2` + `:file.sendfile/5`. Asserting through the test adapter would
  measure Plug's test harness rather than the daemon.
  """
  use ExUnit.Case, async: false

  @moduletag :capture_log

  setup do
    {:ok, _} = Application.ensure_all_started(:inets)

    port = free_port()

    start_supervised!(
      {Bandit, plug: ShuttleWeb.Endpoint, port: port, ip: {127, 0, 0, 1}, startup_log: false}
    )

    dir = Path.join(System.tmp_dir!(), "wedged_fs_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)

    fifo = Path.join(dir, "consent-dialog")
    {_, 0} = System.cmd("mkfifo", [fifo])

    served = Path.join(dir, "served.txt")
    File.write!(served, "bytes from a healthy store")

    {:ok, port: port, fifo: fifo, served: served}
  end

  test "the board's page and a file read still answer", ctx do
    # Warm first: this is about serving reads while the world is not answering,
    # not about doing first-time work while it is not answering.
    assert {200, _} = get(ctx.port, "/")
    assert {200, _} = get(ctx.port, "/api/v1/file?path=#{URI.encode_www_form(ctx.served)}")

    blocker = spawn(fn -> File.read(ctx.fifo) end)

    # Opening the FIFO for writing lets the parked `open(2)` return. Only ever
    # while the reader is still parked: an open-for-write with no reader blocks
    # identically, so an unconditional cleanup would hang the suite.
    release = fn ->
      with {:ok, io} <- :file.open(ctx.fifo, [:write, :raw]), do: :file.close(io)
    end

    on_exit(fn -> if Process.alive?(blocker), do: release.() end)

    # The negative control, and the proof the wedge took.
    wedged = Task.async(fn -> File.dir?("/tmp") end)
    assert Task.yield(wedged, 500) == nil
    Task.shutdown(wedged, :brutal_kill)

    # The board's own page: `Plug.Static` and Bandit's `send_file` are both raw,
    # and `ShuttleWeb.SpaController`'s index check is raw, so the whole path is.
    assert {200, body} = get(ctx.port, "/")
    assert byte_size(body) > 0

    # A companion file on a HEALTHY store, which the wedged one must not take
    # down with it.
    assert {200, "bytes from a healthy store"} =
             get(ctx.port, "/api/v1/file?path=#{URI.encode_www_form(ctx.served)}")

    # And the cached read endpoints, which touch no filesystem at all.
    assert {200, _} = get(ctx.port, "/api/v1/version")
    assert {200, _} = get(ctx.port, "/api/v1/fibers/composite")

    release.()
  end

  defp get(port, path) do
    url = ~c"http://127.0.0.1:#{port}#{path}"

    case :httpc.request(:get, {url, []}, [timeout: 2_000, connect_timeout: 1_000], []) do
      {:ok, {{_, status, _}, _headers, body}} -> {status, IO.iodata_to_binary(body)}
      {:error, reason} -> {:error, reason}
    end
  end

  # Bind port 0, read what the OS gave us, hand it back. A fixed port would
  # collide with a daemon running on the developer's machine.
  defp free_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, ip: {127, 0, 0, 1}])
    {:ok, port} = :inet.port(socket)
    :gen_tcp.close(socket)
    port
  end
end
