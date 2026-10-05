defmodule ShuttleWeb.FileInvalidRangeTest do
  use ExUnit.Case, async: true

  import Shuttle.Test.ApiConn
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  @tag :tmp_dir
  test "reversed byte ranges are invalid and ignored, not unsatisfiable", %{tmp_dir: dir} do
    path = Path.join(dir, "media.mp4")
    File.write!(path, "0123456789")
    url = "/api/v1/file?path=#{URI.encode_www_form(path)}"

    for range <- ["bytes=4-2", "bytes=12-11"] do
      conn = api_conn() |> put_req_header("range", range) |> get(url)
      assert conn.status == 200
      assert conn.resp_body == "0123456789"
      assert get_resp_header(conn, "content-range") == []
      assert get_resp_header(conn, "content-length") == ["10"]
    end
  end
end
