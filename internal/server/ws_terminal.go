package server

import (
	"net/http"

	"github.com/coder/websocket"
)

func (b *Backend) serveTerminal(w http.ResponseWriter, r *http.Request) {
	conn, err := b.acceptWS(w, r)
	if err != nil {
		return
	}
	_ = sendWS(r.Context(), conn, map[string]any{"type": "error", "error": "The terminal is not available in this build yet."})
	_ = conn.Close(websocket.StatusInternalError, "Terminal unavailable")
}
