defmodule ShuttleWeb.RequestDeadline do
  @moduledoc """
  Bounds Bandit request owners from parsed headers through response completion.

  Expiry kills the owner, closing its socket even when it is blocked in IO or
  an OTP call. It cannot render an HTTP error. A timed-out mutation may still
  finish in the process servicing it; disconnecting does not roll it back.
  HTTP/1 keepalive requests have distinct span tokens, so an old timer cannot
  kill a later request. WebSocket lifetimes are outside this request span.
  """

  use GenServer
  require Logger

  @events [[:bandit, :request, :start], [:bandit, :request, :stop]]
  @guard_call_timeout_ms 1_000

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc "Overall request budget in milliseconds, including body reads and sends."
  def budget_ms("POST", "/api/v1/choose-folder"), do: 335_000
  def budget_ms("GET", "/api/v1/transcripts/search"), do: 125_000
  def budget_ms("GET", "/api/v1/version"), do: 8_000
  def budget_ms("GET", path) when path in ["/api/v1/agents", "/api/v1/fleet/remotes"], do: 20_000

  def budget_ms(method, path)
      when method in ["GET", "HEAD"] and
             path in [
               "/api/v1/file",
               "/api/v1/transcript",
               "/api/v1/transcript/raw",
               "/api/v1/transcript/stream"
             ],
      do: 305_000

  def budget_ms("POST", path) when path in ["/api/v1/fleet/remotes", "/api/v1/tunnels"],
    do: 95_000

  def budget_ms("POST", path) when path in ["/api/v1/attachments", "/api/v1/messages/files"],
    do: 300_000

  # The outer fuse leaves room for the owner's buffered read budget and for
  # the configured Poller write budget plus its forwarding transit margin.
  def budget_ms(method, _path) when method in ["GET", "HEAD", "OPTIONS"], do: 35_000
  def budget_ms(_method, _path), do: Shuttle.OriginRouter.default_forward_timeout_ms() + 5_000

  @impl true
  def init(opts) do
    Process.flag(:trap_exit, true)
    id = {__MODULE__, Keyword.get(opts, :name, __MODULE__) || self()}
    plug = Keyword.get(opts, :plug, ShuttleWeb.Endpoint)

    # A hard kill skips terminate/2. Replace the registered guard's old
    # callback before attaching one that addresses this incarnation.
    :telemetry.detach(id)

    :ok =
      :telemetry.attach_many(id, @events, &__MODULE__.handle_event/4, %{
        server: self(),
        plug: plug
      })

    {:ok,
     %{
       handler_id: id,
       budget: Keyword.get(opts, :budget, &budget_ms/2),
       spans: %{},
       monitors: %{}
     }}
  end

  @doc false
  def handle_event(event, _measurements, %{plug: {module, _} = plug} = metadata, config) do
    if config.plug == module or config.plug == plug do
      token = metadata.telemetry_span_context
      key = {self(), token}

      request =
        case event do
          [:bandit, :request, :start] ->
            case metadata do
              %{conn: %{method: method, request_path: path}} -> {:start, key, method, path}
              _ -> {:start, key, nil, nil}
            end

          [:bandit, :request, :stop] ->
            {:stop, key}
        end

      # Telemetry detaches handlers that raise. Never let an unavailable guard
      # turn protection off silently: terminate this request owner instead.
      try do
        GenServer.call(config.server, request, @guard_call_timeout_ms)
      catch
        :exit, _ -> Process.exit(self(), :kill)
      end
    end
  end

  def handle_event(_event, _measurements, _metadata, _config), do: :ok

  @impl true
  def handle_call({:start, {owner, _token} = key, method, path}, _from, state) do
    monitor = Process.monitor(owner)
    guard = self()
    budget = state.budget.(method, path)

    # The fuse is independently supervised: killing this registry must not
    # strand the requests whose deadlines it holds.
    {:ok, fuse} =
      Task.Supervisor.start_child(Shuttle.TaskSupervisor, fn ->
        fuse(guard, owner, key, budget, method, path)
      end)

    fuse_monitor = Process.monitor(fuse)
    span = %{fuse: fuse, monitor: monitor, fuse_monitor: fuse_monitor}

    {:reply, :ok,
     %{
       state
       | spans: Map.put(state.spans, key, span),
         monitors:
           state.monitors
           |> Map.put(monitor, {:owner, key})
           |> Map.put(fuse_monitor, {:fuse, key})
     }}
  end

  def handle_call({:stop, key}, _from, state), do: {:reply, :ok, remove(state, key)}

  @impl true
  def handle_info({:DOWN, monitor, :process, _pid, _reason}, state) do
    case Map.get(state.monitors, monitor) do
      {:fuse, {owner, _token} = key} ->
        # Losing a fuse is losing the request's bound, including when its
        # Task.Supervisor is hard-killed. Fail closed for this active span.
        Process.exit(owner, :kill)
        {:noreply, remove(state, key)}

      {:owner, key} ->
        {:noreply, remove(state, key)}

      nil ->
        # Completion removes both monitor identities before keepalive resumes.
        {:noreply, state}
    end
  end

  @impl true
  def terminate(_reason, state) do
    :telemetry.detach(state.handler_id)
    for {{owner, _token}, _span} <- state.spans, do: Process.exit(owner, :kill)
    :ok
  end

  defp remove(state, key) do
    case Map.pop(state.spans, key) do
      {nil, _spans} ->
        state

      {%{fuse: fuse, monitor: monitor, fuse_monitor: active_fuse_monitor}, spans} ->
        # Disarm the active-span monitor before awaiting cancellation. A
        # queued DOWN for this fuse must not kill the owner's next request.
        Process.demonitor(active_fuse_monitor, [:flush])

        # Stop is synchronous through response completion. The acknowledgement
        # means this fuse can no longer kill a subsequent keepalive request.
        fuse_monitor = Process.monitor(fuse)
        ref = make_ref()
        send(fuse, {:complete, self(), ref})

        receive do
          {:complete, ^ref} -> Process.demonitor(fuse_monitor, [:flush])
          {:DOWN, ^fuse_monitor, :process, ^fuse, _reason} -> :ok
        after
          @guard_call_timeout_ms -> Process.exit(fuse, :kill)
        end

        Process.demonitor(monitor, [:flush])

        %{
          state
          | spans: spans,
            monitors:
              state.monitors
              |> Map.delete(monitor)
              |> Map.delete(active_fuse_monitor)
        }
    end
  end

  defp fuse(guard, owner, key, budget, method, path) do
    guard_monitor = Process.monitor(guard)
    owner_monitor = Process.monitor(owner)
    timer = Process.send_after(self(), {:expire, key}, budget)

    receive do
      {:complete, caller, ref} ->
        send(caller, {:complete, ref})

      {:DOWN, ^owner_monitor, :process, ^owner, _reason} ->
        :ok

      {:DOWN, ^guard_monitor, :process, ^guard, _reason} ->
        Process.exit(owner, :kill)

      {:expire, ^key} ->
        Process.exit(owner, :kill)

        Logger.warning(
          "HTTP request deadline exceeded method=#{method} path=#{path} budget_ms=#{budget}"
        )
    end

    Process.cancel_timer(timer)
    Process.demonitor(guard_monitor, [:flush])
    Process.demonitor(owner_monitor, [:flush])
  end
end
