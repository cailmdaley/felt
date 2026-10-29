defmodule ShuttleWeb.TranscriptStreamShutdownTest do
  use ExUnit.Case, async: true

  alias Shuttle.Test.{Env, StubStreamClient}

  @session "a3edf873-cb1c-40ab-a891-f26f5333b320"
  @moduletag :tmp_dir

  defmodule StreamPlug do
    @behaviour Plug
    def init(opts), do: opts

    def call(conn, owner) do
      Process.put(:"$callers", [owner])
      send(owner, {:stream_handler, self()})
      host = if conn.request_path == "/local", do: "local", else: "owner-a"

      ShuttleWeb.TranscriptController.stream(conn, %{
        "session" => "a3edf873-cb1c-40ab-a891-f26f5333b320",
        "host" => host
      })
    end
  end

  setup %{tmp_dir: tmp} do
    project = Path.join(tmp, "project")
    File.mkdir_p!(project)
    File.write!(Path.join(project, "#{@session}.jsonl"), "{}\n")
    Env.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", tmp)
    Env.put_app_env(:remotes, [%{name: "owner-a", url: "http://127.0.0.1:19999"}])
    Env.put_app_env(:write_forward_client, StubStreamClient)
    StubStreamClient.start!()
    :ok
  end

  for route <- ["local", "relay"] do
    @tag route: route
    test "Bandit shuts down promptly with an open #{route} stream", %{route: route} do
      StubStreamClient.set_events([
        {:open, [{"content-type", "text/event-stream"}]},
        {:data, ": open\n\n"}
      ])

      server =
        start_supervised!(
          {Bandit,
           plug: {StreamPlug, self()},
           port: 0,
           ip: {127, 0, 0, 1},
           startup_log: false,
           thousand_island_options: [shutdown_timeout: 5_000]}
        )

      {:ok, {_ip, port}} = ThousandIsland.listener_info(server)
      {:ok, socket} = :gen_tcp.connect(~c"127.0.0.1", port, [:binary, active: false])
      on_exit(fn -> :gen_tcp.close(socket) end)
      :ok = :gen_tcp.send(socket, "GET /#{route} HTTP/1.1\r\nhost: localhost\r\n\r\n")
      assert_receive {:stream_handler, handler}, 2_000
      assert_open(socket)
      assert Registry.keys(ShuttleWeb.TranscriptStreams, handler) != []
      handler_ref = Process.monitor(handler)
      server_ref = Process.monitor(server)

      stopping = Task.async(fn -> Supervisor.stop(server, :shutdown, :infinity) end)
      assert Task.yield(stopping, 2_000) == {:ok, :ok}
      assert_receive {:DOWN, ^server_ref, :process, ^server, :shutdown}, 2_000
      assert_receive {:DOWN, ^handler_ref, :process, ^handler, reason}, 2_000
      refute reason == :killed
      assert Registry.keys(ShuttleWeb.TranscriptStreams, handler) == []

      if route == "relay" do
        assert StubStreamClient.cancelled() == [StubStreamClient.last().id]
      end
    end
  end

  defp assert_open(socket, body \\ "") do
    assert {:ok, bytes} = :gen_tcp.recv(socket, 0, 2_000)
    body = body <> bytes
    unless body =~ ": open\n\n", do: assert_open(socket, body)
  end
end
