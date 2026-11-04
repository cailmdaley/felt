defmodule ShuttleWeb.VersionControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  alias Shuttle.Test.{Env, StubGetFileClient}
  @endpoint ShuttleWeb.Endpoint

  test "version publishes the namespace contract independently of Poller readiness" do
    response = get(api_conn(), "/api/v1/version") |> json_response(200)
    assert response["contract_level"] == Shuttle.Contract.expected_level()
    assert response["contract_level"] >= 30
  end

  test "owner version is read live instead of substituting this daemon's contract" do
    StubGetFileClient.start!()

    StubGetFileClient.set_response(
      {:ok, 200, "application/json", ~s({"host":"worker","contract_level":29})}
    )

    Env.put_app_env(:write_forward_client, StubGetFileClient)
    Env.put_app_env(:remotes, [%{name: "worker", url: "http://localhost:4001"}])
    response = get(api_conn(), "/api/v1/version?origin=worker") |> json_response(200)
    assert %{"host" => "worker", "contract_level" => 29} = response
    assert %{url: "http://localhost:4001/api/v1/version?"} = StubGetFileClient.last()
  end
end
