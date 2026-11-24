defmodule Shuttle.Terminal.RexLayoutRehomeTest do
  use ExUnit.Case, async: true

  alias Shuttle.Terminal.RexLayout

  test "non-owning host does not create Tab 1 root view for a split-host family" do
    now = ~U[2026-11-24 10:00:00Z]

    root = %{
      "uid" => "01ROOT",
      "slug" => "life/desk",
      "status" => "active",
      "shuttle" => %{"kind" => "oneshot", "host" => "remote-hub"}
    }

    child = %{
      "uid" => "01CHILD",
      "slug" => "life/desk/local-task",
      "status" => "active",
      "shuttle" => %{"kind" => "oneshot", "host" => "laptop"}
    }

    bindings = %{
      "local-task-01CHILD-shuttle" => %{
        "session_id" => "session:1",
        "window_id" => "window:2",
        "block_id" => "block:2",
        "family" => "life/desk",
        "fiber" => "life/desk/local-task"
      }
    }

    desired =
      RexLayout.desired(%{
        fibers: [root, child],
        family_fibers: [root, child],
        bindings: bindings,
        own_host_id: "laptop",
        now: now
      })

    fam = desired.families["life/desk"]
    assert fam != nil
    assert fam.view == nil
    assert Enum.map(fam.places, & &1.uid) == ["01CHILD"]
  end

  test "owning host keeps Tab 1 root view" do
    now = ~U[2026-11-24 10:00:00Z]

    root = %{
      "uid" => "01ROOT",
      "slug" => "life/desk",
      "status" => "active",
      "shuttle" => %{"kind" => "oneshot", "host" => "remote-hub"}
    }

    bindings = %{
      "desk-01ROOT-shuttle" => %{
        "session_id" => "session:1",
        "window_id" => "window:1",
        "block_id" => "block:1",
        "family" => "life/desk",
        "fiber" => "life/desk"
      }
    }

    desired =
      RexLayout.desired(%{
        fibers: [root],
        family_fibers: [root],
        bindings: bindings,
        own_host_id: "remote-hub",
        now: now
      })

    fam = desired.families["life/desk"]
    assert fam.view.uid == "01ROOT"
  end

  test "stale place is retired immediately when shuttle.host moves to another host with no local worker" do
    now = ~U[2026-11-24 10:00:00Z]

    rehomed = %{
      "uid" => "01FELT",
      "slug" => "felt",
      "status" => "active",
      "shuttle" => %{
        "kind" => "oneshot",
        "host" => "remote-hub",
        "ask" => %{"question" => "still waiting"}
      }
    }

    places = %{
      "01FELT" => %{
        "session_id" => "session:1",
        "window_id" => "window:1",
        "family" => "felt",
        "fiber" => "felt",
        "asked_at" => "2026-11-24T09:59:00Z"
      }
    }

    desired =
      RexLayout.desired(%{
        fibers: [rehomed],
        family_fibers: [rehomed],
        places: places,
        chosen_roots: ["felt"],
        own_host_id: "laptop",
        now: now
      })

    assert desired.places_by_uid == %{}
    assert desired.families == %{}
  end
end
