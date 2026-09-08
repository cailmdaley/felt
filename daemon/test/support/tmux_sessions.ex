defmodule Shuttle.Test.TmuxSessions do
  @moduledoc """
  The `tmux has-session` matching rule the mock runners answer with.

  Real tmux treats a bare target as a prefix match over session names (so
  `foo` also matches `foo/bar`) and `=name` as exact. A mock that only did
  exact matching would let a dispatcher bug through, so every mock runner
  shares this predicate.
  """

  @doc "Does `session` (a `tmux has-session -t` target) match any live session?"
  def tmux_session_exists?(sessions, "=" <> session), do: MapSet.member?(sessions, session)

  def tmux_session_exists?(sessions, session) do
    Enum.any?(sessions, &(&1 == session or String.starts_with?(&1, session <> "/")))
  end
end
