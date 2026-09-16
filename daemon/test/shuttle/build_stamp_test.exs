defmodule Shuttle.BuildStampTest do
  @moduledoc """
  `Shuttle.BuildStamp` — what this daemon is, as four fields plus a version.

  Its contract is narrower than it looks and is the whole reason it exists as a
  module: every field is a STRING, `"unknown"` where a source is absent, so the
  two consumers (`GET /api/v1/version` and the poll snapshot) never have to tell
  a missing field from a null one. A checkout that has not run
  `mix shuttle.gen_version` must still boot and report that, rather than failing
  to compile the endpoint that would have told you so.
  """
  use ExUnit.Case, async: false
  import Shuttle.Test.EnvHelpers

  alias Shuttle.BuildStamp

  test "the stamp is five string-valued fields, whatever the build did or did not stamp" do
    stamp = BuildStamp.stamp()

    assert Enum.sort(Map.keys(stamp)) == [
             :booted_at,
             :built_at,
             :git_sha,
             :git_short_sha,
             :mix_vsn
           ]

    for {key, value} <- stamp do
      assert is_binary(value), "#{key} was #{inspect(value)}, not a string"
      assert value != ""
    end
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
    previous = Application.get_env(:shuttle, :booted_at)
    Application.delete_env(:shuttle, :booted_at)
    on_exit(fn -> restore_app_env(:booted_at, previous) end)

    assert BuildStamp.booted_at() == "unknown"
    assert BuildStamp.stamp().booted_at == "unknown"
  end

  test "a stamped boot is rendered ISO8601" do
    previous = Application.get_env(:shuttle, :booted_at)
    {:ok, dt, 0} = DateTime.from_iso8601("2026-09-16T09:00:00Z")
    Application.put_env(:shuttle, :booted_at, dt)
    on_exit(fn -> restore_app_env(:booted_at, previous) end)

    assert BuildStamp.booted_at() == "2026-09-16T09:00:00Z"
  end
end
