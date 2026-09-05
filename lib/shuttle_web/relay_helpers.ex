defmodule ShuttleWeb.RelayHelpers do
  @moduledoc """
  Shared request and response helpers for the API controllers.

  Every write endpoint behind `Shuttle.OriginRouter` relays the owning daemon's
  verbatim response on a forward, and surfaces a tunnel failure as a 502. The
  forwarded leg is identical across endpoints; the failure body differs per
  endpoint (the `*: false` envelope key it echoes), so the JSON helper takes the
  failure body as a builder.

  Import into a controller: `import ShuttleWeb.RelayHelpers`.
  """

  import Plug.Conn
  import Phoenix.Controller, only: [json: 2]

  alias Shuttle.FeltStores

  @doc """
  Relay a JSON-bodied forward verbatim, or render a 502 tunnel failure.

  The forwarded body is already JSON the owning daemon produced, so it is sent
  as-is. On a forward failure, `on_failure.(name, reason)` builds the JSON map
  the endpoint surfaces (its `*: false` envelope plus `origin`/`error`).
  """
  def relay_json(conn, {:forwarded, status, body}, _on_failure) do
    conn |> put_resp_content_type("application/json") |> send_resp(status, body)
  end

  def relay_json(conn, {:error, {:forward_failed, name, reason}}, on_failure) do
    conn |> put_status(502) |> json(on_failure.(name, reason))
  end

  @doc """
  Relay a byte-bodied forward verbatim, or render a 502 tunnel failure.

  The owning daemon already served the bytes through Phoenix, so `content_type`
  carries its own charset; relaying with a `nil` charset avoids appending a
  SECOND one (`image/png; charset=utf-8; charset=utf-8`), which browsers reject —
  a doubled charset renders a remote-owned image as a broken-image icon. Shared
  by the owner-routing GET endpoints (`/file`, `/astra`, `/sent-files`,
  `/api/v1/fibers/:id`), whose owning daemon returns raw bytes + a content-type.
  """
  def relay_bytes(conn, {:forwarded, status, content_type, body}) do
    conn |> put_resp_content_type(content_type, nil) |> send_resp(status, body)
  end

  def relay_bytes(conn, {:error, {:forward_failed, name, reason}}) do
    conn |> put_status(502) |> json(%{error: "forward to #{name} failed: #{inspect(reason)}"})
  end

  @doc """
  Relay a plain-text forward verbatim, or render a 502 tunnel failure.

  Identical across the felt-edit / felt-nest / lifecycle endpoints, whose
  owning daemon returns `text/plain`.
  """
  def relay_text(conn, {:forwarded, status, body}) do
    conn |> put_resp_content_type("text/plain") |> send_resp(status, body)
  end

  def relay_text(conn, {:error, {:forward_failed, name, reason}}) do
    conn
    |> put_resp_content_type("text/plain")
    |> send_resp(502, "forward to #{name} failed: #{inspect(reason)}")
  end

  @doc """
  Render a local CLI-verb result as `text/plain`, mapping the shared error
  vocabulary the felt-edit / felt-nest / lifecycle local branches produce:

    * `{:ok, output}` → 200 with the output verbatim.
    * `{:error, binary}` → 400 with the message (a validation refusal).
    * `{:command_error, status, output}` → 422 `"<tool> exited <status>: <output>"`.
    * `{:error, :timeout, reason}` → 503 with the reason.

  `tool` labels the 422 line (`"felt"` for the felt CLI, `"shuttle"` for the
  `felt shuttle` verbs). A caller that needs a side effect on success (a document
  refresh) keeps its own 200 branch and routes only the `else` failures here.
  """
  def send_cli_result(conn, _tool, {:ok, output}) do
    conn |> put_resp_content_type("text/plain") |> send_resp(200, output)
  end

  def send_cli_result(conn, _tool, {:error, reason}) when is_binary(reason) do
    conn |> put_resp_content_type("text/plain") |> send_resp(400, reason)
  end

  def send_cli_result(conn, tool, {:command_error, status, output}) do
    conn
    |> put_resp_content_type("text/plain")
    |> send_resp(422, "#{tool} exited #{status}: #{output}")
  end

  def send_cli_result(conn, _tool, {:error, :timeout, reason}) do
    conn |> put_resp_content_type("text/plain") |> send_resp(503, reason)
  end

  @doc """
  Resolve a fiber id to its owning felt store and canonical address, mapping the
  resolution failures to the CLI-result error vocabulary `send_cli_result/3`
  renders. Shared by the felt-edit and felt-nest local branches, whose owning
  writer needs `-C <host>` and the store-relative address.
  """
  @spec host_for_fiber(String.t()) ::
          {:ok, String.t(), String.t()}
          | {:error, String.t()}
          | {:error, :timeout, String.t()}
  def host_for_fiber(fiber_id) do
    case FeltStores.resolve_fiber(fiber_id) do
      {:ok, %{host: host, fiber_id: address}} -> {:ok, host, address}
      {:error, :not_found} -> {:error, "fiber not found: #{fiber_id}"}
      {:error, :timeout} -> {:error, :timeout, "felt timed out resolving #{fiber_id}"}
    end
  end

  @doc "True for a non-empty binary — the required-string guard the controllers share."
  def present?(value), do: is_binary(value) and value != ""

  @doc """
  Read a query param that must be a whole integer — an epoch-millisecond bound.

  Strict: the entire value must parse, so `from_ms=17e11` or a trailing-garbage
  bound is refused rather than silently truncated to a window the caller did not
  ask for. A missing param is `{:error, {:bad_param, key}}` unless `:default`
  supplies a value, which is how an *optional* bound is read
  (`integer_param(params, "since_ms", default: 0)`).
  """
  @spec integer_param(map(), String.t(), keyword()) ::
          {:ok, integer()} | {:error, {:bad_param, String.t()}}
  def integer_param(params, key, opts \\ []) do
    # `Keyword.fetch/2`, not `Keyword.get/2`: the latter cannot tell "no default
    # configured" from "the default is nil", which would turn a required bound's
    # 400 into `{:ok, nil}` and a 500 further down.
    case {Map.get(params, key), Keyword.fetch(opts, :default)} do
      {nil, {:ok, default}} ->
        {:ok, default}

      {value, _} when is_binary(value) ->
        case Integer.parse(value) do
          {int, ""} -> {:ok, int}
          _ -> {:error, {:bad_param, key}}
        end

      _ ->
        {:error, {:bad_param, key}}
    end
  end

  @doc "The 400 sentence for a required epoch-millisecond bound."
  def epoch_ms_message(key), do: "#{key} is required and must be an integer (epoch ms)"

  @doc """
  Render `{:bad_param, key}` from `integer_param/3` as a 400.

  Note the one word this sentence lacks against `epoch_ms_message/1`:
  `/activity`'s bounds must be present, while the temporal feeds'
  `since_ms`/`until_ms` default to an open window and only have to parse.
  """
  def bad_param(conn, key) do
    conn
    |> Plug.Conn.put_status(400)
    |> Phoenix.Controller.json(%{error: "#{key} must be an integer (epoch ms)"})
  end

  @doc """
  Serve a JSON body behind a **weak validator**, so a hub polling this endpoint
  over an SSH tunnel pays a header exchange instead of a full transfer whenever
  nothing has changed.

  `parts` is any term that decides the response: the underlying source's cheap
  fingerprint (an events file's `{mtime, size}`, a git HEAD sha) **plus the
  request window**, since the same source serves different bytes per window.
  It is hashed into a weak ETag; a matching `If-None-Match` short-circuits to
  304 and `body_fun` is never called — that is the point, the expensive read is
  skipped, not just the transfer.

  Weak rather than strong (unlike the fibers feed's content etag in
  `ShuttleWeb.FiberDocumentsController`) because the token is derived from file
  metadata, not from the served bytes: it changes whenever the source changes,
  which is the guarantee a cache validator needs, but it is not a hash of the
  response.
  """
  def json_with_validator(conn, parts, body_fun) when is_function(body_fun, 0) do
    etag = weak_etag(parts)
    conn = put_resp_header(conn, "etag", etag)

    if if_none_match?(conn, etag) do
      send_resp(conn, 304, "")
    else
      json(conn, body_fun.())
    end
  end

  defp weak_etag(parts) do
    hash =
      :crypto.hash(:sha256, :erlang.term_to_binary(parts))
      |> Base.encode16(case: :lower)
      |> binary_part(0, 32)

    ~s(W/"#{hash}")
  end

  defp if_none_match?(conn, etag) do
    case get_req_header(conn, "if-none-match") do
      [value | _] -> String.trim(value) == etag
      [] -> false
    end
  end

  @doc """
  Cheap change fingerprint for a file: `{mtime, size}`, or `nil` when it does
  not exist. A missing file's `nil` is itself a stable token — a host that has
  never written the file 304s forever, correctly.
  """
  def file_token(path) when is_binary(path) do
    case File.stat(path, time: :posix) do
      {:ok, %File.Stat{type: :regular, mtime: mtime, size: size}} -> {mtime, size}
      _ -> nil
    end
  end

  def file_token(_path), do: nil
end
