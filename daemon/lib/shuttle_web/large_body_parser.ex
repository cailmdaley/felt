defmodule ShuttleWeb.LargeBodyParser do
  @moduledoc """
  Route-specific JSON ceilings for the endpoints whose bodies carry files.

  Each listed `POST` path is parsed here with its own `length`; every other
  request passes through untouched to the endpoint's ordinary parser, which
  keeps Plug's default 8 MB limit. Plug.Parsers leaves an already-fetched body
  alone, so the two never both read a body.

    * `/api/v1/messages/files` — message envelopes with attachments (32 MB).
    * `/api/v1/attachments` — the composer's pasted images
      (`Shuttle.Attachments.max_request_bytes/0`).

  Both also wait up to `read_timeout/0` for each socket read instead of the
  default 15 s, so a body arriving over a slow uplink is not cut off with a
  408. Plug.Parsers hands `:read_timeout` to `Plug.Conn.read_body/2`, which
  Bandit applies to each receive.
  """

  @read_timeout_ms 120_000

  @limits %{
    "/api/v1/messages/files" => 32 * 1024 * 1024,
    "/api/v1/attachments" => Shuttle.Attachments.max_request_bytes()
  }

  @parsers Map.new(@limits, fn {path, length} ->
             {path,
              Plug.Parsers.init(
                parsers: [:json],
                pass: ["application/json"],
                json_decoder: Phoenix.json_library(),
                length: length,
                read_timeout: @read_timeout_ms
              )}
           end)

  @doc "The per-read socket timeout for the listed routes, in milliseconds."
  def read_timeout, do: @read_timeout_ms

  @doc "The routes this parser reads, with their body ceilings in bytes."
  def limits, do: @limits

  @doc "The initialized Plug.Parsers config for `path`, or nil."
  def parser_for(path), do: Map.get(@parsers, path)

  def init(opts), do: opts

  def call(%Plug.Conn{request_path: path} = conn, _opts) do
    case Map.fetch(@parsers, path) do
      {:ok, parser} -> Plug.Parsers.call(conn, parser)
      :error -> conn
    end
  end
end
