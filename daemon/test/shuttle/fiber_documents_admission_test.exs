defmodule Shuttle.FiberDocumentsAdmissionTest do
  @moduledoc """
  The kanban admission vocabulary and ownerless-card rule.

  Pure functions only — no felt, no poller. Feed behavior is exercised against
  real fixture stores in `ShuttleWeb.FiberDocumentsControllerTest`.
  """
  use ExUnit.Case, async: true

  alias Shuttle.FiberDocuments

  describe "kanban_fields/0" do
    test "projects `start`, without which a cycle band has no left edge" do
      assert "start" in FiberDocuments.kanban_fields()
    end

    test "projects the constitution's bundled channel theme" do
      assert "theme" in FiberDocuments.kanban_fields()
    end

    test "still projects the fields the board has always needed" do
      fields = FiberDocuments.kanban_fields()
      for f <- ~w(id uid name status tags due shuttle path report_path), do: assert(f in fields)
    end
  end

  describe "kanban_aux_admissible?/1" do
    test "claims a fiber carrying a due date" do
      assert FiberDocuments.kanban_aux_admissible?(%{"due" => "2026-11-30T00:00:00Z"})
    end

    test "claims a cycle-tagged fiber, case- and whitespace-insensitively" do
      assert FiberDocuments.kanban_aux_admissible?(%{"tags" => ["cycle"]})
      assert FiberDocuments.kanban_aux_admissible?(%{"tags" => ["Cycle"]})
      assert FiberDocuments.kanban_aux_admissible?(%{"tags" => [" cycle "]})
      assert FiberDocuments.kanban_aux_admissible?(%{"tags" => ["planning", "CYCLE"]})
    end

    test "does not claim a fiber that is neither" do
      refute FiberDocuments.kanban_aux_admissible?(%{"tags" => ["cycles", "recycle"]})
      refute FiberDocuments.kanban_aux_admissible?(%{"name" => "plain"})
      refute FiberDocuments.kanban_aux_admissible?(%{})
    end

    test "treats an absent, nil, or empty due as no due" do
      refute FiberDocuments.kanban_aux_admissible?(%{"due" => nil})
      refute FiberDocuments.kanban_aux_admissible?(%{"due" => ""})
    end

    test "tolerates malformed tags rather than raising" do
      refute FiberDocuments.kanban_aux_admissible?(%{"tags" => nil})
      refute FiberDocuments.kanban_aux_admissible?(%{"tags" => "cycle"})
      assert FiberDocuments.kanban_aux_admissible?(%{"tags" => [nil, 7, "cycle"]})
    end

    test "is false for a non-map row" do
      refute FiberDocuments.kanban_aux_admissible?("nope")
      refute FiberDocuments.kanban_aux_admissible?(nil)
    end

    test "REFUSES a fiber that has an owner, however aux-shaped it looks" do
      # The leak this closes: every daemon shares the git-synced loom store, so
      # a constitution pinned to `nibi` sits on all five disks. Host-ownership
      # excluded it from four of those feeds — until a `due:` let it back in
      # through the aux clause, which exists only for kinds that HAVE no owner.
      # On the board those mirror rows won the card (local-first) and answered
      # for a fiber they cannot observe or write.
      pinned = %{"due" => "2026-11-30T00:00:00Z", "shuttle" => %{"host" => "nibi"}}
      refute FiberDocuments.kanban_aux_admissible?(pinned)

      refute FiberDocuments.kanban_aux_admissible?(%{
               "tags" => ["cycle"],
               "shuttle" => %{"host" => "nibi"}
             })
    end

    test "still claims a shuttle fiber that names NO host — unowned, not elsewhere-owned" do
      # A block without a `host:` is homeless, not foreign: no daemon can claim
      # it, so refusing it here would erase it from every board at once.
      assert FiberDocuments.kanban_aux_admissible?(%{
               "due" => "2026-11-30T00:00:00Z",
               "shuttle" => %{"kind" => "oneshot"}
             })

      assert FiberDocuments.kanban_aux_admissible?(%{
               "due" => "2026-11-30T00:00:00Z",
               "shuttle" => %{"host" => ""}
             })
    end
  end

  describe "host_pinned?/1" do
    test "is true only for a non-empty shuttle.host" do
      assert FiberDocuments.host_pinned?(%{"shuttle" => %{"host" => "nibi"}})
      refute FiberDocuments.host_pinned?(%{"shuttle" => %{"host" => ""}})
      refute FiberDocuments.host_pinned?(%{"shuttle" => %{"host" => nil}})
      refute FiberDocuments.host_pinned?(%{"shuttle" => %{"kind" => "oneshot"}})
      refute FiberDocuments.host_pinned?(%{"due" => "2026-11-30T00:00:00Z"})
      refute FiberDocuments.host_pinned?("nope")
    end
  end
end
