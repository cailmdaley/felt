defmodule Shuttle.RexView do
  @moduledoc """
  Keeps Rex's view to what is in focus. A window this daemon opened for a
  worker, a resumed conversation or a tmux viewer leaves the view once it has
  stood behind its session's active window for `grace_ms`: its block is
  detached (`Shuttle.Terminal.Rex.hide/3`), so the window closes and the
  program in it runs on. Opening the conversation again (`c`, Open in Rex)
  puts it back in a window of its own.

  Each session keeps the window it shows. Windows this daemon did not open
  (a human's shell, hark, Remote Control) are never touched.

  A sweep runs every `every_ms` on this host's Rex server; `sweep/3` is the
  same pass, run once to clear what has gathered.
  """
  use GenServer

  require Logger

  alias Shuttle.Env
  alias Shuttle.Terminal.RexBindings

  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))

  @impl true
  def init(opts) do
    state = %{
      every_ms: Keyword.get(opts, :every_ms, 30_000),
      grace_ms: Keyword.get(opts, :grace_ms, 120_000),
      behind: %{}
    }

    send(self(), :sweep)
    {:ok, state}
  end

  @impl true
  def handle_info(:sweep, state) do
    behind =
      with true <- Shuttle.Terminal.primary() == Shuttle.Terminal.Rex,
           {:ok, asking} <- asking(),
           {:ok, behind} <-
             sweep(runner(), state.behind, grace_ms: state.grace_ms, asking: asking) do
        behind
      else
        false ->
          %{}

        reason ->
          Logger.debug("Rex view sweep skipped: #{inspect(reason)}")
          state.behind
      end

    Process.send_after(self(), :sweep, state.every_ms)
    {:noreply, %{state | behind: behind}}
  end

  @doc """
  The terminals whose worker has raised an ask: a question in its fiber, a
  harness prompt, or a block. Unknown while this host's feed is cold.
  """
  def asking do
    case Shuttle.Poller.cached_fiber_documents(
           felt_stores: Shuttle.FeltStores.configured_stores()
         ) do
      {:ok, %{fibers: entries}} ->
        {:ok,
         for(
           %{fiber: fiber, runtime: runtime} <- entries,
           is_binary(runtime[:tmux_session]) and raised?(fiber, runtime),
           into: MapSet.new(),
           do: runtime.tmux_session
         )}

      error ->
        error
    end
  end

  @doc "Whether a worker has raised an ask: the red ones on the Desk."
  def raised?(fiber, runtime) do
    (fiber["status"] == "active" and is_map(get_in(fiber, ["shuttle", "ask"]))) or
      runtime[:phase] in ["attention", "blocked", "identity_failed"] or
      runtime[:state] == "blocked" or is_binary(runtime[:launch_error])
  end

  @doc """
  One pass. A window of ours that has stood behind its session's active window
  since `behind[block]` for at least `:grace_ms` (0: at once) leaves the view,
  unless its terminal is in `:asking`; a hidden one in `:asking` comes back.
  Returns when each remaining one was first seen behind.
  """
  def sweep(runner, behind \\ %{}, opts \\ []) do
    now = Keyword.get(opts, :now, System.monotonic_time(:millisecond))
    grace = Keyword.get(opts, :grace_ms, 0)
    asking = Keyword.get(opts, :asking, MapSet.new())

    with {:ok, doc} <- RexBindings.read() do
      ours = Enum.to_list(doc["bindings"]) ++ Enum.to_list(doc["viewers"] || %{})
      names = Map.new(ours, fn {name, b} -> {b["block_id"], name} end)
      keep = fn bid -> MapSet.member?(asking, names[bid]) end

      ours
      |> Enum.map(fn {_, b} -> b["session_id"] end)
      |> Enum.uniq()
      |> Enum.reduce_while({:ok, %{}}, fn sid, {:ok, seen} ->
        case session(runner, sid, names, keep, behind, now, grace) do
          {:ok, more} -> {:cont, {:ok, Map.merge(seen, more)}}
          {:error, :not_found} -> {:cont, {:ok, seen}}
          error -> {:halt, error}
        end
      end)
    end
  end

  defp session(runner, sid, names, keep, behind, now, grace) do
    with {:ok, view} <- Shuttle.Rex.call(runner, "session.view", %{}, session: sid),
         {:ok, blocks} <- Shuttle.Rex.blocks(runner, sid),
         :ok <- bring_back(runner, sid, blocks, names, keep) do
      active = view["active_window_id"]

      view
      |> Map.get("windows", [])
      |> Enum.reject(&(&1["window_id"] == active))
      |> Enum.flat_map(&window_blocks/1)
      |> Enum.filter(&(Map.has_key?(names, &1) and not keep.(&1)))
      |> Enum.reduce_while({:ok, %{}}, fn bid, {:ok, seen} ->
        since = Map.get(behind, bid, now)

        if now - since >= grace do
          case Shuttle.Terminal.Rex.hide(runner, sid, bid) do
            {:ok, _} -> {:cont, {:ok, seen}}
            {:error, :not_found} -> {:cont, {:ok, seen}}
            error -> {:halt, error}
          end
        else
          {:cont, {:ok, Map.put(seen, bid, since)}}
        end
      end)
    end
  end

  # A worker that raises an ask while hidden comes back into view.
  defp bring_back(runner, sid, blocks, names, keep) do
    blocks
    |> Enum.filter(&(&1["placement"] == "detached" and Map.has_key?(names, &1["block_id"])))
    |> Enum.filter(&keep.(&1["block_id"]))
    |> Enum.reduce_while(:ok, fn block, :ok ->
      case Shuttle.Terminal.Rex.place(runner, sid, block) do
        {:ok, _} -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end

  defp window_blocks(window),
    do: for(layer <- window["layers"] || [], b <- layer["blocks"] || [], do: b["block_id"])

  defp runner, do: Env.app(:rex_runner, Shuttle.Runner.Default)
end
