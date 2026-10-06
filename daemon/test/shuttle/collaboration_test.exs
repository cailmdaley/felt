defmodule Shuttle.CollaborationTest do
  use ExUnit.Case, async: true

  alias Shuttle.Collaboration

  @collaborator "01KTS261GJMMRDRHS2QDMEFV3K"
  @role "01KTS261GJMMRDRHS2QDMEFV3M"

  test "accepts role-to-collaborator slug assignments, including role-only assignments" do
    assert {:ok, %{"vizier" => ["fable", "astra"], "organizer" => ["opus"]}} =
             Collaboration.parse(%{"vizier" => ["fable", "astra"], "organizer" => ["opus"]})

    assert {:ok, %{"vizier" => []}} = Collaboration.parse(%{"vizier" => []})

    assert {:ok, %{"role" => ["collaborator"]}} =
             Collaboration.parse(%{"role" => ["collaborator"]})
  end

  test "rejects malformed paths and duplicate collaborator slugs" do
    for assignment <- [
          %{"../vizier" => ["fable"]},
          %{"vizier/notes" => ["fable"]},
          %{"vizier\n" => ["fable"]},
          %{"Vizier" => ["fable"]},
          %{"vizier" => ["../fable"]},
          %{"vizier" => ["fable\n"]},
          %{"vizier" => ["fable/notes"]},
          %{"vizier" => ["fable", "fable"]},
          %{"vizier" => "fable"}
        ] do
      assert {:error, _} = Collaboration.parse(assignment)
    end

    assert {:error, _} =
             Collaboration.parse(%{
               "role" => %{"uid" => @role},
               "vizier" => ["fable"]
             })
  end

  test "accepts UID-only references and keeps optional origins as metadata" do
    assert {:ok,
            %{
              "collaborator" => %{"uid" => @collaborator},
              "role" => %{"uid" => @role, "origin" => "old-host"}
            }} =
             Collaboration.parse(%{
               "collaborator" => %{"uid" => @collaborator},
               "role" => %{"uid" => @role, "origin" => "old-host"}
             })

    assert {:ok, %{"role" => %{"uid" => @role, "origin" => ""}}} =
             Collaboration.parse(%{"role" => %{"uid" => @role, "origin" => ""}})
  end

  test "rejects empty, unknown, and malformed collaboration references" do
    assert {:ok, nil} = Collaboration.parse(nil)
    assert {:error, _} = Collaboration.parse(%{})
    assert {:error, _} = Collaboration.parse(%{"extra" => %{}})
    assert {:error, _} = Collaboration.parse(%{"role" => %{"uid" => @role, "extra" => "x"}})
    assert {:error, _} = Collaboration.parse(%{"role" => %{"uid" => @role, "origin" => 7}})
    assert {:error, _} = Collaboration.parse(%{"role" => %{"uid" => @role, "origin" => "local"}})
    assert {:error, _} = Collaboration.parse(%{"role" => %{"uid" => @role, "origin" => "Host-A"}})

    for uid <- ["not-a-ulid", String.duplicate("0", 25), "81KTS261GJMMRDRHS2QDMEFV3M"] do
      assert {:error, _} = Collaboration.parse(%{"role" => %{"uid" => uid}})
    end
  end

  test "normalizes many valid UIDs independently of legacy origins" do
    state = :rand.seed_s(:exsss, {14, 29, 2026})

    {cases, _state} =
      Enum.reduce(1..128, {[], state}, fn index, {cases, state} ->
        {first, state} = :rand.uniform_s(8, state)
        {tail, state} = random_ulid_tail(state)
        uid = Integer.to_string(first - 1) <> tail
        origin = if rem(index, 2) == 0, do: "host-#{index}", else: ""
        {[{uid, origin} | cases], state}
      end)

    assert 128 = length(cases)

    Enum.each(cases, fn {uid, origin} ->
      assert {:ok, %{"role" => %{"uid" => ^uid}}} =
               Collaboration.parse(%{"role" => %{"uid" => uid, "origin" => origin}})
    end)
  end

  test "prompt resolves references from the local shared store and ignores origins" do
    prompt =
      Collaboration.prompt_section(
        {:ok,
         %{
           "collaborator" => %{"uid" => @collaborator},
           "role" => %{"uid" => @role, "origin" => "stale-host"}
         }},
        "/tmp/shared loom"
      )

    assert prompt ==
             "Collaboration: collaborator #{@collaborator}, role #{@role}; " <>
               "role store: /tmp/shared loom"

    refute prompt =~ "stale-host"
    refute prompt =~ "response.host"
    refute prompt =~ "/api/v1/fibers"
  end

  test "prompt names only an unambiguous assigned pair" do
    prompt =
      Collaboration.prompt_section({:ok, %{"vizier" => ["fable"]}}, "/tmp/shared loom")

    # The store resolves through its realpath; on macOS /tmp is /private/tmp.
    assert prompt =~
             ~r"\ACollaboration: fable in role vizier; role store: (/private)?/tmp/shared loom\z"
  end

  @tag :tmp_dir
  test "readable role paths use the enclosing shared store from project and constitution views",
       %{
         tmp_dir: tmp_dir
       } do
    loom = Path.join(tmp_dir, "loom")
    project = Path.join(tmp_dir, "project")
    constitution = Path.join(tmp_dir, "constitution")
    project_view = Path.join([loom, ".felt", "projects", "weak-lensing"])
    constitution_view = Path.join(project_view, "constitution")
    local_notes = Path.join([project_view, "roles", "vizier", "fable.md"])
    constitution_notes = Path.join([constitution_view, "roles", "vizier", "fable.md"])
    global_identity = Path.join([loom, ".felt", "roles", "vizier", "fable.md"])

    File.mkdir_p!(Path.dirname(local_notes))
    File.mkdir_p!(Path.dirname(constitution_notes))
    File.mkdir_p!(Path.dirname(global_identity))
    File.write!(local_notes, "task-local notes")
    File.write!(constitution_notes, "constitution-local notes")
    File.write!(global_identity, "global collaborator identity")
    File.mkdir_p!(project)
    File.mkdir_p!(constitution)
    File.ln_s!(project_view, Path.join(project, ".felt"))
    File.ln_s!(constitution_view, Path.join(constitution, ".felt"))

    collaboration = {:ok, %{"vizier" => ["fable"]}}

    for store <- [
          project,
          Path.join(project, ".felt"),
          constitution,
          Path.join(constitution, ".felt")
        ] do
      prompt = Collaboration.prompt_section(collaboration, store)

      assert prompt == "Collaboration: fable in role vizier; role store: #{loom}"
    end
  end

  test "role-only and multi-role prompts do not print a participant roster" do
    role_only = Collaboration.prompt_section({:ok, %{"vizier" => []}})
    assert role_only == "Collaboration: role vizier, no collaborator named"
    refute role_only =~ "participants"

    multi =
      Collaboration.prompt_section(
        {:ok, %{"vizier" => ["fable", "astra"], "organizer" => ["opus"]}}
      )

    assert multi == "Collaboration: several assignments on the roster"
    refute multi =~ "vizier"
    refute multi =~ "fable"
    refute multi =~ "astra"
    refute multi =~ "organizer"
    refute multi =~ "opus"
  end

  test "a fiber without a roster is prompted to take up and assign a role" do
    prompt = Collaboration.prompt_section({:ok, nil}, "/tmp/shared loom")

    assert prompt =~
             ~r"\ACollaboration: no roster — before substantive work, take up the role that fits \(felt find -t role\) or create one, and assign it \(shuttle assign\); role store: (/private)?/tmp/shared loom\z"

    assert Collaboration.prompt_section({:ok, nil}) ==
             "Collaboration: no roster — before substantive work, take up the role that fits " <>
               "(felt find -t role) or create one, and assign it (shuttle assign)"
  end

  test "no snapshot or a non-result renders no collaboration line" do
    assert Collaboration.prompt_section(nil) == ""
    assert Collaboration.prompt_section(:junk, "/tmp/loom") == ""
  end

  test "malformed document metadata remains visible in the worker prompt" do
    assert Collaboration.prompt_section({:error, "collaboration must be an object"}) ==
             "Collaboration: invalid metadata (collaboration must be an object)"
  end

  defp random_ulid_tail(state) do
    alphabet = String.to_charlist("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    Enum.map_reduce(1..25, state, fn _, state ->
      {index, state} = :rand.uniform_s(length(alphabet), state)
      {Enum.at(alphabet, index - 1), state}
    end)
    |> then(fn {chars, state} -> {List.to_string(chars), state} end)
  end
end
