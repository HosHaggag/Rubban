//go:build desktop

package main

import (
	rubban "github.com/HosHaggag/rubban"
	"github.com/HosHaggag/rubban/internal/app"
)

func runDesktop(args []string) int {
	return app.Run(app.Config{Args: args, UI: rubban.UI(), Icon: rubban.Icon})
}
