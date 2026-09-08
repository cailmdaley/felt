defmodule Shuttle.RemoteRegistry.ClientTest do
  @moduledoc """
  Regression coverage for the real `:httpc`-backed client. The bug: `get/2`
  fetched without `body_format: :binary`, so httpc returned the body as a
  charlist of *bytes* and `List.to_string/1` re-UTF-8-encoded each byte —
  double-encoding every multibyte char (the cmbx "— analysis hub" mojibake on
  the composite board). ASCII (< 128) survived, so the corruption hid until a
  special character appeared. These tests round-trip a real multibyte body
  through a live Bandit server and assert byte-faithfulness.
  """
  use ExUnit.Case, async: false

  alias Shuttle.RemoteRegistry.Client.Default

  # Body with an em-dash (U+2014), multiplication sign (U+00D7), and an accented
  # vowel (U+00E9) — exactly the characters that mojibake'd in the field.
  @utf8_body ~s({"fibers":[{"name":"cmbx — analysis hub","note":"γ×κ Cramér"}]})

  defmodule EchoPlug do
    @moduledoc false
    @behaviour Plug

    @impl true
    def init(opts), do: opts

    @impl true
    def call(conn, body: body) do
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, body)
    end
  end

  setup do
    port = 4097

    {:ok, server} =
      Bandit.start_link(
        plug: {EchoPlug, body: @utf8_body},
        port: port,
        ip: {127, 0, 0, 1}
      )

    Process.sleep(100)
    on_exit(fn -> Process.exit(server, :normal) end)
    {:ok, url: "http://127.0.0.1:#{port}/api/v1/fibers"}
  end

  test "get/2 returns the response body byte-for-byte (no double-encoding)", %{url: url} do
    assert {:ok, body} = Default.get(url, 5_000)
    # Byte-identical to what the server sent: the em-dash stays \xe2\x80\x94,
    # not the double-encoded \xc3\xa2\xc2\x80\xc2\x94.
    assert body == @utf8_body
    assert String.contains?(body, "cmbx — analysis hub")
    refute String.contains?(body, "Ã¢")
    assert {:ok, %{"fibers" => [%{"name" => "cmbx — analysis hub"}]}} = Jason.decode(body)
  end
end
