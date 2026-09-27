defmodule ShuttleWeb.DeliverControllerTest do
  use ExUnit.Case, async: false

  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn
  import Shuttle.Test.EnvHelpers
  import Shuttle.Test.ForwardStub
  import Shuttle.Test.PollerHelpers

  alias Shuttle.Poller
  alias Shuttle.Test.FeltStoreRunner, as: MockRunner
  alias Shuttle.Test.StubPostClient

  @endpoint ShuttleWeb.Endpoint

  # Answers `felt shuttle message` with an accepted receipt and records the
  # frame; every other command is the store mock's.
  defmodule MessageRunner do
    @behaviour Shuttle.Runner

    def cmd("felt", ["shuttle", "message", "--local", "--json", "--request-json"], opts) do
      request = opts[:input] |> String.trim() |> Jason.decode!()
      send(Application.fetch_env!(:shuttle, :deliver_test_pid), {:message, request})

      {Jason.encode!(%{
         message_id: request["message_id"],
         address: request["address"],
         status: "accepted",
         transport: "claude"
       }), 0}
    end

    def cmd(command, args, opts), do: MockRunner.cmd(command, args, opts)
  end

  setup do
    start_supervised!(MockRunner)
    MockRunner.reset()
    root = MockRunner.felt_root()
    on_exit(fn -> File.rm_rf(root) end)

    start_supervised!(
      {Poller, runner: MockRunner, poll_interval_ms: 600_000, felt_stores: [root]}
    )

    Process.sleep(50)
    :ok
  end

  defp run_script do
    {_, args} =
      MockRunner.commands()
      |> Enum.reverse()
      |> Enum.find(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)

    File.read!(List.last(args))
  end

  defp put_constitution(fiber_id) do
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())
  end

  test "a never-run constitution dispatches fresh with the text as From User" do
    put_constitution("tests/deliver-fresh")

    body =
      api_conn()
      |> post(
        "/api/v1/deliver",
        Jason.encode!(%{"fiber_id" => "tests/deliver-fresh", "text" => "Meeting mode (call)."})
      )
      |> json_response(200)

    assert %{"delivered" => true, "delivery" => "dispatch", "dispatched" => true} = body
    script = run_script()
    assert script =~ "From User"
    assert script =~ "Meeting mode (call)."
  end

  test "a constitution with a previous conversation resumes it with the text" do
    put_constitution("tests/deliver-resume")
    MockRunner.put_shuttle_fields("tests/deliver-resume", %{"session_uuid" => "prior-session-1"})
    Poller.refresh_document("tests/deliver-resume")

    body =
      api_conn()
      |> post(
        "/api/v1/deliver",
        Jason.encode!(%{"fiber_id" => "tests/deliver-resume", "text" => "join the meeting"})
      )
      |> json_response(200)

    assert %{"delivered" => true, "delivery" => "resume"} = body
    script = run_script()
    assert script =~ "prior-session-1"
    assert script =~ "join the meeting"
  end

  test "a live worker is messaged at its conversation instead of relaunched" do
    fiber_id = "tests/deliver-live"
    put_constitution(fiber_id)
    assert {:ok, _session} = Poller.dispatch_fiber(fiber_id, [])
    MockRunner.put_shuttle_fields(fiber_id, %{"session_uuid" => "live-session-9"})
    Poller.refresh_document(fiber_id)

    previous_runner = Application.get_env(:shuttle, :felt_runner)
    Application.put_env(:shuttle, :felt_runner, MessageRunner)
    Application.put_env(:shuttle, :deliver_test_pid, self())

    on_exit(fn ->
      restore_app_env(:felt_runner, previous_runner)
      Application.delete_env(:shuttle, :deliver_test_pid)
    end)

    launches_before =
      Enum.count(MockRunner.commands(), fn {cmd, args} ->
        cmd == "tmux" and hd(args) == "new-session"
      end)

    body =
      api_conn()
      |> post(
        "/api/v1/deliver",
        Jason.encode!(%{
          "fiber_id" => fiber_id,
          "text" => "Meeting mode (room).",
          "from" => "shuttle meeting"
        })
      )
      |> json_response(200)

    assert %{"delivered" => true, "delivery" => "message", "receipt" => receipt} = body
    assert receipt["status"] == "accepted"

    assert_received {:message, request}
    assert request["address"] == "shuttle://#{Poller.own_host_id()}/claude/live-session-9"
    assert request["text"] == "Meeting mode (room)."
    assert request["from"] == "shuttle meeting"
    assert request["wake"] == true

    assert launches_before ==
             Enum.count(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
  end

  test "a remote-owned constitution is delivered by its owner" do
    stub_forward(
      "cineca",
      "http://localhost:4002",
      {:ok, 200, Jason.encode!(%{"delivered" => true, "delivery" => "message"})},
      StubPostClient
    )

    body =
      api_conn()
      |> post(
        "/api/v1/deliver",
        Jason.encode!(%{"fiber_id" => "tests/remote", "text" => "hello", "origin" => "cineca"})
      )
      |> json_response(200)

    assert body == %{"delivered" => true, "delivery" => "message"}
    last = StubPostClient.last()
    assert last.url == "http://localhost:4002/api/v1/deliver"
    assert Jason.decode!(last.body) == %{"fiber_id" => "tests/remote", "text" => "hello"}
  end

  test "fiber_id and text are required" do
    assert %{"error" => "text is required"} =
             api_conn()
             |> post("/api/v1/deliver", Jason.encode!(%{"fiber_id" => "tests/x"}))
             |> json_response(400)

    assert %{"error" => "fiber_id is required"} =
             api_conn()
             |> post("/api/v1/deliver", Jason.encode!(%{"text" => "x"}))
             |> json_response(400)
  end
end
