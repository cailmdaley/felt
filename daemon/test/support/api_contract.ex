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
  template, e.g. `"/fibers/{id}"`) promises for the request's method, status
  and content type. Returns decoded JSON or the raw text/bytes; a response
  without content must have an empty body.
  """
  def assert_contract(%Plug.Conn{} = conn, path) do
    method = String.downcase(conn.method)
    status = Integer.to_string(conn.status)

    response =
      get_in(@document, ["paths", path, method, "responses", status]) ||
        flunk(
          "the contract describes no #{status} response for #{conn.method} #{path}; got #{conn.resp_body}"
        )

    case response["content"] do
      nil ->
        assert conn.resp_body == "", "#{conn.method} #{path} #{status} must have no body"
        conn.resp_body

      content ->
        [content_type | _] = Plug.Conn.get_resp_header(conn, "content-type")
        media = content_type |> String.split(";") |> hd()

        schema =
          get_in(content, [media, "schema"]) || get_in(content, ["*/*", "schema"]) ||
            flunk(
              "the contract describes no #{media} response for #{conn.method} #{path} #{status}"
            )

        body =
          if media == "application/json", do: Jason.decode!(conn.resp_body), else: conn.resp_body

        errors = Shuttle.Test.JsonSchema.errors(schema, body, @document)

        assert errors == [],
               "#{conn.method} #{path} #{status} departs from the contract:\n#{Enum.join(errors, "\n")}"

        body
    end
  end
end
