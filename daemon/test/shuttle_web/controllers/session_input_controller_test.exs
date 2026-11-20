defmodule ShuttleWeb.SessionInputControllerTest do
  use ExUnit.Case, async: true
  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn

  alias Shuttle.Test.Env

  @endpoint ShuttleWeb.Endpoint

  defmodule Runner do
    def cmd("tmux", ["has-session" | _], _opts), do: Process.get(:session_input_tmux, {"", 0})

    def cmd("ps", _args, _opts), do: Process.get(:session_input_ps, {"", 0})

    def cmd("shuttle", ["process-identity", pid], _opts) do
      send(Shuttle.Env.app(:session_input_test), {:identity_probe, pid})
      Process.get(:session_input_identity, {~s({"status":"unknown"}), 0})
    end

    def cmd("tmux", args, _opts) do
      send(Shuttle.Env.app(:session_input_test), {:tmux, args})

      case Process.get({:session_input_tmux, hd(args)}) do
        [reply | later] ->
          tap(reply, fn _ -> Process.put({:session_input_tmux, hd(args)}, later) end)

        nil ->
          Process.get(:session_input_tmux, {"", 0})

        reply ->
          reply
      end
    end
  end

  setup do
    path =
      Path.join(System.tmp_dir!(), "session-input-#{System.unique_integer([:positive])}.jsonl")

    Env.put_env("SHUTTLE_SESSIONS_FILE", path)
    Env.put_app_env(:terminal_runner, Runner)
    Env.put_app_env(:paste_submit_delay_ms, 0)
    Env.put_app_env(:session_input_test, self())
    on_exit(fn -> File.rm(path) end)
    {:ok, path: path}
  end

  test "pastes only to the current terminal binding", %{path: path} do
    session = "11111111-1111-4111-8111-111111111111"
    uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV"

    assert :ok =
             Shuttle.SessionLedger.record_checked(
               session: session,
               fiber: "work/worker",
               uid: uid,
               harness: "codex",
               host: "test-host",
               tmux: "worker-shuttle",
               kind: "dispatch",
               path: path
             )

    assert %{"status" => "submitted"} =
             post(
               api_conn(),
               "/api/v1/sessions/input",
               Jason.encode!(%{
                 session_uuid: session,
                 text: "please continue"
               })
             )
             |> json_response(200)

    assert_received {:tmux, ["load-buffer", "-b", _, _]}
    assert_received {:tmux, ["paste-buffer", "-p", "-d", "-b", _, "-t", "=worker-shuttle:"]}
    assert_received {:tmux, ["send-keys", "-t", "=worker-shuttle:", "Enter"]}

    assert %{"tmux_session" => "worker-shuttle"} =
             post(
               api_conn(),
               "/api/v1/sessions/prepare-terminal",
               Jason.encode!(%{fiber: uid})
             )
             |> json_response(200)
  end

  test "pastes to a harness that takes typed input, and to no other", %{path: path} do
    for {harness, session, status} <- [
          {"antigravity", "22222222-2222-4222-8222-222222222222", 200},
          {"claude-code", "33333333-3333-4333-8333-333333333333", 404}
        ] do
      uid = "01ARZ3NDEKTSV4RRFFQ69G5F" <> String.slice(session, 0, 2)

      assert :ok =
               Shuttle.SessionLedger.record_checked(
                 session: session,
                 fiber: "work/#{harness}",
                 uid: uid,
                 harness: harness,
                 host: "test-host",
                 tmux: "#{harness}-shuttle",
                 kind: "dispatch",
                 path: path
               )

      conn =
        post(
          api_conn(),
          "/api/v1/sessions/input",
          Jason.encode!(%{session_uuid: session, text: "please continue"})
        )

      assert conn.status == status, "#{harness}: #{conn.resp_body}"
    end

    assert_received {:tmux, ["send-keys", "-t", "=antigravity-shuttle:", "Enter"]}
    refute_received {:tmux, ["send-keys", "-t", "=claude-code-shuttle:", "Enter"]}
  end

  for {step, status, code} <- [
        {"load-buffer", 503, "terminal_input_failed"},
        {"paste-buffer", 502, "terminal_input_ambiguous"},
        {"send-keys", 502, "terminal_input_ambiguous"}
      ] do
    test "a paste failing at #{step} answers #{status} #{code}", %{path: path} do
      session = "11111111-1111-4111-8111-111111111111"
      record_session(path, session, "01ARZ3NDEKTSV4RRFFQ69G5FAV", "worker-shuttle")
      Process.put({:session_input_tmux, unquote(step)}, {"tmux refused", 1})

      assert %{"code" => unquote(code)} =
               post(
                 api_conn(),
                 "/api/v1/sessions/input",
                 Jason.encode!(%{session_uuid: session, text: "please continue"})
               )
               |> json_response(unquote(status))
    end
  end

  test "a paste whose pane lookup fails answers 503 without typing", %{path: path} do
    session = "11111111-1111-4111-8111-111111111111"
    record_session(path, session, "01ARZ3NDEKTSV4RRFFQ69G5FAV", "$worker")

    # The route's liveness probe and the paste's choice of backend each resolve
    # the pane; the paste's own lookup then fails.
    found = {"$7\t$worker\n", 0}
    Process.put({:session_input_tmux, "ls"}, [found, found, {"no server running", 1}])

    assert %{"code" => "terminal_input_failed"} =
             post(
               api_conn(),
               "/api/v1/sessions/input",
               Jason.encode!(%{session_uuid: session, text: "please continue"})
             )
             |> json_response(503)

    refute_received {:tmux, ["load-buffer" | _]}
    refute_received {:tmux, ["paste-buffer" | _]}
  end

  for {route, address, status} <- [
        {"input", :session, 503},
        {"receiver", :session, 503},
        {"prepare-terminal", :session, 404},
        {"prepare-terminal", :fiber, 404}
      ] do
    @tag :reachable_terminal
    test "#{route} by #{address} does not mistake a live process for a reachable terminal", %{
      path: path
    } do
      session = "11111111-1111-4111-8111-111111111111"
      uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
      record_session(path, session, uid, "worker-shuttle")
      Process.put(:session_input_tmux, {"tmux timed out", :timeout})

      Process.put(
        :session_input_ps,
        {"812 700 bash -l /tmp/shuttle-run-worker-shuttle.42.sh\n" <>
           "813 812 codex resume #{session}\n", 0}
      )

      Process.put(:session_input_identity, {~s({"status":"present","start":"birth-813"}), 0})
      assert Shuttle.Terminal.status(Runner, "worker-shuttle") == :alive

      params =
        if unquote(address) == :fiber,
          do: %{fiber: uid},
          else: %{session_uuid: session, text: "continue"}

      conn = post(api_conn(), "/api/v1/sessions/#{unquote(route)}", Jason.encode!(params))
      body = json_response(conn, unquote(status))
      if unquote(status) == 503, do: assert(body["code"] == "terminal_unavailable")
      refute_received {:tmux, _}
      refute_received {:identity_probe, _}
    end
  end

  test "rejects a session whose UUID is no longer the uid's current binding", %{path: path} do
    session = "11111111-1111-4111-8111-111111111111"
    uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV"

    for {id, terminal} <- [
          {session, "worker-shuttle"},
          {"22222222-2222-4222-8222-222222222222", "worker-shuttle"}
        ] do
      assert :ok =
               Shuttle.SessionLedger.record_checked(
                 session: id,
                 fiber: "work/worker",
                 uid: uid,
                 harness: "codex",
                 host: "test-host",
                 tmux: terminal,
                 kind: "dispatch",
                 path: path
               )
    end

    assert %{"code" => "session_not_found"} =
             post(
               api_conn(),
               "/api/v1/sessions/input",
               Jason.encode!(%{
                 session_uuid: session,
                 text: "please continue"
               })
             )
             |> json_response(404)

    assert %{"code" => "session_not_found"} =
             post(
               api_conn(),
               "/api/v1/sessions/receiver",
               Jason.encode!(%{session_uuid: session})
             )
             |> json_response(404)

    refute_received {:tmux, _}
  end

  test "returns the exact live native Codex process and kernel start token", %{path: path} do
    session = "11111111-1111-4111-8111-111111111111"
    uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    record_session(path, session, uid, "worker-shuttle")

    Process.put(
      :session_input_ps,
      {"815 1 codex resume #{session}\n" <>
         "812 700 bash -l /tmp/shuttle-run-worker-shuttle.42.sh\n" <>
         "813 812 codex --model gpt-6.1-sol resume #{session}\n" <>
         "814 812 bash -lc 'codex resume #{session}'\n", 0}
    )

    Process.put(:session_input_identity, {~s({"status":"present","start":"birth-813"}), 0})

    assert %{
             "session_uuid" => ^session,
             "pid" => 813,
             "process_start" => "birth-813"
           } =
             post(
               api_conn(),
               "/api/v1/sessions/receiver",
               Jason.encode!(%{session_uuid: session})
             )
             |> json_response(200)

    assert_received {:identity_probe, "813"}
  end

  test "does not identify a shell containing the UUID as the native Codex receiver", %{
    path: path
  } do
    session = "11111111-1111-4111-8111-111111111111"
    uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    record_session(path, session, uid, "worker-shuttle")
    Process.put(:session_input_ps, {"814 812 bash -lc 'codex resume #{session}'\n", 0})

    assert %{"code" => "session_not_running"} =
             post(
               api_conn(),
               "/api/v1/sessions/receiver",
               Jason.encode!(%{session_uuid: session})
             )
             |> json_response(404)

    refute_received {:identity_probe, _}
  end

  test "does not register another native Codex process outside the canonical terminal", %{
    path: path
  } do
    session = "11111111-1111-4111-8111-111111111111"
    uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    record_session(path, session, uid, "worker-shuttle")

    Process.put(
      :session_input_ps,
      {"812 700 bash -l /tmp/shuttle-run-worker-shuttle.42.sh\n" <>
         "815 1 codex resume #{session}\n", 0}
    )

    assert %{"code" => "session_not_running"} =
             post(
               api_conn(),
               "/api/v1/sessions/receiver",
               Jason.encode!(%{session_uuid: session})
             )
             |> json_response(404)

    refute_received {:identity_probe, _}
  end

  test "reports process and lifetime uncertainty without certifying a receiver", %{path: path} do
    session = "11111111-1111-4111-8111-111111111111"
    uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    record_session(path, session, uid, "worker-shuttle")

    Process.put(:session_input_ps, {"process scan failed", 1})

    assert %{"code" => "process_scan_unavailable"} =
             post(
               api_conn(),
               "/api/v1/sessions/receiver",
               Jason.encode!(%{session_uuid: session})
             )
             |> json_response(503)

    Process.put(
      :session_input_ps,
      {"812 700 bash -l /tmp/shuttle-run-worker-shuttle.42.sh\n" <>
         "813 812 codex resume #{session}\n", 0}
    )

    assert %{"code" => "process_identity_unavailable"} =
             post(
               api_conn(),
               "/api/v1/sessions/receiver",
               Jason.encode!(%{session_uuid: session})
             )
             |> json_response(503)
  end

  defp record_session(path, session, uid, terminal) do
    assert :ok =
             Shuttle.SessionLedger.record_checked(
               session: session,
               fiber: "work/worker",
               uid: uid,
               harness: "codex",
               host: "test-host",
               tmux: terminal,
               kind: "dispatch",
               path: path
             )
  end
end
