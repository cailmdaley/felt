defmodule Shuttle.HostPeerUidTest do
  use ExUnit.Case, async: true

  alias Shuttle.Host

  test "parse_uid accepts a decimal with surrounding whitespace and nothing else" do
    assert Host.parse_uid("1168\n") == {:ok, 1168}
    assert Host.parse_uid(" 0 ") == {:ok, 0}
    assert Host.parse_uid("-1") == :error
    assert Host.parse_uid("12a") == :error
    assert Host.parse_uid("") == :error
  end

  test "the peer uid is `id -u` by default and SHUTTLE_PEER_UID when set" do
    Shuttle.Test.Env.delete_env("SHUTTLE_PEER_UID")
    {out, 0} = System.cmd("id", ["-u"])
    expected_uid = String.to_integer(String.trim(out))
    assert Host.expected_peer_uid_config!() == {expected_uid, :euid}

    Shuttle.Test.Env.put_env("SHUTTLE_PEER_UID", "424242")
    assert Host.expected_peer_uid_config!() == {424_242, :env}

    Shuttle.Test.Env.put_env("SHUTTLE_PEER_UID", "root")

    assert_raise ArgumentError, ~r/SHUTTLE_PEER_UID must be a non-negative integer/, fn ->
      Host.expected_peer_uid_config!()
    end
  end
end
