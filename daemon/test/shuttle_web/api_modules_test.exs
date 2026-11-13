defmodule ShuttleWeb.ApiModulesTest do
  # The contract's `x-modules` classes every route the daemon serves, so a
  # route cannot be added without deciding which module it belongs to.
  use ExUnit.Case, async: true

  @document Shuttle.ApiContract.json() |> Jason.decode!()

  test "every /api/v1 route belongs to exactly one module" do
    served =
      for %{verb: verb, path: "/api/v1" <> path} <- ShuttleWeb.Router.__routes__(),
          do:
            "#{verb |> Atom.to_string() |> String.upcase()} #{String.replace(path, ~r/[:*](\w+)/, "{\\1}")}"

    core =
      for {path, operations} <- @document["paths"],
          {method, _} <- operations,
          do: "#{String.upcase(method)} #{path}"

    classed =
      core ++
        Enum.flat_map(@document["x-modules"], fn {_name, module} -> module["routes"] || [] end)

    assert classed -- Enum.uniq(classed) == [], "routes classed twice"
    assert Enum.sort(served -- classed) == [], "routes no module claims"
    assert Enum.sort(classed -- served) == [], "classed routes the daemon does not serve"
  end

  test "an extension names the software it needs" do
    for {name, %{"extension" => true} = module} <- @document["x-modules"] do
      assert is_binary(module["requires"]), "#{name} names no requirement"
    end
  end
end
