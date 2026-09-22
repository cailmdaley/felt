defmodule Shuttle.CollaborationTest do
  use ExUnit.Case, async: true

  alias Shuttle.Collaboration

  @collaborator "01KTS261GJMMRDRHS2QDMEFV3K"
  @role "01KTS261GJMMRDRHS2QDMEFV3M"

  test "accepts optional collaborator and role pointers with explicit origins" do
    assert {:ok,
            %{
              "collaborator" => %{"uid" => @collaborator, "origin" => "host-a"},
              "role" => %{"uid" => @role, "origin" => "host-b"}
            }} =
             Collaboration.parse(%{
               "collaborator" => %{"uid" => @collaborator, "origin" => "host-a"},
               "role" => %{"uid" => @role, "origin" => "host-b"}
             })
  end

  test "rejects empty, unknown, and incomplete collaboration references" do
    assert {:error, _} = Collaboration.parse(%{})
    assert {:error, _} = Collaboration.parse(%{"extra" => %{}})
    assert {:error, _} = Collaboration.parse(%{"role" => %{"uid" => @role}})

    assert {:error, _} =
             Collaboration.parse(%{"role" => %{"uid" => "not-a-ulid", "origin" => "host"}})

    assert {:error, _} = Collaboration.parse(%{"role" => %{"uid" => @role, "origin" => "Host-A"}})
    assert {:error, _} = Collaboration.parse(%{"role" => %{"uid" => @role, "origin" => "local"}})
  end

  test "prompt points to owner-routed reads and demands host plus uid verification" do
    prompt =
      Collaboration.prompt_section({
        :ok,
        %{"collaborator" => %{"uid" => @collaborator, "origin" => "host-a"}}
      })

    assert prompt =~ "/api/v1/fibers/#{@collaborator}?body=true&origin=host-a"
    assert prompt =~ "fiber.uid and response.host"
    assert prompt =~ "Never substitute a local git mirror"
  end

  test "malformed document metadata remains visible in the worker prompt" do
    assert Collaboration.prompt_section({:error, "collaboration must be an object"}) =~
             "invalid"
  end
end
