defmodule ShuttleWeb.ChannelsControllerTest do
  use ExUnit.Case, async: true
  import Phoenix.ConnTest
  import Plug.Conn
  import Shuttle.Test.ApiConn
  alias Shuttle.Test.Env
  @endpoint ShuttleWeb.Endpoint

  defmodule Runner do
    def cmd("shuttle", args, _) do
      send(Shuttle.Env.app(:channels_test_owner), {:cli, args})
      Shuttle.Env.app(:channels_test_reply, {"", 0})
    end
  end

  defmodule RemoteClient do
    def get(_, _, _) do
      now = System.system_time(:millisecond)

      records = [
        %{
          "id" => "remote",
          "type" => "board",
          "timestamp" => now,
          "kind" => "dismissed",
          "text" => "file:remote:plot.png:1"
        },
        %{
          "id" => "remote-pin",
          "type" => "board",
          "timestamp" => now - 60_000,
          "kind" => "pinned",
          "text" => "role:vizier"
        },
        %{
          "id" => "remote-order",
          "type" => "board",
          "timestamp" => now - 30_000,
          "kind" => "ordered",
          "keys" => ["fiber:REMOTE"]
        },
        %{
          "id" => "post",
          "type" => "board",
          "timestamp" => now,
          "kind" => "post",
          "text" => "not a dismissal"
        }
      ]

      {:ok, 200, [], Jason.encode!(%{records: records})}
    end
  end

  test "dismiss writes through the CLI, and reports a failed write" do
    Env.put_app_env(:felt_runner, Runner)
    Env.put_app_env(:channels_test_owner, self())

    assert api_conn()
           |> put_req_header("content-type", "application/json")
           |> post("/api/v1/channels/dismiss", Jason.encode!(%{key: "ask:U:1", fiber: "U"}))
           |> json_response(200) == %{"ok" => true}

    assert_receive {:cli, ["channels", "dismiss", "ask:U:1", "--fiber", "U"]}

    assert api_conn()
           |> post("/api/v1/channels/pin", %{key: "role:vizier"})
           |> json_response(200) == %{"ok" => true}

    assert_receive {:cli, ["channels", "pin", "role:vizier"]}
    Env.put_app_env(:channels_test_reply, {"cannot write", 1})

    assert api_conn()
           |> post("/api/v1/channels/dismiss", %{key: "file:x"})
           |> json_response(422)
           |> Map.has_key?("error")

    assert api_conn() |> post("/api/v1/channels/dismiss", %{}) |> json_response(400) == %{
             "error" => "key is required"
           }

    assert api_conn() |> post("/api/v1/channels/pin", %{key: ""}) |> json_response(400) == %{
             "error" => "key is required"
           }
  end

  test "order writes the full key list through the CLI" do
    Env.put_app_env(:felt_runner, Runner)
    Env.put_app_env(:channels_test_owner, self())

    assert api_conn()
           |> put_req_header("content-type", "application/json")
           |> post(
             "/api/v1/channels/order",
             Jason.encode!(%{keys: ["channel:the mill", "fiber:U"]})
           )
           |> json_response(200) == %{"ok" => true}

    assert_receive {:cli, ["channels", "order", "channel:the mill", "fiber:U"]}

    assert api_conn()
           |> put_req_header("content-type", "application/json")
           |> post("/api/v1/channels/order", Jason.encode!(%{keys: []}))
           |> json_response(400) == %{"error" => "keys are required"}

    assert api_conn()
           |> put_req_header("content-type", "application/json")
           |> post("/api/v1/channels/order", Jason.encode!(%{keys: ["fiber:U", 3]}))
           |> json_response(400) == %{"error" => "keys must be channel keys"}

    refute_received {:cli, _}
  end

  @tag :tmp_dir
  test "dismissed merges local and remote board feeds over the reach", %{tmp_dir: dir} do
    now = System.system_time(:millisecond)
    path = Path.join(dir, "events.jsonl")

    rows =
      for {id, at, kind, text} <- [
            {"local", now, "dismissed", "ask:U:1"},
            {"old", now - Shuttle.Board.retention_ms() - 1, "dismissed", "expired"},
            {"pin", now - 10, "pinned", "role:vizier"},
            {"pin-again", now, "pinned", "role:vizier"},
            {"lapsed", now - Shuttle.Board.retention_ms() - 1, "pinned", "fiber:OLD"},
            {"post", now, "post", "not a dismissal"}
          ],
          do: %{id: id, timestamp: at, type: "board", kind: kind, text: text}

    rows =
      rows ++
        [
          %{
            id: "order-old",
            timestamp: now - 60_000,
            type: "board",
            kind: "ordered",
            keys: ["fiber:OLD"]
          },
          %{
            id: "order",
            timestamp: now - 10,
            type: "board",
            kind: "ordered",
            keys: ["channel:spt", "fiber:U"]
          }
        ]

    File.write!(path, Enum.map_join(rows, "\n", &Jason.encode!/1) <> "\n")
    Shuttle.Test.EventFiles.scope!(path)

    registry =
      start_supervised!(
        {Shuttle.RemoteTemporalRegistry,
         name: nil,
         remotes: [%Shuttle.Remote{name: "remote", url: "http://remote"}],
         client: RemoteClient,
         store_dir: Path.join(dir, "cache")}
      )

    Env.put_server(Shuttle.RemoteTemporalRegistry, registry)
    assert %{items: [_ | _]} = Shuttle.RemoteTemporalRegistry.entries(registry, :board)["remote"]

    assert %{
             "dismissed" => ["ask:U:1", "file:remote:plot.png:1"],
             "pinned" => pinned,
             "order" => order,
             "reach_ms" => reach
           } =
             api_conn() |> get("/api/v1/channels/dismissed") |> json_response(200)

    assert pinned == %{"role:vizier" => now}
    assert order == %{"keys" => ["channel:spt", "fiber:U"], "at" => now - 10}

    assert reach == Shuttle.Board.retention_ms()

    assert %{records: []} =
             Shuttle.BoardFamily.compose(
               [],
               [
                 %{"id" => "d", "timestamp" => now, "kind" => "dismissed", "text" => "ask:U:1"},
                 %{"id" => "p", "timestamp" => now, "kind" => "pinned", "text" => "role:vizier"},
                 %{"id" => "o", "timestamp" => now, "kind" => "ordered", "keys" => ["fiber:U"]}
               ],
               %{},
               "host",
               %{"all" => "true"}
             )
  end
end
