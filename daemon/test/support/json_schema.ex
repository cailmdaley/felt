defmodule Shuttle.Test.JsonSchema do
  @moduledoc """
  Validates a decoded JSON value against the JSON Schema subset the API
  contract uses. A keyword outside the subset raises, so a schema cannot
  state a constraint this validator silently skips.
  """

  @annotations ~w(description title example examples default format deprecated)

  @doc "Every violation of `schema` by `value`, as `path: reason` strings; `[]` when it conforms."
  @spec errors(map(), term(), map()) :: [String.t()]
  def errors(schema, value, document), do: check(schema, value, document, "$")

  defp check(schema, value, doc, at) when is_map(schema) do
    Enum.flat_map(schema, fn {keyword, arg} -> keyword(keyword, arg, schema, value, doc, at) end)
  end

  defp keyword("$ref", "#/" <> pointer, _schema, value, doc, at) do
    check(get_in(doc, String.split(pointer, "/")) || raise("unresolved $ref #{pointer}"), value, doc, at)
  end

  defp keyword("type", types, _schema, value, _doc, at) do
    if Enum.any?(List.wrap(types), &type?(&1, value)),
      do: [],
      else: ["#{at}: expected #{Enum.join(List.wrap(types), " or ")}, got #{inspect(value, limit: 5)}"]
  end

  defp keyword("enum", allowed, _schema, value, _doc, at),
    do: if(value in allowed, do: [], else: ["#{at}: #{inspect(value)} is not one of #{inspect(allowed)}"])

  defp keyword("const", expected, _schema, value, _doc, at),
    do: if(value == expected, do: [], else: ["#{at}: expected #{inspect(expected)}, got #{inspect(value)}"])

  defp keyword("required", names, _schema, value, _doc, at) when is_map(value),
    do: for(name <- names, not Map.has_key?(value, name), do: "#{at}: missing #{name}")

  defp keyword("properties", properties, _schema, value, doc, at) when is_map(value) do
    for {name, schema} <- properties, Map.has_key?(value, name),
        error <- check(schema, value[name], doc, "#{at}.#{name}"),
        do: error
  end

  defp keyword("additionalProperties", extra, schema, value, doc, at) when is_map(value) do
    named = Map.keys(Map.get(schema, "properties", %{}))

    for {name, item} <- value, name not in named,
        error <- extra(extra, item, doc, "#{at}.#{name}"),
        do: error
  end

  defp keyword("items", schema, _schema, value, doc, at) when is_list(value) do
    for {item, index} <- Enum.with_index(value),
        error <- check(schema, item, doc, "#{at}[#{index}]"),
        do: error
  end

  defp keyword(any, schemas, _schema, value, doc, at) when any in ~w(anyOf oneOf) do
    if Enum.any?(schemas, &(check(&1, value, doc, at) == [])),
      do: [],
      else: ["#{at}: matches none of the #{any} alternatives, got #{inspect(value, limit: 5)}"]
  end

  defp keyword("allOf", schemas, _schema, value, doc, at),
    do: Enum.flat_map(schemas, &check(&1, value, doc, at))

  defp keyword(keyword, _arg, _schema, _value, _doc, _at)
       when keyword in ~w(required properties additionalProperties items) or keyword in @annotations,
       do: []

  defp keyword(keyword, _arg, _schema, _value, _doc, at),
    do: raise(ArgumentError, "#{at}: schema keyword #{inspect(keyword)} is outside the validated subset")

  defp extra(false, _item, _doc, at), do: ["#{at}: unexpected property"]
  defp extra(true, _item, _doc, _at), do: []
  defp extra(schema, item, doc, at), do: check(schema, item, doc, at)

  defp type?("object", value), do: is_map(value)
  defp type?("array", value), do: is_list(value)
  defp type?("string", value), do: is_binary(value)
  defp type?("integer", value), do: is_integer(value)
  defp type?("number", value), do: is_number(value)
  defp type?("boolean", value), do: is_boolean(value)
  defp type?("null", value), do: is_nil(value)
end
