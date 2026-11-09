defmodule ShuttleWeb.VoiceTranscriptControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Shuttle.Test.ForwardStub
  import Phoenix.ConnTest
  alias Shuttle.Test.{Env, StubGetFileClient}
  alias Shuttle.Voice.Transcript
  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir

  setup %{tmp_dir: root} do
    Env.put_env("SHUTTLE_DATA_DIR", root)
    Env.put_app_env(:remotes, [])
    Env.put_app_env(:voice_fibers, fn -> [%{"uid" => "uid-a", "slug" => "project/card-a"}] end)
    Env.put_env("SHUTTLE_VOICE_FILE", Path.join(root, "voice.json"))
    Env.put_app_env(:hark_dir, Path.join(root, "hark"))

    # This host is a recorder, so unaddressed reads stay here.
    Env.start_scoped!(
      {Shuttle.Voice,
       name: Module.concat(__MODULE__, "S#{System.unique_integer([:positive])}"),
       poll_ms: 60_000,
       reconcile: fn _enabled, _opts -> {:ok, %{available: true, capture: nil}} end,
       relay: fn _, _ -> :ok end,
       monitor: fn _ -> %{pending: nil, last: nil} end}
    )

    {:ok, _} = Shuttle.Voice.update(%{})
    :ok
  end

  test "day transcript returns JSON rows, persists through recorder stops and filters date, fiber and local time" do
    rows = [
      row("2026-11-06T10:00:00Z", nil, "unrouted"),
      row("2026-11-06T10:01:00Z", "uid-a", "first routed"),
      row("2026-11-06T10:02:00Z", "project/card-b", "other card"),
      row("2026-11-06T10:03:00Z", "uid-a", "later words")
    ]

    assert :ok = Transcript.append(rows)
    # Relay checkpoint replay doesn't append duplicate utterances.
    assert :ok = Transcript.append(rows)
    path = Path.join(Transcript.directory(), "2026-11-06.jsonl")

    assert rows ==
             path |> File.read!() |> String.split("\n", trim: true) |> Enum.map(&Jason.decode!/1)

    conn = api_conn() |> get("/api/v1/voice/transcript?date=2026-11-06&origin=unrelated-owner")
    assert Plug.Conn.get_resp_header(conn, "cache-control") == ["no-store"]
    assert %{"date" => "2026-11-06", "rows" => ^rows, "recorder" => _} = json_response(conn, 200)

    for fiber <- ["uid-a", "card-a", "project/card-a"] do
      query =
        URI.encode_query(%{
          date: "2026-11-06",
          fiber: fiber,
          since: Transcript.local_time("2026-11-06T10:02:00Z")
        })

      assert %{"rows" => [%{"text" => "later words"}]} =
               api_conn() |> get("/api/v1/voice/transcript?" <> query) |> json_response(200)
    end

    assert %{"rows" => [%{"text" => "other card"}]} =
             api_conn()
             |> get("/api/v1/voice/transcript?date=2026-11-06&fiber=card-b")
             |> json_response(200)

    assert {:ok, %{rows: [%{"text" => "other card"}, %{"text" => "later words"}]}} =
             Transcript.read(%{
               "date" => "2026-11-06",
               "since" => String.slice(Transcript.local_time("2026-11-06T10:02:00Z"), 0, 5)
             })

    assert %{"rows" => [], "date" => "2026-11-05"} =
             api_conn() |> get("/api/v1/voice/transcript?date=2026-11-05") |> json_response(200)

    assert %{"rows" => [], "date" => today} =
             api_conn() |> get("/api/v1/voice/transcript") |> json_response(200)

    assert today == Transcript.today()
  end

  test "invalid filters return 422 rather than selecting a caller's file" do
    for query <- ["date=../secret", "date=2026-13-40", "since=25:00", "since=noon"] do
      assert %{"error" => _} =
               api_conn() |> get("/api/v1/voice/transcript?" <> query) |> json_response(422)
    end
  end

  test "recorder routing forwards every transcript filter and ignores the worker origin" do
    stub_forward(
      "audio-host",
      "http://audio.invalid:4000",
      {:ok, 200, "application/json",
       Jason.encode!(%{date: "2026-11-06", rows: [], recorder: "wrong-owner"})}
    )

    conn =
      api_conn()
      |> get(
        "/api/v1/voice/transcript?recorder=audio-host&origin=worker-host&date=2026-11-06&fiber=card-a&since=10:03"
      )

    assert %{"rows" => [], "recorder" => "audio-host"} = json_response(conn, 200)
    %{url: url} = StubGetFileClient.last()
    uri = URI.parse(url)
    assert uri.path == "/api/v1/voice/transcript"

    assert URI.decode_query(uri.query) == %{
             "recorder" => "audio-host",
             "date" => "2026-11-06",
             "fiber" => "card-a",
             "since" => "10:03"
           }

    assert api_conn() |> get("/api/v1/voice/transcript?recorder=unknown-host") |> Map.get(:status) ==
             400

    StubGetFileClient.set_response({:error, :timeout})

    assert api_conn() |> get("/api/v1/voice/transcript?recorder=audio-host") |> Map.get(:status) ==
             502
  end

  defp row(t, fiber, text),
    do: %{
      "t" => t,
      "speaker" => "me",
      "text" => text,
      "fiber_id" => fiber,
      "origin" => if(fiber, do: "owner"),
      "name" => if(fiber, do: "Card"),
      "launch" => "voice-test"
    }
end
