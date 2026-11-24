defmodule ShuttleWeb.RehomeControllerTest do
  use ExUnit.Case, async: false
  import Shuttle.Test.ApiConn
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  defmodule FakeForwardClient do
    def post(url, body, _content_type, _timeout) do
      pid = Application.get_env(:shuttle, :rehome_test_pid)
      send(pid, {:forward_post, url, Jason.decode!(body)})

      case Application.get_env(:shuttle, :rehome_forward_handler) do
        fun when is_function(fun, 2) -> fun.(url, Jason.decode!(body))
        _ -> {:ok, 200, Jason.encode!(%{"ok" => true})}
      end
    end
  end

  setup do
    prev_pid = Application.get_env(:shuttle, :rehome_test_pid)
    prev_handler = Application.get_env(:shuttle, :rehome_forward_handler)

    Shuttle.Test.Env.put_app_env(:write_forward_client, FakeForwardClient)
    Application.put_env(:shuttle, :rehome_test_pid, self())

    on_exit(fn ->
      restore_env(:rehome_test_pid, prev_pid)
      restore_env(:rehome_forward_handler, prev_handler)
    end)

    :ok
  end

  defp restore_env(key, nil), do: Application.delete_env(:shuttle, key)
  defp restore_env(key, val), do: Application.put_env(:shuttle, key, val)

  defp post_rehome(body) do
    api_conn()
    |> put_req_header("content-type", "application/json")
    |> post("/api/v1/rehome", Jason.encode!(body))
  end

  test "rejects missing fiber or unknown target_host" do
    conn = post_rehome(%{"target_host" => "remote-hub"})
    assert conn.status == 400

    conn = post_rehome(%{"fiber" => "felt", "target_host" => "nonexistent-host"})
    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "unknown origin"
  end

  test "succeeds with warning when previous host is unreachable" do
    Application.put_env(:shuttle, :rehome_forward_handler, fn url, body ->
      cond do
        String.contains?(url, "dead-cluster") ->
          {:error, :econnrefused}

        String.contains?(url, "remote-hub") and body["phase"] == "takeover" ->
          {:ok, 200,
           Jason.encode!(%{
             "ok" => true,
             "host" => "remote-hub",
             "fiber" => "felt",
             "uid" => "01FELT",
             "project_dir" => "/home/me/felt"
           })}

        true ->
          {:ok, 200, Jason.encode!(%{"ok" => true})}
      end
    end)

    Shuttle.Test.Env.put_app_env(:remotes, [
      %Shuttle.Remote{name: "remote-hub", url: "http://remote-hub.local:4000"},
      %Shuttle.Remote{name: "dead-cluster", url: "http://dead-cluster.local:4000"}
    ])

    conn =
      post_rehome(%{
        "fiber" => "felt",
        "origin" => "dead-cluster",
        "target_host" => "remote-hub",
        "project_dir" => "/home/me/felt"
      })

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["ok"] == true
    assert body["host"] == "remote-hub"
    assert body["from_host"] == "dead-cluster"
    assert body["previous_host_released"] == false
    assert body["previous_host_warning"] =~ "dead-cluster was unreachable"
  end

  test "fails without touching origin when destination takeover fails" do
    Application.put_env(:shuttle, :rehome_forward_handler, fn url, body ->
      cond do
        String.contains?(url, "remote-hub") and body["phase"] == "takeover" ->
          {:ok, 422,
           Jason.encode!(%{
             "ok" => false,
             "reason" => "project_dir_invalid",
             "needs" => "project_dir",
             "host" => "remote-hub",
             "error" => "project_dir does not exist"
           })}

        String.contains?(url, "source-host") and body["phase"] == "export" ->
          {:ok, 200,
           Jason.encode!(%{
             "ok" => true,
             "document" => "---\nname: Felt\n---\n",
             "uid" => "01FELT",
             "fiber_path" => "felt"
           })}

        true ->
          {:ok, 200, Jason.encode!(%{"ok" => true})}
      end
    end)

    Shuttle.Test.Env.put_app_env(:remotes, [
      %Shuttle.Remote{name: "remote-hub", url: "http://remote-hub.local:4000"},
      %Shuttle.Remote{name: "source-host", url: "http://source-host.local:4000"}
    ])

    conn =
      post_rehome(%{
        "fiber" => "felt",
        "origin" => "source-host",
        "target_host" => "remote-hub",
        "project_dir" => "/missing"
      })

    assert conn.status == 422
    body = Jason.decode!(conn.resp_body)
    assert body["needs"] == "project_dir"

    # Must NEVER have sent phase: "release" to source-host.
    refute_received {:forward_post, "http://source-host.local:4000/api/v1/rehome",
                     %{"phase" => "release"}}
  end
end
