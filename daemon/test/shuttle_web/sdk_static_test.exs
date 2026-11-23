defmodule ShuttleWeb.SdkStaticTest do
  @moduledoc """
  Every daemon serves the UI primitives bundle, `/sdk/shuttle-sdk.js`, from
  the built UI (`ShuttleWeb.Assets.dist/0`), precompressed when the client
  accepts it, so a personal UI can import it with no build step.
  """
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  setup do
    dist = Path.join(System.tmp_dir!(), "shuttle-sdk-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(dist, "sdk"))
    File.write!(Path.join(dist, "sdk/shuttle-sdk.js"), "export const sdk = 1")
    File.write!(Path.join(dist, "sdk/shuttle-sdk.js.gz"), "gzipped sdk")
    File.write!(Path.join(dist, "sdk/shuttle-sdk.js.br"), "brotli sdk")
    Shuttle.Test.Env.put_env("SHUTTLE_UI_DIST", dist)
    on_exit(fn -> File.rm_rf(dist) end)
    :ok
  end

  test "serves the bundle as JavaScript from the UI dist" do
    conn = get(local_conn(), "/sdk/shuttle-sdk.js")
    assert conn.status == 200
    assert conn.resp_body == "export const sdk = 1"
    assert [type] = get_resp_header(conn, "content-type")
    assert type =~ "javascript"
  end

  test "serves it precompressed and revalidated" do
    brotli = local_conn() |> put_req_header("accept-encoding", "gzip, br") |> get("/sdk/shuttle-sdk.js")
    assert {brotli.status, brotli.resp_body} == {200, "brotli sdk"}
    assert get_resp_header(brotli, "content-encoding") == ["br"]
    assert get_resp_header(brotli, "cache-control") == ["public"]

    gzip = local_conn() |> put_req_header("accept-encoding", "gzip") |> get("/sdk/shuttle-sdk.js")
    assert {gzip.resp_body, get_resp_header(gzip, "content-encoding")} == {"gzipped sdk", ["gzip"]}
  end

  test "a missing file under sdk/ is not found" do
    assert get(local_conn(), "/sdk/missing.js").status == 404
  end
end
