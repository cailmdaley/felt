defmodule ShuttleWeb.ApiContractTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Shuttle.Test.ApiContract
  import Phoenix.ConnTest
  import Plug.Conn
  alias Shuttle.Test.{Env, ForwardStub, StubGetFileClient, StubPostClient}
  @endpoint ShuttleWeb.Endpoint

  test "every operation in the contract is a tagged route the daemon serves" do
    served =
      for %{verb: verb, path: "/api/v1" <> path} <- ShuttleWeb.Router.__routes__(),
          do: {Atom.to_string(verb), String.replace(path, ~r/[:*](\w+)/, "{\\1}")}

    for {path, operations} <- document()["paths"], {method, operation} <- operations do
      assert {method, path} in served
      assert "core" in operation["tags"]
      assert is_binary(operation["summary"])
      assert is_binary(operation["description"])
    end

    for path <- ~w(/version /fleet /peers /fibers/composite /fibers/{id} /sent-files /file) do
      assert document()["paths"][path]["get"]
    end

    for path <- ~w(/capture /fiber/create /dispatch /deliver /messages /lifecycle /kill) do
      assert document()["paths"][path]["post"]
    end
  end

  test "the daemon serves the contract it was built with" do
    assert get(api_conn(), "/api/v1/contract") |> assert_contract("/contract") == document()
  end

  test "version promises identity and readiness, including during boot, and refuses unknown origins" do
    Env.own_scope!()

    assert %{"api_level" => 1, "host" => _, "ready" => true} =
             get(api_conn(), "/api/v1/version") |> assert_contract("/version")

    Shuttle.Readiness.begin_boot()
    assert %{"ready" => false} = get(api_conn(), "/api/v1/version") |> assert_contract("/version")
    conn = get(api_conn(), "/api/v1/version?origin=not-configured")
    assert conn.status == 400
    assert %{"error" => _} = assert_contract(conn, "/version")
    assert Shuttle.ApiContract.level() == String.to_integer(document()["info"]["version"])
  end

  test "GET forwards fail as contracted without falling back to local data" do
    ForwardStub.stub_forward(
      "edge",
      "http://edge.test",
      {:error, :econnrefused},
      StubGetFileClient
    )

    for path <- ~w(/version /fleet /fibers/work/missing /sent-files /file) do
      conn =
        get(api_conn(), "/api/v1" <> path <> "?origin=edge&uid=work/missing&path=/tmp/report")

      assert conn.status == 502

      assert_contract(
        conn,
        if(String.starts_with?(path, "/fibers/"), do: "/fibers/{id}", else: path)
      )
    end
  end

  test "POST forwards preserve each route's failure envelope and delivery's uncertain timeout" do
    ForwardStub.stub_forward("edge", "http://edge.test", {:error, :econnrefused}, StubPostClient)

    for path <- ~w(/capture /fiber/create /dispatch /deliver /lifecycle /kill) do
      conn =
        post(
          api_conn(),
          "/api/v1" <> path,
          Jason.encode!(%{origin: "edge", fiber_id: "work/item", text: "hello"})
        )

      assert conn.status == 502
      assert_contract(conn, path)
    end

    StubPostClient.set_response({:error, :timeout})

    conn =
      post(
        api_conn(),
        "/api/v1/deliver",
        Jason.encode!(%{origin: "edge", fiber_id: "work/item", text: "hello"})
      )

    assert conn.status == 202

    assert %{"delivered" => nil, "reason" => "forward_timeout"} =
             assert_contract(conn, "/deliver")
  end

  test "boot refuses stateful routes with the shared readiness shape" do
    Env.own_scope!()
    Shuttle.Readiness.begin_boot()

    for path <- ~w(/fleet /fibers/composite /fibers/work/item /sent-files /file) do
      conn = get(api_conn(), "/api/v1" <> path)
      assert conn.status == 503
      template = if String.starts_with?(path, "/fibers/work/"), do: "/fibers/{id}", else: path
      assert %{"ready" => false, "error" => "booting"} = assert_contract(conn, template)
    end

    for path <- ~w(/capture /fiber/create /dispatch /deliver /lifecycle /kill) do
      conn = post(api_conn(), "/api/v1" <> path, "{}")
      assert conn.status == 503
      assert_contract(conn, path)
    end
  end

  @tag :tmp_dir
  test "artifact queries support raw bytes, empty history and conditional reads", %{tmp_dir: tmp} do
    path = Path.join(tmp, "report.txt")
    File.write!(path, "report bytes")
    conn = get(api_conn(), "/api/v1/file", %{path: path})
    assert conn.status == 200
    assert assert_contract(conn, "/file") == "report bytes"
    [etag] = get_resp_header(conn, "etag")

    unchanged =
      api_conn() |> put_req_header("if-none-match", etag) |> get("/api/v1/file", %{path: path})

    assert unchanged.status == 304
    assert_contract(unchanged, "/file")

    partial =
      api_conn() |> put_req_header("range", "bytes=0-5") |> get("/api/v1/file", %{path: path})

    assert partial.status == 206
    assert assert_contract(partial, "/file") == "report"

    range =
      api_conn() |> put_req_header("range", "bytes=999-") |> get("/api/v1/file", %{path: path})

    assert range.status == 416
    assert_contract(range, "/file")

    for {query, status} <- [
          {%{}, 400},
          {%{path: "relative"}, 400},
          {%{path: Path.join(tmp, "absent")}, 404}
        ] do
      refused = get(api_conn(), "/api/v1/file", query)
      assert refused.status == status
      assert_contract(refused, "/file")
    end

    events = Path.join(tmp, "events.jsonl")
    File.write!(events, "")
    Shuttle.Test.EventFiles.scope!(events)

    assert %{"files" => []} =
             get(api_conn(), "/api/v1/sent-files?uid=not-sent") |> assert_contract("/sent-files")

    history = get(api_conn(), "/api/v1/sent-files?uid=not-sent")
    [history_etag] = get_resp_header(history, "etag")

    unchanged =
      api_conn()
      |> put_req_header("if-none-match", history_etag)
      |> get("/api/v1/sent-files?uid=not-sent")

    assert unchanged.status == 304
    assert_contract(unchanged, "/sent-files")
    refused = get(api_conn(), "/api/v1/sent-files")
    assert refused.status == 400
    assert_contract(refused, "/sent-files")
  end
