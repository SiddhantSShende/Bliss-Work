package db

import (
	"strings"
	"testing"
)

func TestMigrationAlreadyAppliedRejectsChangedChecksum(t *testing.T) {
	applied, err := migrationAlreadyApplied("001_init.sql", "new", map[string]string{
		"001_init.sql": "old",
	})
	if err == nil || !strings.Contains(err.Error(), "add a new numbered migration") {
		t.Fatalf("expected changed checksum to fail with migration guidance, got %v", err)
	}
	if applied {
		t.Fatal("changed migration must not be treated as applied")
	}
}

func TestMigrationAlreadyAppliedAcceptsMatchingChecksum(t *testing.T) {
	applied, err := migrationAlreadyApplied("001_init.sql", "same", map[string]string{
		"001_init.sql": "same",
	})
	if err != nil || !applied {
		t.Fatalf("matching migration should be skipped, applied=%v err=%v", applied, err)
	}
}
