defmodule Shuttle.LogLevelTest do
  @moduledoc """
  `SHUTTLE_LOG_LEVEL`: `Shuttle.Application.configure_log_level/1` applies a
  valid level, ignores an unset or blank one, and keeps the configured level
  with a warning on anything else.
  """
  # sync: Logger.configure/1 sets the VM-wide log level.
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  setup do
    level = Logger.level()
    on_exit(fn -> Logger.configure(level: level) end)
    Logger.configure(level: :info)
  end

  test "a valid level is applied, whatever its case or padding" do
    Shuttle.Application.configure_log_level(" Debug ")
    assert Logger.level() == :debug
    Shuttle.Application.configure_log_level("warning")
    assert Logger.level() == :warning
  end

  test "unset or blank leaves the level alone" do
    Shuttle.Application.configure_log_level(nil)
    Shuttle.Application.configure_log_level("")
    assert Logger.level() == :info
  end

  test "an unknown value warns and keeps the level" do
    log = capture_log(fn -> Shuttle.Application.configure_log_level("verbose") end)
    assert log =~ ~s(SHUTTLE_LOG_LEVEL="verbose" is not a log level)
    assert Logger.level() == :info
  end
end
