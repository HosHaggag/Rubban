package updater

import (
	"fmt"
	"regexp"
	"strings"
)

var versionRE = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$`)
var digitsRE = regexp.MustCompile(`^\d+$`)

// ParsedVersion is major.minor.patch with an optional pre-release part. The numbers stay
// strings so arbitrarily large components compare correctly.
type ParsedVersion struct {
	Numbers [3]string
	Pre     []string
}

// ParseVersion accepts major.minor.patch[-pre] with an optional leading "v".
func ParseVersion(text string) (ParsedVersion, error) {
	m := versionRE.FindStringSubmatch(strings.TrimSpace(text))
	if m == nil {
		return ParsedVersion{}, fmt.Errorf("Invalid version: %s", text)
	}
	v := ParsedVersion{Numbers: [3]string{m[1], m[2], m[3]}}
	if m[4] != "" {
		v.Pre = strings.Split(m[4], ".")
	}
	return v, nil
}

// compareNumeric compares two non-negative decimal strings of any length.
func compareNumeric(a, b string) int {
	a = strings.TrimLeft(a, "0")
	b = strings.TrimLeft(b, "0")
	if len(a) != len(b) {
		if len(a) < len(b) {
			return -1
		}
		return 1
	}
	return strings.Compare(a, b)
}

// CompareVersions returns -1, 0 or 1; a version with a pre-release part sorts before the plain release.
func CompareVersions(a, b string) (int, error) {
	x, err := ParseVersion(a)
	if err != nil {
		return 0, err
	}
	y, err := ParseVersion(b)
	if err != nil {
		return 0, err
	}
	for i := 0; i < 3; i++ {
		if c := compareNumeric(x.Numbers[i], y.Numbers[i]); c != 0 {
			return c, nil
		}
	}
	if len(x.Pre) == 0 || len(y.Pre) == 0 {
		switch {
		case len(x.Pre) == len(y.Pre):
			return 0, nil
		case len(x.Pre) > 0:
			return -1, nil
		default:
			return 1, nil
		}
	}
	for i := 0; i < len(x.Pre) || i < len(y.Pre); i++ {
		if i >= len(x.Pre) {
			return -1, nil
		}
		if i >= len(y.Pre) {
			return 1, nil
		}
		l, r := x.Pre[i], y.Pre[i]
		ln, rn := digitsRE.MatchString(l), digitsRE.MatchString(r)
		switch {
		case ln && rn:
			if c := compareNumeric(l, r); c != 0 {
				return c, nil
			}
		case ln != rn:
			if ln {
				return -1, nil
			}
			return 1, nil
		case l != r:
			if l < r {
				return -1, nil
			}
			return 1, nil
		}
	}
	return 0, nil
}
