#!/usr/bin/env bash
# scan-secrets.sh — Detect hardcoded secrets in tracked / staged / arbitrary files.
#
# Bash mirror of scripts/scan-secrets.ps1 — same modes, same exit codes,
# same JSON output shape. Use on CI, Linux, macOS where PowerShell isn't
# the default shell.
#
# Modes:
#   --mode staged   (default) — files staged for commit
#   --mode tracked          — every git-tracked file
#   --mode all              — tracked + untracked (respects .gitignore)
#   --mode paths -- a b c   — explicit file list
#
# Exit 0 if clean, exit 1 if any match. Emits JSON on stdout.

set -uo pipefail

MODE="staged"
EXPLICIT_PATHS=()

# ---------- Arg parse ----------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode)
            MODE="$2"
            shift 2
            ;;
        --)
            shift
            while [[ $# -gt 0 ]]; do
                EXPLICIT_PATHS+=("$1")
                shift
            done
            ;;
        *)
            EXPLICIT_PATHS+=("$1")
            shift
            ;;
    esac
done

case "$MODE" in
    staged|tracked|all|paths) ;;
    *)
        echo '{"error":"invalid --mode (use staged|tracked|all|paths)","status":"error"}' >&2
        exit 2
        ;;
esac

# ---------- Patterns (mirror scan-secrets.ps1) ----------
# Use POSIX ERE. Each pattern is tagged so the JSON report can name it.
declare -a SECRET_NAMES=(
    "JWT-shape"
    "Stripe-secret"
    "Stripe-publishable"
    "GitHub-PAT"
    "GitHub-OAuth"
    "GitHub-fine-grained"
    "GitLab-PAT"
    "Slack-bot"
    "Slack-user"
    "AWS-access-key"
    "AWS-temporary-key"
    "Google-API-key"
    "OpenAI-key"
    "Anthropic-key"
    "PostgreSQL-URL"
    "MongoDB-URL"
    "Generic-bearer-token"
    "Hex-near-secret-keyword"
    "Base64-near-secret-keyword"
    "Long-value-near-secret-keyword"
    "Generic-live-key-quoted"
    "Generic-test-key-quoted"
)

declare -a SECRET_PATTERNS=(
    'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
    'sk_(live|test)_[A-Za-z0-9]{16,}'
    'pk_(live|test)_[A-Za-z0-9]{16,}'
    'ghp_[A-Za-z0-9]{30,}'
    'gho_[A-Za-z0-9]{30,}'
    'github_pat_[A-Za-z0-9_]{40,}'
    'glpat-[A-Za-z0-9_-]{16,}'
    'xoxb-[A-Za-z0-9-]{20,}'
    'xoxp-[A-Za-z0-9-]{20,}'
    'AKIA[A-Z0-9]{16}'
    'ASIA[A-Z0-9]{16}'
    'AIza[A-Za-z0-9_-]{35}'
    'sk-(proj-)?[A-Za-z0-9_-]{20,}'
    'sk-ant-(api|admin)[0-9]{2}-[A-Za-z0-9_-]{20,}'
    'postgres(ql)?://[^:[:space:]]+:[^@[:space:]]+@[^/[:space:]]+/[^[:space:]]+'
    'mongodb(\+srv)?://[^:[:space:]]+:[^@[:space:]]+@[^/[:space:]]+'
    '[Aa]uthorization:[[:space:]]*[Bb]earer[[:space:]]+[A-Za-z0-9._-]{20,}'
    '(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer|password|passwd|client[_-]?secret)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][a-fA-F0-9]{32,}["'"'"']'
    '(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer|password|passwd|client[_-]?secret)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9+/]{40,}={0,2}["'"'"']'
    '(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer|password|passwd|client[_-]?secret)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9._+/=-]{30,}["'"'"']'
    '["'"'"'][A-Za-z0-9_-]{0,20}_live_[A-Za-z0-9]{20,}["'"'"']'
    '["'"'"'][A-Za-z0-9_-]{0,20}_test_[A-Za-z0-9]{20,}["'"'"']'
)

