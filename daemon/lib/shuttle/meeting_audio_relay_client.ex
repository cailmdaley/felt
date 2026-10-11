defmodule Shuttle.MeetingAudioRelay.Client do
  @moduledoc """
  Single-use RFC 6455 client for recorder forwarding. The calling WebSock
  process owns the socket; its death closes the connection even on an abnormal
  exit. No worker, reconnect queue, or audio replay exists.

  HTTPS follows the same transport selection as RemoteRegistry.Client.Default:
  a configured private TailnetDial bridge is mandatory, otherwise an allowed
  HTTPS proxy or certificate-verified direct TLS is used.
  """
  import Bitwise
  @limit 1_000_000
  @timeout 5_000

  def connect(url, timeout \\ @timeout) do
    uri = URI.parse(url)
    deadline = System.monotonic_time(:millisecond) + timeout

    with {:ok, {transport, socket}} <- dial(uri, deadline) do
      state = %{transport: transport, socket: socket, buffer: <<>>, fragment: nil}
      key = Base.encode64(:crypto.strong_rand_bytes(16))
      path = (uri.path || "/") <> if(uri.query, do: "?" <> uri.query, else: "")

      request = [
        "GET ",
        path,
        " HTTP/1.1\r\nHost: ",
        authority(uri),
        "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ",
        key,
        "\r\nSec-WebSocket-Version: 13\r\n\r\n"
      ]

      result =
        with :ok <- transport.send(socket, request),
             {:ok, headers, rest} <- headers(state, <<>>, deadline),
             :ok <- verify(headers, key),
             :ok <- active_once(state),
             do: {:ok, %{state | buffer: rest}}

      case result do
        {:ok, _} ->
          result

        {:error, _} ->
          close(state)
          result
      end
    end
  end

  def send_frame(state, opcode, payload) when byte_size(payload) <= @limit do
    op = %{text: 1, binary: 2, close: 8, ping: 9, pong: 10}[opcode]
    mask = :crypto.strong_rand_bytes(4)
    n = byte_size(payload)

    size =
      cond do
        n < 126 -> <<0x80 ||| n>>
        n <= 65_535 -> <<254, n::16>>
        true -> <<255, n::64>>
      end

    state.transport.send(state.socket, [<<0x80 ||| op>>, size, mask, mask(payload, mask)])
  end

  def send_frame(_state, _opcode, _payload), do: {:error, :frame_too_large}

  def close(state), do: state.transport.close(state.socket)

  def active_once(%{transport: :gen_tcp, socket: socket}),
    do: :inet.setopts(socket, active: :once)

  def active_once(%{transport: :ssl, socket: socket}), do: :ssl.setopts(socket, active: :once)

  # Only incomplete wire frames/messages are accumulated, bounded to one MiB.
  def consume(state, data) do
    parse(%{state | buffer: state.buffer <> data}, [])
  end

  defp parse(state, acc) do
    case decode(state.buffer) do
      :more when byte_size(state.buffer) <= @limit + 14 ->
        {:ok, Enum.reverse(acc), state}

      :more ->
        {:error, :frame_too_large}

      {:error, reason} ->
        {:error, reason}

      {:ok, op, fin, body, rest} ->
        state = %{state | buffer: rest}

        case message(op, fin, body, state) do
          {:ok, nil, state} -> parse(state, acc)
          {:ok, frame, state} -> parse(state, [frame | acc])
          {:error, reason} -> {:error, reason}
        end
    end
  end

  defp message(op, true, body, state) when op in [8, 9, 10] do
    cond do
      op == 8 and byte_size(body) == 1 ->
        {:error, :invalid_close}

      op == 8 and byte_size(body) >= 2 ->
        <<code::16, reason::binary>> = body

        if valid_code?(code) and String.valid?(reason),
          do: {:ok, {:close, code, reason}, state},
          else: {:error, :invalid_close}

      op == 8 ->
        {:ok, {:close, 1000, ""}, state}

      op == 9 ->
        {:ok, {:ping, body}, state}

      op == 10 ->
        {:ok, {:pong, body}, state}
    end
  end

  defp message(op, fin, body, %{fragment: nil} = state) when op in [1, 2] do
    if fin, do: completed(op, body, state), else: {:ok, nil, %{state | fragment: {op, body}}}
  end

  defp message(0, fin, body, %{fragment: {op, fragment}} = state) do
    if byte_size(fragment) + byte_size(body) <= @limit do
      body = fragment <> body

      if fin,
        do: completed(op, body, %{state | fragment: nil}),
        else: {:ok, nil, %{state | fragment: {op, body}}}
    else
      {:error, :message_too_large}
    end
  end

  defp message(_, _, _, _), do: {:error, :unexpected_frame}

  defp completed(1, body, state) do
    if String.valid?(body), do: {:ok, {:text, body}, state}, else: {:error, :invalid_text}
  end

  defp completed(2, body, state), do: {:ok, {:binary, body}, state}

  defp valid_code?(n),
    do:
      n in [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014] or
        n in 3000..4999

  defp decode(<<first, second, rest::binary>>) do
    op = first &&& 15
    fin = (first &&& 128) != 0
    n = second &&& 127

    cond do
      (first &&& 112) != 0 or second >= 128 -> {:error, :invalid_server_frame}
      op not in [0, 1, 2, 8, 9, 10] -> {:error, :invalid_opcode}
      op >= 8 and (not fin or n > 125) -> {:error, :invalid_control_frame}
      true -> payload(op, fin, n, rest)
    end
  end

  defp decode(_), do: :more

  defp payload(op, fin, n, rest) do
    case length_field(n, rest) do
      {:ok, size, _} when size > @limit ->
        {:error, :frame_too_large}

      {:ok, size, rest} when byte_size(rest) >= size ->
        <<body::binary-size(size), tail::binary>> = rest
        {:ok, op, fin, body, tail}

      {:ok, _, _} ->
        :more

      other ->
        other
    end
  end

  defp length_field(n, rest) when n < 126, do: {:ok, n, rest}
  defp length_field(126, <<n::16, rest::binary>>) when n >= 126, do: {:ok, n, rest}
  defp length_field(127, <<0::1, n::63, rest::binary>>) when n > 65_535, do: {:ok, n, rest}
  defp length_field(126, rest) when byte_size(rest) < 2, do: :more
  defp length_field(127, rest) when byte_size(rest) < 8, do: :more
  defp length_field(_, _), do: {:error, :invalid_length}

  defp mask(payload, <<a, b, c, d>>) do
    # crypto's C implementation avoids allocating a list per audio byte.
    key =
      binary_part(
        :binary.copy(<<a, b, c, d>>, div(byte_size(payload) + 3, 4)),
        0,
        byte_size(payload)
      )

    :crypto.exor(payload, key)
  end

  defp dial(%URI{scheme: "https", host: host, port: port} = uri, deadline) do
    cond do
      Shuttle.Remotes.tailscale_socket_configured?() ->
        if is_nil(Shuttle.Remotes.tailscale_socket()) do
          {:error, {:tailnet_dial, :invalid_tailscale_socket}}
        else
          case Shuttle.TailnetDial.socket_for(String.downcase(host), port) do
            path when is_binary(path) -> tcp({:local, String.to_charlist(path)}, 0, deadline)
            nil -> {:error, {:tailnet_dial, :no_bridge}}
          end
        end

      true ->
        dial_https(uri, Shuttle.Remotes.https_proxy(), deadline)
    end
  end

  defp dial(%URI{scheme: "http", host: host, port: port}, deadline),
    do: tcp(String.to_charlist(host), port, deadline)

  defp dial(_, _), do: {:error, :invalid_url}

  defp tcp(host, port, deadline) do
    case :gen_tcp.connect(
           host,
           port,
           [:binary, active: false, send_timeout: @timeout, send_timeout_close: true],
           remaining(deadline)
         ) do
      {:ok, socket} -> {:ok, {:gen_tcp, socket}}
      error -> error
    end
  end

  defp dial_https(uri, nil, deadline) do
    {:ok, _} = Application.ensure_all_started(:ssl)

    case :ssl.connect(
           String.to_charlist(uri.host),
           uri.port,
           tls_opts(uri.host),
           remaining(deadline)
         ) do
      {:ok, socket} -> {:ok, {:ssl, socket}}
      error -> error
    end
  end

  defp dial_https(uri, {host, port}, deadline) do
    cond do
      Shuttle.host_class() != :single_user ->
        {:error, :https_proxy_refused}

      String.downcase(uri.host) in ["localhost", "127.0.0.1", "::1"] ->
        dial_https(uri, nil, deadline)

      true ->
        with {:ok, {_, socket}} <- tcp(String.to_charlist(host), port, deadline) do
          state = %{transport: :gen_tcp, socket: socket}
          target = uri.host <> ":" <> Integer.to_string(uri.port)

          result =
            with :ok <-
                   :gen_tcp.send(socket, [
                     "CONNECT ",
                     target,
                     " HTTP/1.1\r\nHost: ",
                     target,
                     "\r\n\r\n"
                   ]),
                 {:ok, response, ""} <- headers(state, <<>>, deadline),
                 true <- Regex.match?(~r/^HTTP\/1\.[01] 200 /, response),
                 {:ok, _} <- Application.ensure_all_started(:ssl),
                 {:ok, tls} <- :ssl.connect(socket, tls_opts(uri.host), remaining(deadline)),
                 do: {:ok, {:ssl, tls}}

          case result do
            {:ok, _} ->
              result

            _ ->
              :gen_tcp.close(socket)
              {:error, :proxy_connect_failed}
          end
        end
    end
  end

  defp tls_opts(host),
    do: [
      :binary,
      active: false,
      verify: :verify_peer,
      cacerts: :public_key.cacerts_get(),
      server_name_indication: String.to_charlist(host),
      customize_hostname_check: [match_fun: :public_key.pkix_verify_hostname_match_fun(:https)],
      send_timeout: @timeout,
      send_timeout_close: true
    ]

  defp headers(state, acc, deadline) do
    case :binary.match(acc, "\r\n\r\n") do
      {i, 4} when i < 16_384 ->
        <<head::binary-size(i + 4), rest::binary>> = acc
        {:ok, head, rest}

      _ when byte_size(acc) > 16_384 ->
        {:error, :headers_too_large}

      :nomatch ->
        with {:ok, bytes} <- state.transport.recv(state.socket, 0, remaining(deadline)),
             do: headers(state, acc <> bytes, deadline)
    end
  end

  defp verify(headers, key) do
    [status | lines] = String.split(headers, "\r\n", trim: true)

    fields =
      Map.new(lines, fn line ->
        case String.split(line, ":", parts: 2) do
          [k, v] -> {String.downcase(k), String.trim(v)}
          _ -> {"", ""}
        end
      end)

    expected = Base.encode64(:crypto.hash(:sha, key <> "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))

    tokens =
      String.downcase(fields["connection"] || "") |> String.split(",") |> Enum.map(&String.trim/1)

    if Regex.match?(~r/^HTTP\/1\.[01] 101 /, status) and
         String.downcase(fields["upgrade"] || "") == "websocket" and
         "upgrade" in tokens and fields["sec-websocket-accept"] == expected,
       do: :ok,
       else: {:error, :upgrade_rejected}
  end

  defp remaining(deadline), do: max(0, deadline - System.monotonic_time(:millisecond))

  defp authority(uri) do
    host = if String.contains?(uri.host, ":"), do: "[#{uri.host}]", else: uri.host
    if uri.port in [80, 443], do: host, else: host <> ":" <> Integer.to_string(uri.port)
  end
end
