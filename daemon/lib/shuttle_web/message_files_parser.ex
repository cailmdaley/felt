defmodule ShuttleWeb.MessageFilesParser do
  @moduledoc false

  @parser Plug.Parsers.init(
            parsers: [:json],
            pass: ["application/json"],
            json_decoder: Phoenix.json_library(),
            length: 32 * 1024 * 1024
          )

  def init(opts), do: opts

  def call(%Plug.Conn{request_path: "/api/v1/messages/files"} = conn, _opts),
    do: Plug.Parsers.call(conn, @parser)

  def call(conn, _opts), do: conn
end