end

defmodule ShuttleWeb.ApiContractWorkerTest do
  use ExUnit.Case, async: true
  import Phoenix.ConnTest
  import Plug.Conn
  import Shuttle.Test.ApiConn
  import Shuttle.Test.ApiContract
  import Shuttle.Test.PollerHelpers
  import Shuttle.Test.TranscriptHelpers
  alias Shuttle.Test.{Env, FeltStoreRunner}
  alias FeltStoreRunner, as: Store
  @endpoint ShuttleWeb.Endpoint

  defmodule Runner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["message", "--local", "--json", "--request-json"], opts) do
      request = opts[:input] |> String.trim() |> Jason.decode!()

      {Jason.encode!(%{
         message_id: request["message_id"],
         address: request["address"],
         status: if(request["wake"], do: "accepted", else: "context_added"),
         transport: "claude-native",
         detail: nil
       }), 0}
    end

    def cmd(command, args, opts), do: FeltStoreRunner.cmd(command, args, opts)
  end

  setup do
    Store.start!()
    Store.reset()
    root = Store.felt_root()
    Env.put_env("SHUTTLE_STORES", root)
    Env.put_app_env(:felt_runner, Runner)
    {:ok, poller} = start_poller!(runner: Runner, poll_interval_ms: 600_000, felt_stores: [root])
    await_boot_cycle!(poller)
    on_exit(fn -> File.rm_rf(root) end)
    {:ok, root: root, poller: poller}
  end

  defp constitution(id) do
    Store.set_fiber(id, make_fiber(id))
    Store.set_shuttle(id, oneshot_shuttle())
  end

  defp request(path, payload, status) do
    conn = post(api_conn(), "/api/v1" <> path, Jason.encode!(payload))
    assert conn.status == status, conn.resp_body
    assert_contract(conn, path)
  end

  test "capture returns worker coordinates, and distinguishes validation from preflight", %{
    root: root
  } do
    assert %{"spawned" => true, "agent" => _, "tmux_session" => _} =
             request("/capture", %{prompt: "Investigate", project_dir: root}, 200)

    assert %{"error" => "prompt is required"} = request("/capture", %{}, 400)

    assert %{"spawned" => false, "reason" => "project_dir_missing"} =
             request(
               "/capture",
               %{prompt: "Investigate", project_dir: Path.join(root, "absent")},
               422
             )
  end

  test "dispatch promises worker identity and refuses duplicate launches and missing input" do
    id = "work/dispatch"
    constitution(id)

    assert %{"dispatched" => true, "fiber_id" => ^id, "session_uuid" => _} =
             request("/dispatch", %{fiber_id: id}, 200)

    assert %{"dispatched" => false, "reason" => "already_running"} =
             request("/dispatch", %{fiber_id: id}, 409)

    assert %{"error" => "fiber_id is required"} = request("/dispatch", %{}, 400)

    assert %{"reason" => "fiber_not_found"} =
             request("/dispatch", %{fiber_id: "absent/item"}, 404)
  end

  test "delivery launches fresh, messages the live session and can paste terminal input" do
    id = "work/deliver"
    constitution(id)

    assert %{"delivery" => "dispatch", "delivered" => true, "dispatched" => true} =
             request("/deliver", %{fiber_id: id, text: "Start here"}, 200)

    assert %{"delivery" => "message", "delivered" => true, "receipt" => %{"status" => "accepted"}} =
             request(
               "/deliver",
               %{fiber_id: id, text: "Then this", message_id: "live-message"},
               200
             )

    assert %{"delivery" => "input", "delivered" => true} =
             request("/deliver", %{fiber_id: id, text: "Typed input", live_input: true}, 200)

    assert %{"error" => "text is required", "delivered" => false} =
             request("/deliver", %{fiber_id: id}, 400)
  end

  test "delivery can resume a prior conversation" do
    id = "work/resume"
    session = "de11ae00-0000-4000-8000-000000000091"
    constitution(id)

    Store.put_shuttle_fields(id, %{
      "session_uuid" => session,
      "dispatched_at" => DateTime.to_iso8601(DateTime.add(DateTime.utc_now(), -60))
    })

    Shuttle.Poller.refresh_document(id)

    write_transcript(session, 30)

    assert %{"delivery" => "resume", "delivered" => true} =
             request("/deliver", %{fiber_id: id, text: "Continue", resume_mode: "previous"}, 200)
  end

  test "delivery context queues for a dormant worker and refuses unless_live after launch" do
    id = "work/context"
    constitution(id)

    assert %{"delivery" => "context", "queued" => true, "delivered" => false} =
             request(
               "/deliver",
               %{fiber_id: id, text: "Next time", context_only: true, message_id: "context-1"},
               202
             )

    assert %{"status" => "queued_for_next_worker"} =
             request(
               "/deliver",
               %{
                 fiber_id: id,
                 text: "Next worker",
                 context_only: true,
                 unless_live: true,
                 message_id: "context-2"
               },
               202
             )

    request("/dispatch", %{fiber_id: id}, 200)

    assert %{"live" => true, "queued" => false} =
             request(
               "/deliver",
               %{
                 fiber_id: id,
                 text: "No queue",
                 context_only: true,
                 unless_live: true,
                 message_id: "context-3"
               },
               409
             )
  end

  test "kill covers a stopped worker and the idempotent no-session response" do
    id = "work/kill"
    constitution(id)
    request("/dispatch", %{fiber_id: id}, 200)

    assert %{"fiber_id" => ^id, "killed" => true, "session" => _} =
             request("/kill", %{fiber_id: id}, 200)

    assert %{"fiber_id" => ^id, "killed" => false} = request("/kill", %{fiber_id: id}, 200)
    assert %{"error" => "fiber_id is required"} = request("/kill", %{}, 400)
  end

  test "composite validates populated owner rows and refuses during boot", %{poller: poller} do
    id = "work/composite"
    constitution(id)
    before = :sys.get_state(poller).poll_cycles
    send(poller, :run_poll_cycle)
    await_cycle(poller, before)
    first = get(api_conn(), "/api/v1/fibers/composite")

    assert %{
             "fibers" => [
               %{"fiber" => %{"name" => ^id}, "origin" => _, "column" => _, "turn" => _}
             ],
             "origins" => _
           } = assert_contract(first, "/fibers/composite")

    [etag] = get_resp_header(first, "etag")

    unchanged =
      api_conn() |> put_req_header("if-none-match", etag) |> get("/api/v1/fibers/composite")

    assert unchanged.status == 304
    assert_contract(unchanged, "/fibers/composite")
    Shuttle.Readiness.begin_boot()
    refused = get(api_conn(), "/api/v1/fibers/composite")
    assert refused.status == 503
    assert_contract(refused, "/fibers/composite")
  end

  defp await_cycle(poller, before, attempts \\ 3_000) do
    state = :sys.get_state(poller, :infinity)

    cond do
      state.poll_cycles > before and not state.poll_check_in_progress ->
        :ok

      attempts == 0 ->
        flunk("poll did not finish")

      true ->
        Process.sleep(10)
        await_cycle(poller, before, attempts - 1)
    end
  end
