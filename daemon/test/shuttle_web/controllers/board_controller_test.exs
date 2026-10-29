defmodule ShuttleWeb.BoardControllerTest do
  use ExUnit.Case, async: true
  import Phoenix.ConnTest
  import Plug.Conn
  import Shuttle.Test.ApiConn

  @endpoint ShuttleWeb.Endpoint

  test "local feed filters and supports conditional requests" do
    path = Path.join(System.tmp_dir!(), "board-api-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm(path) end)
    now = System.system_time(:millisecond)
    record = %{"type" => "board", "id" => "brd-test", "timestamp" => now, "kind" => "post"}
    File.write!(path, Jason.encode!(record) <> "\n")
    Shuttle.Test.Env.put_env("SHUTTLE_EVENTS_FILE", path)
    first = get(api_conn(), "/api/v1/board?since_ms=#{now}")
    assert %{"records" => [^record]} = json_response(first, 200)
    [etag] = get_resp_header(first, "etag")

    assert (api_conn()
            |> put_req_header("if-none-match", etag)
            |> get("/api/v1/board?since_ms=#{now}")).status == 304

    assert %{"records" => []} =
             api_conn() |> get("/api/v1/board?since_ms=#{now + 1}") |> json_response(200)
  end
end
