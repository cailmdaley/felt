defmodule ShuttleWeb.SpaControllerTest do
  @moduledoc """
  `GET /` serves the built UI's `index.html`. Asset resolution prefers an
  environment override, then the bundled release UI, then the source checkout.
  These tests verify the exact default path and the endpoint's response.
  """
  use ExUnit.Case
  import Shuttle.Test.ApiConn
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  test "Assets.dist/0 resolves the bundled UI or the repository's sibling UI" do
    previous = System.get_env("SHUTTLE_UI_DIST")
    on_exit(fn -> Shuttle.Test.EnvHelpers.restore_env("SHUTTLE_UI_DIST", previous) end)
    System.delete_env("SHUTTLE_UI_DIST")

    bundled_dist = Application.app_dir(:shuttle, "priv/ui/dist")
    checkout_dist = Path.expand("../../../../ui/dist", __DIR__)

    expected = if File.dir?(bundled_dist), do: bundled_dist, else: checkout_dist
    assert ShuttleWeb.Assets.dist() == expected
  end

  test "GET / serves index.html when built, else 404s with a build hint" do
    conn = get(local_conn(), "/")
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
