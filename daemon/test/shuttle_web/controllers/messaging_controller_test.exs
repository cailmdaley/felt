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
        receipt = %{
          message_id: request["message_id"],
          address: request["address"],
          status:
            if(request["message_id"] in ["queued", "context_added", "submitted"],
              do: request["message_id"],
              else: "accepted"
            ),
          transport: "codex",
          detail: nil
        }

        files =
          Enum.map(request["attachments"] || [], fn attachment ->
            %{
              name: attachment["name"],
              path: "/receiver/#{attachment["name"]}",
              sha256: attachment["sha256"],
              size: attachment["data"] |> Base.decode64!() |> byte_size()
            }
          end)

        files =
          if request["message_id"] == "bad-files-receipt" do
            Enum.map(files, &Map.put(&1, :sha256, String.duplicate("f", 64)))
          else
            files
          end

        receipt = if files == [], do: receipt, else: Map.put(receipt, :files, files)
        {Jason.encode!(receipt), 0}
      end
    end
  end

  defmodule MalformedPeerRunner do
    @behaviour Shuttle.Runner
    def cmd("felt", ["shuttle", "sessions", "--local", "--json"], _opts),
      do: {Jason.encode!(%{sessions: [], gaps: "wrong"}), 0}
  end

  defmodule TimeoutClient do
    @behaviour Shuttle.RemoteRegistry.Client
    def get(_url, _timeout), do: {:error, :timeout}
    def post(_url, _body, _content_type, _timeout), do: {:error, :timeout}
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

        status when status in ["queued", "context_added", "submitted"] ->
          {:ok, 200,
           Jason.encode!(%{
             message_id: status,
             address: request["address"],
             status: status,
             transport: "peer"
           })}

        _ ->
          {:ok, 200,
           Jason.encode!(%{
             message_id: request["message_id"],
             address: request["address"],
             status: "accepted",
             transport: "pi",
             detail: nil
           })}
      end
    end

    def post("http://remote.test/api/v1/messages/files", body, "application/json", timeout) do
      request = Jason.decode!(body)
      send(Process.whereis(__MODULE__), {:forwarded_files, request, timeout})

      if request["message_id"] == "old-daemon" do
        {:ok, 404, Jason.encode!(%{error: "not found"})}
      else
        files =
          request["attachments"]
          |> Enum.with_index()
          |> Enum.map(fn {attachment, index} ->
            %{
              name: attachment["name"],
              path: "/remote/#{index}-#{attachment["name"]}",
              sha256: attachment["sha256"],
              size: attachment["data"] |> Base.decode64!() |> byte_size()
            }
          end)

        {:ok, 200,
         Jason.encode!(%{
           message_id: request["message_id"],
           address: request["address"],
           status: "accepted",
           transport: "codex",
           detail: nil,
           files: files
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

  test "remote discovery timeouts identify an unreachable host" do
    Application.put_env(:shuttle, :write_forward_client, TimeoutClient)

    body = api_conn() |> get("/api/v1/peers") |> json_response(200)

    assert %{"host" => "edge", "error" => error} =
             Enum.find(body["gaps"], &(&1["host"] == "edge"))

    assert error =~ "timed out"
    assert error =~ "offline or unreachable"
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
    assert receipt["status"] == "accepted"
  end

  test "omitted wake defaults to an active task request" do
    request = %{
      "address" => "shuttle://edge/pi/p%2F1",
      "text" => "please act",
      "message_id" => "omitted-wake"
    }

    receipt = api_conn() |> post("/api/v1/messages", Jason.encode!(request)) |> json_response(200)
    assert_receive {:forwarded, %{"address" => "shuttle://local/pi/p%2F1", "wake" => true}}
    assert receipt["status"] == "accepted"
  end

  test "wake cannot succeed with a context-only acknowledgement from local or remote peers", %{
    host: host
  } do
    for target <- [host, "edge"], status <- ["queued", "context_added", "submitted"] do
      request = %{
        address: "shuttle://#{target}/codex/thread",
        text: "begin work",
        wake: true,
        message_id: status
      }

      receipt =
        api_conn() |> post("/api/v1/messages", Jason.encode!(request)) |> json_response(502)

      assert receipt["status"] == "unknown"
      assert receipt["message_id"] == status
    end
  end

  test "binary attachments use the files route and retain exact identity" do
    data = <<0, 1, 2, 255, 128, 64>>
    sha256 = :crypto.hash(:sha256, data) |> Base.encode16(case: :lower)

    request = %{
      "address" => "shuttle://edge/codex/native%2Fid",
      "text" => "",
      "from" => "test",
      "wake" => false,
      "message_id" => "files-1",
      "attachments" => [
        %{"name" => "sample.bin", "data" => Base.encode64(data), "sha256" => sha256}
      ]
    }

    receipt =
      api_conn()
      |> post("/api/v1/messages/files", Jason.encode!(request))
      |> json_response(200)

    assert_receive {:forwarded_files,
                    %{
                      "address" => "shuttle://local/codex/native%2Fid",
                      "message_id" => "files-1",
                      "attachments" => [forwarded]
                    }, 90_000}

    assert forwarded == hd(request["attachments"])
    assert receipt["address"] == request["address"]
    assert [%{"name" => "sample.bin", "sha256" => ^sha256, "size" => 6}] = receipt["files"]
  end

  test "duplicate basenames remain distinct attachments" do
    attachments =
      for data <- ["first", "second"] do
        %{
          "name" => "result.dat",
          "data" => Base.encode64(data),
          "sha256" => :crypto.hash(:sha256, data) |> Base.encode16(case: :lower)
        }
      end

    request = %{
      "address" => "shuttle://edge/codex/id",
      "text" => "two source paths shared this basename",
      "message_id" => "duplicate-basenames",
      "attachments" => attachments
    }

    receipt =
      api_conn()
      |> post("/api/v1/messages/files", Jason.encode!(request))
      |> json_response(200)

    assert_receive {:forwarded_files, %{"attachments" => ^attachments}, 90_000}
    assert [first, second] = receipt["files"]
    assert first["name"] == "result.dat"
    assert second["name"] == "result.dat"
    assert first["sha256"] != second["sha256"]
    assert first["path"] != second["path"]
  end

  test "file envelopes do not copy attachment bytes into request logs", %{host: host} do
    bytes = "private-attachment-log-marker"
    encoded = Base.encode64(bytes)

    request = %{
      "address" => "shuttle://#{host}/codex/id",
      "message_id" => "filtered-attachment",
      "attachments" => [
        %{
          "name" => "private.bin",
          "data" => encoded,
          "sha256" => Base.encode16(:crypto.hash(:sha256, bytes), case: :lower)
        }
      ]
    }

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        api_conn() |> post("/api/v1/messages/files", Jason.encode!(request)) |> json_response(200)
      end)

    assert log =~ "[FILTERED]"
    refute log =~ encoded
  end

  test "an old remote files endpoint returns unknown without falling back to messages" do
    data = "payload"
    sha256 = :crypto.hash(:sha256, data) |> Base.encode16(case: :lower)

    request = %{
      "address" => "shuttle://edge/codex/id",
      "text" => "see file",
      "message_id" => "old-daemon",
      "attachments" => [%{"name" => "x.txt", "data" => Base.encode64(data), "sha256" => sha256}]
    }

    receipt =
      api_conn()
      |> post("/api/v1/messages/files", Jason.encode!(request))
      |> json_response(502)

    assert_receive {:forwarded_files, %{"message_id" => "old-daemon"}, 90_000}
    refute_receive {:forwarded, %{"message_id" => "old-daemon"}}
    assert receipt["status"] == "unknown"
    assert receipt["address"] == request["address"]
  end

  test "messages refuses attachments and files requires them" do
    base = %{
      "address" => "shuttle://edge/codex/id",
      "text" => "hello",
      "message_id" => "route-check"
    }

    attachment = %{"name" => "x", "data" => "eA==", "sha256" => String.duplicate("0", 64)}

    assert %{"error" => error} =
             api_conn()
             |> post(
               "/api/v1/messages",
               Jason.encode!(Map.put(base, "attachments", [attachment]))
             )
             |> json_response(400)

    assert error =~ "/api/v1/messages/files"

    assert %{"error" => "POST /api/v1/messages/files requires attachments"} =
             api_conn()
             |> post("/api/v1/messages/files", Jason.encode!(base))
             |> json_response(400)
  end

  test "files validates envelope shape and receipt correlation", %{host: host} do
    base = %{
      "address" => "shuttle://#{host}/codex/id",
      "text" => "",
      "message_id" => "bad-file"
    }

    invalid = [
      [%{"name" => "../x", "data" => "eA==", "sha256" => String.duplicate("0", 64)}],
      [%{"name" => "x\u0085", "data" => "eA==", "sha256" => String.duplicate("0", 64)}],
      [%{"name" => "x", "data" => "%%%", "sha256" => String.duplicate("0", 64)}],
      [%{"name" => "x", "data" => "eA==", "sha256" => String.duplicate("A", 64)}],
      Enum.map(1..9, &%{"name" => "x#{&1}", "data" => "", "sha256" => String.duplicate("0", 64)})
    ]

    for attachments <- invalid do
      assert api_conn()
             |> post(
               "/api/v1/messages/files",
               Jason.encode!(Map.put(base, "attachments", attachments))
             )
             |> json_response(400)
    end

    data = "correlate"
    sha256 = :crypto.hash(:sha256, data) |> Base.encode16(case: :lower)

    receipt =
      api_conn()
      |> post(
        "/api/v1/messages/files",
        Jason.encode!(
          Map.merge(base, %{
            "message_id" => "bad-files-receipt",
            "attachments" => [
              %{"name" => "x", "data" => Base.encode64(data), "sha256" => sha256}
            ]
          })
        )
      )
      |> json_response(502)

    assert receipt["status"] == "unknown"
    refute Map.has_key?(receipt, "files")
  end

  test "the larger JSON parser is scoped to the files route" do
    data = :binary.copy(<<42>>, 7 * 1024 * 1024)
    sha256 = :crypto.hash(:sha256, data) |> Base.encode16(case: :lower)

    request = %{
      "address" => "shuttle://edge/codex/id",
      "text" => "",
      "message_id" => "large-parser",
      "attachments" => [
        %{"name" => "large.bin", "data" => Base.encode64(data), "sha256" => sha256}
      ]
    }

    assert api_conn()
           |> post("/api/v1/messages/files", Jason.encode!(request))
           |> json_response(200)

    assert_raise Plug.Parsers.RequestTooLargeError, fn ->
      api_conn() |> post("/api/v1/messages", Jason.encode!(request))
    end
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

  test "remote wake timeout stays unknown and explains safe retry" do
    Application.put_env(:shuttle, :write_forward_client, TimeoutClient)

    request = %{
      "address" => "shuttle://edge/codex/native%2Fid",
      "text" => "please continue",
      "wake" => true,
      "message_id" => "remote-timeout"
    }

    receipt = api_conn() |> post("/api/v1/messages", Jason.encode!(request)) |> json_response(502)

    assert receipt["status"] == "unknown"
    assert receipt["message_id"] == request["message_id"]
    assert receipt["detail"] =~ "timed out"
    assert receipt["detail"] =~ "outcome is unknown"
    assert receipt["detail"] =~ "same message_id"
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
