defmodule Shuttle.HarnessesTest do
  use ExUnit.Case, async: true

  alias Shuttle.Harnesses

  test "address spellings match the shared Go and Elixir fixture" do
    fixture =
      Path.expand("../fixtures/harness_names.json", __DIR__)
      |> File.read!()
      |> Jason.decode!()

    assert Harnesses.address_names() == fixture["names"]

    for {spelling, canonical} <- fixture["names"] do
      assert Harnesses.normalize(spelling) == canonical
      assert Harnesses.supported?(spelling)
    end
  end

  test "ledger writes retain the legacy spelling through the shared mapping" do
    assert Harnesses.ledger_name("claude") == "claude-code"
    assert Harnesses.ledger_name("codex") == "codex"
    assert Harnesses.ledger_name("pi") == "pi"
    assert Harnesses.ledger_name("unknown") == nil
  end
end
