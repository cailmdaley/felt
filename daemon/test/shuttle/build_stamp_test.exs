defmodule Shuttle.BuildStampTest do
  @moduledoc """
  `Shuttle.BuildStamp` — the daemon's build identity and runtime boot receipt.

  Its contract is narrower than it looks and is the whole reason it exists as a
  module: every field is a STRING, `"unknown"` where a source is absent, so the
  two consumers (`GET /api/v1/version` and the poll snapshot) never have to tell
  a missing field from a null one. A checkout that has not run
  `mix shuttle.gen_version` must still boot and report that, rather than failing
  to compile the endpoint that would have told you so.
  """
  use ExUnit.Case, async: true

  alias Shuttle.BuildStamp

  test "the stamp includes build identity and boot release path" do
    stamp = BuildStamp.stamp()

    assert Enum.sort(Map.keys(stamp)) == [
             :booted_at,
             :built_at,
             :git_sha,
             :git_short_sha,
             :mix_vsn,
             :release_path
           ]

    for {key, value} <- stamp do
      assert is_binary(value), "#{key} was #{inspect(value)}, not a string"
      assert value != ""
    end
  end

  test "Mix has no boot release path" do
    assert BuildStamp.release_path() == "unknown"
  end

  test "the short sha is the first seven characters of the long one" do
    stamp = BuildStamp.stamp()
    assert stamp.git_short_sha == String.slice(stamp.git_sha, 0, 7)
  end

  test "short_sha/1 degrades to \"unknown\" rather than raising on a non-sha" do
    assert BuildStamp.short_sha("7ebb14e1e20ebf3b20398817cb8a76e43151e33b") == "7ebb14e"
    assert BuildStamp.short_sha(nil) == "unknown"
    assert BuildStamp.short_sha(:missing) == "unknown"
  end

  test "an unstamped boot reports \"unknown\", not nil and not a crash" do
    # `booted_at` is a RUNTIME fact stamped by `Shuttle.Application.start/2`,
    # deliberately not a compile-time one — so "nobody stamped it" is a state
    # this has to survive, and it is the field a deploy verifier reads.
    Shuttle.Test.Env.delete_app_env(:booted_at)

    assert BuildStamp.booted_at() == "unknown"
    assert BuildStamp.stamp().booted_at == "unknown"
  end

  test "a stamped boot is rendered ISO8601" do
    {:ok, dt, 0} = DateTime.from_iso8601("2026-09-16T09:00:00Z")
    Shuttle.Test.Env.put_app_env(:booted_at, dt)

    assert BuildStamp.booted_at() == "2026-09-16T09:00:00Z"
  end
end
