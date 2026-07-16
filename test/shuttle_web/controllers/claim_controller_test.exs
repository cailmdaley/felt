defmodule ShuttleWeb.ClaimControllerTest do
  use ExUnit.Case
  import Phoenix.ConnTest
  import Plug.Conn

  @endpoint ShuttleWeb.Endpoint

  # POST transport stub for the write-forward plane: records the last (url, body)
  # and replays a scripted response.
  defmodule ClaimForwardClient do
    use Agent

    def start_link(response),
      do: Agent.start_link(fn -> %{response: response, last: nil} end, name: __MODULE__)

    def last, do: Agent.get(__MODULE__, & &1.last)

    def post(url, body, _content_type, _timeout_ms) do
      Agent.update(__MODULE__, &Map.put(&1, :last, %{url: url, body: body}))
      Agent.get(__MODULE__, & &1.response)
    end
  end

  test "POST /api/v1/claim without fiber_id is a 400" do
    conn =
      api_conn()
      |> post("/api/v1/claim", Jason.encode!(%{tmux_session: "capture-x"}))

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "fiber_id"
  end

  test "POST /api/v1/claim without tmux_session is a 400" do
    conn =
      api_conn()
      |> post("/api/v1/claim", Jason.encode!(%{fiber_id: "tests/x"}))

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "tmux_session"
  end

  test "forwards a remote-origin claim to the owning daemon, origin stripped, relaying its response" do
    start_supervised!(
      {ClaimForwardClient,
       {:ok, 200,
        Jason.encode!(%{
          "claimed" => true,
          "fiber_id" => "tests/x",
          "tmux_session" => "capture-x"
        })}}
    )

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: "candide", url: "http://localhost:4001"}])
    Application.put_env(:shuttle, :write_forward_client, ClaimForwardClient)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)

    conn =
      api_conn()
      |> post(
        "/api/v1/claim",
        Jason.encode!(%{
          fiber_id: "tests/x",
          tmux_session: "capture-x",
          origin: "candide"
        })
      )

    # The owning daemon's response is relayed verbatim (status + JSON body).
    assert conn.status == 200
    assert %{"claimed" => true, "fiber_id" => "tests/x"} = Jason.decode!(conn.resp_body)

    # Forwarded to the owning remote's identical /claim with origin stripped —
    # only the owner can see the tmux session and run the watcher.
    last = ClaimForwardClient.last()
    assert last.url == "http://localhost:4001/api/v1/claim"
    forwarded = Jason.decode!(last.body)
    refute Map.has_key?(forwarded, "origin")
    assert forwarded["fiber_id"] == "tests/x"
    assert forwarded["tmux_session"] == "capture-x"
  end

  defp restore_app_env(key, nil), do: Application.delete_env(:shuttle, key)
  defp restore_app_env(key, value), do: Application.put_env(:shuttle, key, value)

  defp api_conn do
    build_conn() |> put_req_header("content-type", "application/json")
  end
end
