defmodule Shuttle.Test.EventFiles do
  @moduledoc """
  From-scratch folds of an event stream's two files, rotated sibling first —
  the oracle the projections `Shuttle.EventStream` holds are pinned against.
  """

  alias Shuttle.{Activity, EventStream, SentFiles}

  @doc "Every event of `live <> \".1\"` and then of `live`, folded onto `acc`."
  def fold(live, acc, fun) do
    [live <> ".1", live]
    |> Enum.filter(&File.regular?/1)
    |> Enum.flat_map(&File.stream!/1)
    |> fold_lines(acc, fun)
  end

  @doc "`lines`, in order, decoded and folded onto `acc`."
  def fold_lines(lines, acc, fun) do
    Enum.reduce(lines, acc, fn line, acc ->
      case EventStream.decode(line) do
        nil -> acc
        event -> fun.(event, acc)
      end
    end)
  end

  @doc "The activity fold of both files."
  def activity(live), do: fold(live, Activity.new_acc(), &Activity.fold_event(&2, &1))

  @doc "`lines` folded onto an activity accumulator."
  def activity_lines(acc, lines), do: fold_lines(lines, acc, &Activity.fold_event(&2, &1))

  @doc "The projected sent-file events of both files, oldest first."
  def sent_events(live),
    do: live |> fold([], &Enum.reverse(SentFiles.project(&1), &2)) |> Enum.reverse()

  @doc "A stream following `live`, started under the test supervisor; returns its name."
  def start_stream(live, opts \\ []) do
    name = :"event_stream_#{System.unique_integer([:positive])}"

    ExUnit.Callbacks.start_supervised!(
      {EventStream,
       Keyword.merge([events_file: live, poll_interval_ms: 3_600_000, name: name], opts)},
      id: name
    )

    name
  end

  @doc """
  Make a stream following `live` this test's `Shuttle.EventStream`, and point
  `SHUTTLE_EVENTS_FILE` at `live` for the readers that stat it. Returns its name.
  """
  def scope!(live, opts \\ []) do
    Shuttle.Test.Env.put_env("SHUTTLE_EVENTS_FILE", live)
    name = :"event_stream_#{System.unique_integer([:positive])}"

    Shuttle.Test.Env.start_scoped!(
      Supervisor.child_spec(
        {EventStream,
         Keyword.merge([events_file: live, poll_interval_ms: 3_600_000, name: name], opts)},
        id: name
      ),
      EventStream
    )

    name
  end
end
