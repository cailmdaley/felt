defmodule ShuttleWeb.SpaControllerTest do
  @moduledoc """
  `GET /` serves the built UI's `index.html` so the daemon hosts its own
  frontend. The bundle dir is a compile-time constant (`ShuttleWeb.Assets.dist/0`,
  shared with the `Plug.Static` mount), so these tests assert the real wiring
  against whatever state the bundle is actually in — 200 + html when built,
  404 + build hint when not — rather than forcing a branch through a runtime
  override that the compile-time design intentionally doesn't offer.
  """
  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  test "Assets.dist/0 is an absolute path to ui/dist" do
    dist = ShuttleWeb.Assets.dist()
    assert Path.type(dist) == :absolute
    assert String.ends_with?(dist, "ui/dist")
  end

  test "GET / serves index.html when built, else 404s with a build hint" do
    conn = get(build_conn(), "/")
    index = Path.join(ShuttleWeb.Assets.dist(), "index.html")

    if File.regular?(index) do
      assert conn.status == 200
      assert get_resp_header(conn, "content-type") |> List.first() =~ "text/html"
      assert conn.resp_body =~ "<"
    else
      assert conn.status == 404
      assert conn.resp_body =~ "npm run build"
    end
  end
end
