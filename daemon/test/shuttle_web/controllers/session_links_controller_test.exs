defmodule ShuttleWeb.SessionLinksControllerTest do
  @moduledoc """
  `GET /api/v1/sessions/links` — where past sessions open, resolved from
  fixture transcript trees shaped like each harness's own: a bridged Claude
  session, an unbridged one, a Codex rollout, a pi session, and a UUID with no
  transcript at all. Plus remote forwarding and the parameter guard.
  """
  use ExUnit.Case, async: false
  import Shuttle.Test.ApiConn
  import Shuttle.Test.EnvHelpers
  import Phoenix.ConnTest

  alias Shuttle.Test.StubGetFileClient

  @endpoint ShuttleWeb.Endpoint

  @bridged "a3edf873-cb1c-40ab-a891-f26f5333b320"
  @unbridged "fef866ba-b397-4277-a01b-16fcecc2b256"
  @codex "01a0b39f-d9d0-7d02-9adf-c24f825c3342"
  @pi "01a042f4-6b7f-7f79-9c6c-8140ffd0126c"
  @missing "11111111-2222-3333-4444-555555555555"
  @url "https://claude.ai/code/session_01BRIDGED"

  setup do
    root =
      Path.join(System.tmp_dir!(), "shuttle_links_http_#{System.unique_integer([:positive])}")

    claude = Path.join(root, "claude/-Users-cail-felt")
    codex = Path.join(root, "codex/2026/09/27")
    pi = Path.join(root, "pi/--Users-cail-felt--")
    Enum.each([claude, codex, pi], &File.mkdir_p!/1)

    bridge = %{
      "type" => "user",
      "attachment" => %{"type" => "remote_session_change", "url" => @url}
    }

    File.write!(Path.join(claude, "#{@bridged}.jsonl"), Jason.encode!(bridge) <> "\n")
    File.write!(Path.join(claude, "#{@unbridged}.jsonl"), ~s({"type":"user"}\n))

    File.write!(
      Path.join(codex, "rollout-2026-09-27T10-00-00-#{@codex}.jsonl"),
      ~s({"type":"session_meta"}\n)
    )

    File.write!(Path.join(pi, "2026-09-27T10-00-00-000Z_#{@pi}.jsonl"), ~s({"type":"session"}\n))

    env = %{
      "SHUTTLE_CLAUDE_PROJECTS_DIR" => Path.join(root, "claude"),
      "SHUTTLE_CODEX_SESSIONS_DIR" => Path.join(root, "codex"),
      "SHUTTLE_PI_SESSIONS_DIR" => Path.join(root, "pi")
    }

    prior = Map.new(env, fn {key, _} -> {key, System.get_env(key)} end)
    Enum.each(env, fn {key, value} -> System.put_env(key, value) end)

    on_exit(fn ->
      File.rm_rf(root)

      Enum.each(prior, fn
        {key, nil} -> System.delete_env(key)
        {key, value} -> System.put_env(key, value)
      end)
    end)

    :ok
  end

  defp links(params) do
    local_conn()
    |> get("/api/v1/sessions/links", params)
    |> json_response(200)
  end

  test "each harness answers with exactly the link its transcript supports, in request order" do
    body = links(%{"sessions" => Enum.join([@bridged, @unbridged, @codex, @pi, @missing], ",")})

    assert body["host"] == Shuttle.Poller.own_host_id()

    assert [bridged, unbridged, codex, pi, missing] = body["links"]

    assert %{
             "session" => @bridged,
             "harness" => "claude-code",
             "url" => @url
           } =
             bridged

    assert %{"harness" => "claude-code", "url" => nil} = unbridged

    assert %{"harness" => "codex", "url" => nil} = codex
    refute Map.has_key?(codex, "desktop_link")

    assert %{"harness" => "pi", "url" => nil} = pi

    assert %{"availability" => "transcript_missing", "url" => nil} =
             missing

    assert bridged["availability"] == "available_local"
  end

  test "an explicit host naming this daemon is local" do
    body = links(%{"sessions" => @bridged, "host" => "local"})
    assert [%{"url" => @url}] = body["links"]
  end

  test "the parameter is required, UUID-only, and bounded" do
    for params <- [
          %{},
          %{"sessions" => ""},
          %{"sessions" => "#{@bridged},../etc"},
          # A trailing newline is not a UUID, however `$` would read it.
          %{"sessions" => @bridged <> "\n"},
          %{"sessions" => Enum.map_join(1..51, ",", &uuid/1)}
        ] do
      assert %{"error" => _} =
               local_conn() |> get("/api/v1/sessions/links", params) |> json_response(400)
    end
  end

  defp uuid(n), do: "00000000-0000-4000-8000-" <> String.pad_leading("#{n}", 12, "0")

  describe "remote host routing" do
    setup do
      StubGetFileClient.start!()
      prior_client = Application.get_env(:shuttle, :write_forward_client)
      prior_remotes = Application.get_env(:shuttle, :remotes)
      Application.put_env(:shuttle, :write_forward_client, StubGetFileClient)
      Application.put_env(:shuttle, :remotes, [%{name: "hub-a", url: "http://127.0.0.1:19999"}])

      on_exit(fn ->
        restore_app_env(:write_forward_client, prior_client)
        restore_app_env(:remotes, prior_remotes)
      end)

      :ok
    end

    test "a remote's sessions are resolved there and relayed under its name" do
      remote_links = [
        %{
          "session" => @bridged,
          "availability" => "available_local",
          "harness" => "claude-code",
          "url" => @url
        }
      ]

      StubGetFileClient.set_response(
        {:ok, 200, "application/json",
         Jason.encode!(%{"host" => "hub-a-own-id", "links" => remote_links})}
      )

      body = links(%{"sessions" => @bridged, "host" => "hub-a"})
      assert body == %{"host" => "hub-a", "links" => remote_links}
      assert StubGetFileClient.last().url =~ "/api/v1/sessions/links?"
      assert StubGetFileClient.last().url =~ "host=local"
    end

    test "a remote's answer is re-checked: requested sessions only, and only well-formed links" do
      StubGetFileClient.set_response(
        {:ok, 200, "application/json",
         Jason.encode!(%{
           "links" => [
             %{
               "session" => @bridged,
               "availability" => "available_local",
               "harness" => "claude-code",
               "url" => "https://evil.example/claude.ai/"
             },
             %{
               "session" => @codex,
               "availability" => "available_local",
               "harness" => "codex",
               "url" => "https://claude.ai/code/session_01OTHER",
               "extra" => "dropped"
             },
             %{
               "session" => @missing,
               "availability" => "available_local",
               "url" => @url
             }
           ]
         })}
      )

      body = links(%{"sessions" => "#{@bridged},#{@codex},#{@pi}", "host" => "hub-a"})

      assert [bridged, codex, pi] = body["links"]
      assert %{"session" => @bridged, "url" => nil} = bridged
      # Relayed entries carry exactly the route's fields.
      assert Map.keys(codex) |> Enum.sort() == ["availability", "harness", "session", "url"]
      # Asked for but not answered: no link, and said so.
      assert %{"session" => @pi, "availability" => "host_unreachable", "url" => nil} = pi
    end

    test "an unreachable remote answers every session host_unreachable, with no link" do
      StubGetFileClient.set_response({:error, :econnrefused})

      assert %{"host" => "hub-a", "links" => [a, b]} =
               links(%{"sessions" => "#{@bridged},#{@codex}", "host" => "hub-a"})

      for entry <- [a, b] do
        assert %{"availability" => "host_unreachable", "url" => nil} =
                 entry
      end
    end

    test "a host that is not in the fleet is unreachable, not local" do
      assert %{"links" => [%{"availability" => "host_unreachable", "url" => nil}]} =
               links(%{"sessions" => @bridged, "host" => "nowhere"})
    end
  end
end
