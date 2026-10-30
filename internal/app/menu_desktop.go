//go:build desktop

package app

import (
	"context"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/HosHaggag/rubban/internal/version"
)

func (s *shell) about() {
	s.app.Dialog.Info().SetTitle("Rubban").SetMessage("Rubban " + version.Version + "\n\nAn independent Kubernetes workbench.").Show()
}

func (s *shell) checkFromMenu() {
	go func() {
		s.updates.Check(context.Background())
		s.app.Dialog.Info().SetTitle("Rubban").SetMessage("Check for updates\n\n" + UpdateMessage(s.updates.Summary())).Show()
	}()
}

func (s *shell) buildMenu() {
	mac := runtime.GOOS == "darwin"
	menu := s.app.Menu.New()

	app := menu.AddSubmenu("Rubban")
	if mac {
		app.Add("About Rubban").OnClick(func(*application.Context) { s.about() })
		app.AddSeparator()
	}
	app.Add("Reload").SetAccelerator("CmdOrCtrl+R").OnClick(func(*application.Context) { s.window.Reload() })
	if mac {
		app.AddSeparator()
		app.AddRole(application.Hide)
		app.AddRole(application.HideOthers)
		app.AddRole(application.UnHide)
	}
	app.AddSeparator()
	app.AddRole(application.Quit)

	edit := menu.AddSubmenu("Edit")
	edit.AddRole(application.Undo)
	edit.AddRole(application.Redo)
	edit.AddSeparator()
	edit.AddRole(application.Cut)
	edit.AddRole(application.Copy)
	edit.AddRole(application.Paste)
	edit.AddRole(application.SelectAll)

	view := menu.AddSubmenu("View")
	view.AddRole(application.ResetZoom)
	view.AddRole(application.ZoomIn)
	view.AddRole(application.ZoomOut)
	view.AddSeparator()
	view.AddRole(application.ToggleFullscreen)
	view.Add("Developer tools").SetAccelerator("CmdOrCtrl+Shift+I").OnClick(func(*application.Context) { s.window.OpenDevTools() })

	if mac {
		menu.AddRole(application.WindowMenu)
	}

	help := menu.AddSubmenu("Help")
	help.Add("Check for updates…").OnClick(func(*application.Context) { s.checkFromMenu() })
	help.Add("Open log folder").OnClick(func(*application.Context) { _ = s.app.Env.OpenFileManager(s.logger.Dir, false) })
	help.Add("About Rubban").OnClick(func(*application.Context) { s.about() })

	s.app.Menu.SetApplicationMenu(menu)
}
