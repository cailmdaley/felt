defmodule ShuttleWeb.TranscriptControllerTest do
  use ExUnit.Case, async: false
  import Shuttle.Test.EnvHelpers

  import Phoenix.ConnTest
  import Plug.Conn

  alias Shuttle.Test.StubGetFileClient

  @endpoint ShuttleWeb.Endpoint
  @session "a3edf873-cb1c-40ab-a891-f26f5333b320"

  setup do
    root =
      Path.join(
        System.tmp_dir!(),
        "shuttle_transcript_http_#{System.unique_integer([:positive])}"
      )

    dir = Path.join(root, "-Users-cail-french")
    File.mkdir_p!(dir)
    path = Path.join(dir, "#{@session}.jsonl")
    bytes = ~s({"type":"user","message":{"content":"native"}}\n)
    File.write!(path, bytes)

    prior_root = System.get_env("SHUTTLE_CLAUDE_PROJECTS_DIR")
    System.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", root)

    on_exit(fn ->
      File.rm_rf(root)

      if prior_root,
        do: System.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", prior_root),
        else: System.delete_env("SHUTTLE_CLAUDE_PROJECTS_DIR")
    end)

    {:ok, root: root, path: path, bytes: bytes}
  end

  test "local receipt exposes the authoritative native path and digest", %{
    path: path,
    bytes: bytes
  } do
    body =
      build_conn()
      |> get("/api/v1/transcript", %{"session" => @session})
      |> json_response(200)

    assert body["availability"] == "available_local"
    assert body["source_path"] == path
    assert body["byte_count"] == byte_size(bytes)
    assert body["sha256"] == :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)
  end

  test "raw local response is byte-for-byte native and carries digest headers", %{bytes: bytes} do
    conn = build_conn() |> get("/api/v1/transcript/raw", %{"session" => @session})

    assert response(conn, 200) == bytes

    assert get_resp_header(conn, "x-transcript-byte-count") == [
             Integer.to_string(byte_size(bytes))
           ]

    assert get_resp_header(conn, "x-transcript-sha256") == [
             Base.encode16(:crypto.hash(:sha256, bytes), case: :lower)
           ]
  end

  test "invalid UUID is a 400 and unknown valid UUID is transcript_missing" do
    assert %{"error" => "session must be a UUID"} =
             build_conn()
             |> get("/api/v1/transcript", %{"session" => "not-a-uuid"})
             |> json_response(400)

    assert %{"availability" => "transcript_missing"} =
             build_conn()
             |> get("/api/v1/transcript", %{"session" => "11111111-2222-3333-4444-555555555555"})
             |> json_response(200)
  end

  describe "remote host routing" do
    setup do
      start_supervised!(StubGetFileClient)
      prior_client = Application.get_env(:shuttle, :write_forward_client)
      prior_remotes = Application.get_env(:shuttle, :remotes)
      Application.put_env(:shuttle, :write_forward_client, StubGetFileClient)
      Application.put_env(:shuttle, :remotes, [%{name: "candide", url: "http://127.0.0.1:19999"}])

      on_exit(fn ->
        restore_app_env(:write_forward_client, prior_client)
        restore_app_env(:remotes, prior_remotes)
      end)

      :ok
    end

    test "receipt marks an owner's available transcript as available_remote" do
      StubGetFileClient.set_response(
        {:ok, 200, "application/json",
         Jason.encode!(%{
           "session" => @session,
           "availability" => "available_local",
           "host" => "dapmcw68",
           "harness" => "codex",
           "source_path" => "/home/cail/.codex/sessions/rollout.jsonl",
           "byte_count" => 4,
           "sha256" => "abcd"
         })}
      )

      body =
        build_conn()
        |> get("/api/v1/transcript", %{"session" => @session, "host" => "candide"})
        |> json_response(200)

      assert body["availability"] == "available_remote"
      assert body["host"] == "candide"
      assert body["source_path"] == "/home/cail/.codex/sessions/rollout.jsonl"
      assert StubGetFileClient.last().url =~ "host=local"
    end

    test "raw remote response is relayed exactly and digested at this hop" do
      bytes = "remote native bytes\n"
      StubGetFileClient.set_response({:ok, 200, "application/x-ndjson", bytes})

      conn =
        build_conn()
        |> get("/api/v1/transcript/raw", %{"session" => @session, "host" => "candide"})

      assert response(conn, 200) == bytes

      assert get_resp_header(conn, "x-transcript-byte-count") == [
               Integer.to_string(byte_size(bytes))
             ]

      assert get_resp_header(conn, "x-transcript-sha256") == [
               Base.encode16(:crypto.hash(:sha256, bytes), case: :lower)
             ]
    end

    test "unreachable host is explicit" do
      StubGetFileClient.set_response({:error, :econnrefused})

      assert %{"availability" => "host_unreachable"} =
               build_conn()
               |> get("/api/v1/transcript", %{"session" => @session, "host" => "candide"})
               |> json_response(200)

      assert %{"availability" => "host_unreachable"} =
               build_conn()
               |> get("/api/v1/transcript/raw", %{"session" => @session, "host" => "candide"})
               |> json_response(503)
    end
  end
end
