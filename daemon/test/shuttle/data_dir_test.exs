defmodule Shuttle.DataDirTest do
  use ExUnit.Case, async: true

  @fixture Path.expand("../fixtures/data_dir/cases.json", __DIR__)

  # The cases the Go CLI's `shuttle.DataDir` is also held to, so a ~-prefixed
  # or padded SHUTTLE_DATA_DIR names one directory for every file either side
  # keeps.
  test "Shuttle.data_dir/0 resolves every shared fixture case" do
    %{"cases" => cases} = @fixture |> File.read!() |> Jason.decode!()
    assert cases != []

    home = System.user_home!()

    for %{"name" => name, "env" => env, "expect" => expect} <- cases do
      Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", env)

      want =
        case expect do
          "~" -> home
          "~/" <> rest -> home <> "/" <> rest
          literal -> literal
        end

      assert {name, Shuttle.data_dir()} == {name, want}
    end
  end

  # The per-file overrides the Go CLI's `shuttleStatePath` is also held to, so
  # the hook that writes events.jsonl (or a ledger) and the daemon that reads
  # it name the same file.
  test "Shuttle.state_path/2 resolves every shared override case" do
    %{"state_files" => %{"data_dir" => data_dir, "files" => files, "cases" => cases}} =
      @fixture |> File.read!() |> Jason.decode!()

    assert files != [] and cases != []
    Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", data_dir)

    for %{"env_var" => var, "leaf" => leaf} <- files,
        %{"name" => name, "env" => env, "expect" => expect} <- cases do
      Shuttle.Test.Env.put_env(var, env)

      want =
        expect
        |> String.replace("<data_dir>", data_dir)
        |> String.replace("<leaf>", leaf)

      assert {var, name, Shuttle.state_path(var, leaf)} == {var, name, want}
    end
  end
end
