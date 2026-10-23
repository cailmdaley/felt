defmodule Shuttle.CodexEndpoint do
  @moduledoc "Host-local control paths; persistent Codex configuration and credentials stay in CODEX_HOME."
  import Bitwise

  # :inet.gethostname/0 shortens at the first dot. The raw kernel hostname
  # must agree with Go's os.Hostname, including FQDNs on cluster hosts.
  def hostname_source, do: &:net.gethostname/0

  def current(read_hostname \\ hostname_source()) do
    with {:ok, hostname} <- read_hostname.() do
      resolve(
        Shuttle.Env.get("SHUTTLE_CODEX_SOCKET") || "",
        Shuttle.Host.euid(),
        List.to_string(hostname)
      )
    end
  end

  def resolve("", uid, hostname) when is_integer(uid) and uid >= 0 and hostname != "" do
    hash = :crypto.hash(:sha256, hostname) |> Base.encode16(case: :lower) |> binary_part(0, 16)
    {:ok, "/tmp/shuttle-codex-#{uid}-#{hash}/control.sock"}
  end

  def resolve(override, _uid, _hostname) when is_binary(override) and override != "" do
    if Path.type(override) == :absolute and Path.expand(override) == override and
         byte_size(override) <= 100 and not String.contains?(override, ["\0", "\n", "\r"]) do
      {:ok, override}
    else
      {:error,
       "SHUTTLE_CODEX_SOCKET must be a clean absolute Unix socket path of at most 100 bytes"}
    end
  end

  def resolve(_, _, _), do: {:error, "cannot establish OS uid and hostname for Codex endpoint"}

  @doc "Create or adopt only a real, owner-only endpoint root; never repair a hostile precreated path."
  def ensure_root(endpoint, uid \\ Shuttle.Host.euid()) do
    parent = Path.dirname(endpoint)

    with :ok <- ancestors(Path.dirname(parent), uid),
         :ok <- create_root(parent),
         {:ok, %File.Stat{type: :directory, uid: ^uid, mode: mode}} <- File.lstat(parent),
         true <- (mode &&& 0o777) == 0o700 do
      :ok
    else
      error -> {:error, "unsafe Codex endpoint root #{parent}: #{inspect(error)}"}
    end
  end

  @doc "Accept a private socket or Codex 0.162.1's exact protected rendezvous alias, never an arbitrary symlink."
  def verify_socket(endpoint, uid \\ Shuttle.Host.euid()) do
    case File.lstat(endpoint) do
      {:error, :enoent} ->
        :ok

      {:ok, %File.Stat{uid: ^uid, mode: mode}}
      when (mode &&& 0o170000) == 0o140000 and (mode &&& 0o077) == 0 ->
        :ok

      {:ok, %File.Stat{type: :symlink, uid: ^uid}} ->
        verify_alias(endpoint, uid)

      other ->
        {:error, "unsafe Codex socket #{endpoint}: #{inspect(other)}"}
    end
  end

  defp verify_alias(endpoint, uid) do
    tmp =
      case File.read_link("/tmp") do
        {:ok, target} when target in ["/private/tmp", "private/tmp"] -> "/private/tmp"
        _ -> "/tmp"
      end

    literal =
      if String.starts_with?(endpoint, "/tmp/"),
        do: tmp <> String.trim_leading(endpoint, "/tmp"),
        else: endpoint

    hash = :crypto.hash(:sha256, literal) |> Base.encode16(case: :lower)
    root = Path.join(tmp, "codex-daemon-#{uid}")
    expected = Path.join(root, hash)

    with {:ok, ^expected} <- File.read_link(endpoint),
         {:ok, %File.Stat{type: :directory, uid: ^uid, mode: mode}} <- File.lstat(root),
         true <- (mode &&& 0o777) == 0o700 do
      case File.lstat(expected) do
        {:ok, %File.Stat{uid: ^uid, mode: mode}}
        when (mode &&& 0o170000) == 0o140000 and (mode &&& 0o077) == 0 ->
          :ok

        # A dangling genuine alias is not removed or taken as proof of death.
        {:error, :enoent} ->
          :ok

        other ->
          {:error, "unsafe Codex protected socket: #{inspect(other)}"}
      end
    else
      other -> {:error, "unsafe Codex rendezvous alias #{endpoint}: #{inspect(other)}"}
    end
  end

  defp create_root(parent) do
    case File.lstat(parent) do
      {:error, :enoent} ->
        # umask belongs to this short-lived shell, never the BEAM process.
        # A losing creator still validates the winner's owner/type/mode.
        case Shuttle.Runner.Default.cmd("sh", ["-c", "umask 077; mkdir \"$1\"", "sh", parent],
               stderr_to_stdout: true,
               timeout_ms: 3_000
             ) do
          {_, 0} -> :ok
          failure -> if File.exists?(parent), do: :ok, else: {:error, failure}
        end

      {:ok, _} ->
        :ok

      error ->
        error
    end
  end

  # /tmp is the OS-provided alias for /private/tmp on macOS. No other
  # symlink component is accepted, including inside an explicit override.
  defp ancestors("/", _uid), do: :ok

  defp ancestors("/tmp", uid) do
    case File.lstat("/tmp") do
      {:ok, %File.Stat{type: :symlink, uid: 0}} ->
        with {:ok, target} when target in ["/private/tmp", "private/tmp"] <-
               File.read_link("/tmp"),
             do: ancestors("/private/tmp", uid)

      _ ->
        directory("/tmp", uid)
    end
  end

  defp ancestors(path, uid) do
    with :ok <- ancestors(Path.dirname(path), uid), do: directory(path, uid)
  end

  defp directory(path, uid) do
    case File.lstat(path) do
      {:ok, %File.Stat{type: :directory, uid: owner, mode: mode}}
      when owner == 0 or owner == uid ->
        if (mode &&& 0o022) == 0 or (owner == 0 and (mode &&& 0o1000) != 0),
          do: :ok,
          else: {:error, {:writable_ancestor, path}}

      other ->
        {:error, {:unsafe_ancestor, path, other}}
    end
  end
end
