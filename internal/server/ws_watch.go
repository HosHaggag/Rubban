package server

import (
	"net/http"

	"github.com/coder/websocket"
)

// serveWatch answers `unavailable` until the live layer exists.
func (b *Backend) serveWatch(w http.ResponseWriter, r *http.Request) {
	conn, err := b.acceptWS(w, r)
	if err != nil {
		return
	}
	_ = sendWS(r.Context(), conn, map[string]any{"type": "unavailable", "message": "Live updates are not available in this mode; showing a snapshot."})
	_ = conn.Close(websocket.StatusNormalClosure, "Watch ended")
}
