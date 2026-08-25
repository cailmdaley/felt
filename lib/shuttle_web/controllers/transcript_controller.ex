defmodule ShuttleWeb.TranscriptController do
  @moduledoc """
  Native transcript provenance and byte transfer:

    * `GET /api/v1/transcript?session=…` returns an availability receipt;
    * `GET /api/v1/transcript/raw?session=…` returns the exact JSONL bytes.

  The host is selected explicitly with `host=`, or from the session ledger.
  Remote requests use the same SSH-routed transport as other host-local reads.
  No endpoint here interprets transcript records or implements search.
  """

  use Phoenix.Controller, formats: [:json]

  import Plug.Conn
  import ShuttleWeb.RelayHelpers, only: [present?: 1]

  alias Shuttle.{OriginRouter, Poller, Remote, SessionLedger, Transcript}

  # Native transcripts can be materially larger than the board/file assets
  # that use OriginRouter's ordinary 30 s forwarding budget. Keep the CLI and
  # owner hop on the same bounded transfer window.
  @transfer_timeout_ms 300_000

  def show(conn, params) do
    with {:ok, session} <- session_param(params) do
      case target_host(params, session) do
        :local ->
          conn |> json(local_receipt(session))

        {:remote, %Remote{} = remote} ->
          remote_receipt(conn, session, remote)

        {:unreachable, host} ->
          conn |> json(receipt(session, :host_unreachable, host: host))
      end
    else
      {:error, message} -> conn |> put_status(400) |> json(%{error: message})
    end
  end

  def raw(conn, params) do
    with {:ok, session} <- session_param(params) do
      case target_host(params, session) do
        :local -> local_bytes(conn, session)
        {:remote, %Remote{} = remote} -> remote_bytes(conn, session, remote)
        {:unreachable, host} -> unavailable(conn, session, :host_unreachable, host)
      end
    else
      {:error, message} -> conn |> put_status(400) |> json(%{error: message})
    end
  end

  defp local_receipt(session) do
    Transcript.resolve(session)
    |> receipt_map()
  end

  defp local_bytes(conn, session) do
    case Transcript.bytes(session) do
      {:ok, path} ->
        {byte_count, sha256} = Transcript.digest(path)

        conn
        |> put_resp_content_type("application/x-ndjson", nil)
        |> put_resp_header("x-transcript-byte-count", Integer.to_string(byte_count))
        |> put_resp_header("x-transcript-sha256", sha256)
        |> send_file(200, path)

      {:error, status} ->
        unavailable(conn, session, status, Poller.own_host_id())
    end
  end

  defp remote_receipt(conn, session, %Remote{} = remote) do
    query = %{"session" => session, "host" => "local"}

    case OriginRouter.forward_get(remote, "/api/v1/transcript", query,
           forward_timeout_ms: @transfer_timeout_ms
         ) do
      {:forwarded, 200, _content_type, body} ->
        case Jason.decode(body) do
          {:ok, %{} = payload} ->
            payload =
              payload
              |> Map.put("host", remote.name)
              |> remote_status()

            json(conn, payload)

          _ ->
            json(conn, receipt(session, :host_unreachable, host: remote.name))
        end

      _ ->
        json(conn, receipt(session, :host_unreachable, host: remote.name))
    end
  end

  defp remote_bytes(conn, session, %Remote{} = remote) do
    query = %{"session" => session, "host" => "local"}

    case OriginRouter.forward_get(remote, "/api/v1/transcript/raw", query,
           forward_timeout_ms: @transfer_timeout_ms
         ) do
      {:forwarded, 200, content_type, body} ->
        {byte_count, sha256} = digest_bytes(body)

        conn
        |> put_resp_content_type(content_type, nil)
        |> put_resp_header("x-transcript-byte-count", Integer.to_string(byte_count))
        |> put_resp_header("x-transcript-sha256", sha256)
        |> send_resp(200, body)

      {:forwarded, status, _content_type, body} ->
        conn |> put_resp_content_type("application/json") |> send_resp(status, body)

      {:error, _reason} ->
        unavailable(conn, session, :host_unreachable, remote.name)
    end
  end

  defp target_host(params, session) do
    explicit = Map.get(params, "host")
    name = if present?(explicit), do: explicit, else: SessionLedger.host_for_session(session)

    case OriginRouter.route(name) do
      {:remote, remote} ->
        {:remote, remote}

      :local ->
        if name in [nil, "", "local", Poller.own_host_id()],
          do: :local,
          else: {:unreachable, name}
    end
  end

  defp remote_status(%{"availability" => "available_local"} = payload),
    do: Map.put(payload, "availability", "available_remote")

  defp remote_status(payload), do: payload

  defp receipt_map(%{availability: availability} = value) do
    value
    |> Map.put(:availability, Atom.to_string(availability))
    |> Map.new(fn {key, item} -> {Atom.to_string(key), item} end)
  end

  defp receipt(session, status, opts) do
    %{
      "session" => session,
      "availability" => Atom.to_string(status),
      "host" => Keyword.get(opts, :host),
      "harness" => nil,
      "source_path" => nil,
      "byte_count" => nil,
      "modified_at" => nil,
      "sha256" => nil
    }
  end

  defp unavailable(conn, session, status, host) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(http_status(status), Jason.encode!(receipt(session, status, host: host)))
  end

  defp http_status(:transcript_missing), do: 404
  defp http_status(:identity_pending), do: 409
  defp http_status(:host_unreachable), do: 503

  defp digest_bytes(bytes) when is_binary(bytes) do
    {byte_size(bytes), :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)}
  end

  defp session_param(params) do
    case Map.get(params, "session") do
      session when is_binary(session) ->
        if Transcript.valid_session?(session),
          do: {:ok, session},
          else: {:error, "session must be a UUID"}

      nil ->
        {:error, "session is required"}

      _ ->
        {:error, "session must be a UUID"}
    end
  end
end
