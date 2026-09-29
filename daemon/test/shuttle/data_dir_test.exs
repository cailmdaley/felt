defmodule Shuttle.DataDirTest do
  # Mutates SHUTTLE_DATA_DIR, which every host-local path reads.
  use ExUnit.Case, async: false

  @fixture Path.expand("../fixtures/data_dir/cases.json", __DIR__)

  # The cases the Go CLI's `shuttle.DataDir` is also held to, so a ~-prefixed
  # or padded SHUTTLE_DATA_DIR names one directory for every file either side
  # keeps.
  test "Shuttle.data_dir/0 resolves every shared fixture case" do
    %{"cases" => cases} = @fixture |> File.read!() |> Jason.decode!()
    assert cases != []

    previous = System.get_env("SHUTTLE_DATA_DIR")
    home = System.user_home!()

    try do
      for %{"name" => name, "env" => env, "expect" => expect} <- cases do
        if env,
          do: System.put_env("SHUTTLE_DATA_DIR", env),
          else: System.delete_env("SHUTTLE_DATA_DIR")

        want =
          case expect do
            "~" -> home
            "~/" <> rest -> home <> "/" <> rest
            literal -> literal
          end

        assert {name, Shuttle.data_dir()} == {name, want}
      end
    after
      if previous,
        do: System.put_env("SHUTTLE_DATA_DIR", previous),
        else: System.delete_env("SHUTTLE_DATA_DIR")
    end
  end

  # The per-file overrides the Go CLI's `shuttleStatePath` is also held to, so
  # the hook that writes events.jsonl (or a ledger) and the daemon that reads
  # it name the same file.
  test "Shuttle.state_path/2 resolves every shared override case" do
    %{"state_files" => %{"data_dir" => data_dir, "files" => files, "cases" => cases}} =
      @fixture |> File.read!() |> Jason.decode!()

    assert files != [] and cases != []
    vars = ["SHUTTLE_DATA_DIR" | Enum.map(files, & &1["env_var"])]
    previous = Map.new(vars, &{&1, System.get_env(&1)})

    try do
      System.put_env("SHUTTLE_DATA_DIR", data_dir)

      for %{"env_var" => var, "leaf" => leaf} <- files,
          %{"name" => name, "env" => env, "expect" => expect} <- cases do
        if env, do: System.put_env(var, env), else: System.delete_env(var)

        want =
          expect
          |> String.replace("<data_dir>", data_dir)
          |> String.replace("<leaf>", leaf)

        assert {var, name, Shuttle.state_path(var, leaf)} == {var, name, want}
      end
    after
      Enum.each(previous, fn
        {var, nil} -> System.delete_env(var)
        {var, value} -> System.put_env(var, value)
      end)
    end
  end
end
