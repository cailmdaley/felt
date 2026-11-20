defmodule ShuttleWeb.DeployRunController do
  @moduledoc """
  Agent-API endpoints for a deploy run: a script the caller supplies, started
  detached from this daemon so that it outlives the daemon it replaces.
  `bin/shuttle-deploy` reaches a remote host this way over the tailnet, in
  place of ssh.

      POST   /api/v1/deploy/runs                       201 {id, dir}
      PUT    /api/v1/deploy/runs/:id/files/:name       204; raw body to <dir>/<name>
      POST   /api/v1/deploy/runs/:id/start             202; raw body is the script
      GET    /api/v1/deploy/runs/:id/output?offset=N   200; output bytes from N
      POST   /api/v1/deploy/runs/:id/cancel            202; creates <dir>/cancel
      DELETE /api/v1/deploy/runs/:id                   204 removed | 409 still running

  A run is a directory under `~/.shuttle/deploy/runs/<id>` and nothing else:
  any daemon incarnation serves any run, so a caller keeps reading across the
  restart its own run causes. `start` writes the body to `<dir>/launch`, once,
  and runs `bash launch` in that directory in a new session, with stdin from
  `/dev/null` and stdout and stderr appended to `<dir>/out`. The script
  inherits the daemon's environment without the release's Erlang runtime
  (`ROOTDIR`, `BINDIR`, `EMU`, `PROGNAME`, `RELEASE_*` and every `PATH` entry
  under the release root) or harness session identity, so it keeps what the
  daemon's supervisor gave it (`XDG_RUNTIME_DIR` and the user bus that
  `systemctl --user` needs, among them). Its exit status lands in
  `<dir>/status`.

  Every output read writes the time to `<dir>/beat`, and `cancel` creates
  `<dir>/cancel`. The daemon gives neither a meaning: the script decides how to
  treat a stale beat or a cancel. An output response carries `x-deploy-status`
  once the run has exited and the response reaches the end of its output.
  Uploads may not take the names the run itself writes. Runs older than a day
  are removed when a new one is created.

  Who may ask is whoever may use the daemon's other control routes: on a
  tailnet, any peer `tailscale serve` admits. A run executes arbitrary shell
  as the daemon's user, which those routes already allow by launching agents.
  These routes are available during boot (`ShuttleWeb.ReadinessPlug`).
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.FS

  import Plug.Conn

  @id ~r/\A[0-9a-f]{24}\z/
  @name ~r/\A[a-z0-9][a-z0-9._-]*\z/
  @reserved ~w(launch out status status.tmp beat cancel)
  @chunk 1_048_576
  @max_age_seconds 86_400

  # Daemonize, then wait for the script and record its exit status. Python
  # because setsid(1) is absent on macOS; every host that deploys has python3.
  # argv: run directory, release root ("" under Mix).
  @detach ~S"""
  import os, sys
  if os.fork():
      os._exit(0)
  os.setsid()
  os.chdir(sys.argv[1])
  null = os.open(os.devnull, os.O_RDONLY)
  out = os.open("out", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
  os.dup2(null, 0); os.dup2(out, 1); os.dup2(out, 2)
  os.closerange(3, 65536)
  root = sys.argv[2].rstrip("/")
  drop = {"ROOTDIR", "BINDIR", "EMU", "PROGNAME", "ESCRIPT_NAME", "AI_AGENT", "PI_SESSION_ID",
          "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_THREAD_ID"}
  env = {k: v for k, v in os.environ.items()
         if k not in drop and not k.startswith(("RELEASE_", "ANTIGRAVITY_"))}
  path = [p for p in env.get("PATH", "").split(":")
          if p and not (root and (p == root or p.startswith(root + "/")))]
  env["PATH"] = ":".join(path or ["/usr/local/bin", "/usr/bin", "/bin"])
  pid = os.fork()
  if pid == 0:
      os.execvpe("bash", ["bash", "launch"], env)
  status = os.waitpid(pid, 0)[1]
  code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
  with open("status.tmp", "w") as f:
      f.write("%d\n" % code)
  os.rename("status.tmp", "status")
  """

  def create(conn, _params) do
    root = root()
    prune(root)
    id = Base.encode16(:crypto.strong_rand_bytes(12), case: :lower)
    dir = Path.join(root, id)

    with :ok <- FS.mkdir_p(root),
         :ok <- FS.mkdir(dir),
         :ok <- FS.chmod(dir, 0o700) do
      conn |> put_status(201) |> json(%{id: id, dir: dir})
    else
      {:error, reason} -> error(conn, 500, "cannot create #{dir}: #{FS.format_error(reason)}")
    end
  end

  def put_file(conn, %{"id" => id, "name" => name}) do
    with {:ok, dir} <- run_dir(id),
         true <-
           (Regex.match?(@name, name) and name not in @reserved and
              not String.ends_with?(name, ".part")) || {:error, 400, "invalid file name"},
         {:ok, conn} <- receive_to(conn, Path.join(dir, name)) do
      send_resp(conn, 204, "")
    else
      {:error, status, message} -> error(conn, status, message)
    end
  end

  def start(conn, %{"id" => id}) do
    with {:ok, dir} <- run_dir(id),
         {:ok, python} <- python(),
         {:ok, conn} <- receive_launch(conn, Path.join(dir, "launch")) do
      args = ["-c", @detach, dir, Shuttle.Dispatcher.release_root() || ""]

      case Shuttle.Env.cmd(python, args, cd: dir, stderr_to_stdout: true) do
        {_, 0} -> conn |> put_status(202) |> json(%{id: id, dir: dir})
        {out, code} -> error(conn, 500, "could not start the run (exit #{code}): #{out}")
      end
    else
      {:error, status, message} -> error(conn, status, message)
    end
  end

  def output(conn, %{"id" => id} = params) do
    with {:ok, dir} <- run_dir(id),
         {:ok, offset} <- offset(params["offset"]) do
      FS.write(Path.join(dir, "beat"), "#{System.os_time(:second)}\n")
      status = FS.read(Path.join(dir, "status"))
      {bytes, size} = read_from(Path.join(dir, "out"), offset)

      conn =
        case status do
          {:ok, code} when offset + byte_size(bytes) >= size ->
            put_resp_header(conn, "x-deploy-status", String.trim(code))

          _ ->
            conn
        end

      conn |> put_resp_content_type("application/octet-stream") |> send_resp(200, bytes)
    else
      {:error, status, message} -> error(conn, status, message)
    end
  end

  def cancel(conn, %{"id" => id}) do
    with {:ok, dir} <- run_dir(id) do
      FS.write(Path.join(dir, "cancel"), "")
      conn |> put_status(202) |> json(%{cancel: true})
    else
      {:error, status, message} -> error(conn, status, message)
    end
  end

  def delete(conn, %{"id" => id}) do
    with {:ok, dir} <- run_dir(id) do
      if FS.exists?(Path.join(dir, "status")) or not FS.exists?(Path.join(dir, "launch")) do
        FS.rm_rf(dir)
        send_resp(conn, 204, "")
      else
        error(conn, 409, "still running; cancel it first")
      end
    else
      {:error, status, message} -> error(conn, status, message)
    end
  end

  defp root,
    do: Shuttle.Env.app(:deploy_runs_dir) || Path.join(Shuttle.Env.home(), ".shuttle/deploy/runs")

  defp run_dir(id) do
    dir = Path.join(root(), id)

    if Regex.match?(@id, id) and FS.dir?(dir),
      do: {:ok, dir},
      else: {:error, 404, "no deploy run #{id}"}
  end

  # The exclusive create is the start's one-time claim.
  defp receive_launch(conn, path) do
    case FS.open(path, [:write, :binary, :exclusive]) do
      {:ok, file} ->
        result = copy_body(conn, file)
        FS.close(file)

        with {:error, reason} <- result do
          FS.rm(path)
          {:error, 500, "could not receive the launch script: #{inspect(reason)}"}
        end

      {:error, :eexist} ->
        {:error, 409, "already started"}

      {:error, reason} ->
        {:error, 500, "cannot write #{path}: #{FS.format_error(reason)}"}
    end
  end

  defp python do
    case Shuttle.Env.find_executable("python3") do
      nil -> {:error, 500, "python3 is not on the daemon's PATH"}
      path -> {:ok, path}
    end
  end

  defp offset(nil), do: {:ok, 0}

  defp offset(text) do
    case Integer.parse(text) do
      {n, ""} when n >= 0 -> {:ok, n}
      _ -> {:error, 400, "invalid offset"}
    end
  end

  defp read_from(path, offset) do
    case FS.open(path, [:read, :binary]) do
      {:ok, file} ->
        {:ok, %{size: size}} = FS.stat(path)

        bytes =
          case FS.pread(file, offset, @chunk) do
            {:ok, data} -> data
            _ -> ""
          end

        FS.close(file)
        {bytes, size}

      {:error, _} ->
        {"", 0}
    end
  end

  defp receive_to(conn, path) do
    tmp = path <> ".part"

    case FS.open(tmp, [:write, :binary]) do
      {:ok, file} ->
        result = copy_body(conn, file)
        FS.close(file)

        with {:ok, conn} <- result,
             :ok <- FS.rename(tmp, path) do
          {:ok, conn}
        else
          {:error, reason} ->
            FS.rm(tmp)
            {:error, 500, "could not receive #{Path.basename(path)}: #{inspect(reason)}"}
        end

      {:error, reason} ->
        {:error, 500, "cannot write #{path}: #{FS.format_error(reason)}"}
    end
  end

  defp copy_body(conn, file) do
    timeout = ShuttleWeb.LargeBodyParser.read_timeout()

    case read_body(conn, length: @chunk, read_length: @chunk, read_timeout: timeout) do
      {:ok, data, conn} -> with :ok <- FS.write(file, data), do: {:ok, conn}
      {:more, data, conn} -> with :ok <- FS.write(file, data), do: copy_body(conn, file)
      {:error, reason} -> {:error, reason}
    end
  end

  defp prune(root) do
    cutoff = System.os_time(:second) - @max_age_seconds

    with {:ok, ids} <- FS.ls(root) do
      for id <- ids, Regex.match?(@id, id), dir = Path.join(root, id), newest(dir) < cutoff do
        FS.rm_rf(dir)
      end
    end
  end

  defp newest(dir) do
    [dir, Path.join(dir, "out"), Path.join(dir, "beat")]
    |> Enum.map(fn path ->
      case FS.stat(path, time: :posix) do
        {:ok, %{mtime: mtime}} -> mtime
        _ -> 0
      end
    end)
    |> Enum.max()
  end

  defp error(conn, status, message) do
    conn |> put_status(status) |> json(%{error: message})
  end
end
