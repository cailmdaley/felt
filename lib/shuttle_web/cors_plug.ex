defmodule ShuttleWeb.CORSPlug do
  @moduledoc """
  Hand-rolled CORS plug for the Shuttle API endpoints.

  The browser UI is served same-origin from :4000, so CORS only matters for
  the Vite dev server (and a legacy :3000 fallback) calling the daemon
  directly during development. Origin matching is allowlist-based on those
  localhost variants.

  Requests from non-allowed origins pass through without CORS headers for safe
  reads. Unsafe browser requests are rejected before they reach a controller:
  CORS response headers alone do not stop a simple cross-origin form POST from
  executing. Requests without `Origin` are left alone for CLI calls and the
  daemon-to-daemon owner-forwarding leg once their loopback (or paired proxy)
  authority is validated. Same-origin requests are identified from the request
  host (and forwarded host/proto headers when a local reverse proxy is in
  front of the loopback listener).

  OPTIONS preflight requests are answered immediately with 204 and halted
  so they never reach the router. CORS response headers are appended to
  all other requests from allowed origins.
  """

  @behaviour Plug

  import Plug.Conn

  # Vite dev-server ports: 5173 is the default, but Vite falls back to the
  # next free port (5174, 5175, ...) whenever 5173 is already taken by
  # another local project, so a couple of fallbacks are allowlisted too.
  @dev_ports [3000, 5173, 5174, 5175]

  @allowed_origins for host <- ["localhost", "127.0.0.1"],
                       port <- @dev_ports,
                       do: "http://#{host}:#{port}"

  @allowed_methods "GET, POST, OPTIONS"
  @allowed_headers "Content-Type, Accept"
  @max_age "3600"
  @unsafe_methods ~w(POST PUT PATCH DELETE)
  @forbidden_body "origin not allowed"
  @loopback_hosts ~w(localhost 127.0.0.1 ::1)

  @impl true
  def init(opts), do: opts

  @impl true
  def call(%Plug.Conn{method: "OPTIONS"} = conn, _opts) do
    if trusted_request_authority?(conn) do
      conn
      |> put_cors_headers()
      |> send_resp(204, "")
      |> halt()
    else
      reject_cross_origin(conn)
    end
  end

  def call(%Plug.Conn{method: method} = conn, _opts) when method in @unsafe_methods do
    if trusted_request_authority?(conn) do
      case request_origin(conn) do
        nil ->
          conn

        origin when origin in @allowed_origins ->
          put_cors_headers(conn)

        origin ->
          if same_origin?(conn, origin) do
            conn
          else
            reject_cross_origin(conn)
          end
      end
    else
      reject_cross_origin(conn)
    end
  end

  def call(conn, _opts) do
    if trusted_request_authority?(conn) do
      put_cors_headers(conn)
    else
      reject_cross_origin(conn)
    end
  end

  defp request_origin(conn), do: conn |> get_req_header("origin") |> List.first()

  defp reject_cross_origin(conn) do
    conn
    |> put_resp_content_type("text/plain")
    |> send_resp(403, @forbidden_body)
    |> halt()
  end

  # The listener is loopback-only. Validate the request authority on reads as
  # well as writes, since a DNS-rebinding page can make a same-origin GET to a
  # loopback service and read its response. A reverse proxy must provide the
  # paired forwarded host and scheme that same-origin?/2 validates.
  defp trusted_request_authority?(conn) do
    case request_host_port(conn) do
      {:ok, host, _port, true} -> is_binary(host)
      {:ok, host, _port, false} -> loopback_host?(host)
      _ -> false
    end
  end

  defp put_cors_headers(conn) do
    origin = request_origin(conn)

    if origin in @allowed_origins do
      conn
      |> put_resp_header("access-control-allow-origin", origin)
      |> put_resp_header("access-control-allow-methods", @allowed_methods)
      |> put_resp_header("access-control-allow-headers", @allowed_headers)
      |> put_resp_header("access-control-max-age", @max_age)
      |> put_resp_header("vary", "Origin")
    else
      conn
    end
  end

  # Same-origin requests normally carry the Host header and the connection's
  # scheme. The direct listener is loopback-only, so accept only canonical
  # loopback hosts there; otherwise a DNS-rebinding host could make an
  # attacker-controlled origin look same-origin. A local reverse proxy
  # serving the UI over HTTPS may preserve its public host and scheme as
  # paired, sanitized X-Forwarded-* headers while its hop to Bandit remains
  # HTTP. The daemon only binds loopback; an operator's proxy must strip
  # client-supplied forwarded headers.
  defp same_origin?(conn, origin) do
    with %URI{
           scheme: origin_scheme,
           host: origin_host,
           port: origin_port,
           path: nil,
           query: nil,
           fragment: nil,
           userinfo: nil
         }
         when origin_scheme in ["http", "https"] and is_binary(origin_host) <-
           parse_origin(origin),
         {:ok, request_host, request_port, forwarded_origin?} <- request_host_port(conn),
         true <- is_binary(request_host),
         true <- String.downcase(origin_host) == String.downcase(request_host),
         true <- allowed_same_origin_host?(origin_host, forwarded_origin?),
         true <- same_scheme?(conn, origin_scheme),
         true <- same_port?(origin_port, request_port, origin_scheme) do
      true
    else
      _ -> false
    end
  end

  defp parse_origin(origin) do
    URI.parse(origin)
  rescue
    URI.Error -> nil
  end

  defp same_scheme?(conn, origin_scheme) do
    forwarded_proto = forwarded_header(conn, "x-forwarded-proto")
    request_scheme = forwarded_proto || Atom.to_string(conn.scheme)
    String.downcase(request_scheme) == String.downcase(origin_scheme)
  end

  defp same_port?(nil, nil, _scheme), do: true
  defp same_port?(nil, request_port, scheme), do: request_port == default_port(scheme)
  defp same_port?(origin_port, nil, scheme), do: origin_port == default_port(scheme)
  defp same_port?(origin_port, request_port, _scheme), do: origin_port == request_port

  defp default_port("http"), do: 80
  defp default_port("https"), do: 443

  defp allowed_same_origin_host?(_host, true), do: true

  defp allowed_same_origin_host?(host, false) do
    loopback_host?(host)
  end

  defp loopback_host?(host) when is_binary(host), do: String.downcase(host) in @loopback_hosts
  defp loopback_host?(_), do: false

  defp request_host_port(conn) do
    forwarded_host = forwarded_header(conn, "x-forwarded-host")
    forwarded_proto = forwarded_header(conn, "x-forwarded-proto")
    value = forwarded_host || forwarded_header(conn, "host")
    forwarded_origin? = is_binary(forwarded_host) and valid_forwarded_proto?(forwarded_proto)

    case value do
      nil ->
        {:ok, conn.host, conn.port, forwarded_origin?}

      host_header ->
        case parse_host_header(host_header) do
          %URI{host: host, port: port, path: nil, query: nil, fragment: nil, userinfo: nil}
          when is_binary(host) ->
            if valid_authority_host?(host) do
              {:ok, host, port, forwarded_origin?}
            else
              :error
            end

          _ ->
            :error
        end
    end
  end

  defp parse_host_header(host_header) do
    URI.parse("//" <> host_header)
  rescue
    URI.Error -> nil
    ArgumentError -> nil
  end

  defp valid_forwarded_proto?(value) when is_binary(value),
    do: String.downcase(value) in ["http", "https"]

  defp valid_forwarded_proto?(_), do: false

  defp valid_authority_host?(host) when is_binary(host) do
    String.match?(host, ~r/\A[\p{L}\p{N}._:-]+\z/u)
  end

  defp valid_authority_host?(_), do: false

  defp forwarded_header(conn, name) do
    case get_req_header(conn, name) do
      [value | _] -> value |> String.split(",", parts: 2) |> hd() |> String.trim()
      [] -> nil
    end
  end
end
