defmodule Shuttle.Test.ApiContract do
  @moduledoc """
  Checks a controller response against the stable API contract
  (`contract/shuttle-api.json`).
  """

  import ExUnit.Assertions

  @document Shuttle.ApiContract.json() |> Jason.decode!()

  def document, do: @document

  @doc """
  Asserts the sent `conn` answers as the contract's `path` (its OpenAPI
  template, e.g. `"/fibers/{id}"`) promises for the request's method and the
  response's status, and returns the decoded body.
  """
  def assert_contract(%Plug.Conn{} = conn, path) do
    method = String.downcase(conn.method)
    status = Integer.to_string(conn.status)
    body = Jason.decode!(conn.resp_body)

    schema =
      get_in(@document, ["paths", path, method, "responses", status, "content", "application/json", "schema"]) ||
        flunk("the contract describes no #{status} JSON response for #{conn.method} #{path}; got #{conn.resp_body}")

    assert Shuttle.Test.JsonSchema.errors(schema, body, @document) == [],
           "#{conn.method} #{path} #{status} departs from the contract"

    body
  end
end
