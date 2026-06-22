defmodule ShuttleWeb.ErrorJSONTest do
  @moduledoc """
  The daemon serves only JSON + a SPA, so every error path must render as JSON,
  not crash. Before `render_errors` pointed at `ShuttleWeb.ErrorJSON`, Phoenix
  fell back to a non-existent `ShuttleWeb.ErrorView` and the 404 render itself
  raised — an unknown route (e.g. a stale client POSTing a not-yet-deployed
  route) surfaced as an opaque 500 with no body. This pins the JSON shape.
  """

  use ExUnit.Case
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  test "render/2 maps a status template to its JSON detail" do
    assert ShuttleWeb.ErrorJSON.render("404.json", %{}) ==
             %{errors: %{detail: "Not Found"}}

    assert ShuttleWeb.ErrorJSON.render("500.json", %{}) ==
             %{errors: %{detail: "Internal Server Error"}}
  end

  test "an unknown route renders a JSON 404, not a render crash" do
    conn = post(build_conn(), "/api/v1/this-route-does-not-exist", %{})

    assert conn.status == 404
    assert json_response(conn, 404) == %{"errors" => %{"detail" => "Not Found"}}
  end
end
