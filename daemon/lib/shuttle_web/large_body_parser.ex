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
  """

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
                length: length
              )}
           end)

  def init(opts), do: opts

  def call(%Plug.Conn{request_path: path} = conn, _opts) do
    case Map.fetch(@parsers, path) do
      {:ok, parser} -> Plug.Parsers.call(conn, parser)
      :error -> conn
    end
  end
end
