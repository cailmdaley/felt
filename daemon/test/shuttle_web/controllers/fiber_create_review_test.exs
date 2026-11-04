defmodule ShuttleWeb.FiberCreateReviewTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  alias Shuttle.Test.Env
  @endpoint ShuttleWeb.Endpoint

  @tag :tmp_dir
  test "invalid create inputs leave no document behind", %{tmp_dir: tmp} do
    loom = Path.join(tmp, "loom")
    File.mkdir_p!(Path.join(loom, ".felt"))
    Env.put_env("SHUTTLE_STORES", loom)

    for {id, status} <- [{"x/y", ""}, {"x/Upper Case", "open"}] do
      response =
        post(
          api_conn(),
          "/api/v1/fiber/create",
          Jason.encode!(%{id: id, name: "Y", frontmatter: %{status: status}})
        )

      assert response.status == 400
      assert Path.wildcard(Path.join([loom, ".felt", "**", "*.md"])) == []
    end
  end
end
