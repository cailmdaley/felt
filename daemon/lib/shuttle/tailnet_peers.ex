defmodule Shuttle.TailnetPeers do
  @moduledoc """
  Finds the other Shuttle daemons on this host's tailnet.

  Every fleet daemon is served at `https://<magicdns-name>/`. A discovery round
  reads the tailnet status, keeps the peers owned by this node's own user (a
  node shared in from another tailnet is never trusted), probes each online
  one at `/api/v1/version`, and names each daemon that answers by the `host`
  it reports there. Fibers route by `shuttle.host`, so the reported host id is
  the peer's name, never its MagicDNS label. A peer is rejected when it
  reports this daemon's own host id, reports no host id (not a Shuttle daemon,
  or one too old to say), or two peers report the same one. A peer that times
  out, refuses the connection or is not ready yet is simply not discovered
  this round: phones and tablets drop out that way.

  The status comes from tailscaled's LocalAPI when a socket is in effect
  (`Shuttle.Remotes.tailscale_socket_source/0`: configured, or
  `bin/tailscaled-launch`'s default), and the probes then dial through the same
  LocalAPI as `Shuttle.TailnetDial` bridges do. Otherwise the status comes from
  the `tailscale` CLI, found on `PATH` or at the standard macOS and Linux
  install locations (a supervised daemon's `PATH` is thin), and the probes use
  the fleet's ordinary HTTPS client.

  A round runs shortly after boot, off the boot path, and then every minute.
  Results live in an ETS table this process owns: `peers/0` feeds
  `Shuttle.Remotes.configured/0`, `generation/0` (which changes only when the peer
  set changes) is folded into `Shuttle.Remotes.config_token/0` so the registries
  and the dial reconciler pick up a new peer without a bounce, and `status/0`
  is the report `/api/v1/version` and `shuttle doctor` show.

  When Tailscale is absent, stopped or failing, the round discovers nothing
  and records why: the fleet is the configured entries alone. A peer that
  answered once is kept for up to ten minutes while it is offline, unreachable
  or not ready, so a daemon restarting for a deploy goes stale in the
  registries rather than vanishing from them. A peer that answers as another
  host, or not as Shuttle, is dropped at once.

  `discover/5` is the pure core: tailnet status, probe results, own host id and
  the previous round's peers in, peers and rejections out.
  `test/fixtures/tailnet_peers/*.json` drives it together with
  `Shuttle.Remotes.resolve/2`.
  """

  use GenServer
  require Logger

  alias Shuttle.Remote
  alias Shuttle.Remotes

  @table __MODULE__
  @interval_ms 60_000
  @boot_delay_ms 1_000
  @status_timeout_ms 5_000
  @probe_timeout_ms 4_000
  @retain_ms 600_000
  @max_response_bytes 16 * 1024 * 1024
  @host_id ~r/\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\z/

  # Where the tailscale CLI lives when it is not on PATH: Homebrew and the
  # standalone macOS package, the Linux packages, and the macOS app bundle.
  @cli_locations [
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/bin/tailscale",
    "/usr/sbin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  ]

  # ── Readers ──

  @doc "The discovered peers, as `[%{\"name\" => host_id, \"url\" => url}]`."
  @spec peers() :: [map()]
  def peers do
    case lookup(:peers) do
      peers when is_list(peers) -> peers
      _ -> []
    end
  end

  @doc "Changes each time the discovered peer set changes; 0 before any change."
  @spec generation() :: non_neg_integer()
  def generation, do: lookup(:generation) || 0

  @doc """
  The last round's report: `enabled`, `state` (`pending`, `ok`, `unavailable`
  or `disabled`), `via` (`localapi` or `cli`), `error`, `last_run_at`, the
  `peers` found and the candidates `rejected`, each with its reason.
  """
  @spec status() :: map()
  def status do
    lookup(:status) ||
      %{
        enabled: false,
        state: "disabled",
        via: nil,
        error: "tailnet discovery is not running",
        last_run_at: nil,
        peers: [],
        rejected: []
      }
  end

  defp lookup(key) do
    case :ets.lookup(@table, key) do
      [{^key, value}] -> value
      _ -> nil
    end
  rescue
    ArgumentError -> nil
  end

  # ── Process ──

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(opts) do
    :ets.new(@table, [:named_table, :protected, :set, read_concurrency: true])

    :ets.insert(@table, [
      {:peers, []},
      {:generation, 0},
      {:status, %{status() | enabled: true, state: "pending", error: nil}}
    ])

    Process.send_after(self(), :discover, Keyword.get(opts, :boot_delay_ms, @boot_delay_ms))
    {:ok, %{opts: opts, previous: [], generation: 0, last_state: nil}}
  end

  @impl true
  def handle_info(:discover, state) do
    report =
      try do
        run_round(state.previous, state.opts)
      catch
        kind, reason ->
          %{
            state: "unavailable",
            via: nil,
            error: "discovery round failed: #{Exception.format_banner(kind, reason)}",
            peers: [],
            rejected: []
          }
      end

    state = publish(report, state)
    Process.send_after(self(), :discover, Keyword.get(state.opts, :interval_ms, @interval_ms))
    {:noreply, state}
  end

  defp publish(report, state) do
    peers = report.peers
    names = Enum.map(peers, &{&1["name"], &1["url"]})
    changed? = names != Enum.map(state.previous, &{&1["name"], &1["url"]})
    # Unique across restarts of this process, so a registry holding a token
    # from before a crash can never mistake a new peer set for the old one.
    generation =
      if changed?, do: System.unique_integer([:positive, :monotonic]), else: state.generation

    :ets.insert(@table, [
      {:peers, Enum.map(peers, &Map.take(&1, ["name", "url"]))},
      {:generation, generation},
      {:status, render(report)}
    ])

    log_transition(report, changed?, state.last_state)
    %{state | previous: peers, generation: generation, last_state: {report.state, report.error}}
  end

  defp render(report) do
    %{
      enabled: report.state != "disabled",
      state: report.state,
      via: report.via,
      error: report.error,
      last_run_at: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601(),
      peers:
        Enum.map(report.peers, fn peer ->
          %{
            name: peer["name"],
            url: peer["url"],
            dns_name: peer["dns_name"],
            last_seen_at:
              peer["seen_at_ms"] |> DateTime.from_unix!(:millisecond) |> DateTime.to_iso8601()
          }
        end),
      rejected: Enum.map(report.rejected, &%{dns_name: &1["dns_name"], reason: &1["reason"]})
    }
  end

  defp log_transition(report, changed?, last_state) do
    cond do
      report.state == "ok" and changed? ->
        names = report.peers |> Enum.map(& &1["name"]) |> Enum.join(", ")
        Logger.info("TailnetPeers: #{length(report.peers)} peer(s) via #{report.via}: #{names}")

      report.state == "unavailable" and last_state != {report.state, report.error} ->
        Logger.warning(
          "TailnetPeers: discovery unavailable (#{report.error}); the fleet is remotes.json alone"
        )

      true ->
        :ok
    end
  end

  # ── One round ──

  @doc false
  def run_round(previous, opts \\ []) do
    base = %{state: "ok", via: nil, error: nil, peers: [], rejected: []}
    doc = Remotes.document()

    cond do
      not is_nil(Application.get_env(:shuttle, :remotes)) ->
        %{base | state: "disabled", error: "application config sets the fleet"}

      not Remotes.discover?(doc) ->
        %{
          base
          | state: "disabled",
            error: "defaults.discover is false in #{Remotes.config_path()}"
        }

      true ->
        read = Keyword.get(opts, :read_status, &read_status/0)
        probe = Keyword.get(opts, :probe, &probe/1)
        own = Keyword.get_lazy(opts, :own_host, &Shuttle.Poller.daemon_host_id/0)
        now = Keyword.get_lazy(opts, :now_ms, fn -> System.system_time(:millisecond) end)

        case isolated(read, @status_timeout_ms + 1_000) do
          {:ok, {:ok, %{"BackendState" => "Running"} = status, via}} ->
            found = discover(status, probe_all(status, probe), own, previous, now)
            %{base | via: via, peers: found.peers, rejected: found.rejected}

          {:ok, {:ok, status, via}} ->
            backend = Map.get(status, "BackendState") || "in an unknown state"
            %{base | state: "unavailable", via: via, error: "tailscale is #{backend}"}

          {:ok, {:error, via, reason}} ->
            %{base | state: "unavailable", via: via, error: reason}

          {:error, reason} ->
            %{
              base
              | state: "unavailable",
                error: "reading the tailnet status failed: #{format_reason(reason)}"
            }
        end
    end
  end

  defp probe_all(status, probe) do
    urls = status |> candidates() |> Enum.filter(& &1.online) |> Enum.map(& &1.url)

    # Unlinked, so a probe that raises or is killed becomes that peer's
    # rejection rather than a signal to this process.
    Shuttle.TaskSupervisor
    |> Task.Supervisor.async_stream_nolink(urls, probe,
      timeout: @probe_timeout_ms + 1_000,
      on_timeout: :kill_task,
      max_concurrency: 32
    )
    |> Enum.zip(urls)
    |> Map.new(fn
      {{:ok, %{} = result}, url} -> {url, result}
      {{:ok, other}, url} -> {url, %{"error" => "probe returned #{inspect(other)}"}}
      {{:exit, reason}, url} -> {url, %{"error" => format_reason(reason)}}
    end)
  end

  # Runs `fun` in an unlinked task under Shuttle.TaskSupervisor. A raise, an
  # exit or a timeout comes back as `{:error, reason}`, never as a signal to
  # the caller, so a broken tailscale install degrades a round to
  # "unavailable" instead of taking this process down with it.
  defp isolated(fun, timeout_ms) do
    task = Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fun)

    case Task.yield(task, timeout_ms) || Task.shutdown(task, :brutal_kill) do
      {:ok, result} -> {:ok, result}
      {:exit, reason} -> {:error, reason}
      nil -> {:error, :timeout}
    end
  end

  # ── The pure core ──

  @doc """
  Peers and rejections from one round's inputs.

    * `status` — the decoded tailnet status (`tailscale status --json`)
    * `probes` — `url => %{"body" => decoded_version}` for a peer that
      answered 200, `url => %{"error" => reason}` otherwise
    * `own_host` — this daemon's host id
    * `previous` — the last round's peers, for retention
    * `now_ms` — the round's wall clock, in milliseconds

  Returns `%{peers: [...], rejected: [...]}`; a peer is
  `%{"name", "url", "dns_name", "seen_at_ms"}`, a rejection
  `%{"dns_name", "reason"}`. Both are sorted.
  """
  @spec discover(map(), map(), String.t(), [map()], integer()) :: %{
          peers: [map()],
          rejected: [map()]
        }
  def discover(status, probes, own_host, previous \\ [], now_ms \\ 0) do
    previous_by_url = Map.new(previous, &{&1["url"], &1})
    self_user = get_in(status, ["Self", "UserID"])

    {kept, rejected} =
      status
      |> peer_nodes()
      |> Enum.reduce({[], []}, fn node, {kept, rejected} ->
        case candidate(node, self_user) do
          {:ok, cand} ->
            case judge(cand, Map.get(probes, cand.url), own_host, previous_by_url, now_ms) do
              {:peer, peer} -> {[peer | kept], rejected}
              {:reject, reason} -> {kept, [rejection(cand.dns_name, reason) | rejected]}
            end

          {:reject, dns_name, reason} ->
            {kept, [rejection(dns_name, reason) | rejected]}

          :skip ->
            {kept, rejected}
        end
      end)

    {peers, duplicates} =
      kept
      |> Enum.group_by(& &1["name"])
      |> Enum.reduce({[], []}, fn
        {_name, [peer]}, {peers, dups} ->
          {[peer | peers], dups}

        {name, many}, {peers, dups} ->
          reason = "host id #{name} is reported by #{length(many)} peers"
          {peers, Enum.map(many, &rejection(&1["dns_name"], reason)) ++ dups}
      end)

    %{
      peers: Enum.sort_by(peers, & &1["name"]),
      rejected: Enum.sort_by(duplicates ++ rejected, & &1["dns_name"])
    }
  end

  @doc false
  # The same-user peers of a status, as `%{dns_name, url, online}`.
  def candidates(status) do
    self_user = get_in(status, ["Self", "UserID"])

    status
    |> peer_nodes()
    |> Enum.flat_map(fn node ->
      case candidate(node, self_user) do
        {:ok, cand} -> [cand]
        _ -> []
      end
    end)
  end

  defp peer_nodes(%{"Peer" => %{} = peers}), do: Map.values(peers)
  defp peer_nodes(_), do: []

  defp candidate(%{} = node, self_user) do
    dns_name = node |> Map.get("DNSName") |> dns_name()

    cond do
      is_nil(dns_name) ->
        :skip

      is_nil(self_user) or Map.get(node, "UserID") != self_user ->
        {:reject, dns_name, "owned by another tailnet user"}

      true ->
        {:ok,
         %{
           dns_name: dns_name,
           url: "https://" <> dns_name,
           online: Map.get(node, "Online") == true
         }}
    end
  end

  defp candidate(_node, _self_user), do: :skip

  defp dns_name(value) when is_binary(value) do
    name = value |> String.trim() |> String.trim_trailing(".") |> String.downcase()
    if name != "" and Remote.valid_url_host?(name), do: name
  end

  defp dns_name(_), do: nil

  defp judge(cand, probe, own_host, previous_by_url, now_ms) do
    verdict =
      cond do
        not cand.online -> {:transient, "offline"}
        is_nil(probe) -> {:transient, "not probed"}
        Map.has_key?(probe, "body") -> judge_body(Map.get(probe, "body"), own_host)
        true -> {:transient, "probe failed: #{Map.get(probe, "error")}"}
      end

    case verdict do
      {:ok, host} ->
        {:peer, peer(host, cand, now_ms)}

      {:transient, reason} ->
        case Map.get(previous_by_url, cand.url) do
          %{"seen_at_ms" => seen} = prior when now_ms - seen < @retain_ms ->
            {:peer, Map.put(prior, "dns_name", cand.dns_name)}

          _ ->
            {:reject, reason}
        end

      {:reject, reason} ->
        {:reject, reason}
    end
  end

  defp judge_body(%{} = body, own_host) do
    host = Map.get(body, "host")

    cond do
      not is_binary(host) or host == "" ->
        {:reject, "reports no Shuttle host id"}

      host == own_host ->
        {:reject, "reports this host's own id"}

      not Regex.match?(@host_id, host) ->
        {:reject, "reports an unusable host id #{inspect(host)}"}

      Map.get(body, "ready") != true ->
        {:transient, "not ready"}

      true ->
        {:ok, host}
    end
  end

  defp judge_body(_body, _own_host), do: {:reject, "not a Shuttle daemon"}

  defp peer(host, cand, now_ms),
    do: %{"name" => host, "url" => cand.url, "dns_name" => cand.dns_name, "seen_at_ms" => now_ms}

  defp rejection(dns_name, reason), do: %{"dns_name" => dns_name, "reason" => reason}

  # ── Tailnet status ──

  @doc false
  # `{:ok, status, via}` or `{:error, via, reason}`.
  def read_status do
    if Remotes.tailscale_socket_configured?() do
      case Remotes.tailscale_socket() do
        nil -> {:error, "localapi", "defaults.tailscale_socket is invalid"}
        socket -> localapi_status(socket)
      end
    else
      cli_status()
    end
  end

  defp localapi_status(socket) do
    request =
      "GET /localapi/v0/status HTTP/1.0\r\nHost: local-tailscaled.sock\r\n" <>
        "Sec-Tailscale: localapi\r\n\r\n"

    deadline = deadline(@status_timeout_ms)

    result =
      case :gen_tcp.connect({:local, socket}, 0, [:binary, active: false], @status_timeout_ms) do
        {:ok, conn} ->
          try do
            with :ok <- :gen_tcp.send(conn, request),
                 {:ok, raw} <- recv_all(&:gen_tcp.recv(conn, 0, &1), deadline) do
              parse_response(raw)
            end
          after
            :gen_tcp.close(conn)
          end

        {:error, reason} ->
          {:error, {:connect, reason}}
      end

    case result do
      {:ok, 200, body} -> decode_status(body, "localapi")
      {:ok, code, _body} -> {:error, "localapi", "LocalAPI status answered HTTP #{code}"}
      {:error, reason} -> {:error, "localapi", "LocalAPI #{socket}: #{inspect(reason)}"}
    end
  end

  defp cli_status do
    case tailscale_cli() do
      nil ->
        {:error, "cli", "no executable tailscale CLI found"}

      path ->
        run = fn -> System.cmd(path, ["status", "--json"], stderr_to_stdout: true) end

        case isolated(run, @status_timeout_ms) do
          # `tailscale status` exits non-zero when stopped but still prints the
          # status, whose BackendState says why; warnings may precede the JSON.
          {:ok, {output, _code}} ->
            case :binary.match(output, "{") do
              {start, _} ->
                decode_status(binary_part(output, start, byte_size(output) - start), "cli")

              :nomatch ->
                {:error, "cli", "tailscale status: #{String.trim(output)}"}
            end

          {:error, :timeout} ->
            {:error, "cli", "tailscale status timed out"}

          {:error, reason} ->
            {:error, "cli", "#{path} status failed: #{format_reason(reason)}"}
        end
    end
  end

  @doc false
  # The first executable tailscale CLI: PATH, then the standard locations.
  # `:tailscale_cli_locations` application config replaces the whole search.
  def tailscale_cli do
    case Application.get_env(:shuttle, :tailscale_cli_locations) do
      nil -> System.find_executable("tailscale") || Enum.find(@cli_locations, &executable?/1)
      locations -> Enum.find(locations, &executable?/1)
    end
  end

  defp executable?(path) do
    case File.stat(path) do
      {:ok, %File.Stat{type: :regular, mode: mode}} -> Bitwise.band(mode, 0o111) != 0
      _ -> false
    end
  end

  defp decode_status(body, via) do
    case Jason.decode(body) do
      {:ok, %{} = status} -> {:ok, status, via}
      _ -> {:error, via, "tailscale status is not JSON"}
    end
  end

  # ── Probes ──

  @doc false
  # `%{"body" => decoded}` for a 200 answer, `%{"error" => reason}` otherwise.
  def probe(url) do
    version_url = url <> "/api/v1/version"

    result =
      case Remotes.tailscale_socket() do
        socket when is_binary(socket) ->
          %URI{host: host, path: path} = URI.parse(version_url)
          localapi_get(socket, host, path)

        nil ->
          Shuttle.RemoteRegistry.Client.Default.get(version_url, @probe_timeout_ms)
      end

    case result do
      {:ok, body} ->
        case Jason.decode(body) do
          {:ok, decoded} -> %{"body" => decoded}
          _ -> %{"body" => nil}
        end

      {:error, reason} ->
        %{"error" => format_reason(reason)}
    end
  end

  defp localapi_get(socket, host, path) do
    deadline = deadline(@probe_timeout_ms)

    case Shuttle.TailnetDial.Bridge.open_tls(socket, host, 443) do
      {:ok, tls} ->
        try do
          request = "GET #{path} HTTP/1.0\r\nHost: #{host}\r\nAccept: application/json\r\n\r\n"

          with :ok <- :ssl.send(tls, request),
               {:ok, raw} <- recv_all(&:ssl.recv(tls, 0, &1), deadline),
               {:ok, 200, body} <- parse_response(raw) do
            {:ok, body}
          else
            {:ok, code, _body} -> {:error, {:http_status, code}}
            {:error, reason} -> {:error, reason}
          end
        after
          :ssl.close(tls)
        end

      {:error, stage, reason} ->
        {:error, {stage, reason}}
    end
  end

  defp format_reason({:http_status, code}), do: "HTTP #{code}"

  defp format_reason({:failed_connect, details}) when is_list(details) do
    case List.keyfind(details, :inet, 0) do
      {:inet, _families, reason} -> "connect: #{format_reason(reason)}"
      _ -> "connect failed"
    end
  end

  defp format_reason(reason) when is_atom(reason), do: Atom.to_string(reason)

  defp format_reason({%{__exception__: true} = error, _stacktrace}),
    do: Exception.message(error)

  defp format_reason(reason) when is_binary(reason), do: reason
  defp format_reason(reason), do: inspect(reason)

  # ── HTTP/1.0 over a raw socket ──

  defp deadline(ms), do: System.monotonic_time(:millisecond) + ms

  # Reads until the server closes, which an HTTP/1.0 exchange guarantees.
  defp recv_all(recv, deadline, acc \\ []) do
    remaining = deadline - System.monotonic_time(:millisecond)

    cond do
      remaining <= 0 ->
        {:error, :timeout}

      IO.iodata_length(acc) > @max_response_bytes ->
        {:error, :response_too_large}

      true ->
        case recv.(remaining) do
          {:ok, data} -> recv_all(recv, deadline, [acc, data])
          {:error, :closed} -> {:ok, IO.iodata_to_binary(acc)}
          {:error, reason} -> {:error, reason}
        end
    end
  end

  defp parse_response(raw) do
    with [head, body] <- :binary.split(raw, "\r\n\r\n"),
         [status_line | _] <- String.split(head, "\r\n"),
         ["HTTP/" <> _, code | _] <- String.split(status_line, " ", parts: 3),
         {code, ""} <- Integer.parse(code) do
      {:ok, code, body}
    else
      _ -> {:error, :malformed_response}
    end
  end
end
