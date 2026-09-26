defmodule ShuttleWeb.PeerGateThrottle do
  @moduledoc false

  use GenServer

  @table __MODULE__
  @window_ms 60_000

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, Keyword.put_new(opts, :name, __MODULE__))
  end

  @impl true
  def init(:ok) do
    table =
      :ets.new(@table, [
        :named_table,
        :set,
        :public,
        read_concurrency: true,
        write_concurrency: true
      ])

    {:ok, table}
  end

  @doc false
  def allow_warning?(uid, now_ms \\ System.monotonic_time(:millisecond)) do
    key = if is_integer(uid), do: {:uid, uid}, else: :unresolved

    case :ets.insert_new(@table, {key, now_ms}) do
      true ->
        true

      false ->
        case :ets.lookup(@table, key) do
          [{^key, last_ms}] when now_ms - last_ms >= @window_ms ->
            :ets.select_replace(@table, [{{key, last_ms}, [], [{:const, {key, now_ms}}]}]) == 1

          _ ->
            false
        end
    end
  end
end
