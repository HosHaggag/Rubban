package server

import (
	"os"
	"regexp"
	"slices"
	"testing"
)

// The icon ids the server accepts in preferences must be exactly the ones the UI can draw.
func TestClusterIconsMatchUI(t *testing.T) {
	source, err := os.ReadFile("../../ui/cluster-icons.js")
	if err != nil {
		t.Fatal(err)
	}
	table := regexp.MustCompile(`(?s)export const CLUSTER_ICON_PATHS = \{(.*?)\n\};`).FindSubmatch(source)
	if table == nil {
		t.Fatal("CLUSTER_ICON_PATHS not found in ui/cluster-icons.js")
	}
	var ui []string
	for _, m := range regexp.MustCompile(`(?m)^\s*([a-z]+):\s*'`).FindAllSubmatch(table[1], -1) {
		ui = append(ui, string(m[1]))
	}
	server := slices.Clone(ClusterIcons)
	slices.Sort(ui)
	slices.Sort(server)
	if !slices.Equal(ui, server) {
		t.Fatalf("icon lists differ\nui:     %v\nserver: %v", ui, server)
	}
}
