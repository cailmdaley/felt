defmodule Shuttle.CodexApp.TransportTest do
  use ExUnit.Case, async: false

  import Bitwise

  alias Shuttle.CodexApp
  alias Shuttle.CodexApp.Transport

  @client Shuttle.CodexApp.Client

  setup do
    if pid = Process.whereis(@client), do: Transport.close(pid)
    previous = Application.get_env(:shuttle, :codex_app_transport_opts)

    on_exit(fn ->
      if pid = Process.whereis(@client), do: Transport.close(pid)

      if previous,
        do: Application.put_env(:shuttle, :codex_app_transport_opts, previous),
        else: Application.delete_env(:shuttle, :codex_app_transport_opts)
    end)

    :ok
  end

  test "preserves upgrade bytes and handles segmented, fragmented, ping, and coalesced startup frames" do
    {path, peer} =
      start_peer(fn socket ->
        upgrade = upgrade_response(socket)
        ping = frame("during-upgrade", 0x9)
        send_segmented(socket, upgrade <> ping, [1, 2, 3, 5, 8, 13])

        assert_request(socket, "initialize")
        assert %{opcode: 0xA, payload: "during-upgrade"} = recv_frame(socket)

        json = Jason.encode!(%{"id" => 0, "result" => %{}})
        pivot = div(byte_size(json), 2)
        <<left::binary-size(pivot), right::binary>> = json

        startup =
          frame(Jason.encode!(%{"method" => "account/updated", "params" => %{}})) <>
            frame(left, 0x1, false) <>
            frame("middle", 0x9) <>
            frame(right, 0x0, true) <>
            frame(Jason.encode!(%{"method" => "thread/started", "params" => %{}}))

        send_segmented(socket, startup, deterministic_segments(byte_size(startup), 73))
        assert %{opcode: 0xA, payload: "middle"} = recv_frame(socket)
        assert_request(socket, "initialized")
        assert %{"id" => id, "method" => "works"} = recv_json(socket)

        :ok =
          :gen_tcp.send(socket, frame(Jason.encode!(%{"id" => id, "result" => %{"ok" => true}})))
      end)

    {:ok, client} = Transport.start_link(socket_path: path, connect_timeout: 1_000)
    assert {:ok, %{"ok" => true}} = Transport.request(client, "works", %{}, 1_000)
    if Process.alive?(client), do: Transport.close(client)
    await_peer(peer)
  end

  test "matches concurrent replies by id when they arrive out of order" do
    {path, peer} =
      initialized_peer(fn socket ->
        requests = Enum.map(1..24, fn _ -> recv_json(socket) end)

        requests
        |> Enum.reverse()
        |> Enum.each(fn %{"id" => id, "params" => %{"value" => value}} ->
          bytes = frame(Jason.encode!(%{"id" => id, "result" => value}))
          send_segmented(socket, bytes, deterministic_segments(byte_size(bytes), id + 1))
        end)
      end)

    {:ok, client} = Transport.start_link(socket_path: path)

    tasks =
      for value <- 1..24 do
        Task.async(fn ->
          {value, Transport.request(client, "echo", %{"value" => value}, 2_000)}
        end)
      end

    assert Enum.sort(Enum.map(tasks, &Task.await(&1, 3_000))) ==
             Enum.map(1..24, &{&1, {:ok, &1}})

    await_peer(peer)
  end

  test "encodes and decodes the 16-bit and 64-bit frame length boundaries" do
    {path, peer} =
      initialized_peer(fn socket ->
        Enum.each([{1, 126}, {2, 65_536}], fn {expected_id, size} ->
          received = recv_frame(socket)
          assert byte_size(received.payload) == size
          assert %{"id" => ^expected_id, "method" => "boundary"} = Jason.decode!(received.payload)

          response = json_of_size(%{"id" => expected_id, "result" => %{"pad" => ""}}, size)
          bytes = frame(response)

          send_segmented(
            socket,
            bytes,
            [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987] ++
              List.duplicate(997, 70)
          )
        end)
      end)

    {:ok, client} = Transport.start_link(socket_path: path)

    Enum.each([126, 65_536], fn size ->
      id = if size == 126, do: 1, else: 2
      params = params_for_json_size(id, size)
      assert {:ok, %{"pad" => pad}} = Transport.request(client, "boundary", params, 2_000)
      assert byte_size(Jason.encode!(%{"id" => id, "result" => %{"pad" => pad}})) == size
    end)

    await_peer(peer)
  end

  test "rejects bad websocket status and accept headers" do
    Enum.each([:status, :accept], fn fault ->
      {path, peer} =
        start_peer(fn socket ->
          response = upgrade_response(socket)

          response =
            case fault do
              :status ->
                String.replace(response, "101 Switching Protocols", "200 OK")

              :accept ->
                String.replace(
                  response,
                  ~r/Sec-WebSocket-Accept: [^\r]+/,
                  "Sec-WebSocket-Accept: wrong"
                )
            end

          :ok = :gen_tcp.send(socket, response)
        end)

      assert {:error, {:transport, :websocket_upgrade_rejected}} =
               Transport.start_link(socket_path: path, connect_timeout: 500)

      await_peer(peer)
    end)
  end

  test "handshake timeout is an absolute deadline despite trickled bytes" do
    {path, peer} =
      start_peer(fn socket ->
        {:ok, _headers} = recv_until(socket, <<>>, "\r\n\r\n")

        Enum.reduce_while(1..20, :ok, fn _, _ ->
          Process.sleep(10)

          case :gen_tcp.send(socket, "x") do
            :ok -> {:cont, :ok}
            {:error, _} -> {:halt, :ok}
          end
        end)
      end)

    started = System.monotonic_time(:millisecond)

    assert {:error, {:transport, :timeout}} =
             Transport.start_link(socket_path: path, connect_timeout: 50)

    assert System.monotonic_time(:millisecond) - started < 180
    await_peer(peer)
  end

  test "times out one request, ignores its late response, and continues" do
    {path, peer} =
      initialized_peer(fn socket ->
        %{"id" => late_id} = assert_request(socket, "late")
        Process.sleep(50)
        :ok = :gen_tcp.send(socket, frame(Jason.encode!(%{"id" => late_id, "result" => "late"})))
        %{"id" => next_id} = assert_request(socket, "after")
        :ok = :gen_tcp.send(socket, frame(Jason.encode!(%{"id" => next_id, "result" => "after"})))
      end)

    {:ok, client} = Transport.start_link(socket_path: path)
    assert {:error, :timeout} = Transport.request(client, "late", %{}, 20)
    assert {:ok, "after"} = Transport.request(client, "after", %{}, 1_000)
    await_peer(peer)
  end

  test "fails every pending RPC when the peer disconnects" do
    {path, peer} =
      initialized_peer(fn socket ->
        Enum.each(1..3, fn _ -> assert_request(socket, "pending") end)
        :gen_tcp.close(socket)
      end)

    {:ok, client} = Transport.start_link(socket_path: path)

    tasks =
      for _ <- 1..3, do: Task.async(fn -> Transport.request(client, "pending", %{}, 2_000) end)

    assert Enum.map(tasks, &Task.await(&1, 3_000)) == List.duplicate({:error, :disconnected}, 3)
    await_peer(peer)
  end

  test "does not answer a server decision request and reports it to pending callers" do
    {path, peer} =
      initialized_peer(fn socket ->
        %{"id" => rpc_id} = assert_request(socket, "pending")

        :ok =
          :gen_tcp.send(
            socket,
            frame(
              Jason.encode!(%{
                "id" => rpc_id,
                "method" => "item/commandExecution/requestApproval",
                "params" => %{}
              })
            )
          )

        assert {:error, :closed} = :gen_tcp.recv(socket, 0, 1_000)
      end)

    {:ok, client} = Transport.start_link(socket_path: path)

    assert {:error,
            {:transport,
             {:unsupported_server_request, "item/commandExecution/requestApproval", 1}}} =
             Transport.request(client, "pending", %{}, 1_000)

    await_peer(peer)
  end

  test "rejects malformed and oversized server frames without retaining pending calls" do
    malformed = [
      <<0xC1, 0x00>>,
      <<0x81, 0x80, 0, 0, 0, 0>>,
      <<0x09, 126, 0, 126>>,
      <<0x81, 127, 0, 0, 0, 0, 1, 0, 0, 1>>
    ]

    Enum.each(malformed, fn bytes ->
      {path, peer} =
        initialized_peer(fn socket ->
          assert_request(socket, "pending")
          :ok = :gen_tcp.send(socket, bytes)
        end)

      {:ok, client} = Transport.start_link(socket_path: path)
      assert {:error, {:transport, _}} = Transport.request(client, "pending", %{}, 1_000)
      await_peer(peer)
    end)
  end

  test "close frames and malformed JSON fail pending requests" do
    Enum.each([frame(<<>>, 0x8), frame("{not json")], fn bytes ->
      {path, peer} =
        initialized_peer(fn socket ->
          assert_request(socket, "pending")
          :ok = :gen_tcp.send(socket, bytes)
        end)

      {:ok, client} = Transport.start_link(socket_path: path)
      assert {:error, {:transport, _}} = Transport.request(client, "pending", %{}, 1_000)
      await_peer(peer)
    end)
  end

  test "a registered transport has exactly one winner under concurrent startup" do
    name = Module.concat(__MODULE__, Singleton)

    {path, peer} =
      initialized_peer(fn socket ->
        assert {:error, :closed} = :gen_tcp.recv(socket, 0, 2_000)
      end)

    tasks =
      for _ <- 1..16,
          do: Task.async(fn -> Transport.start_link(socket_path: path, name: name) end)

    results = Enum.map(tasks, &Task.await(&1, 2_000))
    winners = for {:ok, pid} <- results, do: pid
    existing = for {:error, {:already_started, pid}} <- results, do: pid

    assert [winner] = Enum.uniq(winners)
    assert Enum.all?(existing, &(&1 == winner))
    assert length(existing) == 15
    Transport.close(winner)
    await_peer(peer)
  end

  test "adapter reuses a project found on a later page and sends workspace roots" do
    cwd = Path.join(System.tmp_dir!(), "codex-project")
    felt = Path.join(System.tmp_dir!(), "codex-felt")

    {path, peer} =
      initialized_peer(fn socket ->
        assert %{"id" => first, "method" => "project/list", "params" => %{"cursor" => nil}} =
                 recv_json(socket)

        send_result(socket, first, %{"data" => [], "nextCursor" => "page-2"})

        assert %{"id" => second, "method" => "project/list", "params" => %{"cursor" => "page-2"}} =
                 recv_json(socket)

        send_result(socket, second, %{
          "data" => [%{"id" => "existing", "roots" => [%{"path" => cwd}]}],
          "nextCursor" => nil
        })

        assert %{"id" => start_id, "method" => "thread/start", "params" => params} =
                 recv_json(socket)

        assert params["projectId"] == "existing"
        assert params["runtimeWorkspaceRoots"] == [cwd, felt]
        send_result(socket, start_id, %{"thread" => %{"id" => "thread-1"}})

        assert %{
                 "id" => name_id,
                 "method" => "thread/name/set",
                 "params" => %{"threadId" => "thread-1", "name" => "Friendly fiber"}
               } = recv_json(socket)

        send_result(socket, name_id, %{})
      end)

    configure_adapter(path)

    assert {:ok, %{"id" => "thread-1", "projectId" => "existing"}} =
             CodexApp.start_thread(cwd: cwd, felt_store: felt)

    assert :ok = CodexApp.name_thread("thread-1", "Friendly fiber")

    await_peer(peer)
  end

  test "adapter returns typed errors for malformed turn and project responses" do
    {path, peer} =
      initialized_peer(fn socket ->
        %{"id" => turn_id, "method" => "turn/start"} = recv_json(socket)
        send_result(socket, turn_id, %{})
        %{"id" => project_id, "method" => "project/list"} = recv_json(socket)
        send_result(socket, project_id, %{"data" => "not-a-list"})
      end)

    configure_adapter(path)

    assert {:error, {:transport, :malformed_turn_response}} =
             CodexApp.start_turn("thread-1", "hello")

    assert {:error, {:transport, :malformed_project_response}} =
             CodexApp.start_thread(cwd: System.tmp_dir!())

    await_peer(peer)
  end

  test "adapter keeps state errors unknown and distinguishes idle from unresolved active turns" do
    {path, peer} =
      initialized_peer(fn socket ->
        %{"id" => state_id, "method" => "thread/read"} = recv_json(socket)
        send_error(socket, state_id, %{"code" => -32_000, "message" => "not found"})

        %{"id" => read_id, "method" => "thread/read"} = recv_json(socket)

        send_result(socket, read_id, %{
          "thread" => %{"id" => "thread-1", "status" => %{"type" => "active"}, "turns" => []}
        })

        %{"id" => idle_id, "method" => "thread/read"} = recv_json(socket)

        send_result(socket, idle_id, %{
          "thread" => %{"id" => "thread-2", "status" => %{"type" => "idle"}, "turns" => []}
        })
      end)

    configure_adapter(path)
    assert :unknown = CodexApp.state("unknown")
    assert {:error, :active_turn_unresolved} = CodexApp.interrupt("thread-1")
    assert :ok = CodexApp.interrupt("thread-2")
    await_peer(peer)
  end

  test "interrupt resumes an unloaded thread before resolving its active turn" do
    thread_id = "00000000-0000-4000-8000-000000000001"

    {path, peer} =
      initialized_peer(fn socket ->
        %{"id" => read_id, "method" => "thread/read"} = recv_json(socket)

        send_error(socket, read_id, %{
          "code" => -32_600,
          "message" => "thread not loaded: #{thread_id}"
        })

        assert %{
                 "id" => resume_id,
                 "method" => "thread/resume",
                 "params" => %{"threadId" => ^thread_id}
               } =
                 recv_json(socket)

        send_result(socket, resume_id, %{
          "thread" => %{
            "id" => thread_id,
            "status" => %{"type" => "active"},
            "turns" => [%{"id" => "turn-1", "status" => "inProgress"}]
          }
        })

        assert %{
                 "id" => interrupt_id,
                 "method" => "turn/interrupt",
                 "params" => %{"turnId" => "turn-1"}
               } =
                 recv_json(socket)

        send_result(socket, interrupt_id, %{})
      end)

    configure_adapter(path)
    assert :ok = CodexApp.interrupt(thread_id)
    await_peer(peer)
  end

  test "interrupt surfaces the confirmed missing error after unloaded read and resume" do
    thread_id = "00000000-0000-4000-8000-000000000000"
    missing = %{"code" => -32_600, "message" => "no rollout found for thread id #{thread_id}"}

    {path, peer} =
      initialized_peer(fn socket ->
        %{"id" => read_id, "method" => "thread/read"} = recv_json(socket)

        send_error(socket, read_id, %{
          "code" => -32_600,
          "message" => "thread not loaded: #{thread_id}"
        })

        %{"id" => resume_id, "method" => "thread/resume"} = recv_json(socket)
        send_error(socket, resume_id, missing)
      end)

    configure_adapter(path)
    assert {:error, :thread_missing} = CodexApp.interrupt(thread_id)
    await_peer(peer)
  end

  test "adapter reconnects on the next call after the shared transport disconnects" do
    {first_path, first_peer} =
      initialized_peer(fn socket ->
        %{"id" => id, "method" => "thread/read"} = recv_json(socket)
        send_error(socket, id, %{"code" => -32_000, "message" => "unavailable"})
      end)

    configure_adapter(first_path)
    assert :unknown = CodexApp.state("thread-1")
    await_peer(first_peer)
    wait_until(fn -> Process.whereis(@client) == nil end)

    {second_path, second_peer} =
      initialized_peer(fn socket ->
        %{"id" => id, "method" => "thread/read"} = recv_json(socket)
        send_result(socket, id, %{"thread" => %{"status" => %{"type" => "idle"}}})
      end)

    configure_adapter(second_path)
    assert :idle = CodexApp.state("thread-1")
    await_peer(second_peer)
  end

  defp configure_adapter(path) do
    Application.put_env(:shuttle, :codex_app_transport_opts,
      socket_path: path,
      connect_timeout: 1_000
    )
  end

  defp initialized_peer(handler) do
    start_peer(fn socket ->
      :ok = :gen_tcp.send(socket, upgrade_response(socket))
      assert_request(socket, "initialize")
      :ok = :gen_tcp.send(socket, frame(Jason.encode!(%{"id" => 0, "result" => %{}})))
      assert_request(socket, "initialized")
      handler.(socket)
    end)
  end

  defp start_peer(handler) do
    path = Path.join(System.tmp_dir!(), "felt-codex-#{System.unique_integer([:positive])}.sock")

    {:ok, listen} =
      :gen_tcp.listen(0, [:binary, active: false, ifaddr: {:local, String.to_charlist(path)}])

    task =
      Task.async(fn ->
        {:ok, socket} = :gen_tcp.accept(listen)

        try do
          handler.(socket)
        after
          :gen_tcp.close(socket)
          :gen_tcp.close(listen)
          File.rm(path)
        end
      end)

    {path, task}
  end

  defp upgrade_response(socket) do
    {:ok, headers} = recv_until(socket, <<>>, "\r\n\r\n")

    key =
      headers
      |> String.split("Sec-WebSocket-Key: ")
      |> Enum.at(1)
      |> String.split("\r\n")
      |> hd()

    accept = :crypto.hash(:sha, key <> "258EAFA5-E914-47DA-95CA-C5AB0DC85B11") |> Base.encode64()

    "HTTP/1.1 101 Switching Protocols\r\n" <>
      "Upgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n" <>
      "Sec-WebSocket-Accept: #{accept}\r\n\r\n"
  end

  defp recv_until(socket, acc, needle) do
    if :binary.match(acc, needle) != :nomatch do
      {:ok, acc}
    else
      with {:ok, data} <- :gen_tcp.recv(socket, 0, 1_000),
           do: recv_until(socket, acc <> data, needle)
    end
  end

  defp assert_request(socket, method) do
    message = recv_json(socket)
    assert %{"method" => ^method} = message
    message
  end

  defp recv_json(socket), do: socket |> recv_frame() |> Map.fetch!(:payload) |> Jason.decode!()

  defp recv_frame(socket) do
    <<first, second>> = recv_exact(socket, 2)
    length_code = second &&& 0x7F

    length =
      case length_code do
        n when n < 126 ->
          n

        126 ->
          <<n::16>> = recv_exact(socket, 2)
          n

        127 ->
          <<n::64>> = recv_exact(socket, 8)
          n
      end

    mask = if (second &&& 0x80) != 0, do: recv_exact(socket, 4), else: nil
    payload = recv_exact(socket, length)
    payload = if mask, do: apply_mask(payload, mask), else: payload
    %{opcode: first &&& 0x0F, fin: (first &&& 0x80) != 0, payload: payload}
  end

  defp recv_exact(_socket, 0), do: <<>>

  defp recv_exact(socket, count) do
    {:ok, data} = :gen_tcp.recv(socket, count, 1_000)
    data
  end

  defp apply_mask(payload, mask) do
    payload
    |> :binary.bin_to_list()
    |> Enum.with_index()
    |> Enum.map(fn {byte, index} -> bxor(byte, :binary.at(mask, rem(index, 4))) end)
    |> :erlang.list_to_binary()
  end

  defp frame(payload, opcode \\ 0x1, fin \\ true) do
    first = if(fin, do: 0x80, else: 0) ||| opcode
    size = byte_size(payload)

    header =
      cond do
        size < 126 -> <<first, size>>
        size <= 65_535 -> <<first, 126, size::16>>
        true -> <<first, 127, size::64>>
      end

    header <> payload
  end

  defp send_result(socket, id, result),
    do: :gen_tcp.send(socket, frame(Jason.encode!(%{"id" => id, "result" => result})))

  defp send_error(socket, id, error),
    do: :gen_tcp.send(socket, frame(Jason.encode!(%{"id" => id, "error" => error})))

  defp send_segmented(socket, bytes, sizes) do
    {chunks, tail} =
      Enum.reduce_while(sizes, {[], bytes}, fn size, {chunks, rest} ->
        if rest == <<>> do
          {:halt, {chunks, rest}}
        else
          take = min(size, byte_size(rest))
          <<chunk::binary-size(take), rest::binary>> = rest
          {:cont, {[chunk | chunks], rest}}
        end
      end)

    Enum.each(Enum.reverse(chunks) ++ if(tail == <<>>, do: [], else: [tail]), fn chunk ->
      :ok = :gen_tcp.send(socket, chunk)
    end)
  end

  defp params_for_json_size(id, target) do
    base = Jason.encode!(%{"id" => id, "method" => "boundary", "params" => %{"pad" => ""}})
    %{"pad" => String.duplicate("x", target - byte_size(base))}
  end

  defp json_of_size(message, target) do
    base = Jason.encode!(message)

    put_in(message, ["result", "pad"], String.duplicate("x", target - byte_size(base)))
    |> Jason.encode!()
  end

  defp deterministic_segments(total, seed) do
    Stream.unfold(seed, fn state ->
      next = rem(state * 48_271, 2_147_483_647)
      {rem(next, 11) + 1, next}
    end)
    |> Enum.take(total)
  end

  defp await_peer(task) do
    case Task.yield(task, 2_000) || Task.shutdown(task) do
      {:ok, result} -> result
      nil -> flunk("fake Codex peer did not finish")
    end
  end

  defp wait_until(predicate, attempts \\ 100)
  defp wait_until(predicate, 0), do: assert(predicate.())

  defp wait_until(predicate, attempts) do
    if predicate.() do
      :ok
    else
      Process.sleep(5)
      wait_until(predicate, attempts - 1)
    end
  end
end
