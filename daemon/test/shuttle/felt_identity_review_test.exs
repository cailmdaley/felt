defmodule Shuttle.FeltIdentityReviewTest do
  use ExUnit.Case, async: true
  alias Shuttle.Test.Env
  import Shuttle.Test.PollerHelpers

  defmodule ContentRunner do
    def cmd(command, args, opts) when command in ["felt", "shuttle"],
      do: Shuttle.Runner.Default.cmd(command, args, opts)

    def cmd("tmux", args, _opts), do: {"", if("has-session" in args, do: 1, else: 0)}
    def cmd(_command, _args, _opts), do: {"", 0}
  end

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

  defmodule HintOnlyRunner do
    def cmd("felt", ["-C", _store, "show", id | _] = args, opts) do
      if Shuttle.ULID.valid?(id),
        do: {"UID walk forbidden by this request budget", 1},
        else: Shuttle.Runner.Default.cmd("felt", args, opts)
    end

    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  @tag :tmp_dir
  test "verified lifecycle path hints avoid UID walks in both resolution and the real writer", %{
    tmp_dir: tmp
  } do
    store = Path.join(tmp, "store")
    uid = "01ARZ3NDEKTSV4RRFFQ69G5FAX"
    wanted = write_fiber(store, "team/target", uid)
    trap = write_fiber(store, "elsewhere/trap", uid)
    Env.put_env("SHUTTLE_STORES", store)
    Env.put_app_env(:felt_stores_runner, HintOnlyRunner)

    assert {:ok, _} =
             Shuttle.LifecycleService.transition(:pause, uid, ["--no-kill"], "team/target")

    assert File.read!(wanted) =~ "status: open"
    assert File.read!(trap) =~ "status: active"
  end

  @tag :tmp_dir
  test "serialized lifecycle keeps the exactly resolved store and UID", %{tmp_dir: tmp} do
    loom = Path.join(tmp, "loom")
    project = Path.join(tmp, "project")
    wrong = write_fiber(loom, "x/y/analysis", "01ARZ3NDEKTSV4RRFFQ69G5FAW")
    uid = "01ARZ3NDEKTSV4RRFFQ69G5FAX"
    wanted = write_fiber(project, "analysis", uid)
    stores = [loom, project]
    Env.put_env("SHUTTLE_STORES", Enum.join(stores, ","))

    {:ok, _poller} =
      start_poller!(runner: ContentRunner, felt_stores: stores, interval_ms: 60_000)

    assert {:ok, _} = Shuttle.LifecycleService.transition(:pause, uid, ["--no-kill"])
    assert File.read!(wanted) =~ "status: open"
    assert File.read!(wrong) =~ "status: active"
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