end

defmodule ShuttleWeb.ApiContractDocumentsTest do
  use ExUnit.Case, async: true
  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn
  import Shuttle.Test.ApiContract
  alias Shuttle.Test.Env
  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir

  setup %{tmp_dir: tmp} do
    tmp = Path.expand(tmp)
    assert {:ok, _} = Shuttle.CLI.run_felt(["-C", tmp, "init"])
    Env.put_env("SHUTTLE_STORES", tmp)
    Env.put_env("SHUTTLE_HOST", "test-host")
    {:ok, root: tmp}
  end

  test "create confirms identity and reads optional Markdown while refusing duplicates" do
    payload = %{
      id: "work/note",
      name: "A note",
      body: "Read this.",
      frontmatter: %{status: "open"}
    }

    conn = post(api_conn(), "/api/v1/fiber/create", Jason.encode!(payload))
    assert conn.status == 200

    assert %{"id" => "work/note", "uid" => uid, "host" => "test-host", "status" => "open"} =
             assert_contract(conn, "/fiber/create")

    assert is_binary(uid)

    for suffix <- ["", "?body=true"] do
      read = get(api_conn(), "/api/v1/fibers/work/note" <> suffix)
      assert read.status == 200
      assert %{"fibers" => [%{"fiber" => fiber}]} = assert_contract(read, "/fibers/{id}")
      assert fiber["name"] == "A note"

      if suffix == "",
        do: refute(Map.has_key?(fiber, "body")),
        else: assert(fiber["body"] == "Read this.")
    end

    duplicate = post(api_conn(), "/api/v1/fiber/create", Jason.encode!(payload))
    assert duplicate.status == 400
    assert_contract(duplicate, "/fiber/create")
    missing = get(api_conn(), "/api/v1/fibers/absent/no-match")
    assert missing.status == 404
    assert_contract(missing, "/fibers/{id}")
  end

  test "lifecycle returns plain CLI output and validation errors with structured missing identity" do
    created =
      post(
        api_conn(),
        "/api/v1/fiber/create",
        Jason.encode!(%{
          id: "work/lifecycle",
          name: "Lifecycle",
          frontmatter: %{status: "open", shuttle: %{kind: "oneshot"}}
        })
      )

    assert created.status == 200, created.resp_body

    success =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{fiber: "work/lifecycle", action: "set-outcome", outcome: "Recorded"})
      )

    assert success.status == 200
    assert is_binary(assert_contract(success, "/lifecycle"))

    bad =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{fiber: "work/lifecycle", action: "unknown"})
      )

    assert bad.status == 400
    assert assert_contract(bad, "/lifecycle") =~ "unknown lifecycle action"

    missing =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{fiber: "absent/note", action: "set-outcome", outcome: "No"})
      )

    assert missing.status == 404

    assert %{"error_code" => "fiber_not_found", "fiber" => "absent/note", "host" => "test-host"} =
             assert_contract(missing, "/lifecycle")

    refused =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{fiber: "work/lifecycle", action: "reshape", kind: "standing"})
      )

    assert refused.status == 422
    assert assert_contract(refused, "/lifecycle") =~ "shuttle exited"
  end
