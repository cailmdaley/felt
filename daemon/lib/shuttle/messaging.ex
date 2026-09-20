defmodule Shuttle.Messaging do
  @moduledoc "Fleet discovery and strictly host-addressed worker messaging."

  alias Shuttle.{Felt, OriginRouter, Poller, RegistryCommon, Remote}

  @local_message_timeout_ms 20_000
  @remote_message_timeout_ms 25_000
  @local_discovery_timeout_ms 10_000
  @remote_discovery_timeout_ms 12_000
  @max_text_bytes 65_536
  @receipt_statuses ~w(accepted context_added submitted queued unknown rejected)
  @part_pattern ~r/\A[a-z0-9._-]+\z/

  def peers(local? \\ false) do
    if local? do
      local_peers()
    else
      remotes = RegistryCommon.configured_remotes([])
      targets = [:local | remotes]

      results =
        Task.Supervisor.async_stream_nolink(
          Shuttle.TaskSupervisor,
          targets,
          fn
            :local -> {:local, local_peers()}
            %Remote{} = remote -> {:remote, remote_peers(remote)}
          end,
          ordered: true,
          timeout: @remote_discovery_timeout_ms + 250,
          on_timeout: :kill_task,
          max_concurrency: length(targets)
        )
        |> Enum.zip(targets)

      initial = %{host: Poller.own_host_id(), sessions: [], gaps: []}

      Enum.reduce(results, initial, fn
        {{:ok, {:local, directory}}, :local}, acc ->
          %{acc | sessions: acc.sessions ++ directory.sessions, gaps: acc.gaps ++ directory.gaps}

        {{:ok, {:remote, {:ok, directory}}}, %Remote{} = remote}, acc ->
          %{
            acc
            | sessions: acc.sessions ++ alias_sessions(directory.sessions, remote.name),
              gaps: acc.gaps ++ alias_gaps(directory.gaps, remote.name)
          }

        {{:ok, {:remote, {:error, error}}}, %Remote{} = remote}, acc ->
          %{acc | gaps: acc.gaps ++ [%{host: remote.name, error: error}]}

        {{:exit, reason}, :local}, acc ->
          %{acc | gaps: acc.gaps ++ [%{host: acc.host, error: render_error(reason)}]}

        {{:exit, reason}, %Remote{} = remote}, acc ->
          %{acc | gaps: acc.gaps ++ [%{host: remote.name, error: render_error(reason)}]}
      end)
    end
  end

  def send_message(payload) when is_map(payload) do
    with {:ok, request} <- validate_message(payload),
         {:ok, address} <- parse_address(request.address),
         decision <- OriginRouter.route_host(address.host),
         result <- deliver(decision, request, address) do
      result
    end
  end

  def send_message(_), do: {:error, 400, "body must be a JSON object"}

  defp local_peers do
    host = Poller.own_host_id()

    case Felt.run(["shuttle", "sessions", "--local", "--json"],
           timeout_ms: @local_discovery_timeout_ms
         ) do
      {:ok, output} ->
        case Jason.decode(output) do
          {:ok, %{"sessions" => sessions} = directory} when is_list(sessions) ->
            gaps = Map.get(directory, "gaps", [])

            if Enum.all?(sessions, &valid_session?/1) and valid_gaps?(gaps),
              do: %{
                host: host,
                sessions: alias_sessions(sessions, host),
                gaps: alias_gaps(gaps, host)
              },
              else: malformed_local_directory(host)

          {:ok, sessions} when is_list(sessions) ->
            if Enum.all?(sessions, &valid_session?/1),
              do: %{host: host, sessions: alias_sessions(sessions, host), gaps: []},
              else: malformed_local_directory(host)

          _ ->
            malformed_local_directory(host)
        end

      {:command_error, :timeout, _} ->
        %{host: host, sessions: [], gaps: [%{host: host, error: "timed out"}]}

      {:command_error, _, output} ->
        %{host: host, sessions: [], gaps: [%{host: host, error: String.trim(output)}]}

      {:error, reason} ->
        %{host: host, sessions: [], gaps: [%{host: host, error: reason}]}
    end
  end

  defp malformed_local_directory(host),
    do: %{host: host, sessions: [], gaps: [%{host: host, error: "malformed local response"}]}

  defp remote_peers(%Remote{} = remote) do
    url = Remote.url_for(remote, "/api/v1/peers") <> "?local=true"

    case OriginRouter.forward_client().get(url, @remote_discovery_timeout_ms) do
      {:ok, body} -> decode_remote(body)
      {:error, {:http_status, 404}} -> {:error, "peer discovery unsupported"}
      {:error, reason} -> {:error, render_error(reason)}
    end
  end

  defp decode_remote(body) do
    case Jason.decode(body) do
      {:ok, %{"sessions" => sessions} = directory} when is_list(sessions) ->
        gaps = Map.get(directory, "gaps", [])

        if Enum.all?(sessions, &valid_session?/1) and valid_gaps?(gaps),
          do: {:ok, %{sessions: sessions, gaps: gaps}},
          else: {:error, "malformed peer response"}

      _ ->
        {:error, "malformed peer response"}
    end
  end

  defp valid_session?(%{} = session) do
    address = Map.get(session, "address") || Map.get(session, :address)
    is_binary(address) and match?({:ok, _}, parse_address(address))
  end

  defp valid_session?(_), do: false

  defp valid_gaps?(gaps) when is_list(gaps),
    do: Enum.all?(gaps, &(is_map(&1) and is_binary(Map.get(&1, "error"))))

  defp valid_gaps?(_), do: false

  defp alias_gaps(gaps, host) do
    Enum.map(gaps, fn gap -> gap |> stringify_keys() |> Map.put("host", host) end)
  end

  defp alias_sessions(sessions, host) do
    Enum.flat_map(sessions, fn
      %{} = session ->
        case Map.get(session, "address") || Map.get(session, :address) do
          address when is_binary(address) ->
            case parse_address(address) do
              {:ok, parsed} ->
                [
                  session
                  |> stringify_keys()
                  |> Map.put("host", host)
                  |> Map.put("address", build_address(host, parsed))
                ]

              _ ->
                []
            end

          _ ->
            []
        end

      _ ->
        []
    end)
  end

  defp deliver(:local, request, address) when address.host in ["local"] do
    case deliver_local(request, %{address | host: Poller.own_host_id()}) do
      {:ok, status, receipt} -> {:ok, status, Map.put(receipt, "address", request.address)}
      other -> other
    end
  end

  defp deliver(:local, request, address) do
    if address.host == Poller.own_host_id(),
      do: deliver_local(request, address),
      else: {:error, 400, OriginRouter.unknown_origin_message(address.host)}
  end

  defp deliver({:remote, remote}, request, address) do
    forwarded = Map.put(request.raw, "address", build_address("local", address))

    case OriginRouter.forward(remote, "/api/v1/messages", forwarded,
           forward_timeout_ms: @remote_message_timeout_ms
         ) do
      {:forwarded, status, body} ->
        case Jason.decode(body) do
          {:ok, receipt} when is_map(receipt) ->
            case validate_receipt(receipt, request.raw["message_id"], forwarded["address"]) do
              :ok ->
                {:ok, status, Map.put(receipt, "address", request.address)}

              :error ->
                {:ok, 502,
                 unknown_receipt(
                   request,
                   "daemon",
                   "#{remote.name} returned a malformed message receipt; outcome is unknown"
                 )}
            end

          _ ->
            {:ok, 502,
             unknown_receipt(
               request,
               "daemon",
               "#{remote.name} returned a malformed message receipt; outcome is unknown"
             )}
        end

      {:error, {:forward_failed, name, reason}} ->
        {:ok, 502,
         unknown_receipt(
           request,
           "daemon",
           "forward to #{name} failed; delivery outcome is unknown: #{render_error(reason)}"
         )}
    end
  end

  defp deliver({:error, {:unknown_origin, host}}, _request, _address),
    do: {:error, 400, OriginRouter.unknown_origin_message(host)}

  defp deliver_local(request, address) do
    payload = Map.put(request.raw, "address", build_address(address.host, address))

    frame = Jason.encode!(payload) <> "\n"

    case Felt.run(["shuttle", "message", "--local", "--json", "--request-json"],
           timeout_ms: @local_message_timeout_ms,
           input: frame
         ) do
      {:ok, output} ->
        case Jason.decode(output) do
          {:ok, receipt} when is_map(receipt) ->
            if validate_receipt(receipt, request.raw["message_id"], payload["address"]) == :ok,
              do: {:ok, 200, receipt},
              else:
                {:ok, 502,
                 unknown_receipt(
                   request,
                   "daemon",
                   "felt returned a malformed message receipt; outcome is unknown"
                 )}

          _ ->
            {:ok, 502,
             unknown_receipt(
               request,
               "daemon",
               "felt returned a malformed message receipt; outcome is unknown"
             )}
        end

      {:command_error, :timeout, _} ->
        {:ok, 504,
         unknown_receipt(request, "daemon", "local delivery timed out; outcome is unknown")}

      {:command_error, _, output} ->
        case decode_receipt_line(output, request.raw["message_id"], payload["address"]) do
          {:ok, receipt} ->
            {:ok, 400, receipt}

          :error ->
            {:ok, 502,
             unknown_receipt(
               request,
               "daemon",
               "felt failed without a valid receipt; outcome is unknown: #{String.trim(output)}"
             )}
        end

      {:error, reason} ->
        {:error, 503, "could not run felt: #{reason}"}
    end
  end

  defp validate_message(payload) do
    address = Map.get(payload, "address")
    text = Map.get(payload, "text")
    from = Map.get(payload, "from", "")
    wake = Map.get(payload, "wake", false)
    id = Map.get(payload, "message_id")

    cond do
      not is_binary(address) or byte_size(address) > 8_192 ->
        {:error, 400, "address must be a bounded string"}

      not is_binary(text) or text == "" or byte_size(text) > @max_text_bytes or
          String.contains?(text, <<0>>) ->
        {:error, 400, "text must be a string of 1..#{@max_text_bytes} bytes without NUL"}

      not is_binary(from) or byte_size(from) > 1_024 or has_control?(from) ->
        {:error, 400, "from must be a string of at most 1024 bytes without control characters"}

      not is_boolean(wake) ->
        {:error, 400, "wake must be a boolean"}

      not is_binary(id) or id == "" or byte_size(id) > 256 or has_control?(id) ->
        {:error, 400, "message_id must be a non-empty bounded string without control characters"}

      true ->
        {:ok,
         %{
           address: address,
           raw: Map.take(payload, ["address", "text", "from", "wake", "message_id"])
         }}
    end
  end

  defp parse_address(value) do
    case URI.parse(value) do
      %URI{
        scheme: "shuttle",
        host: host,
        path: path,
        query: nil,
        fragment: nil,
        userinfo: nil,
        port: nil
      }
      when is_binary(host) and host != "" and is_binary(path) ->
        case String.split(String.trim_leading(path, "/"), "/", parts: 2) do
          [harness, native] when harness != "" and native != "" ->
            parsed = %{host: host, harness: harness, native: URI.decode(native)}

            if valid_part?(host) and valid_part?(harness) and byte_size(parsed.native) <= 4_096 and
                 not String.contains?(parsed.native, <<0>>) and
                 build_address(host, parsed) == value,
               do: {:ok, parsed},
               else: {:error, 400, "address is not canonical"}

          _ ->
            {:error, 400, "address must be shuttle://HOST/HARNESS/NATIVE_ID"}
        end

      _ ->
        {:error, 400, "address must be shuttle://HOST/HARNESS/NATIVE_ID"}
    end
  rescue
    ArgumentError -> {:error, 400, "address contains invalid escaping"}
  end

  defp build_address(host, address),
    do:
      "shuttle://#{host}/#{address.harness}/#{URI.encode(address.native, &go_path_segment_char?/1)}"

  defp validate_receipt(receipt, expected_id, expected_address) do
    if Map.get(receipt, "message_id") == expected_id and
         Map.get(receipt, "address") == expected_address and
         Map.get(receipt, "status") in @receipt_statuses and
         is_binary(Map.get(receipt, "transport")) and
         (is_nil(Map.get(receipt, "detail")) or is_binary(Map.get(receipt, "detail"))),
       do: :ok,
       else: :error
  end

  defp decode_receipt_line(output, expected_id, expected_address) do
    with [line | _] <- String.split(output, "\n", parts: 2),
         {:ok, receipt} when is_map(receipt) <- Jason.decode(line),
         :ok <- validate_receipt(receipt, expected_id, expected_address) do
      {:ok, receipt}
    else
      _ -> :error
    end
  end

  defp unknown_receipt(request, transport, detail) do
    %{
      "message_id" => request.raw["message_id"],
      "address" => request.address,
      "status" => "unknown",
      "transport" => transport,
      "detail" => detail
    }
  end

  defp valid_part?(part), do: byte_size(part) <= 255 and Regex.match?(@part_pattern, part)

  # Go's net/url.PathEscape path-segment mode keeps these RFC 3986 subdelims
  # in addition to unreserved bytes. This must remain byte-identical to the
  # CLI's canonical address formatter.
  defp go_path_segment_char?(char),
    do: URI.char_unreserved?(char) or char in ~c"+:@$&="

  defp has_control?(value) do
    value
    |> String.to_charlist()
    |> Enum.any?(&(&1 < 32 or &1 == 127))
  end

  defp stringify_keys(map), do: Map.new(map, fn {k, v} -> {to_string(k), v} end)
  defp render_error(reason) when is_binary(reason), do: reason
  defp render_error(reason), do: inspect(reason)
end
