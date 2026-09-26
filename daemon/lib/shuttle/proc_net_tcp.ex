defmodule Shuttle.ProcNetTcp do
  @moduledoc """
  Resolves a TCP peer's uid from Linux's `/proc/net/tcp` and `/proc/net/tcp6`.

  A connection is identified by its established client-side row: the local
  endpoint is the peer address and ephemeral port, while the remote endpoint
  is the daemon listener. The mirror server-side row has the daemon's uid and
  must not be used. Address words are decoded in the host's native byte order,
  and IPv4-mapped IPv6 loopback addresses normalize to IPv4.
  """

  @tcp_state "01"

  @doc "Whether `/proc/net/tcp` can be read under `proc_root`."
  @spec readable?(String.t()) :: boolean()
  def readable?(proc_root \\ "/proc") do
    case File.read(Path.join([proc_root, "net", "tcp"])) do
      {:ok, _data} -> true
      {:error, _reason} -> false
    end
  end

  @doc "Resolve the peer uid for a Plug peer-data map and the listener URL."
  @spec peer_uid(map(), String.t(), String.t()) :: non_neg_integer() | nil
  def peer_uid(peer_data, listen, proc_root \\ "/proc") do
    with %{address: peer_address, port: peer_port} <- peer_data,
         {:ok, {:tcp, listen_address, listen_port}} <- Shuttle.Host.parse_listen(listen) do
      proc_root
      |> read_tables()
      |> Enum.find_value(&uid_from_data(&1, peer_address, peer_port, listen_address, listen_port))
    else
      _ -> nil
    end
  end

  @doc """
  Resolve a uid from proc table text, without filesystem or platform access.

  `peer_address` and `listen_address` are Erlang IPv4/IPv6 tuples; `peer_port`
  and `listen_port` are integers.
  """
  @spec uid_from_data(String.t(), tuple(), non_neg_integer(), tuple(), non_neg_integer()) ::
          non_neg_integer() | nil
  def uid_from_data(data, peer_address, peer_port, listen_address, listen_port) do
    with {:ok, peer} <- endpoint(peer_address, peer_port),
         {:ok, listener} <- endpoint(listen_address, listen_port) do
      data
      |> String.split("\n")
      |> Enum.find_value(fn line ->
        case parse_row(line) do
          %{state: @tcp_state, local: local, remote: remote, uid: uid} ->
            if endpoint_matches?(local, peer) and endpoint_matches?(remote, listener), do: uid

          _ ->
            nil
        end
      end)
    else
      _ -> nil
    end
  end

  defp read_tables(proc_root) do
    for name <- ["tcp", "tcp6"],
        {:ok, data} <- [File.read(Path.join([proc_root, "net", name]))],
        do: data
  end

  defp parse_row(line) do
    case String.split(line) do
      [_slot, local, remote, state, _tx_queue, _timer, _retrnsmt, uid_text | _] ->
        with {:ok, local} <- parse_endpoint(local),
             {:ok, remote} <- parse_endpoint(remote),
             {:ok, uid} <- decimal(uid_text) do
          %{local: local, remote: remote, state: String.upcase(state), uid: uid}
        else
          _ -> nil
        end

      _ ->
        nil
    end
  end

  defp parse_endpoint(value) do
    case String.split(value, ":") do
      [address, port_text] ->
        with {:ok, port} <- hexadecimal(port_text),
             {:ok, addresses} <- proc_addresses(address) do
          {:ok, {addresses, port}}
        end

      _ ->
        :error
    end
  end

  defp endpoint(address, port) when is_integer(port) and port in 0..65_535 do
    case normalize_address(address) do
      {:ok, normalized} -> {:ok, {[normalized], port}}
      :error -> :error
    end
  end

  defp endpoint(_address, _port), do: :error

  defp endpoint_matches?({addresses, port}, {[target], port}), do: target in addresses
  defp endpoint_matches?(_actual, _expected), do: false

  defp proc_addresses(hex) when byte_size(hex) in [8, 32] do
    with {:ok, bytes} <- Base.decode16(hex, case: :mixed),
         native <- decode_native_order(bytes),
         address when not is_nil(address) <- normalize_bytes(native) do
      {:ok, [address]}
    else
      _ -> :error
    end
  end

  defp proc_addresses(_hex), do: :error

  defp decode_native_order(bytes) when byte_size(bytes) == 4 do
    if :erlang.system_info(:endian) == :little, do: reverse_bytes(bytes), else: bytes
  end

  defp decode_native_order(bytes) when byte_size(bytes) == 16 do
    if :erlang.system_info(:endian) == :little, do: reverse_words(bytes), else: bytes
  end

  defp normalize_address(address) when is_tuple(address) and tuple_size(address) == 4 do
    {:ok, {:ipv4, address}}
  end

  defp normalize_address(address) when is_tuple(address) and tuple_size(address) == 8 do
    address
    |> Tuple.to_list()
    |> Enum.reduce(<<>>, fn word, acc -> <<acc::binary, word::16>> end)
    |> normalize_bytes_result()
  end

  defp normalize_address(_address), do: :error

  defp normalize_bytes(<<a, b, c, d>>), do: {:ipv4, {a, b, c, d}}

  defp normalize_bytes(<<0::80, 65_535::16, a, b, c, d>>),
    do: {:ipv4, {a, b, c, d}}

  defp normalize_bytes(<<_::128>> = bytes), do: {:ipv6, bytes}
  defp normalize_bytes(_bytes), do: nil

  defp normalize_bytes_result(bytes) do
    case normalize_bytes(bytes) do
      nil -> :error
      normalized -> {:ok, normalized}
    end
  end

  defp reverse_words(
         <<a::binary-size(4), b::binary-size(4), c::binary-size(4), d::binary-size(4)>>
       ) do
    reverse_bytes(a) <> reverse_bytes(b) <> reverse_bytes(c) <> reverse_bytes(d)
  end

  defp reverse_bytes(bytes),
    do: bytes |> :binary.bin_to_list() |> Enum.reverse() |> :erlang.list_to_binary()

  defp hexadecimal(text) do
    case Integer.parse(text, 16) do
      {n, ""} when n in 0..65_535 -> {:ok, n}
      _ -> :error
    end
  end

  defp decimal(text) do
    case Integer.parse(text, 10) do
      {n, ""} when n >= 0 -> {:ok, n}
      _ -> :error
    end
  end
end
