defmodule ShuttleWeb.FileRelayTest do
  use ExUnit.Case

  import Shuttle.Test.ApiConn
  import Shuttle.Test.EnvHelpers
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir
  @size 6 * 1024 * 1024

  defmodule UncappedOwner do
    @behaviour Plug
    def init(opts), do: opts

    def call(conn, opts) do
      send(opts[:observer], {:owner_request, conn.method, get_req_header(conn, "range")})
      conn = put_resp_content_type(conn, "video/mp4", nil)
      size = File.stat!(opts[:path]).size

      ranges =
        if get_req_header(conn, "if-range") == ["stale"],
          do: [],
          else: get_req_header(conn, "range")

      case ranges do
        ["bytes=" <> range] ->
          [first, last] = String.split(range, "-")

          {first, last} =
            cond do
              first == "" -> {max(size - String.to_integer(last), 0), size - 1}
              last == "" -> {String.to_integer(first), size - 1}
              true -> {String.to_integer(first), min(String.to_integer(last), size - 1)}
            end

          conn
          |> put_resp_header("content-range", "bytes #{first}-#{last}/#{size}")
          |> send_file(206, opts[:path], first, last - first + 1)

        [] ->
          send_file(conn, 200, opts[:path])
      end
    end
  end

  setup %{tmp_dir: dir} do
    path = Path.join(dir, "remote.mp4")
    {:ok, file} = :file.open(String.to_charlist(path), [:write, :raw, :binary])
    :ok = :file.pwrite(file, @size - 1, <<0>>)
    :ok = :file.close(file)

    server =
      start_supervised!(
        {Bandit, plug: {UncappedOwner, path: path, observer: self()}, port: 0, ip: {127, 0, 0, 1}}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(server)

    previous_client = Application.get_env(:shuttle, :write_forward_client)
    previous_remotes = Application.get_env(:shuttle, :remotes)
    Application.put_env(:shuttle, :write_forward_client, Shuttle.RemoteRegistry.Client.Default)

    Application.put_env(:shuttle, :remotes, [
      %{name: "file-owner", url: "http://127.0.0.1:#{port}"}
    ])

    on_exit(fn ->
      restore_app_env(:write_forward_client, previous_client)
      restore_app_env(:remotes, previous_remotes)
    end)

    {:ok, owner_url: "http://127.0.0.1:#{port}"}
  end

  test "real httpc relay caps open-ended and suffix ranges even on an uncapped owner" do
    for {range, forwarded, content_range} <- [
          {"bytes=7-", "bytes=7-4194310", "bytes 7-4194310/6291456"},
          {"bytes=7-99999999", "bytes=7-4194310", "bytes 7-4194310/6291456"},
          {"bytes=-99999999", "bytes=-4194304", "bytes 2097152-6291455/6291456"}
        ] do
      conn =
        api_conn()
        |> put_req_header("range", range)
        |> get("/api/v1/file?path=%2Fremote.mp4&origin=file-owner")

      assert conn.status == 206
      assert byte_size(conn.resp_body) == 4 * 1024 * 1024
      assert get_resp_header(conn, "content-range") == [content_range]
      assert get_resp_header(conn, "content-length") == ["4194304"]
      assert_receive {:owner_request, "GET", [^forwarded]}
    end
  end

  test "remote HEAD remains an upstream HEAD and transfers no representation body", %{
    owner_url: owner_url
  } do
    conn =
      api_conn()
      |> put_req_header("range", "bytes=0-1")
      |> head("/api/v1/file?path=%2Fremote.mp4&origin=file-owner")

    assert_receive {:owner_request, "HEAD", []}
    assert conn.status == 200
    assert conn.resp_body == ""
    assert get_resp_header(conn, "content-length") == [Integer.to_string(@size)]

    # Also inspect the transport body directly; the downstream HEAD adapter
    # would hide a body accidentally returned by the upstream transport.
    assert {:ok, 200, headers, "video/mp4", ""} =
             Shuttle.RemoteRegistry.Client.Default.head_file(owner_url <> "/file", [], 30_000)

    assert List.keyfind(headers, "content-length", 0) ==
             {"content-length", Integer.to_string(@size)}

    assert_receive {:owner_request, "HEAD", []}
  end

  test "an If-Range mismatch preserves the owner's full 200 fallback" do
    conn =
      api_conn()
      |> put_req_header("range", "bytes=7-")
      |> put_req_header("if-range", "stale")
      |> get("/api/v1/file?path=%2Fremote.mp4&origin=file-owner")

    assert conn.status == 200
    assert byte_size(conn.resp_body) == @size
    assert get_resp_header(conn, "content-range") == []
    assert get_resp_header(conn, "content-length") == [Integer.to_string(@size)]
    assert_receive {:owner_request, "GET", ["bytes=7-4194310"]}
  end

  test "full remote GET keeps the full representation" do
    conn = get(api_conn(), "/api/v1/file?path=%2Fremote.mp4&origin=file-owner")
    assert conn.status == 200
    assert byte_size(conn.resp_body) == @size
    assert_receive {:owner_request, "GET", []}
  end
end
