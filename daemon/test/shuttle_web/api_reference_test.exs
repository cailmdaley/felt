defmodule ShuttleWeb.ApiReferenceTest do
  # docs/reference/api.md names every route the router serves, so the
  # reference cannot fall behind the daemon.
  use ExUnit.Case, async: true

  @reference Path.expand("../../../docs/reference/api.md", __DIR__)

  test "docs/reference/api.md names every /api/v1 route" do
    doc = File.read!(@reference)

    missing =
      for %{verb: verb, path: "/api/v1" <> path} <- ShuttleWeb.Router.__routes__(),
          pattern = documented(verb, path),
          not Regex.match?(pattern, doc),
          do: "#{verb |> Atom.to_string() |> String.upcase()} #{path}"

    assert missing == [], "undocumented routes: #{Enum.join(missing, ", ")}"
  end

  # A route is named as `VERB /path` or as a backticked `/path`, with or
  # without the /api/v1 prefix; a `:param` or `*glob` segment matches any text.
  defp documented(verb, path) do
    path =
      path
      |> String.split("/")
      |> Enum.map_join("/", fn
        ":" <> _ -> "[^ `/]+"
        "*" <> _ -> "[^ `]+"
        segment -> Regex.escape(segment)
      end)

    verb = verb |> Atom.to_string() |> String.upcase()
    Regex.compile!("(#{verb} |`)(/api/v1)?#{path}(?![\\w/-])")
  end
end
