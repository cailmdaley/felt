defmodule Shuttle.WakeCostTest do
  use ExUnit.Case, async: true

  alias Shuttle.WakeCost

  @now 1_800_000_000_000
  @hour 3_600_000

  setup do
    root = Path.join(System.tmp_dir!(), "wake_cost_#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(root, "project"))
    Shuttle.Test.Env.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", root)
    on_exit(fn -> File.rm_rf(root) end)
    {:ok, root: root}
  end

  defp uuid do
    <<a::binary-8, b::binary-4, c::binary-3, d::binary-3, e::binary-12, _::binary>> =
      Base.encode16(:crypto.strong_rand_bytes(16), case: :lower)

    "#{a}-#{b}-4#{c}-8#{d}-#{e}"
  end

  # A Claude conversation whose latest turn read `context` tokens `ago` ms
  # before @now, under a five-minute cache entry.
  defp conversation(root, context, ago) do
    session = uuid()
    at = DateTime.from_unix!(@now - ago, :millisecond) |> DateTime.to_iso8601()

    line =
      Jason.encode!(%{
        type: "assistant",
        timestamp: at,
        message: %{
          model: "claude-opus-5-5",
          usage: %{
            input_tokens: 2,
            cache_read_input_tokens: context - 2,
            cache_creation_input_tokens: 0
          }
        }
      })

    File.write!(Path.join([root, "project", session <> ".jsonl"]), line <> "\n")
    session
  end

  test "a large conversation whose cache has gone cold is costly to wake", %{root: root} do
    session = conversation(root, 412_000, 3 * @hour + 5 * 60_000)
    assert %{context: 412_000, cold_ms: cold} = cost = WakeCost.costly(session, @now)
    assert cold == 3 * @hour
    assert WakeCost.describe(cost) == "412k tokens of context, cache cold for 3h"
  end

  test "a warm cache, a small context and an unknown conversation are not", %{root: root} do
    assert WakeCost.costly(conversation(root, 412_000, 60_000), @now) == nil
    assert WakeCost.costly(conversation(root, 249_999, 3 * @hour), @now) == nil
    assert WakeCost.costly(uuid(), @now) == nil
    assert WakeCost.costly(nil, @now) == nil
  end
end
