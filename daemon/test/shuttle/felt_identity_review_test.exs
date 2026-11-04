defmodule Shuttle.FeltIdentityReviewTest do
  use ExUnit.Case, async: true
  alias Shuttle.Test.Env

  defp write_fiber(root, id, uid \\ nil) do
    path = Path.join([root, ".felt", id, Path.basename(id) <> ".md"])
    File.mkdir_p!(Path.dirname(path))
    stamp = if uid, do: "id: #{uid}\n", else: ""

    File.write!(
      path,
      "---\n#{stamp}name: #{id}\nstatus: active\nshuttle:\n  kind: oneshot\n  host: test-host\n  project_dir: #{root}\n---\n#{id}\n"
    )

    path
  end

  @tag :tmp_dir
  test "a no-UID substore address retains its exact path after switching stores", %{tmp_dir: tmp} do
    loom = Path.join(tmp, "loom")
    project = Path.join(tmp, "project")
    File.mkdir_p!(Path.join([loom, ".felt", "ai-futures"]))
    original = write_fiber(project, "hub")
    wanted = write_fiber(project, "other/hub")
    File.ln_s!(Path.join(project, ".felt"), Path.join([loom, ".felt", "ai-futures", "lightcone"]))
    Env.put_env("SHUTTLE_STORES", Enum.join([loom, project], ","))

    assert {:ok, %{store: ^project, fiber_id: "other/hub", uid: nil}} =
             Shuttle.FeltStores.resolve_request("ai-futures/lightcone/other/hub")

    assert {:ok, _} = Shuttle.LifecycleService.transition(:rest, "ai-futures/lightcone/other/hub")
    assert File.read!(wanted) =~ "status: open"
    assert File.read!(original) =~ "status: active"
  end
end
