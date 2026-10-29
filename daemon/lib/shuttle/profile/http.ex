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
  @text_limit 128
  @overflow "<overflow>"

  @type profile :: %{id: term(), collector: pid(), owner: pid()}

  @spec start(pid()) :: {:ok, profile()} | {:error, term()}
  def start(owner \\ self()) when is_pid(owner) do
    id = {__MODULE__, make_ref()}
    collector = spawn(fn -> collect(id, owner, Process.monitor(owner), %{}, %{}, 0) end)

    handler = &__MODULE__.handle_event/4

    case :telemetry.attach_many(id, [@start_event, @stop_event], handler, collector) do
      :ok ->
        {:ok, %{id: id, collector: collector, owner: owner}}

      {:error, reason} ->
        Process.exit(collector, :normal)
        {:error, reason}
    end
  end

  @spec finish(profile()) :: map()
  def finish(%{id: id, collector: collector}) do
    :telemetry.detach(id)
    ref = make_ref()
    send(collector, {:finish, self(), ref})

    receive do
      {:finished, ^ref, result} -> result
    after
      5_000 -> %{"groups" => [], "dropped" => 0, "overflow" => 0}
    end
  end

  def stop(profile), do: finish(profile)

  @doc false
  def handle_event(@start_event, _measurements, %{conn: conn}, collector) do
    send(
      collector,
      {:request_start, self(), System.monotonic_time(), reductions(), dimensions(conn)}
    )
  end

  def handle_event(@stop_event, measurements, %{conn: conn}, collector) do
    send(
      collector,
      {:request_stop, self(), System.monotonic_time(), reductions(), duration_ms(measurements),
       status(conn)}
    )
  end

  def handle_event(_event, _measurements, _metadata, _collector), do: :ok

  defp collect(id, owner, monitor, active, groups, dropped) do
    receive do
      {:request_start, pid, started, reductions, dimensions} ->
        cond do
          Map.has_key?(active, pid) ->
            collect(id, owner, monitor, active, groups, dropped + 1)

          map_size(active) >= @max_active ->
            collect(id, owner, monitor, active, groups, dropped + 1)

          true ->
            collect(
              id,
              owner,
              monitor,
              Map.put(active, pid, {started, reductions, dimensions}),
              groups,
              dropped
            )
        end

      {:request_stop, pid, stopped, final_reductions, measured_ms, status} ->
        case Map.pop(active, pid) do
          {nil, active} ->
            collect(id, owner, monitor, active, groups, dropped)

          {{started, initial_reductions, dimensions}, active} ->
            duration = measured_ms || native_ms(stopped - started)
            group = Map.put(dimensions, :status, status)

            groups =
              add_group(groups, group, max(final_reductions - initial_reductions, 0), duration)

            collect(id, owner, monitor, active, groups, dropped)
        end

      {:finish, from, ref} ->
        send(from, {:finished, ref, result(groups, dropped)})
        Process.demonitor(monitor, [:flush])
        :ok

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
      route: bounded(conn.private[:phoenix_route] || "<unmatched>"),
      shuttle: get_in(conn.params || %{}, ["shuttle"]) == "true",
      remote_ip: conn.remote_ip |> format_ip() |> bounded(),
      forwarded_for_untrusted:
        conn |> Plug.Conn.get_req_header("x-forwarded-for") |> List.first() |> bounded()
    }
  end

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
  defp format_ip(ip), do: ip |> :inet.ntoa() |> List.to_string()
end
