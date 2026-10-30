package mcp

import (
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"runtime"
	"strconv"
)

const usage = "Usage: rubban mcp [--connection-file PATH]"

// Connection is where and how to reach the local Rubban API.
type Connection struct {
	URL   string // http(s)://127.0.0.1[:port], no trailing slash
	Token string
}

// LoadConnection resolves the connection from args (--connection-file PATH) or RUBBAN_CONNECTION_FILE,
// with RUBBAN_API_URL / RUBBAN_API_TOKEN overriding the file's values.
func LoadConnection(args []string, env func(string) string) (Connection, error) {
	file := env("RUBBAN_CONNECTION_FILE")
	if len(args) > 0 {
		if len(args) != 2 || args[0] != "--connection-file" {
			return Connection{}, errors.New(usage)
		}
		file = args[1]
	}
	var fromFile map[string]any
	if file != "" {
		st, err := os.Stat(file)
		if err != nil {
			return Connection{}, errors.New("Cannot read the Rubban connection file")
		}
		if !st.Mode().IsRegular() || st.Size() > 8192 {
			return Connection{}, errors.New("Invalid Rubban connection file")
		}
		if runtime.GOOS != "windows" && st.Mode().Perm()&0o077 != 0 {
			return Connection{}, errors.New("Rubban connection file must be readable only by its owner")
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return Connection{}, errors.New("Cannot read the Rubban connection file")
		}
		if json.Unmarshal(data, &fromFile) != nil || fromFile == nil {
			return Connection{}, errors.New("Invalid Rubban connection file")
		}
	}
	pick := func(envName, key string) any {
		if v := env(envName); v != "" {
			return v
		}
		return fromFile[key]
	}
	value, token := pick("RUBBAN_API_URL", "url"), pick("RUBBAN_API_TOKEN", "token")
	if s, ok := value.(string); !ok || s == "" {
		return Connection{}, errors.New("Set RUBBAN_API_URL and RUBBAN_API_TOKEN, or provide --connection-file")
	}
	origin, err := loopbackOrigin(value.(string))
	if err != nil {
		return Connection{}, err
	}
	t, ok := token.(string)
	if !ok || t == "" || len(t) > 4096 {
		return Connection{}, errors.New("A valid RUBBAN_API_TOKEN is required")
	}
	for i := 0; i < len(t); i++ {
		if t[i] < 0x21 || t[i] > 0x7e {
			return Connection{}, errors.New("A valid RUBBAN_API_TOKEN is required")
		}
	}
	return Connection{URL: origin, Token: t}, nil
}

// loopbackOrigin accepts exactly http(s)://127.0.0.1[:port][/] and returns the origin.
func loopbackOrigin(value string) (string, error) {
	bad := errors.New("RUBBAN_API_URL must be an http(s)://127.0.0.1:<port>/ origin")
	u, err := url.Parse(value)
	if err != nil {
		return "", errors.New("RUBBAN_API_URL is not a valid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", bad
	}
	if u.Hostname() != "127.0.0.1" {
		return "", bad
	}
	if u.User != nil {
		if _, hasPassword := u.User.Password(); hasPassword || u.User.Username() != "" {
			return "", bad
		}
	}
	if u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || u.Opaque != "" {
		return "", bad
	}
	origin := u.Scheme + "://127.0.0.1"
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n > 65535 {
			return "", errors.New("RUBBAN_API_URL is not a valid URL")
		}
		if !(u.Scheme == "http" && n == 80) && !(u.Scheme == "https" && n == 443) {
			origin += ":" + strconv.Itoa(n)
		}
	}
	return origin, nil
}
