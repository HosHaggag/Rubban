package app

import "context"

// UpdateSummary is the part of the updater state the native menu needs.
type UpdateSummary struct {
	Status, Current, Latest, Error string
	Disabled                       bool
}

// Updates is the updater as the desktop shell drives it (internal/updater adapts to it).
type Updates interface {
	State() any
	Summary() UpdateSummary
	Check(ctx context.Context) any
	Download(ctx context.Context) any
	Install(ctx context.Context) (any, error)
	Dismiss() any
	Subscribe(fn func(state any)) (cancel func())
	Start()
	Stop()
}

// UpdateMessage is the Help › Check for updates… text; it never assumes an update exists.
func UpdateMessage(s UpdateSummary) string {
	switch {
	case s.Disabled:
		return "Updates are turned off in this build."
	case s.Status == "error":
		return "Could not check for updates: " + s.Error
	case s.Status == "up-to-date":
		return "You have the latest version (" + s.Current + ")."
	case s.Status == "available" || s.Status == "downloading" || s.Status == "ready" || s.Status == "installing":
		return "Version " + s.Latest + " is available. Open Settings › Updates to install it."
	case s.Status == "checking":
		return "Rubban is still checking for updates. Try again in a moment."
	}
	return "You have the latest version (" + s.Current + ")."
}
