defmodule ShuttleWeb.MessagingControllerTest do
  use ExUnit.Case, async: false
  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn

  alias Shuttle.Remote
  @endpoint ShuttleWeb.Endpoint

  defmodule Runner do
    @behaviour Shuttle.Runner
    def cmd("felt", ["shuttle", "sessions", "--local", "--json"], _opts) do
      {Jason.encode!(%{
         sessions: [%{address: "shuttle://actual/codex/native%2Fid", harness: "codex"}]
       }), 0}
    end

    def cmd("felt", ["shuttle", "message", "--local", "--json", "--request-json"], opts) do
      request = opts[:input] |> String.trim() |> Jason.decode!()

      if request["message_id"] == "malformed-local" do
        {Jason.encode!(%{error: "receipt lost"}), 0}
      else
        {Jason.encode!(%{
           message_id: request["message_id"],
           address: request["address"],
           status: "accepted",
           transport: "codex",
           detail: nil
         }), 0}
      end
    end
  end

  defmodule MalformedPeerRunner do
    @behaviour Shuttle.Runner
    def cmd("felt", ["shuttle", "sessions", "--local", "--json"], _opts),
      do: {Jason.encode!(%{sessions: [], gaps: "wrong"}), 0}
  end

  defmodule Client do
    @behaviour Shuttle.RemoteRegistry.Client
    def get("http://remote.test/api/v1/peers?local=true", _timeout) do
      {:ok,
       Jason.encode!(%{
         host: "actual-remote",
         sessions: [%{address: "shuttle://actual-remote/pi/p%2F1"}],
         gaps: [%{host: "actual-remote", harness: "claude", error: "mailbox unavailable"}]
       })}
    end

    def post("http://remote.test/api/v1/messages", body, "application/json", _timeout) do
      request = Jason.decode!(body)
      send(Process.whereis(__MODULE__), {:forwarded, request})

      case request["message_id"] do
        "rejected" ->
          {:ok, 400,
           Jason.encode!(%{
             message_id: "rejected",
             address: request["address"],
             status: "rejected",
             transport: "validation",
             detail: "refused"
           })}

        "malformed" ->
          {:ok, 500, Jason.encode!(%{error: "lost receipt"})}

        _ ->
          {:ok, 200,
           Jason.encode!(%{
             message_id: request["message_id"],
             address: request["address"],
             status: "submitted",
             transport: "pi",
             detail: nil
           })}
      end
    end
  end

  setup do
    previous_runner = Application.get_env(:shuttle, :felt_runner)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    previous_remotes = Application.get_env(:shuttle, :remotes)
    host = Shuttle.Poller.own_host_id()
    Process.register(self(), Client)
    Application.put_env(:shuttle, :felt_runner, Runner)
    Application.put_env(:shuttle, :write_forward_client, Client)
    Application.put_env(:shuttle, :remotes, [%Remote{name: "edge", url: "http://remote.test"}])

    on_exit(fn ->
      if Process.whereis(Client), do: Process.unregister(Client)
      restore(:felt_runner, previous_runner)
      restore(:write_forward_client, previous_client)
      restore(:remotes, previous_remotes)
    end)

    {:ok, host: host}
  end

  test "local discovery does not fan out", %{host: host} do
    body = api_conn() |> get("/api/v1/peers?local=true") |> json_response(200)
    expected_address = "shuttle://#{host}/codex/native%2Fid"
    assert body["host"] == host

    assert [%{"address" => ^expected_address, "host" => ^host}] =
             body["sessions"]

    assert body["gaps"] == []
  end

  test "fleet discovery aliases a remote's claimed identity" do
    body = api_conn() |> get("/api/v1/peers") |> json_response(200)

    assert Enum.any?(
             body["sessions"],
             &(&1["address"] == "shuttle://edge/pi/p%2F1" and &1["host"] == "edge")
           )

    assert %{"host" => "edge", "harness" => "claude", "error" => "mailbox unavailable"} in body[
             "gaps"
           ]
  end

  test "remote delivery forwards once through the local sentinel" do
    request = %{
      "address" => "shuttle://edge/pi/p%2F1",
      "text" => "hello",
      "from" => "test",
      "wake" => true,
      "message_id" => "m-1"
    }

    receipt = api_conn() |> post("/api/v1/messages", Jason.encode!(request)) |> json_response(200)
    assert_receive {:forwarded, %{"address" => "shuttle://local/pi/p%2F1"}}
    assert receipt["address"] == request["address"]
    assert receipt["status"] == "submitted"
  end

  test "remote failures preserve validated receipts and public addresses" do
    base = %{
      "address" => "shuttle://edge/pi/p%2F1",
      "text" => "hello",
      "from" => "test",
      "wake" => true
    }

    rejected =
      api_conn()
      |> post("/api/v1/messages", Jason.encode!(Map.put(base, "message_id", "rejected")))
      |> json_response(400)

    assert rejected["address"] == base["address"]
    assert rejected["status"] == "rejected"

    unknown =
      api_conn()
      |> post("/api/v1/messages", Jason.encode!(Map.put(base, "message_id", "malformed")))
      |> json_response(502)

    assert unknown["message_id"] == "malformed"
    assert unknown["address"] == base["address"]
    assert unknown["status"] == "unknown"
  end

  test "malformed local receipts preserve request identity as unknown", %{host: host} do
    request = %{
      "address" => "shuttle://#{host}/codex/native%2Fid",
      "text" => "hello",
      "from" => "test",
      "wake" => false,
      "message_id" => "malformed-local"
    }

    receipt = api_conn() |> post("/api/v1/messages", Jason.encode!(request)) |> json_response(502)
    assert receipt["message_id"] == request["message_id"]
    assert receipt["address"] == request["address"]
    assert receipt["status"] == "unknown"
  end

  test "malformed local discovery gaps become an explicit local gap", %{host: host} do
    Application.put_env(:shuttle, :felt_runner, MalformedPeerRunner)
    on_exit(fn -> Application.put_env(:shuttle, :felt_runner, Runner) end)

    body = api_conn() |> get("/api/v1/peers?local=true") |> json_response(200)
    assert body["sessions"] == []
    assert [%{"host" => ^host, "error" => "malformed local response"}] = body["gaps"]
  end

  test "unknown hosts and invalid booleans fail closed" do
    base = %{
      "address" => "shuttle://nowhere/codex/1",
      "text" => "hello",
      "from" => "test",
      "message_id" => "m-2"
    }

    assert %{"error" => error} =
             api_conn() |> post("/api/v1/messages", Jason.encode!(base)) |> json_response(400)

    assert error =~ "unknown host"

    assert api_conn()
           |> post("/api/v1/messages", Jason.encode!(Map.put(base, "wake", "true")))
           |> json_response(400)
  end

  test "canonical address parsing matches Go PathEscape", %{host: host} do
    valid = [
      "shuttle://#{host}/codex/plain",
      "shuttle://#{host}/codex/a%2Fb",
      "shuttle://#{host}/codex/caf%C3%A9",
      "shuttle://#{host}/codex/a%20space",
      "shuttle://#{host}/codex/+:@$&="
    ]

    for {address, index} <- Enum.with_index(valid) do
      request = %{
        "address" => address,
        "text" => "hello",
        "from" => "",
        "wake" => false,
        "message_id" => "valid-#{index}"
      }

      assert api_conn() |> post("/api/v1/messages", Jason.encode!(request)) |> json_response(200)
    end

    invalid = [
      "shuttle://H/codex/id",
      "shuttle://#{host}/CODEX/id",
      "shuttle://#{host}/codex/%69d",
      "shuttle://#{host}/codex/id?q=x",
      "shuttle://#{host}:4000/codex/id",
      "shuttle://#{host}/codex/id/extra",
      "shuttle://#{host}/codex/%00"
    ]

    for {address, index} <- Enum.with_index(invalid) do
      request = %{
        "address" => address,
        "text" => "hello",
        "from" => "",
        "wake" => false,
        "message_id" => "invalid-#{index}"
      }

      assert api_conn() |> post("/api/v1/messages", Jason.encode!(request)) |> json_response(400)
    end
  end

  defp restore(key, nil), do: Application.delete_env(:shuttle, key)
  defp restore(key, value), do: Application.put_env(:shuttle, key, value)
end
