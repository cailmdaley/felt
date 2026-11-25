defmodule Shuttle.Voice.Recovered do
  @moduledoc """
  Speech recovered from a muted mic, put before the human rather than delivered.

  `hark recover` writes each recovered utterance to the live transcript's JSONL
  as `{"wall", "recovered": {speaker, text, ...}}` and closes the batch with a
  `{"wall", "recovery": {...}}` row. The relay collects those rows apart from
  its live utterances, so none of them is ever routed to a worker: words said
  into a muted mic may have been muted on purpose. At the batch's close this
  module writes them as one Markdown document under
  `<data_dir>/voice-recovered/`, grouped by the card that was in view when each
  was said (the route journal's history), and sends it with `shuttle send-file`
  (`send_file/4`).
  """

  @doc """
  The document for nonempty `rows` (`%{"t", "speaker", "text"}`, oldest first), as
  `{file name, markdown}`, given the capture's `routes` and the batch's
  `summary` and closing `wall`.
  """
  def document(launch, rows, routes, summary, wall) do
    speakers = rows |> Enum.map(& &1["speaker"]) |> Enum.uniq()

    groups =
      rows
      |> Enum.map(&{route_at(routes, &1["t"]), &1})
      |> Enum.group_by(fn {route, _row} -> route && {route["fiber_id"], route["origin"]} end)
      |> Enum.map(fn {_card, [{route, _} | _] = said} ->
        {route, Enum.map(said, &elem(&1, 1))}
      end)
      |> Enum.sort_by(fn {_route, [first | _]} -> instant(first["t"]) end, DateTime)

    body =
      Enum.map_join(groups, "\n", fn {route, said} ->
        lines =
          Enum.map_join(said, "\n\n", fn row ->
            who = if length(speakers) > 1, do: " #{row["speaker"]}:", else: ""
            "**#{binary_part(row["t"], 11, 8)}**#{who} #{row["text"]}"
          end)

        heading(route) <> "\n\n" <> lines <> "\n"
      end)

    said = ", said #{day(hd(rows)["t"])} #{clock(hd(rows)["t"])}–#{clock(List.last(rows)["t"])}"

    markdown = """
    # Said while muted

    Recovered at #{clock(wall)} from #{minutes(summary["seconds"])} of speech held while the mic was muted#{said}. None of it was delivered; forward what you want.

    #{body}\
    """

    {"#{launch}-#{stamp(wall)}.md", markdown}
  end

  @doc "A one-line caption for the send of nonempty `rows`."
  def caption(rows, summary) do
    "Said while muted, #{clock(hd(rows)["t"])}–#{clock(List.last(rows)["t"])} " <>
      "(#{minutes(summary["seconds"])} held): nothing was delivered"
  end

  @doc "The route in force at spoken time `t`, or nil before the first."
  def route_at(routes, t) do
    at = instant(t)

    Enum.find(Enum.reverse(routes), &(DateTime.compare(at, instant(&1["t"])) != :lt))
    |> case do
      nil -> nil
      route -> Map.take(route, ~w(fiber_id origin name slug))
    end
  end

  @doc """
  Put `path` on the board for `card`, the route in view now. A card this host
  owns takes it the way its own worker's send arrives: the send's terminal is
  named for the card's uid (`<leaf>-<ULID>-shuttle`, which a worker's
  dispatch environment carries), so the card's channel, its Sent Files and the
  Library all file it under the card. Another host's card lists only its own
  host's sends in its Sent Files, so there the document goes unaddressed, as
  this host's own file.
  """
  def send_file(path, card, session, caption) do
    terminal =
      case card do
        %{"fiber_id" => uid} = card ->
          if card["origin"] in [nil, Shuttle.Poller.own_host_id()] and Shuttle.ULID.valid?(uid),
            do: "voice-#{uid}-shuttle",
            else: ""

        nil ->
          ""
      end

    env = [
      {"SHUTTLE_TMUX_SESSION", terminal},
      {"TMUX", ""},
      {"REX_SESSION", ""},
      {"REX_BLOCK", ""}
    ]

    case Shuttle.CLI.run(["send-file", path, "--session", session, "--caption", caption],
           env: env
         ) do
      {:ok, _} -> :ok
      {:command_error, _status, output} -> {:error, String.trim(output)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp instant(iso) do
    {:ok, at, _} = DateTime.from_iso8601(iso)
    at
  end

  defp heading(nil), do: "## No card in view"

  defp heading(route) do
    name = route["name"] || route["slug"] || route["fiber_id"]
    slug = route["slug"] || route["fiber_id"]
    if name == slug, do: "## #{name}", else: "## #{name}\n\n`#{slug}`"
  end

  # Hark writes local times with their offset: the wall clock as said.
  defp clock(iso), do: binary_part(iso, 11, 5)

  defp day(iso),
    do: iso |> binary_part(0, 10) |> Date.from_iso8601!() |> Calendar.strftime("%-d %b")

  defp stamp(iso), do: iso |> binary_part(0, 19) |> String.replace(["-", ":"], "")

  defp minutes(seconds) when is_number(seconds) and seconds >= 90,
    do: "#{round(seconds / 60)} min"

  defp minutes(seconds) when is_number(seconds), do: "#{round(seconds)} s"
end
