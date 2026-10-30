package server

import (
	"context"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
)

// DesktopHooks is what the desktop shell provides to the /api/desktop/* routes (PLAN-GO.md §3.3).
// The routes exist only when Options.Desktop is set; in web mode they are plain 404s.
type DesktopHooks interface {
	OpenExternal(url string) error
	SetTheme(theme string) error
	// SaveFile shows a native Save dialog and writes text; it reports whether a file was written.
	SaveFile(name, text string) (bool, error)
	// Updater state machine. State values are sent to the page as JSON.
	UpdateState() any
	UpdateCheck(ctx context.Context) any
	UpdateDownload(ctx context.Context) any
	UpdateInstall(ctx context.Context) (any, error)
	UpdateDismiss() any
	// SubscribeUpdates calls fn with every new state until the returned function is called.
	SubscribeUpdates(fn func(state any)) (cancel func())
	// Smoke mode only.
	RendererError(message, stack string)
	SmokeReport(report map[string]any)
}

const maxSaveFileBytes = 32 * 1024 * 1024

// externalURL accepts only http(s) URLs without credentials.
func externalURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return "", bad("Only web links can open externally.")
	}
	return u.String(), nil
}

// safeFileName keeps only the last path element and drops control characters.
func safeFileName(name string) string {
	name = strings.ReplaceAll(name, `\`, "/")
	name = filepath.Base(name)
	var b strings.Builder
	for _, r := range name {
		if r >= 0x20 && r != 0x7f && !strings.ContainsRune(`<>:"|?*`, r) {
			b.WriteRune(r)
		}
	}
	out := strings.TrimSpace(b.String())
	if out == "" || out == "." || out == ".." {
		return "download.txt"
	}
	if len(out) > 200 {
		out = out[:200]
	}
	return out
}

func init() {
	registerRoutes(func(b *Backend, q *request) (any, int, bool, error) {
		if !strings.HasPrefix(q.route, "/api/desktop/") {
			return nil, 0, false, nil
		}
		d := b.opts.Desktop
		if d == nil {
			return nil, 0, false, nil // 404 in web mode
		}
		switch {
		case q.method == "GET" && q.route == "/api/desktop/updates":
			return d.UpdateState(), 200, true, nil
		case q.method == "POST" && q.route == "/api/desktop/updates/check":
			return d.UpdateCheck(q.ctx), 200, true, nil
		case q.method == "POST" && q.route == "/api/desktop/updates/download":
			return d.UpdateDownload(q.ctx), 200, true, nil
		case q.method == "POST" && q.route == "/api/desktop/updates/install":
			state, err := d.UpdateInstall(q.ctx)
			return state, 200, true, err
		case q.method == "POST" && q.route == "/api/desktop/updates/dismiss":
			return d.UpdateDismiss(), 200, true, nil
		case q.method == "POST" && q.route == "/api/desktop/open-external":
			raw, _ := q.body["url"].(string)
			target, err := externalURL(raw)
			if err != nil {
				return nil, 0, true, err
			}
			if err := d.OpenExternal(target); err != nil {
				return nil, 0, true, problem(err.Error(), 500)
			}
			return obj{"ok": true}, 200, true, nil
		case q.method == "POST" && q.route == "/api/desktop/theme":
			theme, _ := q.body["theme"].(string)
			if theme == "system" || theme == "light" || theme == "dark" {
				if err := d.SetTheme(theme); err != nil {
					return nil, 0, true, problem(err.Error(), 500)
				}
			}
			return obj{"ok": true}, 200, true, nil
		case q.method == "POST" && q.route == "/api/desktop/save-file":
			name, _ := q.body["name"].(string)
			text, ok := q.body["text"].(string)
			if !ok || len(text) > maxSaveFileBytes {
				return nil, 0, true, bad("Invalid file contents")
			}
			saved, err := d.SaveFile(safeFileName(name), text)
			if err != nil {
				return nil, 0, true, problem(err.Error(), 500)
			}
			return obj{"saved": saved}, 200, true, nil
		case q.method == "POST" && q.route == "/api/desktop/renderer-error" && b.opts.Smoke:
			message, _ := q.body["message"].(string)
			stack, _ := q.body["stack"].(string)
			d.RendererError(clip(message, 2000), clip(stack, 4000))
			return obj{"ok": true}, 200, true, nil
		case q.method == "POST" && q.route == "/api/desktop/smoke-report" && b.opts.Smoke:
			d.SmokeReport(q.body)
			return obj{"ok": true}, 200, true, nil
		}
		return nil, 0, false, nil
	})
}

// serveDesktopEvents streams updater state to the page: {type:'update-state', state}.
func (b *Backend) serveDesktopEvents(w http.ResponseWriter, r *http.Request) {
	d := b.opts.Desktop
	conn, err := b.acceptWS(w, r)
	if err != nil {
		return
	}
	ctx := r.Context()
	if d == nil {
		_ = conn.CloseNow()
		return
	}
	states := make(chan any, 16)
	cancel := d.SubscribeUpdates(func(state any) {
		select {
		case states <- state:
		default: // a slow page drops intermediate states; the next one carries the full state
		}
	})
	defer cancel()
	go func() {
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				_ = conn.CloseNow()
				return
			}
		}
	}()
	_ = sendWS(ctx, conn, map[string]any{"type": "update-state", "state": d.UpdateState()})
	for {
		select {
		case <-ctx.Done():
			return
		case state := <-states:
			if sendWS(ctx, conn, map[string]any{"type": "update-state", "state": state}) != nil {
				return
			}
		}
	}
}
