defmodule ShuttleWeb.CaptureControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest

  alias Shuttle.Terminal.{Rex, RexBindings}
  alias Shuttle.Test.{Env, FakeRex, ForwardStub, StubPostClient}

  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir

  defmodule CapturePollerStub do
    use GenServer

    def start_link(opts), do: GenServer.start_link(__MODULE__, opts)

    @impl true
    def init(opts), do: {:ok, %{test_pid: Keyword.fetch!(opts, :test_pid), reply: Keyword.fetch!(opts, :reply)}}

    @impl true
    def handle_call({:capture, yap, opts}, _from, state) do
      send(state.test_pid, {:poller_capture, yap, opts})
      {:reply, state.reply, state}
    end
  end

  test "POST /api/v1/capture without prompt is a 400" do
    conn =
      api_conn()
      |> post("/api/v1/capture", Jason.encode!(%{project_dir: "/tmp"}))

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "prompt"
  end

  test "POST /api/v1/capture rejects a whitespace-only ordinary prompt" do
    conn =
      api_conn()
      |> post(
        "/api/v1/capture",
        Jason.encode!(%{prompt: " \n\t ", project_dir: "/no/such/project"})
      )

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "prompt"
  end

  test "POST /api/v1/capture defaults omitted or blank project_dir to the first configured store", %{
    tmp_dir: dir
  } do
    store_dir = Path.join(dir, "store-a")
    File.mkdir_p!(store_dir)
    Env.put_env("SHUTTLE_STORES", store_dir)

    stub =
      start_supervised!(
        {CapturePollerStub,
         test_pid: self(), reply: {:ok, %{session: "capture-default", agent_id: "claude-opus"}}}
      )

    Env.put_server(Shuttle.Poller, stub)

    for payload <- [%{prompt: "an idea"}, %{prompt: "another idea", project_dir: "   "}] do
      conn = api_conn() |> post("/api/v1/capture", Jason.encode!(payload))
      assert conn.status == 200
      assert %{"spawned" => true, "agent" => "claude-opus"} = Jason.decode!(conn.resp_body)
      assert_receive {:poller_capture, _, opts}
      assert opts[:work_dir] == store_dir
    end
  end

  test "POST /api/v1/capture with focus: true selects and activates the launched Rex binding best-effort", %{
    tmp_dir: dir
  } do
    Env.put_env("SHUTTLE_DATA_DIR", dir)
    Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
    Env.put_app_env(:fake_rex, start_supervised!({FakeRex, []}))
    Env.put_app_env(:rex_runner, FakeRex)
    Env.put_app_env(:terminal_backend, Rex)
    Env.put_app_env(:os_type, {:unix, :darwin})

    FakeRex.clients([
      %{"client_id" => "client:mac", "info" => %{"kind" => "app", "platform" => "macos"}}
    ])

    session_name = "capture-focus-1"

    :ok =
      RexBindings.put(
        session_name,
        %{
          "session_id" => "session:cap1",
          "window_id" => "window:w1",
          "block_id" => "block:b1",
          "created_at" => "2026-11-23T00:00:00Z"
        },
        "host-test"
      )

    FakeRex.sessions(%{
      "session:cap1" => %{
        label: session_name,
        windows: [%{"window_id" => "window:w1", "label" => session_name}],
        window_label: session_name,
        blocks: [%{"block_id" => "block:b1", "window_id" => "window:w1", "label" => session_name}]
      }
    })

    stub =
      start_supervised!(
        {CapturePollerStub,
         test_pid: self(), reply: {:ok, %{session: session_name, agent_id: "claude-opus"}}}
      )

    Env.put_server(Shuttle.Poller, stub)

    conn =
      api_conn()
      |> post(
        "/api/v1/capture",
        Jason.encode!(%{prompt: "focus me", project_dir: dir, focus: true})
      )

    assert conn.status == 200
    assert %{"spawned" => true} = Jason.decode!(conn.resp_body)
    assert_receive {:poller_capture, "focus me", opts}
    assert opts[:work_dir] == dir

    calls = FakeRex.calls()
    assert Enum.any?(calls, fn {_bin, argv, _opts} -> "client.perform" in argv end)
    assert Enum.any?(calls, fn {bin, _argv, _opts} -> bin == "open" end)

    # Focusing failures never fail the 200 response.
    FakeRex.reply("client.perform", {"boom", 1})

    conn2 =
      api_conn()
      |> post(
        "/api/v1/capture",
        Jason.encode!(%{prompt: "focus fails", project_dir: dir, focus: true})
      )

    assert conn2.status == 200
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
    ForwardStub.stub_forward(
      "candide",
      "http://localhost:4001",
      {:ok, 200, Jason.encode!(%{"spawned" => true, "tmux_session" => "capture-1"})},
      StubPostClient
    )

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
    last = StubPostClient.last()
    assert last.url == "http://localhost:4001/api/v1/capture"
    forwarded = Jason.decode!(last.body)
    refute Map.has_key?(forwarded, "origin")
    assert forwarded["prompt"] == "an idea"
    assert forwarded["project_dir"] == "/candide/project"
  end
end
