package server

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/coder/websocket"
)

func (b *Backend) acceptWS(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Host, Origin and token were already checked by authorize.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(64 * 1024)
	return conn, nil
}

func (b *Backend) handleStream(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/watch":
		b.serveWatch(w, r)
	case "/api/logs":
		b.serveLogs(w, r)
	default:
		b.serveTerminal(w, r)
	}
}

func sendWS(ctx context.Context, conn *websocket.Conn, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, data)
}
