package cmd

import "testing"

func TestIdentityFindingFromRowUsesSlugWhenPresent(t *testing.T) {
	row := daemonFiberRow{
		Path:      "fiber/fiber.md",
		FeltStore: "/tmp/store",
		Fiber: map[string]any{
			"id":     "01KTCA2CWXBSNHETE66MXKPVE7",
			"uid":    "01KTCA2CWXBSNHETE66MXKPVE7",
			"slug":   "fiber",
			"status": "active",
			"shuttle": map[string]any{
				"host": "dapmcw68",
			},
		},
	}

	got := identityFindingFromRow(row)

	if got.Slug != "fiber" {
		t.Fatalf("Slug = %q, want %q", got.Slug, "fiber")
	}
	if got.ID != "01KTCA2CWXBSNHETE66MXKPVE7" {
		t.Fatalf("ID = %q", got.ID)
	}
	if got.UID != got.ID {
		t.Fatalf("UID = %q, ID = %q", got.UID, got.ID)
	}
	if got.Host != "dapmcw68" {
		t.Fatalf("Host = %q", got.Host)
	}
}

func TestIdentityFindingFromRowFallsBackToAddressIDForOldDaemons(t *testing.T) {
	row := daemonFiberRow{
		Fiber: map[string]any{
			"id":     "ai-futures/portolan/debug",
			"status": "active",
		},
	}

	got := identityFindingFromRow(row)

	if got.Slug != "ai-futures/portolan/debug" {
		t.Fatalf("Slug = %q, want old daemon address id", got.Slug)
	}
}

func TestDuplicateIdentityRowsIgnoresMultipleViewsOfSameSlug(t *testing.T) {
	rows := []identityFiberFinding{
		{UID: "01KTCA2CWXBSNHETE66MXKPVE7", Slug: "fiber", FeltStore: "/tmp/a"},
		{UID: "01KTCA2CWXBSNHETE66MXKPVE7", Slug: "fiber", FeltStore: "/tmp/b"},
	}

	if duplicateIdentityRows(rows) {
		t.Fatal("same uid + same slug across stores should be a duplicate view, not an identity collision")
	}

	rows = append(rows, identityFiberFinding{UID: "01KTCA2CWXBSNHETE66MXKPVE7", Slug: "other", FeltStore: "/tmp/c"})
	if !duplicateIdentityRows(rows) {
		t.Fatal("same uid across distinct slugs should report an identity collision")
	}
}
