defmodule Shuttle.CarriedDocument do
  @moduledoc """
  The owner's adopt step for a remote `shuttle resume` or `shuttle dispatch`.

  The caller sends its copy of the constitution as `document` (the raw fiber
  file text), with `carry: true` to insist on it. Before the verb runs, the
  owner writes the document to a temporary file and shells
  `shuttle adopt <fiber> --document-file <file> [--carry]` through
  `Shuttle.LifecycleService`, inside the Poller like every other lifecycle
  write. A copy this host already holds (its `shuttle:` block names this host)
  stands unless `carry` is set; any other copy takes the caller's document.
  adopt's output says which happened and what differed; the controllers pass it
  back to the caller.

  A request without `document` adopts nothing.
  """

  alias Shuttle.LifecycleService

  @spec adopt(map(), String.t()) ::
          {:ok, String.t()}
          | {:command_error, non_neg_integer() | :timeout, String.t()}
          | {:error, String.t()}
          | {:error, :not_found | :timeout | :unavailable, String.t()}
  def adopt(%{"document" => document} = params, identifier)
      when is_binary(document) and is_binary(identifier) do
    path =
      Path.join(System.tmp_dir!(), "shuttle-carried-#{System.unique_integer([:positive])}.md")

    case Shuttle.FS.write_private(path, document) do
      :ok ->
        try do
          LifecycleService.transition(
            :adopt,
            identifier,
            ["--document-file", path] ++ if(params["carry"] == true, do: ["--carry"], else: []),
            params["fiber_path"]
          )
        after
          Shuttle.FS.rm(path)
        end

      {:error, reason} ->
        {:error, "writing the carried document: #{Shuttle.FS.format_error(reason)}"}
    end
  end

  def adopt(_params, _identifier), do: {:ok, ""}
end
