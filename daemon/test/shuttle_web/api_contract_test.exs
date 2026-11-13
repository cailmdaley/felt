defmodule ShuttleWeb.ApiContractTest do
  # The stable tier of the API (contract/shuttle-api.json) against the daemon:
  # every route it names exists, and each controller answers in the shape it
  # promises.
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Shuttle.Test.ApiContract
  import Phoenix.ConnTest
  @endpoint ShuttleWeb.Endpoint

  test "every operation in the contract is a route the daemon serves" do
    served =
      for %{verb: verb, path: "/api/v1" <> path} <- ShuttleWeb.Router.__routes__(),
          do: {Atom.to_string(verb), String.replace(path, ~r/[:*](\w+)/, "{\\1}")}

    missing =
      for {path, operations} <- document()["paths"],
          {method, _} <- operations,
          {method, path} not in served,
          do: "#{String.upcase(method)} #{path}"

    assert missing == []
  end

  test "the daemon serves the contract it was built with" do
    served = get(api_conn(), "/api/v1/contract") |> assert_contract("/contract")
    assert served == document()
  end

  test "version reports the contract's level" do
    assert %{"api_level" => 1} = get(api_conn(), "/api/v1/version") |> json_response(200)
    assert Shuttle.ApiContract.level() == String.to_integer(document()["info"]["version"])
  end
end