end

defmodule ShuttleWeb.ApiContractDirectoryTest do
  use ExUnit.Case, async: true
  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn
  import Shuttle.Test.ApiContract
  alias Shuttle.Test.Env
  @endpoint ShuttleWeb.Endpoint

  defmodule Runner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["sessions", "--local", "--json"], _) do
      {Jason.encode!(%{
         sessions: [
           %{
             address: "shuttle://test-host/claude/session-1",
             host: "test-host",
             harness: "claude",
             id: "session-1",
             title: "Worker",
             cwd: "/home/me/project",
             state: "working",
             capabilities: ["message"],
             last_seen: 1_800_000_000_000
           }
         ]
       }), 0}
    end

    def cmd("shuttle", ["remotes", "list", "--json", "--no-reach"], _) do
      {Jason.encode!(%{
         remotes: [
           %{name: "edge", url: "http://edge.test", source: "file", tunnel: %{manager: "none"}}
         ]
       }), 0}
    end

    def cmd("shuttle", ["message", "--local", "--json", "--request-json"], opts) do
      request = opts[:input] |> String.trim() |> Jason.decode!()

      {status, error, exit} =
        case request["message_id"] do
          "conflict" -> {"rejected", "message_id_conflict", 1}
          "preflight" -> {"rejected", "preflight_failed", 1}
          "malformed" -> {"not-a-status", nil, 0}
          _ -> {if(request["wake"], do: "accepted", else: "context_added"), nil, 0}
        end

      {Jason.encode!(%{
         message_id: request["message_id"],
         address: request["address"],
         status: status,
         transport: "claude-native",
         detail: nil,
         _felt_error_code: error
       }), exit}
    end
  end

  setup do
    Env.put_env("SHUTTLE_HOST", "test-host")
    Env.put_app_env(:felt_runner, Runner)
    Env.put_app_env(:remotes, [])
    :ok
  end

  test "peers validates a populated session, and rejects a malformed local selector" do
    assert %{
             "sessions" => [
               %{"address" => "shuttle://test-host/claude/session-1", "host" => "test-host"}
             ]
           } = get(api_conn(), "/api/v1/peers?local=true") |> assert_contract("/peers")

    bad = get(api_conn(), "/api/v1/peers?local=maybe")
    assert bad.status == 400
    assert_contract(bad, "/peers")
  end

  test "fleet validates populated remote health, and refuses an unknown host" do
    assert %{"remotes" => [%{"name" => "edge", "health" => %{"polled" => false}}]} =
             get(api_conn(), "/api/v1/fleet") |> assert_contract("/fleet")

    bad = get(api_conn(), "/api/v1/fleet?origin=not-configured")
    assert bad.status == 400
    assert_contract(bad, "/fleet")
  end

  test "messages validates waking and context receipts, conflicts, preflight and invalid input" do
    payload = %{
      address: "shuttle://test-host/claude/session-1",
      text: "Hello",
      from: "shuttle",
      message_id: "message-1"
    }

    for {wake, status} <- [{true, "accepted"}, {false, "context_added"}] do
      conn = post(api_conn(), "/api/v1/messages", Jason.encode!(Map.put(payload, :wake, wake)))
      assert conn.status == 200

      assert %{"status" => ^status, "message_id" => "message-1"} =
               assert_contract(conn, "/messages")
    end

    for {id, code} <- [{"conflict", 409}, {"preflight", 400}, {"malformed", 502}] do
      conn = post(api_conn(), "/api/v1/messages", Jason.encode!(%{payload | message_id: id}))
      assert conn.status == code
      assert_contract(conn, "/messages")
    end

    bad = post(api_conn(), "/api/v1/messages", "{}")
    assert bad.status == 400
    assert %{"error" => _} = assert_contract(bad, "/messages")
  end
end
