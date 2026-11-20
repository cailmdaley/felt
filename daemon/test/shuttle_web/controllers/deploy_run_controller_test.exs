defmodule ShuttleWeb.DeployRunControllerTest do
  @moduledoc """
  The deploy-run routes end to end, with real detached processes: a run
  receives its files, starts outside the daemon's session with an ssh-login
  environment, streams its output, records its exit status, and turns DELETE
  into a cancel marker while running and a removal once finished.
  """
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  alias Shuttle.Test.Env

  setup do
    root = Path.join(System.tmp_dir!(), "deploy-runs-#{System.unique_integer([:positive])}")
    Env.put_app_env(:deploy_runs_dir, root)
    on_exit(fn -> File.rm_rf(root) end)
    %{root: root}
  end

  defp raw(conn), do: put_req_header(conn, "content-type", "application/octet-stream")

  defp create do
    %{"id" => id, "dir" => dir} = json_response(post(api_conn(), "/api/v1/deploy/runs", ""), 201)
    {id, dir}
  end

  defp start(id, script),
    do: post(raw(local_conn()), "/api/v1/deploy/runs/#{id}/start", script)

  # Reads output until the run reports its status, as the relay does.
  defp drain(id, offset \\ 0, acc \\ "", tries \\ 200) do
    conn = get(local_conn(), "/api/v1/deploy/runs/#{id}/output?offset=#{offset}")
    assert conn.status == 200
    acc = acc <> conn.resp_body

    case get_resp_header(conn, "x-deploy-status") do
      [code] ->
        {String.to_integer(code), acc}

      [] when tries > 0 ->
        Process.sleep(50)
        drain(id, offset + byte_size(conn.resp_body), acc, tries - 1)
    end
  end

  test "a run receives files, runs detached with a login-like environment, and reports its exit",
       %{root: root} do
    Env.put_env("SHUTTLE_DEPLOY_RUN_LEAK", "leaked")
    {id, dir} = create()
    assert dir == Path.join(root, id)

    conn = put(raw(local_conn()), "/api/v1/deploy/runs/#{id}/files/payload.tar", "payload bytes")
    assert conn.status == 204

    script = """
    cat payload.tar; echo
    echo "leak=${SHUTTLE_DEPLOY_RUN_LEAK-unset} root=${ROOTDIR-unset} home=$HOME"
    [ "$(ps -o pgid= -p $$)" != "$(ps -o pgid= -p #{System.pid()})" ] && echo own-session
    echo to-stderr >&2
    exit 3
    """

    assert json_response(start(id, script), 202)["id"] == id
    assert start(id, script).status == 409

    {code, out} = drain(id)
    assert code == 3
    assert out =~ "payload bytes"
    assert out =~ "leak=unset root=unset home=#{System.user_home!()}"
    assert out =~ "own-session"
    assert out =~ "to-stderr"
    assert File.exists?(Path.join(dir, "beat"))

    assert delete(local_conn(), "/api/v1/deploy/runs/#{id}").status == 204
    refute File.exists?(dir)
    assert get(local_conn(), "/api/v1/deploy/runs/#{id}/output").status == 404
  end

  test "DELETE on a running run leaves a cancel marker the script obeys" do
    {id, _dir} = create()

    script =
      "echo started; while [ ! -e cancel ]; do sleep 0.05; done; echo cancelled; exit 143\n"

    assert start(id, script).status == 202

    assert json_response(delete(local_conn(), "/api/v1/deploy/runs/#{id}"), 202) == %{
             "cancel" => true
           }

    assert {143, out} = drain(id)
    assert out =~ "started\n"
    assert out =~ "cancelled\n"
  end

  test "names and ids outside their forms are refused" do
    {id, _dir} = create()
    assert put(raw(local_conn()), "/api/v1/deploy/runs/#{id}/files/..evil", "x").status == 400
    assert get(local_conn(), "/api/v1/deploy/runs/../output").status == 404
    assert get(local_conn(), "/api/v1/deploy/runs/#{id}/output?offset=-1").status == 400
  end
end
