defmodule ShuttleWeb.PeerPlug do
  @moduledoc """
  Records who is on the other end of a request as `conn.assigns.peer`:

      %{
        transport: :unix | :tcp,
        uid: non_neg_integer() | nil,
        uid_error: :peer_closed | :no_row | nil,
        forwarded: boolean(),
        tailscale_login: String.t() | nil
      }

  Facts only — this plug records peer data; `PeerGatePlug` separately decides
  whether a TCP peer may continue. TCP uid comes from the owned client-side
  row in `/proc/net/tcp` or `/proc/net/tcp6` (`Shuttle.ProcNetTcp`). When it
  cannot be resolved, `uid` is `nil` and `uid_error` says why: `:peer_closed`
  when the client had already closed its socket, `:no_row` when no row names
  the connection. Both are `nil` where the uid is never looked up.

    * `transport` — `:unix` when the listener is a unix socket
      (`Shuttle.Host`), else `:tcp`.
    * `forwarded` — whether a proxy says it relayed the request: any
      `x-forwarded-*`, `forwarded`, or `tailscale-*` header is present. On a
      direct connection nothing sets these, so their presence marks a request
      that arrived through something else.
    * `tailscale_login` — the `tailscale-user-login` header. On `:unix` it is
      recorded as an untrusted assertion: the socket's `0700` directory bounds
      who can connect, but ssh tunnels forward client bytes verbatim. On TCP,
      `PeerGatePlug` retains it only after the peer uid passes the gate. The
      header remains an assertion; the uid identifies the process that could
      provide it.

  A loopback TCP row is selected by matching the peer address and ephemeral
  port as the row's local endpoint and the daemon listener as its remote
  endpoint. The mirror row describes the server socket and carries the
  daemon's uid, not the client's.

  ## What Bandit reports for a unix listener

  Measured on Bandit 1.12 / thousand_island 1.5 (macOS), and asserted by
  `test/shuttle_web/peer_plug_test.exs` against a real listener:
  `Plug.Conn.get_peer_data/1` returns
  `%{address: {:local, ""}, port: 0, ssl_cert: nil}`, and `conn.remote_ip` is
  the same `{:local, ""}` — the client end of a unix connection is unnamed.
  No peer credentials (uid/pid) are exposed through Plug, so the socket
  directory's permissions are the whole of the transport-level identity. A
  request with no `Host` header is rejected by Bandit with 400 before any plug
  runs; a client dialing the socket sends `Host: localhost`, which is also
  what `ShuttleWeb.CORSPlug`'s loopback authority check accepts.
  """

  @behaviour Plug

  @gated_classes [:shared_multi_user, :exposed]

  import Plug.Conn

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, opts) do
    peer_data = get_peer_data(conn)
    transport = transport(peer_data)

    {uid, uid_error} =
      case transport == :tcp && peer_uid(peer_data, opts) do
        {:ok, uid} -> {uid, nil}
        {:error, reason} -> {nil, reason}
        _ -> {nil, nil}
      end

    assign(conn, :peer, %{
      transport: transport,
      uid: uid,
      uid_error: uid_error,
      forwarded: forwarded?(conn),
      tailscale_login: if(transport == :unix, do: header(conn, "tailscale-user-login"))
    })
  end

  defp transport(%{address: {:local, _}}), do: :unix
  defp transport(_peer_data), do: :tcp

  # Resolved only on the classes whose gate consults it: on a single-user host
  # the fact would cost a /proc/net/tcp read per request and nothing reads it.
  # A test's `:uid_resolver` may answer a bare uid or nil as shorthand for a
  # `Shuttle.ProcNetTcp.lookup/3` result.
  defp peer_uid(peer_data, opts) do
    listen = Shuttle.listen()

    case Keyword.get(opts, :uid_resolver) do
      resolver when is_function(resolver, 2) ->
        case resolver.(peer_data, listen) do
          uid when is_integer(uid) -> {:ok, uid}
          nil -> {:error, :no_row}
          result -> result
        end

      nil ->
        if Keyword.get(opts, :host_class, Shuttle.host_class()) in @gated_classes do
          proc_root =
            Keyword.get(opts, :proc_root, Shuttle.Env.app(:proc_net_root, "/proc"))

          connection_uid(peer_data, listen, proc_root)
        end
    end
  end

  # An HTTP/1 connection is served by one process for its whole life, and the
  # uid on a socket's row is fixed when the socket is created, so a resolved
  # uid is remembered in that process's dictionary, which the endpoint tells
  # Bandit to keep across keep-alive requests (`clear_process_dict: false`,
  # config/config.exs): keep-alive pollers (a hub behind `tailscale serve`)
  # cost one table read per connection rather than one per request. An
  # unresolved lookup is not remembered, so the next request on the connection
  # reads the table again.
  defp connection_uid(%{address: address, port: port} = peer_data, listen, proc_root) do
    key = {__MODULE__, :uid, address, port, listen, proc_root}

    case Process.get(key) do
      {:ok, _uid} = resolved ->
        resolved

      nil ->
        result = Shuttle.ProcNetTcp.lookup(peer_data, listen, proc_root)
        if match?({:ok, _uid}, result), do: Process.put(key, result)
        result
    end
  end

  defp connection_uid(peer_data, listen, proc_root),
    do: Shuttle.ProcNetTcp.lookup(peer_data, listen, proc_root)

  defp forwarded?(conn) do
    Enum.any?(conn.req_headers, fn {name, _value} ->
      name == "forwarded" or String.starts_with?(name, "x-forwarded-") or
        String.starts_with?(name, "tailscale-")
    end)
  end

  defp header(conn, name) do
    case get_req_header(conn, name) do
      [value | _] when value != "" -> value
      _ -> nil
    end
  end
end
