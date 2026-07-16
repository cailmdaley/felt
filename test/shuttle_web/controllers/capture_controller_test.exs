defmodule ShuttleWeb.CaptureControllerTest do
  use ExUnit.Case
  import Phoenix.ConnTest
  import Plug.Conn

  @endpoint ShuttleWeb.Endpoint

  # POST transport stub for the write-forward plane: records the last (url, body)
  # and replays a scripted response.
  defmodule CaptureForwardClient do
    use Agent

    def start_link(response),
      do: Agent.start_link(fn -> %{response: response, last: nil} end, name: __MODULE__)

    def last, do: Agent.get(__MODULE__, & &1.last)

    def post(url, body, _content_type, _timeout_ms) do
      Agent.update(__MODULE__, &Map.put(&1, :last, %{url: url, body: body}))
      Agent.get(__MODULE__, & &1.response)
    end
  end

  test "POST /api/v1/capture without prompt is a 400" do
    conn =
      api_conn()
      |> post("/api/v1/capture", Jason.encode!(%{project_dir: "/tmp"}))

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "prompt"
  end

  test "POST /api/v1/capture without project_dir is a 400" do
    conn =
      api_conn()
      |> post("/api/v1/capture", Jason.encode!(%{prompt: "an idea"}))

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "project_dir"
  end

  test "POST /api/v1/capture with a missing project_dir is a 422" do
    conn =
      api_conn()
      |> post(
        "/api/v1/capture",
        Jason.encode!(%{prompt: "an idea", project_dir: "/no/such/dir/portolan"})
      )

    assert conn.status == 422
    assert Jason.decode!(conn.resp_body)["reason"] == "project_dir_missing"
  end

  # Axes constraint rejection (effort outside effort_levels, chrome on a
  # non-claude harness) is covered at the Dispatcher layer
  # (dispatcher_test.exs "capture rejects axes outside the agent's
  # constraints"); the controller maps any string reason to a 422.

  test "forwards a remote-origin capture to the owning daemon, origin stripped, relaying its response" do
    start_supervised!(
      {CaptureForwardClient,
       {:ok, 200, Jason.encode!(%{"spawned" => true, "tmux_session" => "capture-1"})}}
    )

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: "candide", url: "http://localhost:4001"}])
    Application.put_env(:shuttle, :write_forward_client, CaptureForwardClient)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)

    conn =
      api_conn()
      |> post(
        "/api/v1/capture",
        Jason.encode!(%{
          prompt: "an idea",
          project_dir: "/candide/project",
          origin: "candide"
        })
      )

    # The owning daemon's response is relayed verbatim (status + JSON body).
    assert conn.status == 200
    assert %{"spawned" => true, "tmux_session" => "capture-1"} = Jason.decode!(conn.resp_body)

    # Forwarded to the owning remote's identical /capture with origin stripped —
    # the session must spawn where the project lives.
    last = CaptureForwardClient.last()
    assert last.url == "http://localhost:4001/api/v1/capture"
    forwarded = Jason.decode!(last.body)
    refute Map.has_key?(forwarded, "origin")
    assert forwarded["prompt"] == "an idea"
    assert forwarded["project_dir"] == "/candide/project"
  end

  defp restore_app_env(key, nil), do: Application.delete_env(:shuttle, key)
  defp restore_app_env(key, value), do: Application.put_env(:shuttle, key, value)

  defp api_conn do
    build_conn() |> put_req_header("content-type", "application/json")
  end
end
