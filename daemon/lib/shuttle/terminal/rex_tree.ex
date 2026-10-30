defmodule Shuttle.Terminal.RexTree do
  @moduledoc "Constitution families and best-effort projection onto Rex sessions and windows."

  require Logger
  alias Shuttle.{Rex, SessionLedger, Terminal}
  alias Shuttle.Terminal.RexBindings, as: Bindings

  @doc "Resolve from all constitutions, including resting roots and non-running ancestors."
  def family(fiber, fibers) do
    ancestors =
      fibers
      |> Enum.filter(fn row ->
        path = row["slug"] || row["id"]
        is_binary(path) and String.starts_with?(fiber, path <> "/") and constitution?(row)
      end)
      |> Enum.map(&(&1["slug"] || &1["id"]))
      |> Enum.uniq()
      |> Enum.sort_by(&length(String.split(&1, "/")))

    %{fiber: fiber, family: List.first(ancestors) || fiber, depth: length(ancestors)}
  end

  defp constitution?(row),
    do: is_map(row["shuttle"]) or "constitution" in (row["tags"] || [])

  @doc "Read the fiber tree at launch; an unreadable tree cannot authorize a different family."
  def resolve(fiber, opts \\ [])
  def resolve(nil, _opts), do: {:ok, nil}

  def resolve(fiber, opts) do
    stores = if opts[:felt_store], do: [felt_stores: [opts[:felt_store]]], else: []

    with {:ok, %{fibers: entries}} <- Shuttle.FiberDocuments.list(stores) do
      rows = Enum.map(entries, & &1.fiber)
      row = Enum.find(rows, &((&1["slug"] || &1["id"]) == fiber or &1["id"] == fiber))
      path = if row, do: row["slug"] || row["id"], else: fiber
      {:ok, family(path, rows)}
    end
  end

  def session_label(root), do: root |> String.split("/") |> Enum.take(-2) |> Enum.join("/")

  @doc "Order tabs by fiber path, with deterministic ties; label by constitution depth."
  def layout(entries) do
    entries
    |> Enum.sort_by(
      &{String.split(&1.fiber, "/"), Map.get(&1, :suffix, ""), Map.get(&1, :window_id, "")}
    )
    |> Enum.map(fn entry ->
      depth = Map.get(entry, :depth, 0)
      leaf = entry.fiber |> String.split("/") |> List.last()
      prefix = if depth == 0, do: "", else: String.duplicate("\u2003", depth - 1) <> "└ "
      Map.put(entry, :label, prefix <> leaf <> Map.get(entry, :suffix, ""))
    end)
  end

  @doc "Resolve a worker's path from structural ledger identity, never its display label."
  def fiber_for(name) do
    case SessionLedger.latest_for_terminal(name) do
      %{"fiber" => fiber} -> fiber
      nil -> nil
    end
  end

  def fiber_for(name, records) do
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
      Terminal.with_lock({__MODULE__, :projection}, fn ->
        with :ok <- Shuttle.Terminal.Rex.sweep(runner),
             {:ok, doc} <- Bindings.read(),
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
          fiber = b["fiber"] || resolve_fiber(name, b),
          is_binary(fiber) and fiber != "",
          do: Map.merge(b, %{"fiber" => fiber, "suffix" => ""})

    viewers = Map.values(doc["viewers"] || %{})

    Enum.reduce_while(workers ++ viewers, {:ok, []}, fn b, {:ok, acc} ->
      if MapSet.member?(ids, b["session_id"]) do
        case Rex.blocks(runner, b["session_id"]) do
          {:ok, blocks} ->
            if Enum.any?(blocks, &(&1["block_id"] == b["block_id"])) and
                 is_binary(b["fiber"]) and b["fiber"] != "" do
              block = Enum.find(blocks, &(&1["block_id"] == b["block_id"]))

              root =
                b["family"] ||
                  Enum.find_value(doc["families"] || %{}, fn {root, sid} ->
                    if sid == b["session_id"], do: root
                  end)

              depth =
                case b["depth"] do
                  nil ->
                    case resolve(b["fiber"]) do
                      {:ok, %{depth: depth}} -> depth
                      _ -> 0
                    end

                  depth ->
                    depth
                end

              entry = %{
                fiber: b["fiber"],
                session_id: b["session_id"],
                window_id: b["window_id"] || block["window_id"],
                family: root,
                depth: depth,
                suffix: b["suffix"] || ""
              }

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

  defp resolve_fiber(name, binding) do
    fiber = fiber_for(name)
    Bindings.put_fiber(name, fiber, binding)
    fiber
  end

  defp project(runner, entries, sessions) do
    labels = Map.new(sessions, &{&1["session_id"], &1["label"]})

    entries
    |> Enum.group_by(& &1.session_id)
    |> Enum.reduce_while(:ok, fn {sid, windows}, :ok ->
      # A binding without a family keeps its physical placement and uses its
      # fiber's last two segments for its per-worker session display.
      root = hd(windows).family
      label = display_label(session_label(root || hd(windows).fiber))

      result =
        with {:ok, view} <- Rex.windows(runner, sid),
             {:ok, _} <-
               if(label == labels[sid],
                 do: {:ok, %{}},
                 else: Rex.call(runner, "session.set_label", %{"label" => label}, session: sid)
               ),
             :ok <- relabel_windows(runner, sid, windows, view) do
          desired = windows |> Enum.map(& &1.window_id) |> Enum.reject(&is_nil/1) |> Enum.uniq()
          current = Enum.map(view, & &1["window_id"])

          if desired == Enum.take(current, -length(desired)) do
            :ok
          else
            each(desired, fn wid ->
              Rex.call(runner, "session.move_window", %{"window_id" => wid}, session: sid)
            end)
          end
        end

      case result do
        :ok -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end

  defp relabel_windows(runner, sid, entries, view) do
    labels = Map.new(view, &{&1["window_id"], &1["label"]})

    each(Enum.filter(entries, &is_binary(&1.window_id)), fn e ->
      label = display_label(e.label, e.suffix)

      if labels[e.window_id] == label,
        do: {:ok, %{}},
        else:
          Rex.call(
            runner,
            "session.set_window_label",
            %{"window_id" => e.window_id, "label" => label},
            session: sid
          )
    end)
  end

  def display_label(label, suffix \\ "") do
    # Rex trims leading whitespace; a word joiner protects the em spaces.
    label = if String.starts_with?(label, "\u2003"), do: "\u2060" <> label, else: label
    compact(label, suffix)
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
