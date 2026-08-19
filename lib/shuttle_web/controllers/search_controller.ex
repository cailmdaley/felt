defmodule ShuttleWeb.SearchController do
  @moduledoc """
  Agent-API endpoint: `GET /api/v1/search?q=<query>&limit=<n>`

  The Chronicle's search bar. The board already holds every card's NAME and id
  client-side, so those match without a round trip; what it does not hold — and
  cannot, at the size of the record — is the BODY of every constitution. That is
  what this endpoint is for.

  One `felt ls` per configured store does the whole job: felt's own query
  already searches name, outcome, additional YAML field text and the fiber id,
  and `--body` extends it to the markdown body. `-s all` reaches closed and
  tempered work (the chronicle's whole point is the record, not the in-flight
  slice), and `--has-field shuttle` constrains the population to fibers carrying
  a `shuttle:` block — the same admission the kanban's primary walk uses
  (`Shuttle.FiberDocuments.kanban_walks/0`), so a hit is always something the
  board could in principle draw a lifeline for.

  The body itself never crosses the wire. Sending it would mean shipping a few
  hundred KB per keystroke-debounce; instead each hit carries an `excerpt` — the
  matched text with a little of its surroundings — and `where`, the fields the
  query was found in, so the UI can say why a row is in the list.

  LOCAL STORES ONLY. There is no owner-routing and no remote fan-out: a remote
  daemon's constitutions are not searched here. The chronicle's rows come from
  the composite feed, which is cross-host, so a remote-owned fiber can be found
  by name client-side but not by body. Widening this to the tunnel is a
  deliberate follow-up, not an oversight.

  A store whose `felt` call fails does not fail the request: its error is
  collected into `errors` and the other stores' hits are still served, because a
  search that returns most of the record beats one that returns none of it.
  """

  use Phoenix.Controller, formats: [:json]

  require Logger

  alias Shuttle.{Felt, FeltStores}

  @default_limit 25
  @max_limit 100
  # How much of the surrounding line an excerpt carries on either side of the
  # match. Wide enough to read as a sentence, short enough that 25 of them are
  # a small response.
  @excerpt_pad 70

  def show(conn, params) do
    query = params |> Map.get("q", "") |> to_string() |> String.trim()
    limit = parse_limit(params["limit"])

    if query == "" do
      json(conn, %{query: "", results: [], errors: []})
    else
      {results, errors} = search(query, limit)
      json(conn, %{query: query, results: results, errors: errors})
    end
  end

  defp search(query, limit) do
    stores = FeltStores.configured_hosts()

    {rows, errors} =
      Enum.reduce(stores, {[], []}, fn store, {rows, errors} ->
        case search_store(store, query) do
          {:ok, found} -> {rows ++ found, errors}
          {:error, message} -> {rows, errors ++ [%{felt_store: store, error: message}]}
        end
      end)

    {rows |> dedupe() |> Enum.sort_by(&{&1.rank, &1.name}) |> Enum.take(limit), errors}
  end

  defp search_store(store, query) do
    args = ["-C", store, "ls", query, "--body", "--has-field", "shuttle", "-s", "all", "-j"]

    case Felt.run(args) do
      {:ok, output} ->
        case Jason.decode(output) do
          {:ok, rows} when is_list(rows) -> {:ok, Enum.map(rows, &hit(&1, query))}
          {:ok, _} -> {:error, "felt ls returned non-list JSON"}
          {:error, error} -> {:error, Exception.message(error)}
        end

      {:command_error, status, output} ->
        Logger.warning("GET /api/v1/search: felt ls in #{store} exited #{status}")
        {:error, String.trim(output)}

      {:error, message} ->
        {:error, message}
    end
  end

  # One felt row → one wire hit. `where` is recomputed here rather than trusted
  # from felt (which reports only that the row matched, not which field did),
  # and it is what lets the UI rank a name match above a body mention.
  defp hit(fiber, query) do
    id = string(fiber["id"])
    name = string(fiber["name"])
    outcome = string(fiber["outcome"])
    body = string(fiber["body"])
    needle = String.downcase(query)

    where =
      [{"name", name}, {"id", id}, {"outcome", outcome}, {"body", body}]
      |> Enum.filter(fn {_field, text} -> String.contains?(String.downcase(text), needle) end)
      |> Enum.map(fn {field, _text} -> field end)

    %{
      id: id,
      uid: string(fiber["uid"]),
      name: name,
      status: string(fiber["status"]),
      created_at: string(fiber["created_at"]),
      closed_at: string(fiber["closed_at"]),
      tempered: fiber["tempered"],
      where: where,
      excerpt: excerpt(body, needle) || excerpt(outcome, needle),
      rank: rank(where, name, id, needle)
    }
  end

  # The ordering the UI shows results in, decided here so both halves of the
  # merged list (client-side name matches, these) can be ranked by one scale.
  # See ui/src/board/views/chronicleSearch.ts, which mirrors it.
  defp rank(where, name, id, needle) do
    down_name = String.downcase(name)

    cond do
      down_name == needle or String.downcase(id) == needle -> 0
      String.starts_with?(down_name, needle) -> 1
      "name" in where -> 2
      "id" in where -> 3
      "outcome" in where -> 4
      true -> 5
    end
  end

  # The matched text with a little of its surroundings, whitespace collapsed to
  # single spaces so a markdown body reads as one line in a dropdown.
  defp excerpt("", _needle), do: nil

  defp excerpt(text, needle) do
    case :binary.match(String.downcase(text), needle) do
      :nomatch ->
        nil

      {at, len} ->
        from = max(0, at - @excerpt_pad)
        take = min(byte_size(text) - from, len + 2 * @excerpt_pad)
        slice = binary_part(text, from, take)
        # `:binary.match` answers in BYTES, and a body is UTF-8: a window cut at
        # an arbitrary byte can start or end mid-codepoint, which is a JSON
        # encode error rather than a cosmetic one. Scrub the ragged ends.
        collapsed =
          slice
          |> String.chunk(:valid)
          |> Enum.filter(&String.valid?/1)
          |> Enum.join()
          |> String.replace(~r/\s+/u, " ")
          |> String.trim()

        prefix = if from > 0, do: "…", else: ""
        suffix = if from + take < byte_size(text), do: "…", else: ""
        prefix <> collapsed <> suffix
    end
  end

  # The loom and the project stores symlinked into it overlap, so the same
  # fiber can be found twice. Keyed the way the UI addresses a card: the slug
  # id, falling back to the intrinsic uid.
  defp dedupe(rows) do
    {_seen, kept} =
      Enum.reduce(rows, {MapSet.new(), []}, fn row, {seen, kept} ->
        key = if row.id != "", do: row.id, else: row.uid

        if key == "" or MapSet.member?(seen, key) do
          {seen, kept}
        else
          {MapSet.put(seen, key), [row | kept]}
        end
      end)

    Enum.reverse(kept)
  end

  defp parse_limit(nil), do: @default_limit

  defp parse_limit(value) do
    case Integer.parse(to_string(value)) do
      {n, _} when n > 0 -> min(n, @max_limit)
      _ -> @default_limit
    end
  end

  defp string(value) when is_binary(value), do: value
  defp string(_), do: ""
end
