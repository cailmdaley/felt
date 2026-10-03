defmodule ShuttleWeb.LargeBodyParserTest do
  use ExUnit.Case, async: true

  alias ShuttleWeb.LargeBodyParser

  test "each large-body route carries its ceiling and the long read timeout down to the JSON reader" do
    for {path, length} <- LargeBodyParser.limits() do
      config = inspect(LargeBodyParser.parser_for(path), limit: :infinity)
      assert config =~ "length: #{length}"
      assert config =~ "read_timeout: #{LargeBodyParser.read_timeout()}"
    end

    assert LargeBodyParser.read_timeout() >= 120_000

    assert LargeBodyParser.limits()["/api/v1/attachments"] ==
             Shuttle.Attachments.max_request_bytes()
  end

  test "other routes pass through untouched" do
    conn = Plug.Test.conn(:post, "/api/v1/dispatch", "{}")
    assert LargeBodyParser.call(conn, []) == conn
  end
end
