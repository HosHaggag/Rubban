package updater

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// MaxDownload is the largest update zip the updater will accept.
const MaxDownload = 500 * 1024 * 1024

var allowedHosts = map[string]bool{
	"github.com":                           true,
	"objects.githubusercontent.com":        true,
	"release-assets.githubusercontent.com": true,
}

// AllowedURL reports whether value is an https URL without credentials on one of GitHub's release hosts.
func AllowedURL(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Host == "" {
		return false
	}
	return allowedHosts[strings.ToLower(u.Hostname())]
}

func hostOf(value string) string {
	if u, err := url.Parse(value); err == nil && u.Host != "" {
		return u.Host
	}
	return "an invalid address"
}

// safeFetch follows redirects by hand so every hop stays on GitHub's own hosts over HTTPS.
// The caller closes the returned body.
func safeFetch(ctx context.Context, client *http.Client, target string, header http.Header) (*http.Response, error) {
	noFollow := *client
	noFollow.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	for hop := 0; hop < 6; hop++ {
		if !AllowedURL(target) {
			return nil, errors.New("Blocked download from " + hostOf(target))
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return nil, err
		}
		for k, v := range header {
			req.Header[k] = v
		}
		resp, err := noFollow.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			if loc := resp.Header.Get("Location"); loc != "" {
				resp.Body.Close()
				base, _ := url.Parse(target)
				next, err := base.Parse(loc)
				if err != nil {
					return nil, errors.New("Blocked download from an invalid address")
				}
				target = next.String()
				continue
			}
		}
		return resp, nil
	}
	return nil, errors.New("Too many redirects")
}

// Asset is one downloadable zip described by the manifest.
type Asset struct {
	Name   string
	SHA256 string
	Size   int64
}

type manifestAsset struct {
	Name   any `json:"name"`
	SHA256 any `json:"sha256"`
	Size   any `json:"size"`
}

// Manifest is latest.json: {version, assets:{"<platform>-<arch>":{name,sha256,size}}, notes}.
type Manifest struct {
	Version any                       `json:"version"`
	Assets  map[string]*manifestAsset `json:"assets"`
	Notes   any                       `json:"notes"`
}

var (
	assetNameRE = regexp.MustCompile(`^Rubban-[0-9A-Za-z.+-]+\.zip$`)
	sha256RE    = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

func asString(v any) string {
	s, _ := v.(string)
	return s
}

// ValidateManifest checks the manifest and returns the version (without a leading "v"), the asset
// for key (nil when the manifest has none) and the release notes cut at 20000 characters.
func ValidateManifest(m *Manifest, key string) (version string, asset *Asset, notes string, err error) {
	if m == nil {
		return "", nil, "", errors.New("The update manifest is not valid")
	}
	vs, ok := m.Version.(string)
	if !ok {
		return "", nil, "", errors.New("Invalid version: " + "undefined")
	}
	if _, err := ParseVersion(vs); err != nil {
		return "", nil, "", err
	}
	if a := m.Assets[key]; a != nil {
		name, sum := asString(a.Name), asString(a.SHA256)
		if !assetNameRE.MatchString(name) {
			return "", nil, "", errors.New("The update manifest names an invalid file")
		}
		if !sha256RE.MatchString(sum) {
			return "", nil, "", errors.New("The update manifest has an invalid checksum")
		}
		size, ok := a.Size.(float64)
		if !ok || size != math.Trunc(size) || size <= 0 || size > MaxDownload {
			return "", nil, "", errors.New("The update manifest has an invalid size")
		}
		asset = &Asset{Name: name, SHA256: sum, Size: int64(size)}
	}
	notes = asString(m.Notes)
	if r := []rune(notes); len(r) > 20000 {
		notes = string(r[:20000])
	}
	return strings.TrimPrefix(strings.TrimSpace(vs), "v"), asset, notes, nil
}
