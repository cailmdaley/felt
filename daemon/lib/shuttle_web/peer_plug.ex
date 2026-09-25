defmodule ShuttleWeb.PeerPlug do
  @moduledoc """
  Records who is on the other end of a request as `conn.assigns.peer`:

      %{transport: :unix | :tcp, forwarded: boolean(), tailscale_login: String.t() | nil}

  Facts only — nothing here allows or refuses a request. They are recorded
  once at the edge as groundwork for a later authorization step.

    * `transport` — `:unix` when the listener is a unix socket
      (`Shuttle.Host`), else `:tcp`.
    * `forwarded` — whether a proxy says it relayed the request: any
      `x-forwarded-*`, `forwarded`, or `tailscale-*` header is present. On a
      direct connection nothing sets these, so their presence marks a request
      that arrived through something else.
    * `tailscale_login` — the `tailscale-user-login` header, recorded only on
      `:unix`, and **not trustworthy there either**. The socket sits in a
      `0700` directory, but that bounds who can connect, not what they say:
      it is reached by local processes running as this daemon's user and by
      ssh tunnels (`ssh -L` to the socket), and a tunnel forwards client bytes
      verbatim, so whoever reaches a tunnel's local end can send any header.
      `tailscale serve` cannot vouch for it on the hosts that need a socket —
      serving to a unix target requires root on a userspace tailscaled. On
      loopback TCP the value is dropped outright.

  Nothing reads `conn.assigns.peer` yet. Trusting an identity waits on a
  transport that authenticates one — a uid-gated TCP path — rather than on
  anything a header can assert.

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

  import Plug.Conn

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    transport = transport(conn)

    assign(conn, :peer, %{
      transport: transport,
      forwarded: forwarded?(conn),
      tailscale_login: if(transport == :unix, do: header(conn, "tailscale-user-login"))
    })
  end

  defp transport(conn) do
    case get_peer_data(conn) do
      %{address: {:local, _}} -> :unix
      _ -> :tcp
    end
  end

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
