defmodule Shuttle.HarnessTasks do
  @moduledoc "A conversation's own task list, which tells the pulse whether a worker still has work in hand; each harness reads its own (`Shuttle.Harness.tasks/3`)."

  alias Shuttle.Transcript

  @doc "Read one conversation, returning its ordered tasks and the next read's cursor."
  def read(cli, session, previous \\ %{}, opts \\ []) do
    if Transcript.valid_session?(session),
      do: Shuttle.Harness.call(cli, :tasks, [session, previous, opts], {[], %{}}),
      else: {[], %{}}
  end
end
