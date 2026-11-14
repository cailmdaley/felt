defmodule ShuttleWeb.FiberChangeControllerTest do
  @moduledoc """
  `POST /api/v1/fibers/<id>/change` — the board's Change page bakes the
  constitution's change on its owner; `GET /api/v1/changes/<id>` lists the PRs
  it follows. Real felt resolves the fiber's store;
  a fake shuttle records the argv it is handed and answers as the test asks.
  """
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest

  alias Shuttle.Test.{Env, FakeCli, ForwardStub, StubGetFileClient, StubPostClient}

  @endpoint ShuttleWeb.Endpoint

  @moduletag :tmp_dir

  setup %{tmp_dir: tmp} do
    store = Path.join(tmp, "loom")
    fiber_dir = Path.join([store, ".felt", "tests", "review"])
    File.mkdir_p!(fiber_dir)

    File.write!(
      Path.join(fiber_dir, "review.md"),
      "---\nname: Review\nshuttle:\n  kind: oneshot\n  project_dir: /work\n---\n"
    )

    FakeCli.install!(%{
      "felt" => "#!/bin/sh\nexec \"#{FakeCli.real!("felt")}\" \"$@\"\n",
      "shuttle" => """
      #!/bin/sh
      printf '%s\\n' "$@" > "$SHUTTLE_ARGS_FILE"
      printf '%s' "$SHUTTLE_FAKE_OUTPUT"
      exit "${SHUTTLE_FAKE_STATUS:-0}"
      """
    })

    args = Path.join(tmp, "argv")
    Env.put_env("SHUTTLE_STORES", store)
    Env.put_env("SHUTTLE_ARGS_FILE", args)
    Env.put_app_env(:remotes, [])
    %{store: store, args: args}
  end

  test "a local bake shells shuttle change into the cache and answers with its bundle", %{
    store: store,
    args: args
  } do
    report = %{
      "path" => "/cache/felt/changes/u/pr-7.change.json",
      "valid" => true
    }

    Env.put_env("SHUTTLE_FAKE_OUTPUT", Jason.encode!(report, pretty: true) <> "\n")

    conn = post(api_conn(), "/api/v1/fibers/tests/review/change", Jason.encode!(%{"pr" => 7}))

    assert conn.status == 200

    assert Jason.decode!(conn.resp_body) == %{
             "path" => report["path"],
             "report" => report
           }

    assert File.read!(args) ==
             "-C\n#{store}\nchange\ntests/review\n--cache\n--json\n--pr\n7\n"
  end

  test "a failed bake answers with shuttle's reason as one line", %{args: args} do
    Env.put_env("SHUTTLE_FAKE_OUTPUT", "/work is not a Git repository\n")
    Env.put_env("SHUTTLE_FAKE_STATUS", "1")

    conn = post(api_conn(), "/api/v1/fibers/tests/review/change", "{}")

    assert conn.status == 422
    assert Jason.decode!(conn.resp_body) == %{"error" => "/work is not a Git repository"}
    refute File.read!(args) =~ "--pr"
  end

  test "a fiber this host does not hold is a 404 and shuttle never runs", %{args: args} do
    conn = post(api_conn(), "/api/v1/fibers/tests/absent/change", "{}")

    assert conn.status == 404
    refute File.exists?(args)
  end

  test "only the change segment names the route", %{args: args} do
    assert post(api_conn(), "/api/v1/fibers/tests/review", "{}").status == 404
    assert post(api_conn(), "/api/v1/fibers/change", "{}").status == 404
    refute File.exists?(args)
  end

  test "a remote origin forwards to its owner, and nothing runs here", %{args: args} do
    reply =
      Jason.encode!(%{"path" => "/remote/cache.change.json", "report" => %{}})

    ForwardStub.stub_forward(
      "candide",
      "http://candide.example:4000",
      {:ok, 200, reply},
      StubPostClient
    )

    conn =
      post(
        api_conn(),
        "/api/v1/fibers/tests/review/change",
        Jason.encode!(%{"origin" => "candide", "pr" => 7})
      )

    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["path"] == "/remote/cache.change.json"
    last = StubPostClient.last()
    assert last.url == "http://candide.example:4000/api/v1/fibers/tests/review/change"
    assert Jason.decode!(last.body) == %{"pr" => 7}
    refute File.exists?(args)
  end

  test "an unknown origin is a 400", %{args: args} do
    conn =
      post(
        api_conn(),
        "/api/v1/fibers/tests/review/change",
        Jason.encode!(%{"origin" => "nowhere"})
      )

    assert conn.status == 400
    refute File.exists?(args)
  end

  describe "GET: the PRs a constitution follows" do
    test "a local list shells shuttle change --list and answers its PRs", %{
      store: store,
      args: args
    } do
      prs = [%{"number" => 12, "title" => "Open one"}, %{"number" => 404, "error" => "gh: no"}]
      Env.put_env("SHUTTLE_FAKE_OUTPUT", Jason.encode!(prs))

      conn = get(api_conn(), "/api/v1/changes/tests/review")

      assert conn.status == 200
      assert Jason.decode!(conn.resp_body) == %{"prs" => prs}
      assert File.read!(args) == "-C\n#{store}\nchange\ntests/review\n--list\n--json\n"
    end

    test "a failed list answers with shuttle's reason", %{args: args} do
      Env.put_env(
        "SHUTTLE_FAKE_OUTPUT",
        "Error: fiber belongs to host \"fir\"; run shuttle change there\n"
      )

      Env.put_env("SHUTTLE_FAKE_STATUS", "1")

      conn = get(api_conn(), "/api/v1/changes/tests/review")

      assert conn.status == 422
      assert Jason.decode!(conn.resp_body)["error"] =~ "fiber belongs to host"
      assert File.exists?(args)
    end

    test "a fiber whose path ends in change reads as that fiber", %{store: store, args: args} do
      dir = Path.join([store, ".felt", "tests", "review", "change"])
      File.mkdir_p!(dir)
      File.write!(Path.join(dir, "change.md"), "---\nname: A note named change\n---\n")

      conn = get(api_conn(), "/api/v1/fibers/tests/review/change")

      assert conn.status == 200
      assert [%{"fiber" => %{"name" => "A note named change"}}] =
               Jason.decode!(conn.resp_body)["fibers"]
      refute File.exists?(args)
    end

    test "a remote origin forwards to its owner, and nothing runs here", %{args: args} do
      ForwardStub.stub_forward(
        "candide",
        "http://candide.example:4000",
        {:ok, 200, "application/json; charset=utf-8", ~s({"prs":[{"number":3}]})}
      )

      conn = get(api_conn(), "/api/v1/changes/tests/review?origin=candide")

      assert conn.status == 200
      assert Jason.decode!(conn.resp_body) == %{"prs" => [%{"number" => 3}]}

      assert URI.parse(StubGetFileClient.last().url).path == "/api/v1/changes/tests/review"

      refute File.exists?(args)
    end
  end
end
