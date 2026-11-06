defmodule ShuttleWeb.VoiceTranscriptControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Shuttle.Test.ForwardStub
  import Phoenix.ConnTest
  alias Shuttle.Test.{Env, StubGetFileClient}

  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir

  setup %{tmp_dir: root} do
    hark = Path.join(root, "hark")
    File.mkdir_p!(Path.join(hark, "voice"))
    Env.put_app_env(:hark_dir, hark)
    Env.put_app_env(:remotes, [])
    path = Path.join([hark, "voice", "voice-current_A.txt"])
    text = "# Listening\n12:00:00 mic  The actual spoken words.\n"
    File.write!(path, text)
    manifest = %{"phase" => "live", "launch" => "voice-current_A", "transcript" => path}
    write_manifest(hark, manifest)
    {:ok, hark: hark, path: path, text: text, manifest: manifest}
  end

  test "resolves the current transcript independently of the target origin and opens its bytes",
       c do
    conn =
      get(api_conn(), "/api/v1/voice/transcript?origin=worker-on-another-host&path=/etc/passwd")

    assert conn.status == 200
    assert Plug.Conn.get_resp_header(conn, "cache-control") == ["no-store"]

    assert %{"path" => path, "launch" => "voice-current_A", "recorder" => recorder} =
             Jason.decode!(conn.resp_body)

    assert path == c.path
    assert recorder == Shuttle.MeetingRouter.own_host()

    file = get(api_conn(), "/api/v1/file?" <> URI.encode_query(%{path: path, origin: recorder}))
    assert file.status == 200
    assert file.resp_body == c.text
    assert Plug.Conn.get_resp_header(file, "x-content-type-options") == ["nosniff"]
  end

  test "has no transcript before the file appears, and resolves each new launch", c do
    File.rm!(c.path)
    assert get(api_conn(), "/api/v1/voice/transcript").status == 404
    next = Path.join([c.hark, "voice", "voice-next.txt"])
    File.write!(next, "next capture")
    write_manifest(c.hark, %{c.manifest | "launch" => "voice-next", "transcript" => next})

    assert %{"path" => ^next, "launch" => "voice-next"} =
             get(api_conn(), "/api/v1/voice/transcript")
             |> Map.fetch!(:resp_body)
             |> Jason.decode!()
  end

  test "does not expose fixed meetings, ended captures, malformed state, or caller-selected files",
       c do
    outside = Path.join(c.hark, "secret.txt")
    File.write!(outside, "not a transcript")

    for invalid <- [
          %{c.manifest | "launch" => "meeting-fixed"},
          %{c.manifest | "phase" => "ended"},
          %{c.manifest | "transcript" => outside},
          %{c.manifest | "transcript" => "voice/voice-current.txt"},
          %{c.manifest | "launch" => "voice-../secret"},
          %{c.manifest | "launch" => nil},
          %{}
        ] do
      write_manifest(c.hark, invalid)

      assert get(api_conn(), "/api/v1/voice/transcript?path=" <> URI.encode_www_form(c.path)).status ==
               404
    end

    File.write!(Path.join(c.hark, "meeting.json"), "invalid json")
    assert get(api_conn(), "/api/v1/voice/transcript").status == 404
    File.rm!(Path.join(c.hark, "meeting.json"))
    assert get(api_conn(), "/api/v1/voice/transcript").status == 404
  end

  test "refuses a symlink or non-regular transcript and a symlinked voice directory", c do
    outside = Path.join(c.hark, "secret.txt")
    File.write!(outside, "not a transcript")
    File.rm!(c.path)
    File.ln_s!(outside, c.path)
    assert get(api_conn(), "/api/v1/voice/transcript").status == 404
    File.rm!(c.path)
    File.mkdir!(c.path)
    assert get(api_conn(), "/api/v1/voice/transcript").status == 404
    File.rmdir!(c.path)
    File.rmdir!(Path.dirname(c.path))
    elsewhere = Path.join(c.hark, "elsewhere")
    File.mkdir!(elsewhere)
    File.write!(Path.join(elsewhere, "voice-current_A.txt"), "outside voice directory")
    File.ln_s!(elsewhere, Path.dirname(c.path))
    assert get(api_conn(), "/api/v1/voice/transcript").status == 404
  end

  test "pins the recorder rather than the receiving worker and stamps the relay owner", c do
    stub_forward(
      "audio-host",
      "http://audio.invalid:4000",
      {:ok, 200, "application/json",
       Jason.encode!(%{
         path: "/remote/voice/voice-remote.txt",
         launch: "voice-remote",
         recorder: "wrong-owner"
       })}
    )

    conn = get(api_conn(), "/api/v1/voice/transcript?recorder=audio-host&origin=worker-host")
    assert conn.status == 200

    assert %{"path" => "/remote/voice/voice-remote.txt", "recorder" => "audio-host"} =
             Jason.decode!(conn.resp_body)

    assert %{url: "http://audio.invalid:4000/api/v1/voice/transcript"} = StubGetFileClient.last()
    refute conn.resp_body =~ c.path
  end

  test "unknown or unreachable recorders never fall back to the local transcript" do
    assert get(api_conn(), "/api/v1/voice/transcript?recorder=unknown-host").status == 400
    stub_forward("audio-host", "http://audio.invalid:4000", {:error, :timeout})
    assert get(api_conn(), "/api/v1/voice/transcript?recorder=audio-host").status == 502

    for {status, body, expected} <- [
          {404, ~s({"error":"not ready"}), 404},
          {200, "[]", 502},
          {200, "not json", 502}
        ] do
      StubGetFileClient.set_response({:ok, status, "application/json", body})
      assert get(api_conn(), "/api/v1/voice/transcript?recorder=audio-host").status == expected
    end
  end

  defp write_manifest(hark, manifest),
    do: File.write!(Path.join(hark, "meeting.json"), Jason.encode!(manifest))
end
