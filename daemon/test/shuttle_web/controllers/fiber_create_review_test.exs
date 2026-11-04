defmodule ShuttleWeb.FiberCreateReviewTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  alias Shuttle.Test.Env
  @endpoint ShuttleWeb.Endpoint

  @tag :tmp_dir
  test "loom-only owners create in a polled namespace instead of initializing private stores", %{
    tmp_dir: tmp
  } do
    for layout <- ["no-store", "private-store"] do
      loom = Path.join([tmp, layout, "loom"])
      project = Path.join([tmp, layout, "project"])
      File.mkdir_p!(Path.join(loom, ".felt"))
      File.mkdir_p!(project)
      if layout == "private-store", do: File.mkdir_p!(Path.join(project, ".felt"))
      Env.put_env("SHUTTLE_STORES", loom)
      id = "science/team/hub/thread"
      uid = "01ARZ3NDEKTSV4RRFFQ69G5FAX"

      response =
        post(
          api_conn(),
          "/api/v1/fiber/create",
          Jason.encode!(%{
            id: id,
            uid: uid,
            name: "Thread",
            frontmatter: %{status: "active", shuttle: %{kind: "oneshot", project_dir: project}}
          })
        )
        |> json_response(200)

      {:ok, felt_root} = Shuttle.Realpath.resolve(Path.join(loom, ".felt"))
      assert String.starts_with?(response["path"], felt_root <> "/")
      assert {:ok, %{fiber_id: ^id, uid: ^uid}} = Shuttle.FeltStores.resolve_request(uid)
      assert Path.wildcard(Path.join([project, ".felt", "**", "*.md"])) == []
      if layout == "no-store", do: refute(File.exists?(Path.join(project, ".felt")))
    end
  end

  @tag :tmp_dir
  test "transferred UIDs cannot duplicate an existing owner document", %{tmp_dir: tmp} do
    loom = Path.join(tmp, "loom")
    project = Path.join(tmp, "project")
    uid = "01ARZ3NDEKTSV4RRFFQ69G5FAX"
    original = Path.join([loom, ".felt", "science/team/design/rex/rex.md"])
    File.mkdir_p!(Path.dirname(original))
    File.mkdir_p!(project)
    File.ln_s!(Path.join(loom, ".felt/science/team"), Path.join(project, ".felt"))
    content = "---\nid: #{uid}\nname: Rex\nstatus: open\n---\nOriginal\n"
    File.write!(original, content)
    Env.put_env("SHUTTLE_STORES", loom)

    response =
      post(
        api_conn(),
        "/api/v1/fiber/create",
        Jason.encode!(%{
          id: "design/rex",
          uid: uid,
          name: "Rex",
          frontmatter: %{status: "active", shuttle: %{kind: "oneshot", project_dir: project}}
        })
      )

    assert response.status == 400
    assert json_response(response, 400)["error"] =~ "UID"
    assert File.read!(original) == content
    assert Path.wildcard(Path.join([loom, ".felt", "**", "*.md"])) == [original]
    duplicate = Path.join([loom, ".felt", "other/rex/rex.md"])
    File.mkdir_p!(Path.dirname(duplicate))
    File.write!(duplicate, content)

    ambiguous =
      post(api_conn(), "/api/v1/lifecycle", Jason.encode!(%{action: "rest", fiber: uid}))

    assert ambiguous.status != 404
    assert ambiguous.status != 200
    assert ambiguous.resp_body =~ "ambiguous"
  end

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
