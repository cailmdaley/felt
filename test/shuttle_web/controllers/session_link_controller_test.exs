defmodule ShuttleWeb.SessionLinkControllerTest do
  @moduledoc """
  `GET /api/v1/session-link` — the claude.ai bridge URL a remote-controlled
  Claude Code session writes into its own transcript, read locally from a
  fixture tree via `$SHUTTLE_CLAUDE_PROJECTS_DIR`, or forwarded host-routed the
  way `/moment` is.
  """
  use ExUnit.Case, async: false
  alias Shuttle.Test.StubGetFileClient
  import Phoenix.ConnTest
  import Shuttle.Test.EnvHelpers

  alias Shuttle.SessionLink

  @endpoint ShuttleWeb.Endpoint

  @session "a3edf873-cb1c-40ab-a891-f26f5333b320"
  @unbridged "fef866ba-b397-4277-a01b-16fcecc2b256"
  @first "https://claude.ai/code/session_01FIRST"
  @last "https://claude.ai/code/session_01LAST"

  defp bridge(url),
    do: %{"type" => "user", "attachment" => %{"type" => "remote_session_change", "url" => url}}

  defp write_tree(files) do
    root = Path.join(System.tmp_dir!(), "shuttle_link_#{System.unique_integer([:positive])}")

    Enum.each(files, fn {session, records} ->
      dir = Path.join(root, "-Users-cail-felt")
      File.mkdir_p!(dir)

      body =
        records
        |> Enum.map(fn
          line when is_binary(line) -> line
          record -> Jason.encode!(record)
        end)
        |> Enum.join("\n")

      File.write!(Path.join(dir, "#{session}.jsonl"), body <> "\n")
    end)

    on_exit(fn -> File.rm_rf(root) end)
    root
  end

  defp default_tree do
    write_tree([
      {@session,
       [
         %{"type" => "user", "message" => %{"content" => "hello"}},
         bridge(@first),
         "{ not json",
         # Prose that mentions the marker is not a record of it.
         %{"type" => "assistant", "message" => %{"content" => "remote_session_change happened"}},
         bridge(@last),
         %{"type" => "user", "attachment" => %{"type" => "remote_session_change", "url" => 7}}
       ]},
      {@unbridged, [%{"type" => "user", "message" => %{"content" => "never bridged"}}]}
    ])
  end

  describe "Shuttle.SessionLink.remote_url/2" do
    test "the last well-formed bridge record wins" do
      assert SessionLink.remote_url(@session, root: default_tree()) == @last
    end

    test "no bridge record, no transcript → nil" do
      root = default_tree()
      assert SessionLink.remote_url(@unbridged, root: root) == nil
      assert SessionLink.remote_url("00000000-0000-0000-0000-000000000000", root: root) == nil
    end
  end

  describe "GET /api/v1/session-link (local)" do
    setup do
      root = default_tree()
      prior = System.get_env("SHUTTLE_CLAUDE_PROJECTS_DIR")
      System.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", root)
      on_exit(fn -> restore_env("SHUTTLE_CLAUDE_PROJECTS_DIR", prior) end)
      :ok
    end

    test "answers the url, stamped with this host" do
      conn = build_conn() |> get("/api/v1/session-link", %{"session" => @session})
      assert %{"url" => @last, "host" => host} = json_response(conn, 200)
      assert is_binary(host)
    end

    test "an unbridged session is url: null, not an error" do
      conn = build_conn() |> get("/api/v1/session-link", %{"session" => @unbridged})
      assert %{"url" => nil} = json_response(conn, 200)
    end

    test "session is required" do
      conn = build_conn() |> get("/api/v1/session-link", %{})
      assert %{"error" => "session is required"} = json_response(conn, 400)
    end
  end

  describe "GET /api/v1/session-link (cross-host)" do
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

    test "forwards to the named host with host=local and relays verbatim" do
      body = Jason.encode!(%{host: "candide", url: @last})
      StubGetFileClient.set_response({:ok, 200, "application/json", body})

      conn =
        build_conn()
        |> get("/api/v1/session-link", %{"session" => @session, "host" => "candide"})

      assert %{"host" => "candide", "url" => @last} = json_response(conn, 200)
      url = StubGetFileClient.last().url
      assert url =~ "http://127.0.0.1:19999/api/v1/session-link?"
      assert url =~ "session=#{@session}"
      assert url =~ "host=local"
    end

    test "an unreachable remote is url: null with a note, still a 200" do
      StubGetFileClient.set_response({:error, :econnrefused})

      conn =
        build_conn()
        |> get("/api/v1/session-link", %{"session" => @session, "host" => "candide"})

      assert %{"host" => "candide", "url" => nil, "note" => note} = json_response(conn, 200)
      assert note =~ "candide"
    end
  end
end
