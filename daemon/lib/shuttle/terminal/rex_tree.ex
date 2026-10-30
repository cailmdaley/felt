defmodule Shuttle.Terminal.RexTree do
  @moduledoc "Pure fiber-tree presentation and best-effort projection onto bound Rex sessions."

  require Logger
  alias Shuttle.{Rex, SessionLedger, Terminal}
  alias Shuttle.Terminal.RexBindings, as: Bindings

  @doc "Order by path segments (parents first); indent by the number of live ancestors."
  def layout(entries) do
    paths = MapSet.new(entries, & &1.fiber)

    entries
    |> Enum.sort_by(&{String.split(&1.fiber, "/"), Map.get(&1, :suffix, ""), &1.session_id})
    |> Enum.map(fn entry ->
      parts = String.split(entry.fiber, "/")

      depth =
        parts
        |> Enum.drop(-1)
        |> Enum.scan(fn part, prefix -> prefix <> "/" <> part end)
        |> Enum.count(&MapSet.member?(paths, &1))

      label =
        if depth == 0,
          do: parts |> Enum.take(-2) |> Enum.join("/"),
          else: String.duplicate("\u2003", depth - 1) <> "└ " <> List.last(parts)

      Map.put(entry, :label, label <> Map.get(entry, :suffix, ""))
    end)
  end

  @doc "Resolve a worker's path from structural ledger identity, never its display label."
  def fiber_for(name, records \\ SessionLedger.read_since(0)) do
    uid = Shuttle.ULID.from_tmux(name)

    records
    |> Enum.reverse()
    |> Enum.filter(&is_map/1)
    |> Enum.find_value(fn row ->
      session = if is_binary(row["session"]), do: row["session"], else: ""
      thread = if is_binary(row["thread_id"]), do: row["thread_id"], else: ""

      if is_binary(row["fiber"]) and row["fiber"] != "" and
           (row["tmux"] == name or
              (uid != nil and row["uid"] == uid) or
              name in [
                "codex-terminal-" <> thread,
                "codex-terminal-" <> session,
                "resume-" <> session
              ]) do
        row["fiber"]
      end
    end)
  end

  @doc "Refresh display only; a failed projection cannot invalidate a successful terminal mutation."
  def refresh(runner) do
    result =
      Terminal.with_lock({Bindings, Bindings.path()}, fn ->
        with {:ok, doc} <- Bindings.read(),
             {:ok, sessions} <- Rex.sessions(runner),
             {:ok, entries} <- live_entries(runner, doc, sessions) do
          project(runner, layout(entries), sessions)
        end
      end)

    case result do
      :ok -> :ok
      {:error, reason} -> Logger.warning("Rex fiber tree refresh failed: #{inspect(reason)}")
    end

    :ok
  end

  defp live_entries(runner, doc, sessions) do
    ids = MapSet.new(sessions, & &1["session_id"])

    workers =
      for {name, b} <- doc["bindings"],
          fiber = b["fiber"] || fiber_for(name),
          is_binary(fiber) and fiber != "",
          do: Map.merge(b, %{"fiber" => fiber, "suffix" => ""})

    viewers = Map.values(doc["viewers"] || %{})

    Enum.reduce_while(workers ++ viewers, {:ok, []}, fn b, {:ok, acc} ->
      if MapSet.member?(ids, b["session_id"]) do
        case Rex.blocks(runner, b["session_id"]) do
          {:ok, blocks} ->
            if Enum.any?(blocks, &(&1["block_id"] == b["block_id"])) and
                 is_binary(b["fiber"]) and b["fiber"] != "" do
              entry = %{fiber: b["fiber"], session_id: b["session_id"], suffix: b["suffix"] || ""}
              {:cont, {:ok, [entry | acc]}}
            else
              {:cont, {:ok, acc}}
            end

          {:error, :not_found} ->
            {:cont, {:ok, acc}}

          error ->
            {:halt, error}
        end
      else
        {:cont, {:ok, acc}}
      end
    end)
  end

  defp project(runner, entries, sessions) do
    labels = Map.new(sessions, &{&1["session_id"], &1["label"]})

    with :ok <- relabel(runner, entries, labels) do
      desired = Enum.map(entries, & &1.session_id)
      # Moving just owned sessions to the end preserves every unowned session's
      # relative order. An already matching tail needs no move calls.
      if desired == Enum.take(Enum.map(sessions, & &1["session_id"]), -length(desired)) do
        :ok
      else
        each(entries, fn e ->
          Rex.call(runner, "session.move", %{"session_id" => e.session_id}, session: e.session_id)
        end)
      end
    end
  end

  defp relabel(runner, entries, labels) do
    each(entries, fn e ->
      # Rex trims leading Unicode whitespace. A word joiner protects the em
      # spaces without adding a visible glyph to the sidebar.
      label = if String.starts_with?(e.label, "\u2003"), do: "\u2060" <> e.label, else: e.label
      label = compact(label, e.suffix)

      if labels[e.session_id] == label,
        do: {:ok, %{}},
        else: Rex.call(runner, "session.set_label", %{"label" => label}, session: e.session_id)
    end)
  end

  defp compact(label, suffix) do
    if String.length(label) <= 127 do
      label
    else
      hash = :crypto.hash(:sha256, label) |> Base.encode16(case: :lower) |> String.slice(0, 16)

      suffix =
        if String.length(suffix) > 64,
          do: String.slice(suffix, 0, 47) <> "~" <> hash,
          else: suffix

      String.slice(label, 0, 110 - String.length(suffix)) <> "~" <> hash <> suffix
    end
  end

  defp each(entries, fun) do
    Enum.reduce_while(entries, :ok, fn entry, :ok ->
      case fun.(entry) do
        {:ok, _} -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end
end
