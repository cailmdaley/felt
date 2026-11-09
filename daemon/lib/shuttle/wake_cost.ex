defmodule Shuttle.WakeCost do
  @moduledoc """
  What waking a conversation would cost, from its transcript's latest usage.

  Every turn re-reads the whole context. While the prompt cache is warm that
  read is cheap; once it has gone cold the next turn pays for all of it
  uncached. A conversation is `costly` to wake when its cache is cold and its
  context is at least `threshold/0` tokens (250k; app env `:wake_cost_tokens`).
  Only Claude's usage establishes a cache lifetime, so any other conversation,
  and one with no usage on this host, is never costly.
  """

  alias Shuttle.{Transcript, TranscriptUsage}

  @threshold 250_000

  def threshold, do: Shuttle.Env.app(:wake_cost_tokens, @threshold)

  @doc "`%{context: tokens, cold_ms: ms}` when waking `session` is costly, else nil."
  @spec costly(term(), integer()) :: %{context: pos_integer(), cold_ms: non_neg_integer()} | nil
  def costly(session, now_ms \\ System.system_time(:millisecond))

  def costly(session, now_ms) when is_binary(session) do
    with path when is_binary(path) <- Transcript.path(session),
         %{context: context, cache_warm_until: until} <-
           TranscriptUsage.read(path, Transcript.harness_for(path)),
         true <- is_integer(context) and is_integer(until),
         true <- context >= threshold() and until <= now_ms do
      %{context: context, cold_ms: now_ms - until}
    else
      _ -> nil
    end
  end

  def costly(_session, _now_ms), do: nil

  @doc "The cost in a sentence fragment: `412k tokens of context, cache cold for 3h`."
  def describe(%{context: context, cold_ms: cold_ms}),
    do: "#{round(context / 1000)}k tokens of context, cache cold for #{span(cold_ms)}"

  defp span(ms) when ms < 3_600_000, do: "#{max(1, div(ms, 60_000))}m"
  defp span(ms) when ms < 86_400_000, do: "#{div(ms, 3_600_000)}h"
  defp span(ms), do: "#{div(ms, 86_400_000)}d"
end
