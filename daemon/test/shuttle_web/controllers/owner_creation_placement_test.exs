defmodule ShuttleWeb.OwnerCreationPlacementTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  alias Shuttle.Test.Env
  @endpoint ShuttleWeb.Endpoint

  defp doc(root, id) do
    path = Path.join([root, ".felt", id, Path.basename(id) <> ".md"])
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, "---\nname: Parent\nstatus: open\n---\nParent body\n")
  end

  defp create(id, cwd, expected) do
    result =
      post(
        api_conn(),
        "/api/v1/fiber/create",
        Jason.encode!(%{
          id: id,
          name: "Child",
          frontmatter: %{status: "active", shuttle: %{kind: "oneshot", project_dir: cwd}}
        })
      )
      |> json_response(200)

    {:ok, physical} = Shuttle.Realpath.resolve(expected)
    assert result["path"] == physical
    assert result["id"] == id
    assert File.exists?(physical)
    assert {:ok, %{path: ^physical}} = Shuttle.FeltStores.resolve_request(result["uid"])
  end

  @tag :tmp_dir
  test "an unpolled symlink destination is refused before writing anything", %{tmp_dir: tmp} do
    loom = Path.join(tmp, "loom")
    notes = Path.join(tmp, "notes")
    File.mkdir_p!(Path.join(loom, ".felt"))
    File.mkdir_p!(notes)
    File.ln_s!(notes, Path.join(loom, ".felt/linked"))
    Env.put_env("SHUTTLE_STORES", loom)

    result =
      post(
        api_conn(),
        "/api/v1/fiber/create",
        Jason.encode!(%{id: "linked/hole/child", name: "Child", frontmatter: %{status: "open"}})
      )

    assert result.status == 400
    assert result.resp_body =~ "outside every polled store"
    assert File.ls!(notes) == []
    assert File.ls!(Path.join(loom, ".felt")) == ["linked"]
  end

  @tag :tmp_dir
  test "linked project ancestors own their children independent of the worker cwd", %{
    tmp_dir: tmp
  } do
    loom = Path.join(tmp, "loom")
    project = Path.join(tmp, "project")
    plain = Path.join(tmp, "plain")
    File.mkdir_p!(plain)
    doc(loom, "anchor")
    doc(project, "hub")
    File.mkdir_p!(Path.join(loom, ".felt/ai-futures"))
    File.ln_s!(Path.join(project, ".felt"), Path.join(loom, ".felt/ai-futures/lightcone"))
    Env.put_env("SHUTTLE_STORES", loom)

    create(
      "ai-futures/lightcone/hub/measure",
      project,
      Path.join(project, ".felt/hub/measure/measure.md")
    )

    create("hub/m3", plain, Path.join(project, ".felt/hub/m3/m3.md"))
    refute File.exists?(Path.join(project, ".felt/ai-futures"))
    refute File.exists?(Path.join(loom, ".felt/hub"))
  end

  @tag :tmp_dir
  test "the nearest ancestor wins over store order and another registered cwd", %{tmp_dir: tmp} do
    a = Path.join(tmp, "a")
    b = Path.join(tmp, "b")
    plain = Path.join(tmp, "plain")
    File.mkdir_p!(plain)
    doc(a, "science/team")
    doc(b, "science/team/hub")

    for {stores, cwd, leaf} <- [{a <> "," <> b, plain, "first"}, {b <> "," <> a, a, "second"}] do
      Env.put_env("SHUTTLE_STORES", stores)
      id = "science/team/hub/missing/" <> leaf
      create(id, cwd, Path.join([b, ".felt", id, leaf <> ".md"]))
      refute File.exists?(Path.join([a, ".felt", id]))
    end
  end
end
