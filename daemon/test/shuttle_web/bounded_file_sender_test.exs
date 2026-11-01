defmodule ShuttleWeb.BoundedFileSenderTest do
  use ExUnit.Case, async: false
  import Plug.Conn
  import Phoenix.ConnTest

  alias Shuttle.FileAccess
  alias ShuttleWeb.BoundedFileSender, as: Sender

  @moduletag :tmp_dir

  defmodule TransferPlug do
    def init(opts), do: opts

    def call(conn, opts) do
      conn
      |> Plug.Conn.put_resp_content_type("application/x-ndjson", nil)
      |> Plug.Conn.put_private(:shuttle_file_access, opts[:file_access])
      |> ShuttleWeb.BoundedFileSender.send_file(200, opts[:path], 0, opts[:size])
    end
  end

  setup %{tmp_dir: dir} do
    path = Path.join(dir, "transcript.jsonl")
    bytes = :binary.copy("a", 2 * FileAccess.Reader.chunk_size() + 5)
    File.write!(path, bytes)

    service =
      start_supervised!({FileAccess, name: nil, capacity: 2, timeout: 50, protected_roots: [dir]})

    %{path: path, bytes: bytes, service: service, opts: [service: service]}
  end

  test "streams exact bytes and offsets, and skips body I/O for HEAD and empty files", ctx do
    parent = self()

    read_fn = fn fd, offset, count ->
      send(parent, {:pread, offset, count, self()})
      :file.pread(fd, offset, count)
    end

    opts = [file_access: ctx.opts ++ [read_fn: read_fn]]
    conn = Sender.send_file(build_conn(), 200, ctx.path, 0, byte_size(ctx.bytes), opts)
    assert conn.resp_body == ctx.bytes
    assert conn.state == :chunked
    assert get_resp_header(conn, "content-length") == [Integer.to_string(byte_size(ctx.bytes))]
    assert_receive {:pread, 0, 65_536, worker}
    refute worker == self()
    assert_receive {:pread, 65_536, 65_536, ^worker}
    assert_receive {:pread, 131_072, 5, ^worker}

    conn = Sender.send_file(build_conn(), 206, ctx.path, 65_533, 7, opts)
    assert conn.resp_body == binary_part(ctx.bytes, 65_533, 7)
    assert_receive {:pread, 65_533, 7, _}

    for conn <- [Plug.Test.conn(:head, "/"), build_conn() |> put_private(:unused, true)] do
      length = if conn.method == "HEAD", do: byte_size(ctx.bytes), else: 0
      result = Sender.send_file(conn, 200, ctx.path, 0, length, opts)
      assert result.resp_body == ""
      refute_receive {:pread, _, _, _}, 20
    end
  end

  test "busy readers return 503 and an ordinary missing file keeps its 404 callback", ctx do
    {:ok, first} = FileAccess.Reader.open(ctx.path, ctx.opts)
    {:ok, second} = FileAccess.Reader.open(ctx.path, ctx.opts)

    try do
      conn = Sender.send_file(build_conn(), 200, ctx.path, 0, 10, file_access: ctx.opts)
      assert conn.status == 503
      assert %{"reason" => "busy"} = Jason.decode!(conn.resp_body)
      assert get_resp_header(conn, "content-length") == []
    after
      FileAccess.Reader.close(first)
      FileAccess.Reader.close(second)
    end

    eventually(fn -> FileAccess.status(ctx.service).active == 0 end)

    conn =
      build_conn()
      |> put_resp_header("x-transcript-sha256", "digest")
      |> Sender.send_file(200, ctx.path <> ".missing", 0, 10,
        file_access: ctx.opts,
        missing: fn conn -> send_resp(conn, 404, "transcript missing") end
      )

    assert conn.status == 404
    assert conn.resp_body == "transcript missing"
    assert get_resp_header(conn, "content-length") == []
    assert get_resp_header(conn, "x-transcript-sha256") == []
  end

  test "EOF after a regular-file stat is a non-cacheable 503, never a missing-file callback",
       ctx do
    {:ok, %{type: :regular, size: size}} = FileAccess.stat(ctx.path, ctx.opts)
    File.write!(ctx.path, "")

    conn =
      stale_representation()
      |> Sender.send_file(200, ctx.path, 0, size,
        file_access: ctx.opts,
        missing: fn _ -> flunk("EOF is not a missing path") end
      )

    assert_unreadable(conn)
    eventually(fn -> FileAccess.status(ctx.service).active == 0 end)
  end

  test "first prefetch EIO is a non-cacheable 503 and removes stale range and digest headers",
       ctx do
    {:ok, %{type: :regular, size: size}} = FileAccess.stat(ctx.path, ctx.opts)
    read_fn = fn _, _, _ -> {:error, :eio} end

    conn =
      stale_representation()
      |> Sender.send_file(206, ctx.path, 0, size,
        file_access: ctx.opts ++ [read_fn: read_fn],
        missing: fn _ -> flunk("EIO is not a missing path") end
      )

    assert_unreadable(conn)
    eventually(fn -> FileAccess.status(ctx.service).active == 0 end)
  end

  test "prefetch timeout returns 504 before committing representation headers", ctx do
    parent = self()

    read_fn = fn fd, offset, count ->
      send(parent, {:waiting, self()})
      receive do: (:release -> :file.pread(fd, offset, count))
    end

    conn =
      build_conn()
      |> put_resp_header("etag", ~s("native"))
      |> put_resp_header("x-transcript-sha256", "digest")
      |> Sender.send_file(200, ctx.path, 0, byte_size(ctx.bytes),
        file_access: ctx.opts ++ [read_fn: read_fn]
      )

    assert_receive {:waiting, worker}

    try do
      assert conn.status == 504
      assert %{"reason" => "timeout"} = Jason.decode!(conn.resp_body)
      assert get_resp_header(conn, "content-length") == []
      assert get_resp_header(conn, "etag") == []
      assert get_resp_header(conn, "x-transcript-sha256") == []
      assert FileAccess.status(ctx.service).active == 1
      blocked = Sender.send_file(build_conn(), 200, ctx.path, 0, 10, file_access: ctx.opts)
      assert blocked.status == 503
      assert %{"reason" => "blocked"} = Jason.decode!(blocked.resp_body)
    after
      send(worker, :release)
    end
  end

  test "midstream timeout closes a real HTTP connection with an incomplete body", ctx do
    parent = self()

    read_fn = fn fd, offset, count ->
      if offset > 0 do
        send(parent, {:waiting, self()})
        receive do: (:release -> :ok)
      end

      :file.pread(fd, offset, count)
    end

    server =
      start_supervised!(
        {Bandit,
         plug:
           {TransferPlug,
            path: ctx.path,
            size: byte_size(ctx.bytes),
            file_access: ctx.opts ++ [read_fn: read_fn]},
         port: 0,
         ip: {127, 0, 0, 1}}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(server)
    {:ok, socket} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false])
    :ok = :gen_tcp.send(socket, "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
    assert_receive {:waiting, worker}, 1_000

    try do
      wire = receive_until_closed(socket, [])
      [headers, body] = String.split(wire, "\r\n\r\n", parts: 2)
      assert headers =~ "HTTP/1.1 200"
      assert headers =~ "content-length: #{byte_size(ctx.bytes)}"
      assert body == binary_part(ctx.bytes, 0, FileAccess.Reader.chunk_size())
      refute body =~ "timeout"
    after
      send(worker, :release)
      :gen_tcp.close(socket)
    end
  end

  defp stale_representation do
    build_conn()
    |> put_resp_header("cache-control", "public, max-age=300")
    |> put_resp_header("etag", ~s("native"))
    |> put_resp_header("last-modified", "Wed, 01 Jan 2020 00:00:00 GMT")
    |> put_resp_header("content-range", "bytes 0-9/10")
    |> put_resp_header("x-transcript-byte-count", "10")
    |> put_resp_header("x-transcript-sha256", "digest")
  end

  defp assert_unreadable(conn) do
    assert conn.status == 503
    assert %{"reason" => "io"} = Jason.decode!(conn.resp_body)
    assert get_resp_header(conn, "cache-control") == ["no-store"]

    for header <- [
          "content-length",
          "content-range",
          "etag",
          "last-modified",
          "x-transcript-byte-count",
          "x-transcript-sha256"
        ] do
      assert get_resp_header(conn, header) == []
    end
  end

  defp eventually(fun, attempts \\ 100)

  defp eventually(fun, attempts) when attempts > 0 do
    if fun.(),
      do: :ok,
      else:
        (
          Process.sleep(10)
          eventually(fun, attempts - 1)
        )
  end

  defp eventually(fun, 0), do: assert(fun.())

  defp receive_until_closed(socket, acc) do
    case :gen_tcp.recv(socket, 0, 2_000) do
      {:ok, bytes} -> receive_until_closed(socket, [bytes | acc])
      {:error, :closed} -> acc |> Enum.reverse() |> IO.iodata_to_binary()
      other -> flunk("connection did not abort: #{inspect(other)}")
    end
  end
end
