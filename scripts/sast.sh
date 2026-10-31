#!/usr/bin/env bash
# Static security scan of the repository, the way it was done for 0.13.0. Run from the repository
# root on Linux/WSL/macOS; results go to the folder given as $1 (default: ./sast-out, git-ignored).
#
#   scripts/sast.sh [out-dir]
#
# Tools (installed into $GOPATH/bin and a Python venv when missing):
#   govulncheck  known vulnerabilities reachable from the code (Go standard library and modules)
#   gosec        Go security linter (taint analysis; see the accepted findings below)
#   staticcheck  Go correctness and dead code (staticcheck.conf silences the style checks we reject)
#   semgrep      rule packs p/golang p/javascript p/security-audit p/secrets p/github-actions
#   gitleaks     secrets in the working tree and the whole git history (.gitleaks.toml allowlist)
#   trivy        dependency vulnerabilities, secrets and misconfiguration over the file system
#   npm audit    the UI dev dependencies (ESLint and the test runner only; nothing ships from npm)
#
# Accepted findings (re-read them when the code around them changes):
#   gosec G703/G304 in cmd/buildtool: paths come from the command line of a developer tool.
#   gosec G703 os.Stat in server/tools.go, terminal.go, shellenv.go: existence checks on PATH entries.
#   gosec G702/G204 subprocesses: every kubectl/helm/git invocation is argv without a shell, with
#     validated arguments (validate.go, mcp.ValidateQuery); that is the design.
#   gosec G118: long-lived goroutines (proxy pool, forwards) deliberately outlive one request.
#   gosec G402 / semgrep missing-ssl-minversion: the embed proxy skips verification of a console
#     certificate that names the cluster service, not 127.0.0.1; TLS 1.2 minimum is enforced.
#   semgrep use-of-unsafe-block: the Windows MessageBoxW call in app/fatal_windows.go.
#   semgrep filepath-clean-misuse: server.go serves UI files through fs.FS after fs.ValidPath.
#   semgrep math-random-used / gosec G404: reconnect jitter in live/watch.go.
set -u
out=${1:-sast-out}
mkdir -p "$out"
gobin=$(go env GOPATH)/bin
export PATH="$gobin:$PATH"
status=0
note() { printf '\n=== %s\n' "$*"; }
need() { # need <binary> <go install path>
  command -v "$1" >/dev/null 2>&1 || { echo "installing $1"; go install "$2" >/dev/null 2>&1 || { echo "could not install $1"; return 1; }; }
}

note "govulncheck"
need govulncheck golang.org/x/vuln/cmd/govulncheck@latest && { govulncheck ./... | tee "$out/govulncheck.txt" | tail -6; [ "${PIPESTATUS[0]}" -eq 0 ] || status=1; }

note "gosec"
need gosec github.com/securego/gosec/v2/cmd/gosec@latest && {
  gosec -quiet -fmt json -out "$out/gosec.json" -exclude-dir=node_modules ./... >/dev/null 2>&1
  python3 - "$out/gosec.json" <<'EOF'
import json, sys, collections
d = json.load(open(sys.argv[1])); issues = d.get("Issues") or []
print("issues:", len(issues), dict(collections.Counter(i["severity"] for i in issues)))
for i in issues:
    if i["severity"] == "HIGH":
        print("  HIGH", i["rule_id"], i["file"].split("/Rubban/")[-1] + ":" + i["line"], "|", i["details"][:70])
EOF
}

note "staticcheck"
# Without -tags desktop (Linux cannot build the Wails shell) the symbols that only desktop-tagged
# files use look unused; those two files are filtered out here and checked on Windows/macOS.
need staticcheck honnef.co/go/tools/cmd/staticcheck@latest && {
  staticcheck ./... 2>&1 | grep -v -E '^internal/app/(fatal_other|updater_adapter)\.go:.*U1000' | tee "$out/staticcheck.txt"
  [ -s "$out/staticcheck.txt" ] && status=1
}

note "semgrep"
venv=$HOME/.venv-semgrep
[ -x "$venv/bin/semgrep" ] || { python3 -m venv "$venv" && "$venv/bin/pip" install --quiet semgrep; }
"$venv/bin/semgrep" scan --metrics=off --config p/golang --config p/javascript --config p/security-audit --config p/secrets --config p/github-actions \
  --exclude node_modules --exclude ui/vendor.js --exclude ui/xterm.js --exclude ui/addon-fit.js --json -o "$out/semgrep.json" . >/dev/null 2>&1
python3 - "$out/semgrep.json" <<'EOF'
import json, sys, collections
r = json.load(open(sys.argv[1]))["results"]
print("findings:", len(r), dict(collections.Counter(x["check_id"].split(".")[-1] for x in r)))
for x in r:
    print("  ", x["extra"]["severity"], x["path"] + ":" + str(x["start"]["line"]), x["check_id"].split(".")[-1])
EOF

note "gitleaks (working tree, then history)"
need gitleaks github.com/zricethezav/gitleaks/v8@latest && {
  gitleaks dir --no-banner --redact --report-format json --report-path "$out/gitleaks-tree.json" . 2>&1 | tail -1 || status=1
  gitleaks git --no-banner --redact --report-format json --report-path "$out/gitleaks-history.json" . 2>&1 | tail -1 || status=1
}

note "trivy (first run downloads a ~130 MB database)"
need trivy github.com/aquasecurity/trivy/cmd/trivy@latest && {
  trivy fs --quiet --scanners vuln,secret,misconfig --skip-dirs node_modules --format json -o "$out/trivy.json" . || status=1
  python3 - "$out/trivy.json" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1])); total = 0
for res in d.get("Results", []):
    for key, label in (("Vulnerabilities", "VULN"), ("Secrets", "SECRET"), ("Misconfigurations", "MISCONF")):
        for x in res.get(key) or []:
            total += 1
            print("  ", label, x.get("Severity"), res["Target"], x.get("VulnerabilityID") or x.get("RuleID") or x.get("ID"), (x.get("Title") or "")[:70])
print("trivy findings:", total)
EOF
}

note "npm audit (dev dependencies only)"
if command -v npm >/dev/null 2>&1; then npm audit --omit=none 2>&1 | tail -4 | tee "$out/npm-audit.txt"; else echo "npm not available here; run 'npm audit' where Node is installed"; fi

echo
[ "$status" -eq 0 ] && echo "Done; reports in $out" || echo "Done with failures; reports in $out"
exit $status
