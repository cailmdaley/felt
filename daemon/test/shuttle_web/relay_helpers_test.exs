defmodule ShuttleWeb.RelayHelpersTest do
  use ExUnit.Case, async: true

  test "gives actionable ChatGPT connection guidance without exposing daemon internals" do
    message = ShuttleWeb.RelayHelpers.app_server_unavailable_message()

    assert message ==
             "The ChatGPT connection on this host is unavailable. " <>
               "Open or reconnect this host in ChatGPT, then try again."

    refute message =~ "App Server"
    refute message =~ "remote host"
    refute message =~ "CLI"
  end
end
