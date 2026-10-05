defmodule Shuttle.ProjectsTest do
  use ExUnit.Case, async: true

  alias Shuttle.Projects

  setup do
    # Point the registry at a throwaway file so tests never read/clobber the
    # user's real ~/.config/shuttle/projects.json.
    path =
      Path.join(System.tmp_dir!(), "shuttle-projects-#{System.unique_integer([:positive])}.json")

    Shuttle.Test.Env.delete_env("SHUTTLE_PROJECTS")
    Shuttle.Test.Env.put_env("SHUTTLE_PROJECTS_FILE", path)

    on_exit(fn -> File.rm(path) end)

    {:ok, path: path}
  end

  test "absent file resolves to []" do
    assert Projects.configured_projects() == []
  end

  test "reads the persisted {version, projects} shape, normalized", %{path: path} do
    File.write!(
      path,
      Jason.encode!(%{"version" => 1, "projects" => ["~/loom", "/tmp/talks", "~/loom", "  "]})
    )

    assert Projects.configured_projects() == [Path.expand("~/loom"), "/tmp/talks"]
  end

  test "accepts a bare JSON array too", %{path: path} do
    File.write!(path, Jason.encode!(["/tmp/a", "/tmp/b"]))
    assert Projects.configured_projects() == ["/tmp/a", "/tmp/b"]
  end

  test "SHUTTLE_PROJECTS env overrides the file" do
    Shuttle.Test.Env.put_env("SHUTTLE_PROJECTS", "/tmp/x, /tmp/y")
    assert Projects.configured_projects() == ["/tmp/x", "/tmp/y"]
  end

  test "save round-trips and an empty list deletes the file", %{path: path} do
    assert {:ok, saved} = Projects.save(["/tmp/one", "/tmp/one", "/tmp/two"])
    assert saved == ["/tmp/one", "/tmp/two"]
    assert Projects.configured_projects() == ["/tmp/one", "/tmp/two"]

    assert {:ok, []} = Projects.save([])
    refute File.exists?(path)
  end
end
