defmodule Shuttle.Projects do
  @moduledoc """
  The curated picker-project list — the Stash/Capture "city" set a human files
  new work into.

  Deliberately **separate** from `Shuttle.FeltStores`. The two lists answer two
  different questions and must not be conflated:

    * **poll-stores** (`FeltStores`) — where the daemon *enumerates* fibers. On
      macOS this is scoped to `~/loom` (outside `~/Documents`) so the daemon
      never reads Full-Disk-Access / TCC-protected paths; substores are reached
      by following the symlinks under `loom/.felt/`.
    * **picker-projects** (this module) — which project *checkouts* a human can
      file into. These live under `~/Documents/projects/*` (and remotes' own
      trees), the very TCC-protected paths the poll list stays out of.

  Reusing one list for both drags polling into TCC-protected territory (the bug
  this split exists to prevent). So the picker gets its own file.

  Source: `~/.config/felt/projects.json` →
  `%{"version" => 1, "projects" => [absolute path, ...]}` (a bare JSON array is
  also accepted). Absent/empty file → `[]`, and the forms fall back to their
  store-registry + current-cards derivation, so an uncurated host is never worse
  off than before. Hand-editable; the owning host serves it via
  `/api/v1/felt-stores` (`origins.<host>.projects`).
  """

  @config_env "FELT_PROJECTS_FILE"
  @default_config_path "~/.config/felt/projects.json"

  @type project_list :: [String.t()]

  @doc """
  The curated project directories for this host, in file order (de-duplicated).

  Resolution: `FELT_PROJECTS` env (comma-separated) when set, else the persisted
  `~/.config/felt/projects.json`. Empty everywhere → `[]`.
  """
  @spec configured_projects() :: project_list()
  def configured_projects do
    case env_projects() do
      [_ | _] = projects -> projects
      [] -> registered_projects()
    end
  end

  @spec registered_projects() :: project_list()
  def registered_projects do
    path = config_path()

    with true <- File.exists?(path),
         {:ok, content} <- File.read(path),
         {:ok, decoded} <- Jason.decode(content) do
      case decoded do
        %{"projects" => projects} when is_list(projects) -> normalize(projects)
        projects when is_list(projects) -> normalize(projects)
        _ -> []
      end
    else
      _ -> []
    end
  end

  @doc """
  Persist the curated project list, atomically. An empty list deletes the file.
  Returns `{:ok, normalized}` or `{:error, reason}`.
  """
  @spec save(project_list()) :: {:ok, project_list()} | {:error, term()}
  def save(projects) when is_list(projects) do
    normalized = normalize(projects)
    path = config_path()

    try do
      case normalized do
        [] ->
          case File.rm(path) do
            :ok -> {:ok, normalized}
            {:error, :enoent} -> {:ok, normalized}
            {:error, reason} -> {:error, {:file_error, reason}}
          end

        _ ->
          File.mkdir_p!(Path.dirname(path))
          tmp = path <> ".tmp"
          payload = Jason.encode!(%{version: 1, projects: normalized}, pretty: true) <> "\n"
          File.write!(tmp, payload)
          File.rename!(tmp, path)
          {:ok, normalized}
      end
    rescue
      error -> {:error, error}
    end
  end

  @spec config_path() :: String.t()
  def config_path do
    case System.get_env(@config_env) do
      v when is_binary(v) and v != "" -> Path.expand(v)
      _ -> Path.expand(@default_config_path)
    end
  end

  @spec env_projects() :: project_list()
  def env_projects do
    case System.get_env("FELT_PROJECTS") do
      v when is_binary(v) and v != "" -> v |> String.split(",") |> normalize()
      _ -> []
    end
  end

  @spec normalize(list()) :: project_list()
  def normalize(projects) do
    projects
    |> Enum.filter(&is_binary/1)
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.map(&Path.expand/1)
    |> Enum.uniq()
  end
end
