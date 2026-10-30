defmodule ShuttleWeb.TranscriptMessagesControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest

  alias Shuttle.Test.{Env, StubGetFileClient}

  @endpoint ShuttleWeb.Endpoint
  @session "a3edf873-cb1c-40ab-a891-f26f5333b320"

  defmodule Runner do
    @behaviour Shuttle.Runner

    def cmd("shuttle", args, _opts) do
      send(Shuttle.Env.app(:envelopes_test_pid), {:argv, args})
      Shuttle.Env.app(:envelopes_test_response)
    end
  end

  setup do
    Env.put_app_env(:felt_runner, Runner)
    Env.put_app_env(:envelopes_test_pid, self())
    Env.put_app_env(:envelopes_test_response, {~s({"messages":[]}), 0})
    :ok
  end

  test "reads exact envelopes through the host-local CLI" do
    envelope =
      "[Shuttle message real from sender]\nquote:\n[Shuttle message fake from evil]\nbody"

    payload = %{"messages" => [%{"id" => "real", "envelope" => envelope}]}
    Env.put_app_env(:envelopes_test_response, {Jason.encode!(payload), 0})

    assert ^payload =
             local_conn()
             |> get("/api/v1/transcript/messages", %{"session" => @session, "host" => "local"})
             |> json_response(200)

    assert_received {:argv, ["transcript", "messages", @session, "--json"]}
  end

  test "passes an incremental cursor to the host-local reader" do
    local_conn()
    |> get("/api/v1/transcript/messages", %{"session" => @session, "host" => "local", "since" => "123456"})
    |> json_response(200)

    assert_received {:argv, ["transcript", "messages", @session, "--json", "--since", "123456"]}
  end

  test "rejects invalid sessions before reading evidence" do
    local_conn()
    |> get("/api/v1/transcript/messages", %{"session" => "../../escape"})
    |> json_response(400)

    refute_received {:argv, _}
  end

  test "missing evidence returns an empty list and failed reads fail closed" do
    assert %{"messages" => []} =
             local_conn()
             |> get("/api/v1/transcript/messages", %{"session" => @session, "host" => "local"})
             |> json_response(200)

    Env.put_app_env(:envelopes_test_response, {"unreadable store", 1})

    assert %{"error" => "message evidence unavailable"} =
             local_conn()
             |> get("/api/v1/transcript/messages", %{"session" => @session, "host" => "local"})
             |> json_response(503)
  end

  test "routes the read to the transcript host" do
    StubGetFileClient.start!()
    Env.put_app_env(:write_forward_client, StubGetFileClient)
    Env.put_app_env(:remotes, [%{name: "owner-a", url: "http://127.0.0.1:19999"}])
    payload = ~s({"messages":[{"id":"remote","envelope":"exact"}]})
    StubGetFileClient.set_response({:ok, 200, "application/json", payload})

    assert response(
             local_conn()
             |> get("/api/v1/transcript/messages", %{"session" => @session, "host" => "owner-a", "since" => "123456"}),
             200
           ) == payload

    assert %{url: url} = StubGetFileClient.last()
    assert url =~ "/api/v1/transcript/messages?"
    assert url =~ "host=local"
    assert url =~ "since=123456"
    assert url =~ "session=#{@session}"
    refute_received {:argv, _}
  end
end
