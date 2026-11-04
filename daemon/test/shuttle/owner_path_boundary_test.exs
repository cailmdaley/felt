defmodule Shuttle.OwnerPathBoundaryTest do
  use ExUnit.Case, async: true
  alias Shuttle.Test.Env

  @tag :tmp_dir
  test "resolved physical paths outside every namespace are errors rather than absolute IDs", %{
    tmp_dir: tmp
  } do
    loom = Path.join(tmp, "loom")
    notes = Path.join(tmp, "notes")
    File.mkdir_p!(Path.join(loom, ".felt"))
    path = Path.join(notes, "hub/hub.md")
    File.mkdir_p!(Path.dirname(path))
    uid = "01ARZ3NDEKTSV4RRFFQ69G5FAX"
    File.write!(path, "---\nid: #{uid}\nname: Hub\nstatus: open\n---\nBody\n")
    File.ln_s!(notes, Path.join(loom, ".felt/linked"))
    Env.put_env("SHUTTLE_STORES", loom)
    assert {:error, reason} = Shuttle.FeltStores.resolve_request("linked/hub")
    assert reason =~ "outside_store"
    assert {:error, reason} = Shuttle.FeltStores.resolve_request(uid, "linked/hub")
    assert reason =~ "outside_store"
    assert {:error, _} = Shuttle.FeltStores.resolve_fiber("linked/hub")
  end
end
