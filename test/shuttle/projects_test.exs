defmodule Shuttle.ProjectsTest do
  use ExUnit.Case, async: false

  alias Shuttle.Projects

  setup do
    prev_env = System.get_env("FELT_PROJECTS")
    prev_file = System.get_env("FELT_PROJECTS_FILE")

    # Point the registry at a throwaway file so tests never read/clobber the
    # user's real ~/.config/felt/projects.json.
    path = Path.join(System.tmp_dir!(), "shuttle-projects-#{System.unique_integer([:positive])}.json")
    System.delete_env("FELT_PROJECTS")
    System.put_env("FELT_PROJECTS_FILE", path)

    on_exit(fn ->
      File.rm(path)
      restore("FELT_PROJECTS", prev_env)
      restore("FELT_PROJECTS_FILE", prev_file)
    end)

    {:ok, path: path}
  end

  defp restore(key, nil), do: System.delete_env(key)
  defp restore(key, value), do: System.put_env(key, value)

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

  test "FELT_PROJECTS env overrides the file" do
    System.put_env("FELT_PROJECTS", "/tmp/x, /tmp/y")
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
