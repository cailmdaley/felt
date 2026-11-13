defmodule Shuttle.LifecycleModelTest do
  @moduledoc """
  The daemon's half of the lifecycle model (`ui/harness/lifecycleModel.ts`):
  over every state the model distinguishes, the column the daemon serves and
  the action a board `/transition` request resolves to are the model's. The
  Shuttle CLI holds the document writes to the same table
  (`internal/shuttlecli/lifecycle_model_test.go`) and the board its offers.
  """
  use ExUnit.Case, async: true

  alias Shuttle.{Actions, Lifecycle}

  @table "test/fixtures/lifecycle/model.json" |> File.read!() |> Jason.decode!()
  @today ~D[2026-11-09]

  defp live?(%{"worker" => worker}), do: worker != "none"

  test "the daemon serves the model's column for every state" do
    for {key, state} <- @table["states"] do
      assert {key, Lifecycle.column(state["fiber"], live?(state), @today)} ==
               {key, state["column"]}
    end
  end

  # `Shuttle.Actions` invocation → the Shuttle write the model names; a
  # dispatch writes nothing itself.
  defp write(%{verb: "dispatch"}), do: nil
  defp write(%{verb: "close", tempered: tempered}), do: ["close", "--tempered=#{tempered}"]
  defp write(%{verb: "close", review: note}), do: ["close", "--review=#{note}"]
  defp write(%{verb: "reopen", as_draft: true}), do: ["reopen", "--as-draft"]
  defp write(%{verb: verb}), do: [verb]

  test "a board transition resolves to the model's write, or is refused where the model refuses it" do
    for {key, answers} <- @table["answers"],
        {"transition:" <> target, [outcome, next | cli]} <- answers do
      state = @table["states"][key]
      got = Actions.resolve_transition(state["fiber"], target, live?(state))

      want =
        case outcome do
          "refused" -> {:error, :standing_unreviewed}
          "ok" -> {:ok, List.first(cli)}
        end

      got =
        case got do
          {:ok, %{invocation: invocation}} -> {:ok, write(invocation)}
          other -> other
        end

      assert {key, target, got} == {key, target, want}

      # A launch is the one transition the daemon carries out without a write.
      if outcome == "ok" and cli == [] do
        assert {key, target, @table["states"][next]["worker"]} == {key, target, "live"}
      end
    end
  end
end
