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
      if Shuttle.Terminal.primary() == Shuttle.Terminal.Rex do
        case sweep(runner(), state.behind, grace_ms: state.grace_ms) do
          {:ok, behind} ->
            behind

          {:error, reason} ->
            Logger.debug("Rex view sweep skipped: #{inspect(reason)}")
            state.behind
        end
      else
        %{}
      end

    Process.send_after(self(), :sweep, state.every_ms)
    {:noreply, %{state | behind: behind}}
  end

  @doc """
  One pass: hide every window of ours that has stood behind its session's
  active window since `behind[block]` for at least `:grace_ms` (0 hides it at
  once). Returns when each remaining one was first seen behind.
  """
  def sweep(runner, behind \\ %{}, opts \\ []) do
    now = Keyword.get(opts, :now, System.monotonic_time(:millisecond))
    grace = Keyword.get(opts, :grace_ms, 0)

    with {:ok, doc} <- RexBindings.read() do
      ours = Map.values(doc["bindings"]) ++ Map.values(doc["viewers"] || %{})
      blocks = MapSet.new(ours, & &1["block_id"])

      ours
      |> Enum.map(& &1["session_id"])
      |> Enum.uniq()
      |> Enum.reduce_while({:ok, %{}}, fn sid, {:ok, seen} ->
        case session(runner, sid, blocks, behind, now, grace) do
          {:ok, more} -> {:cont, {:ok, Map.merge(seen, more)}}
          {:error, :not_found} -> {:cont, {:ok, seen}}
          error -> {:halt, error}
        end
      end)
    end
  end

  defp session(runner, sid, ours, behind, now, grace) do
    with {:ok, view} <- Shuttle.Rex.call(runner, "session.view", %{}, session: sid) do
      active = view["active_window_id"]

      view
      |> Map.get("windows", [])
      |> Enum.reject(&(&1["window_id"] == active))
      |> Enum.flat_map(&window_blocks/1)
      |> Enum.filter(&MapSet.member?(ours, &1))
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

  defp window_blocks(window),
    do: for(layer <- window["layers"] || [], b <- layer["blocks"] || [], do: b["block_id"])

  defp runner, do: Env.app(:rex_runner, Shuttle.Runner.Default)
end
