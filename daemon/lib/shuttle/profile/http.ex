defmodule Shuttle.Profile.HTTP do
  @moduledoc """
  Collect bounded HTTP request counts, reductions, and durations during an
  explicitly started profile. Header values are capped; forwarded addresses
  are untrusted assertions and no identity or credential headers are read.
  """

  @start_event [:phoenix, :endpoint, :start]
  @stop_event [:phoenix, :endpoint, :stop]
  @max_active 512
  @max_groups 256
  @max_buffered_events 4_096
  @text_limit 128
  @overflow "<overflow>"

  @type profile :: %{id: term(), collector: pid(), owner: pid()}

  @spec start(pid()) :: {:ok, profile()} | {:error, term()}
  def start(owner \\ self()) when is_pid(owner) do
    id = {__MODULE__, make_ref()}
    buffered = :atomics.new(1, signed: false)
    dropped = :atomics.new(1, signed: false)
    caller = self()
    ref = make_ref()
    collector = spawn(fn -> attach_and_collect(id, owner, caller, ref, buffered, dropped) end)

    receive do
      {:http_profile_started, ^ref, :ok} ->
        {:ok, %{id: id, collector: collector, owner: owner}}

      {:http_profile_started, ^ref, {:error, reason}} ->
        {:error, reason}
    after
      5_000 ->
        :telemetry.detach(id)
        Process.exit(collector, :kill)
        {:error, :start_timeout}
    end
  end

  @spec finish(profile()) :: map()
  def finish(%{id: id, collector: collector}) do
    :telemetry.detach(id)
    monitor = Process.monitor(collector)
    ref = make_ref()
    send(collector, {:finish, self(), ref})

    receive do
      {:finished, ^ref, result} ->
        Process.demonitor(monitor, [:flush])
        result

      {:DOWN, ^monitor, :process, ^collector, _reason} ->
        %{"error" => "collector_unavailable"}
    after
      5_000 ->
        Process.exit(collector, :kill)
        Process.demonitor(monitor, [:flush])
        %{"error" => "collector_timeout"}
    end
  end

  def stop(profile), do: finish(profile)

  @doc false
  def handle_event(@start_event, _measurements, _metadata, config) do
    emit(config, {:request_start, self(), System.monotonic_time(), reductions()})
  end

  def handle_event(@stop_event, measurements, %{conn: conn}, config) do
    emit(
      config,
      {:request_stop, self(), System.monotonic_time(), reductions(), duration_ms(measurements),
       dimensions(conn), status(conn)}
    )
  end

  def handle_event(_event, _measurements, _metadata, _collector), do: :ok

  defp emit(%{collector: collector, buffered: buffered, dropped: dropped}, message) do
    if :atomics.add_get(buffered, 1, 1) <= @max_buffered_events do
      send(collector, message)
    else
      :atomics.sub(buffered, 1, 1)
      :atomics.add(dropped, 1, 1)
    end
  end

  defp attach_and_collect(id, owner, caller, ref, buffered, dropped) do
    monitor = Process.monitor(owner)
    config = %{collector: self(), buffered: buffered, dropped: dropped}

    case :telemetry.attach_many(
           id,
           [@start_event, @stop_event],
           &__MODULE__.handle_event/4,
           config
         ) do
      :ok ->
        send(caller, {:http_profile_started, ref, :ok})
        collect(id, owner, monitor, buffered, dropped, %{}, %{}, 0)

      {:error, reason} ->
        Process.demonitor(monitor, [:flush])
        send(caller, {:http_profile_started, ref, {:error, reason}})
    end
  end

  defp collect(id, owner, monitor, buffered, dropped_counter, active, groups, dropped) do
    receive do
      {:request_start, pid, started, reductions} ->
        :atomics.sub(buffered, 1, 1)

        cond do
          Map.has_key?(active, pid) ->
            collect(id, owner, monitor, buffered, dropped_counter, active, groups, dropped + 1)

          map_size(active) >= @max_active ->
            collect(id, owner, monitor, buffered, dropped_counter, active, groups, dropped + 1)

          true ->
            collect(
              id,
              owner,
              monitor,
              buffered,
              dropped_counter,
              Map.put(active, pid, {started, reductions}),
              groups,
              dropped
            )
        end

      {:request_stop, pid, stopped, final_reductions, measured_ms, dimensions, status} ->
        :atomics.sub(buffered, 1, 1)

        case Map.pop(active, pid) do
          {nil, active} ->
            collect(id, owner, monitor, buffered, dropped_counter, active, groups, dropped)

          {{started, initial_reductions}, active} ->
            duration = measured_ms || native_ms(stopped - started)
            group = Map.put(dimensions, :status, status)

            groups =
              add_group(groups, group, max(final_reductions - initial_reductions, 0), duration)

            collect(id, owner, monitor, buffered, dropped_counter, active, groups, dropped)
        end

      {:finish, from, ref} ->
        if :atomics.get(buffered, 1) == 0 do
          dropped = dropped + :atomics.get(dropped_counter, 1)
          send(from, {:finished, ref, result(groups, dropped)})
          Process.demonitor(monitor, [:flush])
          :ok
        else
          Process.send_after(self(), {:finish, from, ref}, 1)
          collect(id, owner, monitor, buffered, dropped_counter, active, groups, dropped)
        end

      {:DOWN, ^monitor, :process, ^owner, _reason} ->
        :telemetry.detach(id)
        :ok
    end
  end

  defp add_group(groups, key, reductions, duration) do
    cond do
      Map.has_key?(groups, key) ->
        update_group(groups, key, reductions, duration)

      map_size(groups) < @max_groups - 1 ->
        Map.put(groups, key, %{count: 1, reductions: reductions, duration_ms: duration})

      true ->
        update_group(groups, @overflow, reductions, duration)
    end
  end

  defp update_group(groups, key, reductions, duration) do
    Map.update(
      groups,
      key,
      %{count: 1, reductions: reductions, duration_ms: duration},
      fn value ->
        %{
          count: value.count + 1,
          reductions: value.reductions + reductions,
          duration_ms: value.duration_ms + duration
        }
      end
    )
  end

  defp result(groups, dropped) do
    rows =
      Enum.map(groups, fn
        {@overflow, totals} -> Map.merge(%{"route" => @overflow}, stringify(totals))
        {key, totals} -> Map.merge(stringify(key), stringify(totals))
      end)

    overflow =
      Enum.find_value(rows, 0, fn row -> if row["route"] == @overflow, do: row["count"] end)

    %{"groups" => rows, "dropped" => dropped, "overflow" => overflow}
  end

  defp stringify(map) do
    Map.new(map, fn {key, value} -> {to_string(key), value} end)
  end

  defp dimensions(conn) do
    %{
      method: bounded(conn.method || ""),
      route: bounded(route(conn)),
      shuttle: shuttle_param(conn.params),
      remote_ip: conn.remote_ip |> format_ip() |> bounded(),
      forwarded_for_untrusted:
        conn |> Plug.Conn.get_req_header("x-forwarded-for") |> List.first() |> bounded()
    }
  end

  defp shuttle_param(%{"shuttle" => "true"}), do: true
  defp shuttle_param(_params), do: false

  defp route(%{private: %{phoenix_route: route}}) when is_binary(route), do: route

  defp route(%{private: %{phoenix_router: router}} = conn) when is_atom(router) do
    case Phoenix.Router.route_info(router, conn.method, conn.request_path, conn.host) do
      %{route: route} -> route
      _ -> "<unmatched>"
    end
  rescue
    _ -> "<unmatched>"
  end

  defp route(_conn), do: "<unmatched>"

  defp status(conn), do: conn.status || 0

  defp reductions do
    case Process.info(self(), :reductions) do
      {:reductions, n} -> n
      _ -> 0
    end
  end

  defp duration_ms(%{duration: duration}) when is_integer(duration) and duration >= 0,
    do: native_ms(duration)

  defp duration_ms(_), do: nil
  defp native_ms(value), do: System.convert_time_unit(value, :native, :millisecond) * 1.0

  defp bounded(nil), do: ""
  defp bounded(value) when is_binary(value), do: String.slice(value, 0, @text_limit)
  defp bounded(value), do: value |> to_string() |> bounded()

  defp format_ip(nil), do: ""

  defp format_ip({:local, path}) when is_binary(path), do: "unix:" <> path

  defp format_ip(ip) when is_tuple(ip) do
    case :inet.ntoa(ip) do
      address when is_list(address) -> List.to_string(address)
      _ -> "<unknown>"
    end
  end

  defp format_ip(_), do: "<unknown>"
end
