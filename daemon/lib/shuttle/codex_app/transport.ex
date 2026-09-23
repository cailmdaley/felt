defmodule Shuttle.CodexApp.Transport do
  @moduledoc false

  use GenServer
  import Bitwise

  @max_header_bytes 16 * 1024
  @max_frame_bytes 16 * 1024 * 1024
  @max_message_bytes 16 * 1024 * 1024

  def start_link(opts \\ []) do
    # The named transport is shared by unrelated workers. The process that wins
    # the startup race must not own its lifetime.
    GenServer.start(__MODULE__, opts, name: Keyword.get(opts, :name))
  end

  def request(server, method, params, timeout \\ 25_000)
      when is_binary(method) and is_integer(timeout) and timeout > 0 do
    GenServer.call(server, {:request, method, params, timeout}, timeout + 1_000)
  catch
    :exit, {:timeout, _} -> {:error, :timeout}
    :exit, _ -> {:error, :disconnected}
  end

  def notify(server, method, params) when is_binary(method) do
    GenServer.call(server, {:notify, method, params})
  catch
    :exit, _ -> {:error, :disconnected}
  end

  def close(server) do
    GenServer.stop(server, :normal)
  catch
    :exit, {:noproc, _} -> :ok
    :exit, {:normal, _} -> :ok
    :exit, {{:normal, _}, {GenServer, :stop, _}} -> :ok
  end

  @impl true
  def init(opts) do
    socket_path = Keyword.get(opts, :socket_path, default_socket())
    timeout = Keyword.get(opts, :connect_timeout, 5_000)
    deadline = deadline(timeout)

    with {:ok, socket} <-
           :gen_tcp.connect(
             {:local, String.to_charlist(socket_path)},
             0,
             [:binary, active: false],
             remaining(deadline)
           ),
         {:ok, rest} <- upgrade(socket, deadline),
         {:ok, rest, fragments} <- initialize(socket, rest, deadline),
         :ok <- :inet.setopts(socket, active: true) do
      state = %{socket: socket, buffer: <<>>, fragments: fragments, next_id: 1, pending: %{}}

      case consume_frames(rest, state) do
        {:ok, buffer, state} -> {:ok, %{state | buffer: buffer}}
        {:error, reason, _state} -> {:stop, {:transport, reason}}
      end
    else
      {:error, reason} -> {:stop, {:transport, reason}}
    end
  end

  @impl true
  def handle_call({:request, method, params, timeout}, from, state) do
    id = state.next_id
    message = Jason.encode!(%{"id" => id, "method" => method, "params" => params})

    case send_frame(state.socket, 0x1, message) do
      :ok ->
        timer = Process.send_after(self(), {:rpc_timeout, id}, timeout)
        pending = Map.put(state.pending, id, {from, timer})
        {:noreply, %{state | next_id: id + 1, pending: pending}}

      {:error, reason} ->
        disconnect(state, {:transport, reason}, {:reply, {:error, {:transport, reason}}})
    end
  end

  def handle_call({:notify, method, params}, _from, state) do
    message = Jason.encode!(%{"method" => method, "params" => params})

    case send_frame(state.socket, 0x1, message) do
      :ok ->
        {:reply, :ok, state}

      {:error, reason} ->
        disconnect(state, {:transport, reason}, {:reply, {:error, {:transport, reason}}})
    end
  end

  @impl true
  def handle_info({:tcp, socket, data}, %{socket: socket} = state) do
    case consume_frames(state.buffer <> data, state) do
      {:ok, buffer, state} -> {:noreply, %{state | buffer: buffer}}
      {:error, reason, state} -> disconnect(state, {:transport, reason})
    end
  end

  def handle_info({:tcp_closed, socket}, %{socket: socket} = state),
    do: disconnect(state, :disconnected)

  def handle_info({:tcp_error, socket, reason}, %{socket: socket} = state),
    do: disconnect(state, {:transport, reason})

  def handle_info({:rpc_timeout, id}, state) do
    case Map.pop(state.pending, id) do
      {nil, _} ->
        {:noreply, state}

      {{from, _timer}, pending} ->
        GenServer.reply(from, {:error, :timeout})
        {:noreply, %{state | pending: pending}}
    end
  end

  defp upgrade(socket, deadline) do
    key = :crypto.strong_rand_bytes(16) |> Base.encode64()

    request = [
      "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ",
      key,
      "\r\nSec-WebSocket-Version: 13\r\n\r\n"
    ]

    with :ok <- :gen_tcp.send(socket, request),
         {:ok, headers, rest} <- recv_headers(socket, <<>>, deadline),
         :ok <- verify_upgrade(headers, key) do
      {:ok, rest}
    end
  end

  defp initialize(socket, buffer, deadline) do
    message =
      Jason.encode!(%{
        "id" => 0,
        "method" => "initialize",
        "params" => %{
          "clientInfo" => %{"name" => "felt-shuttle", "version" => Shuttle.version()},
          "capabilities" => %{"experimentalApi" => true}
        }
      })

    with :ok <- send_frame(socket, 0x1, message),
         {:ok, rest, fragments} <- await_initialize(socket, buffer, nil, deadline),
         :ok <-
           send_frame(socket, 0x1, Jason.encode!(%{"method" => "initialized", "params" => %{}})) do
      {:ok, rest, fragments}
    end
  end

  defp await_initialize(socket, buffer, fragments, deadline) do
    case decode_frame(buffer) do
      :more ->
        with {:ok, data} <- recv(socket, deadline),
             :ok <- ensure_buffer_bound(buffer, data) do
          await_initialize(socket, buffer <> data, fragments, deadline)
        end

      {:error, reason} ->
        {:error, reason}

      {:ok, opcode, fin, payload, rest} ->
        case startup_frame(socket, opcode, fin, payload, fragments) do
          {:continue, fragments} ->
            await_initialize(socket, rest, fragments, deadline)

          {:message, payload} ->
            case decode_initialize(payload) do
              :ok -> {:ok, rest, nil}
              :notification -> await_initialize(socket, rest, nil, deadline)
              {:error, reason} -> {:error, reason}
            end

          {:error, reason} ->
            {:error, reason}
        end
    end
  end

  defp startup_frame(_socket, 0x1, false, payload, nil), do: {:continue, payload}
  defp startup_frame(_socket, 0x1, true, payload, nil), do: {:message, payload}

  defp startup_frame(_socket, 0x0, fin, payload, fragments) when is_binary(fragments) do
    with {:ok, joined} <- append_fragment(fragments, payload) do
      if fin, do: {:message, joined}, else: {:continue, joined}
    end
  end

  defp startup_frame(socket, 0x9, true, payload, fragments) do
    case send_frame(socket, 0xA, payload) do
      :ok -> {:continue, fragments}
      {:error, reason} -> {:error, reason}
    end
  end

  defp startup_frame(_socket, 0xA, true, _payload, fragments), do: {:continue, fragments}
  defp startup_frame(_socket, 0x8, true, _payload, _fragments), do: {:error, :closed}

  defp startup_frame(_socket, _opcode, _fin, _payload, _fragments),
    do: {:error, :unsupported_websocket_frame}

  defp decode_initialize(payload) do
    case Jason.decode(payload) do
      {:ok, %{"id" => 0, "result" => _}} -> :ok
      {:ok, %{"id" => 0, "error" => error}} -> {:error, {:peer, error}}
      {:ok, %{"method" => _}} -> :notification
      {:ok, _} -> {:error, :unexpected_initialize_response}
      {:error, _} -> {:error, :invalid_json}
    end
  end

  defp recv_headers(socket, acc, deadline) do
    case :binary.match(acc, "\r\n\r\n") do
      {index, 4} ->
        header_size = index + 4

        if header_size > @max_header_bytes do
          {:error, :headers_too_large}
        else
          <<headers::binary-size(header_size), rest::binary>> = acc
          {:ok, headers, rest}
        end

      :nomatch when byte_size(acc) > @max_header_bytes ->
        {:error, :headers_too_large}

      :nomatch ->
        with {:ok, data} <- recv(socket, deadline) do
          recv_headers(socket, acc <> data, deadline)
        end
    end
  end

  defp recv(socket, deadline) do
    case remaining(deadline) do
      0 -> {:error, :timeout}
      timeout -> :gen_tcp.recv(socket, 0, timeout)
    end
  end

  defp verify_upgrade(headers, key) do
    [status | lines] = String.split(headers, "\r\n", trim: true)

    expected =
      :crypto.hash(:sha, key <> "258EAFA5-E914-47DA-95CA-C5AB0DC85B11") |> Base.encode64()

    header_map =
      Map.new(lines, fn line ->
        case String.split(line, ":", parts: 2) do
          [name, value] -> {String.downcase(name), String.trim(value)}
          _ -> {"", ""}
        end
      end)

    connection_tokens = header_map |> Map.get("connection", "") |> tokens()
    upgrade = header_map |> Map.get("upgrade", "") |> String.downcase()

    if status == "HTTP/1.1 101 Switching Protocols" and upgrade == "websocket" and
         "upgrade" in connection_tokens and
         Map.get(header_map, "sec-websocket-accept") == expected,
       do: :ok,
       else: {:error, :websocket_upgrade_rejected}
  end

  defp tokens(value),
    do: value |> String.downcase() |> String.split(",", trim: true) |> Enum.map(&String.trim/1)

  defp send_frame(socket, opcode, payload) when is_binary(payload) do
    size = byte_size(payload)

    if size > @max_frame_bytes do
      {:error, :frame_too_large}
    else
      mask = :crypto.strong_rand_bytes(4)

      header =
        case size do
          n when n < 126 -> <<0x80 ||| opcode, 0x80 ||| n>>
          n when n <= 65_535 -> <<0x80 ||| opcode, 0x80 ||| 126, n::16>>
          n -> <<0x80 ||| opcode, 0x80 ||| 127, n::64>>
        end

      :gen_tcp.send(socket, [header, mask, mask_payload(payload, mask)])
    end
  end

  defp mask_payload(payload, <<a, b, c, d>>), do: mask_payload(payload, {a, b, c, d}, 0, [])
  defp mask_payload(<<>>, _mask, _index, acc), do: acc |> Enum.reverse() |> IO.iodata_to_binary()

  defp mask_payload(<<byte, rest::binary>>, mask, index, acc),
    do: mask_payload(rest, mask, rem(index + 1, 4), [bxor(byte, elem(mask, index)) | acc])

  defp consume_frames(buffer, state) do
    case decode_frame(buffer) do
      :more ->
        if byte_size(buffer) > @max_frame_bytes + 14,
          do: {:error, :frame_too_large, state},
          else: {:ok, buffer, state}

      {:error, reason} ->
        {:error, reason, state}

      {:ok, opcode, fin, payload, rest} ->
        case handle_frame(opcode, fin, payload, state) do
          {:ok, state} -> consume_frames(rest, state)
          {:error, reason, state} -> {:error, reason, state}
        end
    end
  end

  defp decode_frame(<<first, second, rest::binary>>) do
    fin = (first &&& 0x80) != 0
    rsv = first &&& 0x70
    opcode = first &&& 0x0F
    masked = (second &&& 0x80) != 0
    length_code = second &&& 0x7F

    cond do
      rsv != 0 -> {:error, :reserved_websocket_bits}
      masked -> {:error, :masked_server_frame}
      opcode not in [0x0, 0x1, 0x8, 0x9, 0xA] -> {:error, :unsupported_websocket_frame}
      opcode >= 0x8 and not fin -> {:error, :fragmented_control_frame}
      opcode >= 0x8 and length_code > 125 -> {:error, :control_frame_too_large}
      true -> decode_payload(opcode, fin, length_code, rest)
    end
  end

  defp decode_frame(_), do: :more

  defp decode_payload(opcode, fin, length_code, rest) do
    case frame_length(length_code, rest) do
      :more ->
        :more

      {:error, reason} ->
        {:error, reason}

      {:ok, length, _} when length > @max_frame_bytes ->
        {:error, :frame_too_large}

      {:ok, length, payload_rest} when byte_size(payload_rest) < length ->
        :more

      {:ok, length, payload_rest} ->
        <<payload::binary-size(length), tail::binary>> = payload_rest
        {:ok, opcode, fin, payload, tail}
    end
  end

  defp frame_length(n, rest) when n < 126, do: {:ok, n, rest}

  defp frame_length(126, <<n::16, _::binary>>) when n < 126,
    do: {:error, :noncanonical_frame_length}

  defp frame_length(126, <<n::16, rest::binary>>), do: {:ok, n, rest}
  defp frame_length(126, _), do: :more
  defp frame_length(127, <<1::1, _::63, _::binary>>), do: {:error, :invalid_frame_length}

  defp frame_length(127, <<n::64, _::binary>>) when n <= 65_535,
    do: {:error, :noncanonical_frame_length}

  defp frame_length(127, <<n::64, _::binary>>) when n > @max_frame_bytes,
    do: {:error, :frame_too_large}

  defp frame_length(127, <<n::64, rest::binary>>), do: {:ok, n, rest}
  defp frame_length(127, _), do: :more

  defp handle_frame(0x1, true, payload, %{fragments: nil} = state), do: dispatch(payload, state)

  defp handle_frame(0x1, false, payload, %{fragments: nil} = state),
    do: {:ok, %{state | fragments: payload}}

  defp handle_frame(0x0, fin, payload, %{fragments: fragments} = state)
       when is_binary(fragments) do
    case append_fragment(fragments, payload) do
      {:ok, joined} ->
        if fin,
          do: dispatch(joined, %{state | fragments: nil}),
          else: {:ok, %{state | fragments: joined}}

      {:error, reason} ->
        {:error, reason, state}
    end
  end

  defp handle_frame(0x9, true, payload, state) do
    case send_frame(state.socket, 0xA, payload) do
      :ok -> {:ok, state}
      {:error, reason} -> {:error, reason, state}
    end
  end

  defp handle_frame(0xA, true, _payload, state), do: {:ok, state}
  defp handle_frame(0x8, true, _payload, state), do: {:error, :closed, state}
  defp handle_frame(_, _, _, state), do: {:error, :unexpected_websocket_frame, state}

  defp append_fragment(left, right) when byte_size(left) + byte_size(right) <= @max_message_bytes,
    do: {:ok, left <> right}

  defp append_fragment(_left, _right), do: {:error, :message_too_large}

  defp dispatch(payload, state) do
    case Jason.decode(payload) do
      {:ok, %{"method" => method, "id" => id}} ->
        # A server request may require a human decision. This headless client
        # cannot answer truthfully, so fail the connection and its callers
        # instead of manufacturing an approval or denial.
        {:error, {:unsupported_server_request, method, id}, state}

      {:ok, %{"id" => id} = message} ->
        dispatch_response(id, message, state)

      {:ok, %{"method" => _notification}} ->
        {:ok, state}

      {:ok, _} ->
        {:error, :invalid_rpc_message, state}

      {:error, _} ->
        {:error, :invalid_json, state}
    end
  end

  defp dispatch_response(id, message, state) do
    case Map.pop(state.pending, id) do
      {nil, _} ->
        {:ok, state}

      {{from, timer}, pending} ->
        Process.cancel_timer(timer)

        reply =
          cond do
            Map.has_key?(message, "error") -> {:error, {:peer, message["error"]}}
            Map.has_key?(message, "result") -> {:ok, message["result"]}
            true -> {:error, {:transport, :malformed_response}}
          end

        GenServer.reply(from, reply)
        {:ok, %{state | pending: pending}}
    end
  end

  defp ensure_buffer_bound(buffer, data) do
    if byte_size(buffer) + byte_size(data) <= @max_frame_bytes + 14,
      do: :ok,
      else: {:error, :frame_too_large}
  end

  defp deadline(timeout), do: System.monotonic_time(:millisecond) + timeout
  defp remaining(deadline), do: max(deadline - System.monotonic_time(:millisecond), 0)

  defp default_socket do
    home =
      case System.get_env("CODEX_HOME") do
        value when value in [nil, ""] -> Path.join(System.user_home!(), ".codex")
        value -> value
      end

    case System.get_env("SHUTTLE_CODEX_SOCKET") do
      value when value in [nil, ""] ->
        Path.join([home, "app-server-control", "app-server-control.sock"])

      value ->
        value
    end
  end

  defp disconnect(state, reason, return \\ nil) do
    Enum.each(state.pending, fn {_id, {from, timer}} ->
      Process.cancel_timer(timer)
      GenServer.reply(from, {:error, reason})
    end)

    state = %{state | pending: %{}}

    case return do
      nil -> {:stop, :normal, state}
      {:reply, reply} -> {:stop, :normal, reply, state}
    end
  end
end
