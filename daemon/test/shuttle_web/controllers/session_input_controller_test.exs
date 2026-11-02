defmodule ShuttleWeb.SessionInputControllerTest do
  use ExUnit.Case, async: true
  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn

  alias Shuttle.Test.Env

  @endpoint ShuttleWeb.Endpoint

  defmodule Runner do
    def cmd("tmux", ["has-session", _target], _opts), do: {"", 0}

    def cmd("ps", _args, _opts), do: Process.get(:session_input_ps, {"", 0})

    def cmd("shuttle", ["process-identity", pid], _opts) do
      send(Shuttle.Env.app(:session_input_test), {:identity_probe, pid})
      Process.get(:session_input_identity, {~s({"status":"unknown"}), 0})
    end

    def cmd("tmux", args, _opts) do
      send(Shuttle.Env.app(:session_input_test), {:tmux, args})
      {"", 0}
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
    assert_received {:tmux, ["paste-buffer", "-p", "-d", "-b", _, "-t", "worker-shuttle"]}
    assert_received {:tmux, ["send-keys", "-t", "worker-shuttle", "Enter"]}

    assert %{"tmux_session" => "worker-shuttle"} =
             post(
               api_conn(),
               "/api/v1/sessions/prepare-terminal",
               Jason.encode!(%{fiber: uid})
             )
             |> json_response(200)
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
