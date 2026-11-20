defmodule Shuttle.Test.HarnessFacts do
  @moduledoc """
  The harness facts the real CLI carries on a resolved agent record
  (`resolved.agent.harness`), read from the shared conformance table, for test
  fixtures that build resolved records by hand.
  """

  @facts Path.expand("../fixtures/harnesses/facts.json", __DIR__)
         |> File.read!()
         |> Jason.decode!()
         |> Map.new(&{&1["name"], &1})

  @doc "The facts of the harness named `cli`, or nil."
  def facts(cli), do: @facts[cli]

  @doc "A string-keyed resolved agent record with its harness's facts."
  def resolved(%{"cli" => cli} = record), do: Map.put(record, "harness", facts(cli))
end
