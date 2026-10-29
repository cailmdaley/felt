defmodule ShuttleWeb.TranscriptControllerTest do
  use ExUnit.Case, async: false
  import Shuttle.Test.ApiConn

  import Phoenix.ConnTest
  import Plug.Conn

  alias Shuttle.Test.{Env, StubGetFileClient, StubStreamClient}
  alias ShuttleWeb.TranscriptStream

  @endpoint ShuttleWeb.Endpoint
  @session "a3edf873-cb1c-40ab-a891-f26f5333b320"

  defmodule ClosedAdapter do
    def chunk(_state, _body), do: {:error, :closed}
  end

  defmodule RelayClosedAdapter do
    def send_chunked(state, _status, _headers), do: {:ok, nil, state}
    def chunk(_state, _body), do: {:error, :closed}
  end

  defmodule BrokenStartAdapter do
    def send_chunked(_, _, _), do: raise("send_chunked failed")
  end

  defmodule SlowAdapter do
    def chunk(state, body) do
      body = IO.iodata_to_binary(body)
      if String.starts_with?(body, "id:"), do: Process.sleep(25)
      {:ok, state <> body, state <> body}
    end
  end

  setup do
    root =
      Path.join(
        System.tmp_dir!(),
        "shuttle_transcript_http_#{System.unique_integer([:positive])}"
      )

    dir = Path.join(root, "-Users-cail-french")
    File.mkdir_p!(dir)
    path = Path.join(dir, "#{@session}.jsonl")
    bytes = ~s({"type":"user","message":{"content":"native"}}\n)
    File.write!(path, bytes)

    Env.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", root)
    on_exit(fn -> File.rm_rf(root) end)

    {:ok, root: root, path: path, bytes: bytes}
  end

  test "local receipt exposes the authoritative native path and digest", %{
    path: path,
    bytes: bytes
  } do
    body =
      local_conn()
      |> get("/api/v1/transcript", %{"session" => @session})
      |> json_response(200)

    assert body["availability"] == "available_local"
    assert body["source_path"] == path
    assert body["byte_count"] == byte_size(bytes)
    assert body["sha256"] == :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)
  end

  test "raw local response is byte-for-byte native and carries digest headers", %{bytes: bytes} do
    conn = local_conn() |> get("/api/v1/transcript/raw", %{"session" => @session})

    assert response(conn, 200) == bytes

    assert get_resp_header(conn, "x-transcript-byte-count") == [
             Integer.to_string(byte_size(bytes))
           ]

    assert get_resp_header(conn, "x-transcript-sha256") == [
             Base.encode16(:crypto.hash(:sha256, bytes), case: :lower)
           ]
  end

  test "raw offset returns the requested byte slice and size metadata", %{bytes: bytes} do
    offset = 12

    conn =
      local_conn()
      |> get("/api/v1/transcript/raw", %{"session" => @session, "offset" => "#{offset}"})

    assert response(conn, 200) == binary_part(bytes, offset, byte_size(bytes) - offset)
    assert get_resp_header(conn, "x-transcript-offset") == [Integer.to_string(offset)]

    assert get_resp_header(conn, "x-transcript-byte-count") == [
             Integer.to_string(byte_size(bytes))
           ]

    assert get_resp_header(conn, "x-transcript-sha256") == []
  end

  test "raw offset at EOF returns an empty body", %{bytes: bytes} do
    offset = byte_size(bytes)

    conn =
      local_conn()
      |> get("/api/v1/transcript/raw", %{"session" => @session, "offset" => "#{offset}"})

    assert response(conn, 200) == ""
    # Bandit refuses a zero-length sendfile, so an empty slice is a plain response.
    assert conn.state == :sent
    assert get_resp_header(conn, "x-transcript-offset") == [Integer.to_string(offset)]
    assert get_resp_header(conn, "x-transcript-byte-count") == [Integer.to_string(offset)]
  end

  test "raw offset past EOF returns a 416 receipt", %{bytes: bytes} do
    size = byte_size(bytes)
    offset = size + 1

    assert %{
             "session" => @session,
             "availability" => "available_local",
             "byte_count" => ^size
           } =
             local_conn()
             |> get("/api/v1/transcript/raw", %{"session" => @session, "offset" => "#{offset}"})
             |> json_response(416)
  end

  test "raw offset must be a non-negative decimal integer" do
    assert %{"error" => "offset must be a non-negative integer"} =
             local_conn()
             |> get("/api/v1/transcript/raw", %{"session" => @session, "offset" => "-1"})
             |> json_response(400)
  end

  test "offset on a missing transcript retains the missing receipt" do
    assert %{"availability" => "transcript_missing"} =
             local_conn()
             |> get("/api/v1/transcript/raw", %{
               "session" => "11111111-2222-3333-4444-555555555555",
               "offset" => "0"
             })
             |> json_response(404)
  end

  test "invalid UUID is a 400 and unknown valid UUID is transcript_missing" do
    assert %{"error" => "session must be a UUID"} =
             local_conn()
             |> get("/api/v1/transcript", %{"session" => "not-a-uuid"})
             |> json_response(400)

    assert %{"availability" => "transcript_missing"} =
             local_conn()
             |> get("/api/v1/transcript", %{"session" => "11111111-2222-3333-4444-555555555555"})
             |> json_response(200)
  end

  describe "local stream" do
    setup do
      Env.put_app_env(:transcript_stream,
        tick_ms: 10,
        max_ms: 160,
        heartbeat_ms: 50,
        event_bytes: 5
      )

      :ok
    end

    defp mutating_stream_conn(mutate) do
      local_conn()
      |> register_before_send(fn conn ->
        assert conn.status == 200
        mutate.()
        conn
      end)
    end

    test "batches complete lines with byte offsets, strips CR, and withholds partial lines", %{
      path: path
    } do
      File.write!(path, "skip\na\r\nb\n\npartial")

      conn =
        local_conn()
        |> get("/api/v1/transcript/stream", %{"session" => @session, "offset" => "5"})

      assert response(conn, 200) =~ ": open\n\nid: 10\ndata: a\ndata: b\n\n"
      refute conn.resp_body =~ "partial"
      assert conn.resp_body =~ ": keepalive\n\n"
      assert get_resp_header(conn, "content-type") == ["text/event-stream; charset=utf-8"]
      assert get_resp_header(conn, "cache-control") == ["no-cache, no-transform"]
      assert get_resp_header(conn, "x-accel-buffering") == ["no"]
      assert get_resp_header(conn, "x-transcript-offset") == ["5"]
      assert Registry.count(ShuttleWeb.TranscriptStreams) == 0
    end

    test "batch ids account for blank lines between records", %{path: path} do
      File.write!(path, "a\n\n\nb\n")

      Env.put_app_env(:transcript_stream,
        tick_ms: 10,
        max_ms: 30,
        event_bytes: 2
      )

      conn = local_conn() |> get("/api/v1/transcript/stream", %{"session" => @session})
      assert response(conn, 200) =~ "id: 2\ndata: a\n\nid: 6\ndata: b\n\n"
    end

    test "registration is released if following raises" do
      Env.put_app_env(:transcript_stream, max_ms: nil)

      assert_raise ArithmeticError, fn ->
        local_conn() |> get("/api/v1/transcript/stream", %{"session" => @session})
      end

      assert Registry.count(ShuttleWeb.TranscriptStreams) == 0
    end

    test "registration is released if send_chunked raises before following" do
      conn = %{Plug.Test.conn(:get, "/") | adapter: {BrokenStartAdapter, nil}}

      assert_raise RuntimeError, "send_chunked failed", fn ->
        ShuttleWeb.TranscriptController.stream(conn, %{"session" => @session, "host" => "local"})
      end

      assert Registry.count(ShuttleWeb.TranscriptStreams) == 0
    end

    test "the deadline is checked between backlog events", %{path: path} do
      File.write!(path, String.duplicate("x\n", 100))
      Env.put_app_env(:transcript_stream, tick_ms: 10, max_ms: 40, event_bytes: 2)
      conn = Plug.Test.conn(:get, "/") |> send_chunked(200)
      conn = %{conn | adapter: {SlowAdapter, ""}}
      result = ShuttleWeb.TranscriptStream.follow(conn, path, 0)
      {_, body} = result.adapter
      assert body =~ "id: 2\ndata: x\n\n"
      refute body =~ "id: 200\n"
    end

    test "disconnect ends the follower", %{path: path} do
      conn = Plug.Test.conn(:get, "/") |> send_chunked(200)
      conn = %{conn | adapter: {ClosedAdapter, nil}}
      assert ShuttleWeb.TranscriptStream.follow(conn, path, 0) == conn
    end

    test "a record larger than the event limit is its own whole event", %{path: path} do
      File.write!(path, "oversized\nx\n")
      conn = local_conn() |> get("/api/v1/transcript/stream", %{"session" => @session})
      assert response(conn, 200) =~ "id: 10\ndata: oversized\n\nid: 12\ndata: x\n\n"
    end

    test "appended records arrive with their offsets", %{path: path} do
      File.write!(path, "one\n")

      conn =
        mutating_stream_conn(fn -> File.write!(path, "two\n", [:append]) end)
        |> get("/api/v1/transcript/stream", %{"session" => @session})

      assert response(conn, 200) =~ "id: 4\ndata: one\n\n"
      assert conn.resp_body =~ "id: 8\ndata: two\n\n"
    end

    test "truncation sends reset", %{path: path} do
      File.write!(path, "one\n")

      conn =
        mutating_stream_conn(fn -> File.write!(path, "") end)
        |> get("/api/v1/transcript/stream", %{"session" => @session, "offset" => "4"})

      assert response(conn, 200) =~ "event: reset\ndata: {\"byte_count\":0}\n\n"
    end

    test "truncation of an unconsumed partial record sends reset", %{path: path} do
      File.write!(path, "partial record")

      conn =
        mutating_stream_conn(fn -> File.write!(path, "short") end)
        |> get("/api/v1/transcript/stream", %{"session" => @session})

      assert response(conn, 200) =~ "event: reset\ndata: {\"byte_count\":5}\n\n"
    end

    test "replacement and deletion send reset", %{path: path} do
      for replacement <- [true, false] do
        File.write!(path, "one\n")

        conn =
          mutating_stream_conn(fn ->
            if replacement do
              File.write!(path <> ".replacement", "new record\n")
              File.rename!(path <> ".replacement", path)
            else
              File.rm!(path)
            end
          end)
          |> get("/api/v1/transcript/stream", %{"session" => @session})

        count = if replacement, do: 11, else: 0
        assert response(conn, 200) =~ "event: reset\ndata: {\"byte_count\":#{count}}\n\n"
      end
    end

    test "validation and missing receipts match raw", %{bytes: bytes} do
      for params <- [
            %{"session" => "bad"},
            %{"session" => @session, "offset" => "-1"},
            %{"session" => @session, "offset" => "#{byte_size(bytes) + 1}"},
            %{"session" => "11111111-2222-3333-4444-555555555555", "offset" => "0"}
          ] do
        raw = local_conn() |> get("/api/v1/transcript/raw", params)
        stream = local_conn() |> get("/api/v1/transcript/stream", params)
        assert stream.status == raw.status
        assert Jason.decode!(stream.resp_body) == Jason.decode!(raw.resp_body)
      end
    end

    test "capacity rejects the 33rd request and releases registrations" do
      parent = self()

      tasks =
        for i <- 1..32 do
          Task.async(fn ->
            :ok = ShuttleWeb.TranscriptStream.admit({:local, i})
            send(parent, :registered)

            receive do
              :stop -> ShuttleWeb.TranscriptStream.release({:local, i})
            end
          end)
        end

      for _ <- tasks, do: assert_receive(:registered, 1000)
      conn = local_conn() |> get("/api/v1/transcript/stream", %{"session" => @session})
      assert json_response(conn, 429) == %{"error" => "stream_capacity"}
      for task <- tasks, do: send(task.pid, :stop)
      for task <- tasks, do: Task.await(task)
      assert Registry.count(ShuttleWeb.TranscriptStreams) == 0
    end
  end

  describe "remote stream relay" do
    setup do
      StubStreamClient.start!()
      Env.put_app_env(:write_forward_client, StubStreamClient)
      Env.put_app_env(:remotes, [%{name: "owner-a", url: "http://127.0.0.1:19999"}])
      Env.put_app_env(:transcript_stream, relay_connect_ms: 40, relay_idle_ms: 40)
      :ok
    end

    defp remote_stream(params \\ %{}) do
      local_conn()
      |> get(
        "/api/v1/transcript/stream",
        Map.merge(%{"session" => @session, "host" => "owner-a"}, params)
      )
    end

    test "relays chunks verbatim in order with hub headers and flow control" do
      chunks = [": open\n\n", "id: 8\ndata: γ", "×κ\n\nevent: reset\ndata: {}\n\n"]

      StubStreamClient.set_events(
        [
          {:open,
           [
             {"Content-Type", "Text/Event-Stream; charset=utf-8"},
             {"content-encoding", "gzip"},
             {"cache-control", "public"},
             {"x-transcript-offset", "999"}
           ]}
        ] ++ Enum.map(chunks, &{:data, &1}) ++ [:done]
      )

      conn = remote_stream(%{"offset" => "42", "origin" => "ignore-me"})
      assert response(conn, 200) == Enum.join(chunks)
      assert get_resp_header(conn, "content-type") == ["text/event-stream; charset=utf-8"]
      assert get_resp_header(conn, "cache-control") == ["no-cache, no-transform"]
      assert get_resp_header(conn, "x-accel-buffering") == ["no"]
      assert get_resp_header(conn, "x-transcript-offset") == ["42"]
      assert get_resp_header(conn, "content-encoding") == []
      %{url: url, headers: headers, timeout: 40, id: id} = StubStreamClient.last()
      assert URI.parse(url).path == "/api/v1/transcript/stream"

      assert URI.decode_query(URI.parse(url).query) == %{
               "session" => @session,
               "host" => "local",
               "offset" => "42"
             }

      assert headers == [{"accept", "text/event-stream"}]
      assert StubStreamClient.nexts() == [id, id, id, id]
      assert StubStreamClient.cancelled() == [id]
      assert Registry.count(ShuttleWeb.TranscriptStreams) == 0
    end

    test "preserves receipt status and body, including missing, pending and past EOF" do
      for {status, availability} <- [
            {404, "transcript_missing"},
            {409, "identity_pending"},
            {416, "available_local"},
            {503, "host_unreachable"}
          ] do
        body = Jason.encode!(%{availability: availability, session: @session, byte_count: 4})
        StubStreamClient.set_events([{:response, status, [], body}])
        conn = remote_stream()
        assert response(conn, status) == body
        assert get_resp_header(conn, "content-type") == ["application/json; charset=utf-8"]
      end
    end

    test "old owner 404 and 405 without a receipt become unsupported" do
      for {status, body} <- [{404, ~s({"errors":{"detail":"Not Found"}})}, {405, "no route"}] do
        StubStreamClient.set_events([{:response, status, [], body}])

        assert json_response(remote_stream(), 501) == %{
                 "error" => "stream_unsupported",
                 "host" => "owner-a"
               }
      end
    end

    test "other non-stream statuses and bodies pass through without encoding headers" do
      for {status, body} <- [
            {503, ~s({"error":"booting"})},
            {429, ~s({"error":"stream_capacity"})}
          ] do
        StubStreamClient.set_events([
          {:response, status,
           [{"content-type", "application/json"}, {"content-encoding", "gzip"}], body}
        ])

        conn = remote_stream()
        assert response(conn, status) == body
        assert get_resp_header(conn, "content-encoding") == []
      end
    end

    test "a non-SSE success is unsupported and never starts a stream" do
      StubStreamClient.set_events([{:open, [{"content-type", "text/html"}]}])
      assert %{"error" => "stream_unsupported"} = json_response(remote_stream(), 501)
      assert StubStreamClient.nexts() == []
      assert StubStreamClient.cancelled() == [StubStreamClient.last().id]
    end

    test "immediate and asynchronous transport errors return unreachable receipts" do
      StubStreamClient.set_error(:econnrefused)

      assert %{"availability" => "host_unreachable", "host" => "owner-a", "session" => @session} =
               json_response(remote_stream(), 503)

      assert Registry.count(ShuttleWeb.TranscriptStreams) == 0
      StubStreamClient.set_error(nil)

      for event <- [{:error, :closed}, :done] do
        StubStreamClient.set_events([event])
        assert %{"availability" => "host_unreachable"} = json_response(remote_stream(), 503)
        assert StubStreamClient.last().id in StubStreamClient.cancelled()
        assert Registry.count(ShuttleWeb.TranscriptStreams) == 0
      end
    end

    @tag :timing
    test "connect timeout cancels and returns an unreachable receipt" do
      assert %{"availability" => "host_unreachable"} = json_response(remote_stream(), 503)
      assert StubStreamClient.cancelled() == [StubStreamClient.last().id]
      assert Registry.count(ShuttleWeb.TranscriptStreams) == 0
    end

    @tag :timing
    test "idle timeout cancels an open relay" do
      StubStreamClient.set_events([{:open, [{"content-type", "text/event-stream"}]}])

      assert response(remote_stream(), 200) ==
               "\nevent: error\ndata: {\"error\":\"upstream_idle\"}\n\n"

      assert StubStreamClient.cancelled() == [StubStreamClient.last().id]
      assert Registry.count(ShuttleWeb.TranscriptStreams) == 0
    end

    test "errors after opening end the response and flush only that stream's messages" do
      foreign = make_ref()
      send(self(), {:remote_stream, foreign, :done})
      StubStreamClient.set_cancel_events([{:data, "late bytes"}, :done, {:error, :closed}])

      StubStreamClient.set_events([
        {:open, [{"content-type", "text/event-stream"}]},
        {:data, ": open\n\n"},
        {:error, :closed}
      ])

      assert response(remote_stream(), 200) ==
               ": open\n\n\nevent: error\ndata: {\"error\":\"upstream_error\"}\n\n"

      id = StubStreamClient.last().id
      refute_received {:remote_stream, ^id, _}
      assert_received {:remote_stream, ^foreign, :done}
      assert Registry.count(ShuttleWeb.TranscriptStreams) == 0
    end

    test "cleanup drains events queued before the delivery cutoff" do
      StubStreamClient.set_events([{:response, 503, [], ~s({"error":"booting"})}])

      conn =
        local_conn()
        |> register_before_send(fn conn ->
          id = StubStreamClient.last().id
          send(self(), {:remote_stream, id, {:data, "already queued"}})
          send(self(), {:remote_stream, id, :done})
          conn
        end)
        |> get("/api/v1/transcript/stream", %{"session" => @session, "host" => "owner-a"})

      assert response(conn, 503) == ~s({"error":"booting"})
      id = StubStreamClient.last().id
      refute_received {:remote_stream, ^id, _}
    end

    test "completed relays reject deliveries sent after cancellation returns" do
      StubStreamClient.set_events([{:open, [{"content-type", "text/event-stream"}]}, :done])
      assert response(remote_stream(), 200) == ""
      %{owner: owner, id: id} = StubStreamClient.last()

      sender =
        Task.async(fn ->
          for event <- [{:data, "late bytes"}, :done, {:error, :closed}] do
            send(owner, {:remote_stream, id, event})
          end
        end)

      Task.await(sender)
      refute_received {:remote_stream, ^id, _}
      assert StubStreamClient.cancelled() == [id]
      assert Registry.count(ShuttleWeb.TranscriptStreams) == 0
    end

    test "downstream disconnect cancels without asking for more bytes" do
      StubStreamClient.set_events([
        {:open, [{"content-type", "text/event-stream"}]},
        {:data, ": open\n\n"},
        {:data, "unrequested"}
      ])

      conn = %{Plug.Test.conn(:get, "/") | adapter: {RelayClosedAdapter, nil}}

      result =
        ShuttleWeb.TranscriptController.stream(conn, %{"session" => @session, "host" => "owner-a"})

      assert result.status == 200
      id = StubStreamClient.last().id
      assert StubStreamClient.nexts() == [id]
      assert StubStreamClient.cancelled() == [id]
      assert Registry.count(ShuttleWeb.TranscriptStreams) == 0
    end

    test "an exception starting the downstream stream still cancels and unregisters" do
      StubStreamClient.set_events([{:open, [{"content-type", "text/event-stream"}]}])
      conn = %{Plug.Test.conn(:get, "/") | adapter: {BrokenStartAdapter, nil}}

      assert_raise RuntimeError, "send_chunked failed", fn ->
        ShuttleWeb.TranscriptController.stream(conn, %{"session" => @session, "host" => "owner-a"})
      end

      assert StubStreamClient.cancelled() == [StubStreamClient.last().id]
      assert Registry.count(ShuttleWeb.TranscriptStreams) == 0
    end

    test "per-owner cap rejects a 17th relay without blocking other owners or local streams" do
      parent = self()

      tasks =
        for _ <- 1..16 do
          Task.async(fn ->
            :ok = TranscriptStream.admit({:relay, "owner-a"})
            send(parent, :registered)

            receive do
              :stop -> TranscriptStream.release({:relay, "owner-a"})
            end
          end)
        end

      for _ <- tasks, do: assert_receive(:registered, 1000)
      assert json_response(remote_stream(), 429) == %{"error" => "stream_capacity"}
      assert StubStreamClient.last() == nil
      assert :ok = TranscriptStream.admit({:relay, "owner-b"})
      TranscriptStream.release({:relay, "owner-b"})
      assert :ok = TranscriptStream.admit({:local, @session})
      TranscriptStream.release({:local, @session})
      for task <- tasks, do: send(task.pid, :stop)
      for task <- tasks, do: Task.await(task)
      assert Registry.count(ShuttleWeb.TranscriptStreams) == 0
    end

    test "the daemon-wide cap also gates relays before any remote request" do
      Env.put_app_env(:transcript_stream, max_streams: 1)
      assert :ok = TranscriptStream.admit({:local, @session})
      assert json_response(remote_stream(), 429) == %{"error" => "stream_capacity"}
      assert StubStreamClient.last() == nil
      TranscriptStream.release({:local, @session})
      assert Registry.count(ShuttleWeb.TranscriptStreams) == 0
    end
  end

  describe "remote host routing" do
    setup do
      StubGetFileClient.start!()
      Env.put_app_env(:write_forward_client, StubGetFileClient)
      Env.put_app_env(:remotes, [%{name: "candide", url: "http://127.0.0.1:19999"}])

      :ok
    end

    test "receipt marks an owner's available transcript as available_remote" do
      StubGetFileClient.set_response(
        {:ok, 200, "application/json",
         Jason.encode!(%{
           "session" => @session,
           "availability" => "available_local",
           "host" => "dapmcw68",
           "harness" => "codex",
           "source_path" => "/home/cail/.codex/sessions/rollout.jsonl",
           "byte_count" => 4,
           "sha256" => "abcd"
         })}
      )

      body =
        local_conn()
        |> get("/api/v1/transcript", %{"session" => @session, "host" => "candide"})
        |> json_response(200)

      assert body["availability"] == "available_remote"
      assert body["host"] == "candide"
      assert body["source_path"] == "/home/cail/.codex/sessions/rollout.jsonl"
      assert StubGetFileClient.last().url =~ "host=local"
    end

    test "raw remote response is relayed exactly and digested at this hop" do
      bytes = "remote native bytes\n"
      StubGetFileClient.set_response({:ok, 200, "application/x-ndjson", bytes})

      conn =
        local_conn()
        |> get("/api/v1/transcript/raw", %{"session" => @session, "host" => "candide"})

      assert response(conn, 200) == bytes

      assert get_resp_header(conn, "x-transcript-byte-count") == [
               Integer.to_string(byte_size(bytes))
             ]

      assert get_resp_header(conn, "x-transcript-sha256") == [
               Base.encode16(:crypto.hash(:sha256, bytes), case: :lower)
             ]
    end

    test "raw remote offset is forwarded and relayed without a slice digest" do
      StubGetFileClient.set_response({:ok, 200, "application/x-ndjson", "tail"})

      conn =
        local_conn()
        |> get("/api/v1/transcript/raw", %{
          "session" => @session,
          "host" => "candide",
          "offset" => "42"
        })

      assert response(conn, 200) == "tail"
      assert get_resp_header(conn, "x-transcript-offset") == ["42"]
      assert get_resp_header(conn, "x-transcript-sha256") == []

      query =
        StubGetFileClient.last().url |> URI.parse() |> Map.fetch!(:query) |> URI.decode_query()

      assert query["session"] == @session
      assert query["offset"] == "42"
      assert query["host"] == "local"
    end

    test "a client without streaming returns unsupported and an unknown host is unreachable" do
      assert %{"error" => "stream_unsupported", "host" => "candide"} =
               local_conn()
               |> get("/api/v1/transcript/stream", %{"session" => @session, "host" => "candide"})
               |> json_response(501)

      assert %{"availability" => "host_unreachable", "host" => "unknown-host"} =
               local_conn()
               |> get("/api/v1/transcript/stream", %{
                 "session" => @session,
                 "host" => "unknown-host"
               })
               |> json_response(503)
    end

    test "unreachable host is explicit" do
      StubGetFileClient.set_response({:error, :econnrefused})

      assert %{"availability" => "host_unreachable"} =
               local_conn()
               |> get("/api/v1/transcript", %{"session" => @session, "host" => "candide"})
               |> json_response(200)

      assert %{"availability" => "host_unreachable"} =
               local_conn()
               |> get("/api/v1/transcript/raw", %{"session" => @session, "host" => "candide"})
               |> json_response(503)
    end
  end
end
