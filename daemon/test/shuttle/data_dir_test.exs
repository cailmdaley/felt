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
end