# Allow-list: any line matching one of these is treated as a placeholder.
ALLOW_RE='\$\{[A-Z_][A-Z0-9_]*\}|\$\{\{[^}]+\}\}|\{\{[A-Z_][A-Z0-9_]*\}\}|<REDACTED>|[Yy][Oo][Uu][Rr][-_]?([Aa][Pp][Ii][-_]?)?([Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll])[-_]?[Hh][Ee][Rr][Ee]|[Ee][Xx][Aa][Mm][Pp][Ll][Ee][_-]?([Aa][Pp][Ii][_-]?)?([Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt])|[Xx][Xx][Xx][_-]?([Tt][Ee][Ss][Tt]|[Ll][Ii][Vv][Ee]|[Pp][Rr][Oo][Dd]|[Dd][Ee][Vv])?[_-]?[Xx][Xx][Xx]|os\.environ|process\.env|getenv\(|config\.get\(|<your[^>]+>|<api[^>]+>|<token[^>]+>|<secret[^>]+>|[Rr][Ee][Dd][Aa][Cc][Tt][Ee][Dd]|[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]|[Ff][Aa][Kk][Ee][_-]?([Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt])|[Dd][Uu][Mm][Mm][Yy][_-]?([Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt])|[Ss][Aa][Mm][Pp][Ll][Ee][_-]?([Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt])|sk-XXXX|sk_test_xxxxx|\.{3,}'

# Skip these files entirely.
SKIP_RE='\.lock$|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|composer\.lock$|Cargo\.lock$|Gemfile\.lock$|poetry\.lock$|uv\.lock$|\.min\.(js|css)$|\.bundle\.(js|css)$|\.(png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|otf|eot|pdf|zip|tar|gz|tgz|bz2|7z|exe|dll|so|dylib|class|jar|pyc|pyo|whl|mp3|mp4|mov|avi)$|/node_modules/|/dist/|/build/|/\.next/|/\.venv/|/venv/|/__pycache__/|/target/|/vendor/|CHANGELOG\.md$|scan-secrets\.(ps1|sh)$|CODING_STANDARDS\.md$|yolo-honesty-checks\.md$'

# ---------- File enumeration ----------
collect_files() {
    case "$MODE" in
        staged)
            git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true
            ;;
        tracked)
            git ls-files 2>/dev/null || true
            ;;
        all)
            { git ls-files 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | sort -u
            ;;
        paths)
            printf '%s\n' "${EXPLICIT_PATHS[@]}"
            ;;
    esac
}

# ---------- Scan ----------
declare -a JSON_MATCHES=()
SCANNED=0

while IFS= read -r FILE; do
    [[ -z "$FILE" ]] && continue
    [[ ! -f "$FILE" ]] && continue
    [[ "$FILE" =~ $SKIP_RE ]] && continue
    SCANNED=$((SCANNED + 1))

    FILE_LINE_NO=0
    while IFS= read -r LINE || [[ -n "$LINE" ]]; do
        FILE_LINE_NO=$((FILE_LINE_NO + 1))

        # Empty / whitespace-only line skip
        [[ -z "${LINE// }" ]] && continue

        # Allow-list check FIRST
        if [[ "$LINE" =~ $ALLOW_RE ]]; then
            continue
        fi

        # Try every secret pattern; first match wins (one per line is enough)
        for IDX in "${!SECRET_PATTERNS[@]}"; do
            PATTERN="${SECRET_PATTERNS[$IDX]}"
            NAME="${SECRET_NAMES[$IDX]}"
            if [[ "$LINE" =~ $PATTERN ]]; then
                # Truncate snippet to 200 chars
                SNIPPET="${LINE//$'\t'/ }"
                SNIPPET="${SNIPPET#"${SNIPPET%%[![:space:]]*}"}"
                if [[ ${#SNIPPET} -gt 200 ]]; then
                    SNIPPET="${SNIPPET:0:200}..."
                fi
                # Escape for JSON: \, ", control chars
                JSON_SNIPPET=$(printf '%s' "$SNIPPET" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r/\\r/g')
                JSON_FILE=$(printf '%s' "$FILE" | sed 's/\\/\\\\/g; s/"/\\"/g')
                JSON_MATCHES+=("{\"file\":\"$JSON_FILE\",\"line\":$FILE_LINE_NO,\"pattern\":\"$NAME\",\"snippet\":\"$JSON_SNIPPET\"}")
                break
            fi
        done
    done < "$FILE"
done < <(collect_files)

# ---------- Emit JSON ----------
STATUS="clean"
if [[ ${#JSON_MATCHES[@]} -gt 0 ]]; then
    STATUS="secrets_detected"
fi

if [[ ${#JSON_MATCHES[@]} -eq 0 ]]; then
    JSON_BODY="[]"
else
    JOINED=$(printf ',%s' "${JSON_MATCHES[@]}")
    JSON_BODY="[${JOINED:1}]"
fi

cat <<EOF
{
  "matches": $JSON_BODY,
  "files_scanned": $SCANNED,
  "mode": "$MODE",
  "status": "$STATUS"
}
EOF

if [[ ${#JSON_MATCHES[@]} -gt 0 ]]; then
    exit 1
else
    exit 0
fi
