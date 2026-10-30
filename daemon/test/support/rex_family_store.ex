defmodule Shuttle.Test.RexFamilyStore do
  @moduledoc "Small on-disk fiber trees for Rex family tests."

  def write(root, constitutions, notes \\ []) do
    store = Path.join(root, "family-store")

    for {paths, tags} <- [{constitutions, "[constitution]"}, {notes, "[]"}], path <- paths do
      file = Path.join([store, ".felt", path, Path.basename(path) <> ".md"])
      File.mkdir_p!(Path.dirname(file))
      File.write!(file, "---\nname: #{Path.basename(path)}\ntags: #{tags}\n---\n")
    end

    registry = Path.join(root, "family-stores.json")
    File.write!(registry, Jason.encode!(%{"felt_stores" => [store]}))
    Shuttle.Test.Env.delete_env("SHUTTLE_STORES")
    Shuttle.Test.Env.put_env("SHUTTLE_STORES_FILE", registry)
    store
  end
end
