defmodule Shuttle.FiberIndex do
  @moduledoc """
  Stale-while-revalidate cache of the daemon-local wikilink/parent index.

  A cold request waits for one shared listing. Warm requests read a pre-encoded
  body and strong validator from memory, including while a refresh is running.
  The 30-second TTL bounds picker staleness during use without repeating a
  whole-store walk for every card opened. Store discovery and JSON encoding run
  in the refresh task, never on a warm request. Failed refreshes keep the last
  good answer and wait one TTL before retrying.
  """

  use GenServer
  require Logger

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  def fetch do
    GenServer.call(Shuttle.Env.server(__MODULE__), {:fetch, Shuttle.Env.callers()}, :infinity)
  end

  @impl true
  def init(opts) do
    # Linked supervised refreshes die with their cache owner. Trapping exits
    # lets their monitor report a failed refresh without losing a warm body.
    Process.flag(:trap_exit, true)

    {:ok,
     %{
       cached: nil,
       attempted_at: nil,
       task: nil,
       waiters: [],
       ttl_ms: Keyword.get(opts, :ttl_ms, 30_000),
       clock: Keyword.get(opts, :clock, fn -> System.monotonic_time(:millisecond) end),
       loader: Keyword.get(opts, :loader, &Shuttle.FiberDocuments.index/0)
     }}
  end

  @impl true
  def handle_call({:fetch, callers}, from, state) do
    stale? = is_nil(state.attempted_at) or state.clock.() - state.attempted_at >= state.ttl_ms
    state = if stale? and is_nil(state.task), do: refresh(state, callers), else: state

    case state.cached do
      nil -> {:noreply, %{state | waiters: [from | state.waiters]}}
      result -> {:reply, result, state}
    end
  end

  @impl true
  def handle_info({ref, result}, %{task: %{ref: ref}} = state) do
    Process.demonitor(ref, [:flush])
    {:noreply, complete(state, result)}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, %{task: %{ref: ref}} = state) do
    {:noreply, complete(state, {:error, [%{error: "index refresh exited: #{inspect(reason)}"}]})}
  end

  def handle_info({:EXIT, _pid, _reason}, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, %{task: task}) do
    if task, do: Task.shutdown(task, :brutal_kill)
    :ok
  end

  defp refresh(state, callers) do
    loader = state.loader

    task =
      Task.Supervisor.async(Shuttle.TaskSupervisor, fn ->
        Shuttle.Env.adopt_callers(callers)

        with {:ok, body} <- loader.() do
          {:ok, %{body: Jason.encode!(body), etag: etag(body)}}
        end
      end)

    %{state | task: task}
  end

  # A strong validator over what the index says: its stores and fibers, not
  # `generated_at`, which every refresh restamps. An unchanged store keeps its
  # etag across refreshes, so a revalidating client gets a 304.
  defp etag(body) do
    content = :erlang.term_to_binary({body.felt_stores, body.fibers}, [:deterministic])
    ~s("#{Base.encode16(:crypto.hash(:sha256, content), case: :lower)}")
  end

  defp complete(state, result) do
    case result do
      {:error, errors} -> Logger.warning("fiber index refresh failed: #{inspect(errors)}")
      {:ok, _} -> :ok
    end

    Enum.each(state.waiters, &GenServer.reply(&1, result))
    # Cold failures are cached for the retry interval too; no caller waits on a
    # task that isn't running. Warm failures retain the last successful body.
    cached =
      case result do
        {:ok, _} -> result
        {:error, _} -> state.cached || result
      end

    %{state | cached: cached, task: nil, waiters: [], attempted_at: state.clock.()}
  end
end
