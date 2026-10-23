defmodule ShuttleWeb.RelayHelpersTest do
  use ExUnit.Case, async: true

  test "names the managed socket and its recovery without suggesting an embedded fallback" do
    message = ShuttleWeb.RelayHelpers.app_server_unavailable_message()

    assert message =~ "selected Codex App Server on this host is unavailable"
    assert message =~ "Shuttle reconciles the dependency without replacing live servers"
    assert message =~ "codex_backend in /api/v1/version"
    assert message =~ "Restore the recorded endpoint"
    assert message =~ "Both Codex surfaces wait"
    assert message =~ "no embedded fallback is used"
    refute message =~ "codex app-server daemon start"
    refute message =~ "ChatGPT"
  end
end
