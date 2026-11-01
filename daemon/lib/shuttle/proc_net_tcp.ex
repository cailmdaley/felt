defmodule Shuttle.ProcNetTcp do
  @moduledoc """
  Resolves a TCP peer's uid from Linux's `/proc/net/tcp` and `/proc/net/tcp6`.

  A connection is identified by its client-side row: the local endpoint is the
  peer address and ephemeral port, while the remote endpoint is the daemon
  listener. The mirror server-side row has the daemon's uid and must not be
  used. Address words are decoded in the host's native byte order, and
  IPv4-mapped IPv6 loopback addresses normalize to IPv4.

  ## Which TCP states carry a uid

  Only a row backed by a real `struct sock` has an owning process, and only
  those rows are trusted. `TIME_WAIT` (06) and `SYN_RECV` (03) are not: a
  timewait entry is an `inet_timewait_sock` and a SYN_RECV entry a request
  sock, neither of which has an owner, so the kernel prints uid 0 for both
  (measured: 414 of 414 `TIME_WAIT` rows on a busy multi-user host). Trusting
  them would authorize nobody on a daemon running as an ordinary user — and
  *everybody* on one running as root, which is precisely the configuration
  `ShuttleWeb.PeerGatePlug` treats as uid-0-allowed.

  Accepting only `ESTABLISHED` was too narrow in the other direction. A client
  that shuts down its write side right after sending — an ordinary
  `Connection: close` pattern — moves its own socket to `FIN_WAIT1`/`FIN_WAIT2`
  before the plug reads the table, so its row was invisible and the owner's own
  request was refused as "peer uid unresolved" (reproduced 30/30). Those states,
  and the closing states that follow them, still name one uniquely-bound live
  connection and carry its owner's true uid, so accepting them does not weaken
  the four-tuple match.

  ## A row whose socket was closed

  The same closing states also hold *orphaned* sockets. Once the client
  process closes its descriptor, the kernel keeps the connection draining in
  `FIN_WAIT1`/`FIN_WAIT2`/`CLOSING`/`LAST_ACK` with no `struct socket` behind
  it, and prints inode 0 and uid 0 for the row (measured on a 5.14 kernel: a
  client that half-closes keeps its uid and inode; the same client after
  `close()` reads `05`, uid 0, inode 0; every inode-0 row on a busy login node
  read uid 0). The requesting process is gone, so the row names nobody. A
  matching row with inode 0 (orphan, `TIME_WAIT` or `SYN_RECV` alike) is
  reported as `{:error, :peer_closed}`, never as uid 0. A client lands here
  when it gives up, usually on a timeout, before the daemon reads its request,
  so a stream of these means requests waited too long, not that someone else
  connected.
  """

  # States whose row can have an owning process; the row also needs a nonzero
  # inode. See "Which TCP states carry a uid" and "A row whose socket was closed".
  @uid_bearing_states ~w(01 04 05 08 09 0B)

  @typedoc """
  A lookup's answer: the owning uid; `:peer_closed` when the connection's row
  has no owning socket because the client closed it; or `:no_row` when no row
  names the connection, or the tables or listener could not be read.
  """
  @type lookup :: {:ok, non_neg_integer()} | {:error, :peer_closed | :no_row}

  @doc "Whether `/proc/net/tcp` can be read under `proc_root`."
  @spec readable?(String.t()) :: boolean()
  def readable?(proc_root \\ "/proc") do
    case File.read(Path.join([proc_root, "net", "tcp"])) do
      {:ok, _data} -> true
      {:error, _reason} -> false
    end
  end

  @doc "Look up the peer's uid for a Plug peer-data map and the listener URL."
  @spec lookup(map(), String.t(), String.t()) :: lookup()
  def lookup(peer_data, listen, proc_root \\ "/proc") do
    with %{address: peer_address, port: peer_port} <- peer_data,
         {:ok, {:tcp, listen_address, listen_port}} <- Shuttle.Host.parse_listen(listen) do
      proc_root
      |> read_tables()
      |> Enum.map(&lookup_data(&1, peer_address, peer_port, listen_address, listen_port))
      |> strongest()
    else
      _ -> {:error, :no_row}
    end
  end

  @doc """
  Look up a uid in proc table text, without filesystem or platform access.

  `peer_address` and `listen_address` are Erlang IPv4/IPv6 tuples; `peer_port`
  and `listen_port` are integers. An owned row wins over an orphaned one.
  """
  @spec lookup_data(String.t(), tuple(), non_neg_integer(), tuple(), non_neg_integer()) ::
          lookup()
  def lookup_data(data, peer_address, peer_port, listen_address, listen_port) do
    with {:ok, peer} <- endpoint(peer_address, peer_port),
         {:ok, listener} <- endpoint(listen_address, listen_port) do
      needles = :binary.compile_pattern(port_needles(peer_port))

      data
      |> String.split("\n")
      |> Enum.map(fn line ->
        with true <- :binary.match(line, needles) != :nomatch,
             %{local: local, remote: remote} = row <- parse_row(line),
             true <- endpoint_matches?(local, peer) and endpoint_matches?(remote, listener) do
          classify(row)
        else
          _ -> {:error, :no_row}
        end
      end)
      |> strongest()
    else
      _ -> {:error, :no_row}
    end
  end

  defp classify(%{inode: 0}), do: {:error, :peer_closed}
  defp classify(%{state: state, uid: uid}) when state in @uid_bearing_states, do: {:ok, uid}
  defp classify(_row), do: {:error, :no_row}

  # An owned row is the answer; failing one, an orphaned row says the client
  # left; failing that, nothing names the connection.
  defp strongest(results) do
    Enum.find(results, &match?({:ok, _uid}, &1)) ||
      Enum.find(results, {:error, :no_row}, &(&1 == {:error, :peer_closed}))
  end

  # A login node's table holds thousands of rows and the gate reads it on every
  # request, so a row is parsed only when its text carries the peer's ephemeral
  # port as an endpoint port (`:XXXX ` in the kernel's hex; either case).
  defp port_needles(port) do
    hex = port |> Integer.to_string(16) |> String.pad_leading(4, "0")
    Enum.uniq([":" <> String.upcase(hex) <> " ", ":" <> String.downcase(hex) <> " "])
  end

  defp read_tables(proc_root) do
    for name <- ["tcp", "tcp6"],
        {:ok, data} <- [File.read(Path.join([proc_root, "net", name]))],
        do: data
  end

  defp parse_row(line) do
    case String.split(line) do
      [
        _slot,
        local,
        remote,
        state,
        _queues,
        _timer,
        _retrnsmt,
        uid_text,
        _timeout,
        inode_text | _
      ] ->
        with {:ok, local} <- parse_endpoint(local),
             {:ok, remote} <- parse_endpoint(remote),
             {:ok, uid} <- decimal(uid_text),
             {:ok, inode} <- decimal(inode_text) do
          %{local: local, remote: remote, state: String.upcase(state), uid: uid, inode: inode}
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
