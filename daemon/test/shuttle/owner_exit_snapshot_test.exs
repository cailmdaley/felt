defmodule Shuttle.OwnerExitSnapshotTest do
  use ExUnit.Case, async: false

  alias Shuttle.OwnerExit
  alias Shuttle.Test.Env

  test "composite reconciliation takes one policy snapshot, not one per row" do
    Env.put_app_env(:remotes, [%Shuttle.Remote{name: "worker", url: "http://127.0.0.1:1"}])
    Code.ensure_loaded!(OwnerExit)
    function = {OwnerExit, :policy, 0}
    on_exit(fn -> :erlang.trace_pattern(function, false, [:call_count]) end)
    :erlang.trace_pattern(function, true, [:call_count])

    rows =
      for n <- 1..64 do
        uid = n |> Integer.to_string(16) |> String.upcase() |> String.pad_leading(26, "0")

        %{
          "origin" => "worker",
          "fiber" => %{
            "id" => uid,
            "uid" => uid,
            "status" => "open",
            "shuttle" => %{"host" => "worker", "kind" => "oneshot"}
          }
        }
      end

    assert length(OwnerExit.reconcile(rows, rows, %{}, "hub")) == 64
    assert :erlang.trace_info(function, :call_count) == {:call_count, 1}
  end
end
