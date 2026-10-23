defmodule ShuttleWeb.RelayHelpersTest do
  use ExUnit.Case, async: true

  test "names the managed socket and its recovery without suggesting an embedded fallback" do
    message = ShuttleWeb.RelayHelpers.app_server_unavailable_message()

    assert message =~ "Codex App Server socket"
    assert message =~ "codex app-server daemon start"
    assert message =~ "SHUTTLE_CODEX_SOCKET"
    assert message =~ "Both Codex surfaces require it"
    refute message =~ "ChatGPT"
  end
end
