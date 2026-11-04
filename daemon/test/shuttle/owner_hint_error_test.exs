defmodule Shuttle.OwnerHintErrorTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  alias Shuttle.Test.Env
  @endpoint ShuttleWeb.Endpoint
  @uid "01ARZ3NDEKTSV4RRFFQ69G5FAX"

  defmodule Runner do
    def cmd("felt", ["-C", _, "show", "a/t" | _], _) do
      case Shuttle.Env.app(:hint_failure) do
        :timeout -> {"", :timeout}
        :error -> {~s({"error":"unparseable owner document"}), 1}
      end
    end

    def cmd("felt", ["-C", _, "show", _ | _], _), do: {~s({"error_code":"not_found"}), 1}
    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  @tag :tmp_dir
  test "hint failures are not permission to search for an authoritative miss", %{tmp_dir: tmp} do
    File.mkdir_p!(Path.join(tmp, ".felt"))
    Env.put_env("SHUTTLE_STORES", tmp)
    Env.put_app_env(:felt_stores_runner, Runner)
    Env.put_app_env(:hint_failure, :error)
    assert {:error, reason} = Shuttle.FeltStores.resolve_request(@uid, "a/t")
    assert reason =~ "unparseable owner document"
    Env.put_app_env(:hint_failure, :timeout)
    assert {:error, :timeout, _} = Shuttle.FeltStores.resolve_request(@uid, "a/t")
  end

  @tag :tmp_dir
  test "conflict markers at the owner hint never produce a lifecycle 404", %{tmp_dir: tmp} do
    path = Path.join(tmp, ".felt/a/t/t.md")
    File.mkdir_p!(Path.dirname(path))

    body =
      "---\nid: #{@uid}\nname: T\n<<<<<<< HEAD\nstatus: open\n=======\nstatus: active\n>>>>>>> branch\n---\nBody\n"

    File.write!(path, body)
    Env.put_env("SHUTTLE_STORES", tmp)

    response =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{action: "resume", fiber: @uid, fiber_path: "a/t"})
      )

    assert response.status not in [200, 404]
    assert File.read!(path) == body
  end
end
