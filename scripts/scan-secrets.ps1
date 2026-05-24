# scan-secrets.ps1 — Detect hardcoded secrets in tracked / staged / arbitrary files.
#
# Used by:
#   - YOLO master Phase 4.3a (close-out drift scan)
#   - YOLO master Phase 1.0 Step 7 (working-tree-clean drift scan)
#   - YOLO implement sub-agent Step 10 (pre-push gate)
#   - prepare-public.md Step 0 (pre-public scan)
#   - Manual: scripts/scan-secrets.ps1 -Mode tracked
#
# Behaviour: emits a JSON report on stdout. Exit 0 if clean, exit 1 if any match.
#
# Modes:
#   -Mode staged   (default) — files currently staged for commit (`git diff --cached --name-only`)
#   -Mode tracked          — every git-tracked file
#   -Mode all              — tracked + untracked (excluding .gitignored — `git ls-files --others --exclude-standard`)
#   -Mode paths -Paths a,b — explicit list (used by callers that pass a `git status --short` parsed list)
#
# Adding a pattern: append to $secretPatterns. Adding an allow-list placeholder
# context: append to $allowListPatterns. Files this scanner should NEVER scan
# (binaries, lockfiles, the scanner itself, the rule file that lists the
# patterns): append to $skipFilePatterns.

[CmdletBinding()]
param(
    [ValidateSet("staged", "tracked", "paths", "all")]
    [string]$Mode = "staged",

    [string[]]$Paths = @(),

    [switch]$Quiet
)

# ---------- Detection patterns (real secret shapes) ----------
$secretPatterns = @(
    # JSON Web Tokens (eyJ-prefix base64.base64.base64)
    @{ Name = "JWT-shape"; Pattern = '\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b' },

    # Provider-specific prefixes
    @{ Name = "Stripe-secret";        Pattern = '\bsk_(live|test)_[A-Za-z0-9]{16,}\b' }
    @{ Name = "Stripe-publishable";   Pattern = '\bpk_(live|test)_[A-Za-z0-9]{16,}\b' }
    @{ Name = "GitHub-PAT";           Pattern = '\bghp_[A-Za-z0-9]{30,}\b' }
    @{ Name = "GitHub-OAuth";         Pattern = '\bgho_[A-Za-z0-9]{30,}\b' }
    @{ Name = "GitHub-fine-grained";  Pattern = '\bgithub_pat_[A-Za-z0-9_]{40,}\b' }
    @{ Name = "GitLab-PAT";           Pattern = '\bglpat-[A-Za-z0-9_-]{16,}\b' }
    @{ Name = "Slack-bot";            Pattern = '\bxoxb-[A-Za-z0-9-]{20,}\b' }
    @{ Name = "Slack-user";           Pattern = '\bxoxp-[A-Za-z0-9-]{20,}\b' }
    @{ Name = "AWS-access-key";       Pattern = '\bAKIA[A-Z0-9]{16}\b' }
    @{ Name = "AWS-temporary-key";    Pattern = '\bASIA[A-Z0-9]{16}\b' }
    @{ Name = "Google-API-key";       Pattern = '\bAIza[A-Za-z0-9_-]{35}\b' }
    @{ Name = "OpenAI-key";           Pattern = '\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b' }
    @{ Name = "Anthropic-key";        Pattern = '\bsk-ant-(api|admin)\d{2}-[A-Za-z0-9_-]{20,}\b' }
    @{ Name = "PostgreSQL-URL";       Pattern = '\bpostgres(ql)?:\/\/[^:\s]+:[^@\s]+@[^/\s]+\/[^\s"' + "'" + ']+' }
    @{ Name = "MongoDB-URL";          Pattern = '\bmongodb(\+srv)?:\/\/[^:\s]+:[^@\s]+@[^/\s]+' }
    @{ Name = "Generic-bearer-token"; Pattern = '(?i)\bauthorization:\s*bearer\s+[A-Za-z0-9._-]{20,}\b' }

    # Generic shape: long high-entropy string adjacent to a secret-keyword
    # NB: keyword on the same line within ~30 chars; matches `apiKey: "<32+ hex>"`
    @{ Name = "Hex-near-secret-keyword";       Pattern = '(?i)(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer|password|passwd|client[_-]?secret)["'']?\s*[:=]\s*["''][a-fA-F0-9]{32,}["'']' }
    @{ Name = "Base64-near-secret-keyword";    Pattern = '(?i)(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer|password|passwd|client[_-]?secret)["'']?\s*[:=]\s*["''][A-Za-z0-9+/]{40,}={0,2}["'']' }
    @{ Name = "Long-value-near-secret-keyword"; Pattern = '(?i)(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer|password|passwd|client[_-]?secret)["'']?\s*[:=]\s*["''][A-Za-z0-9._+/=-]{30,}["'']' }
    @{ Name = "Generic-live-key-quoted";    Pattern = '(?i)["''][A-Za-z0-9_-]{0,20}_live_[A-Za-z0-9]{20,}["'']' }
    @{ Name = "Generic-test-key-quoted";    Pattern = '(?i)["''][A-Za-z0-9_-]{0,20}_test_[A-Za-z0-9]{20,}["'']' }
)

# ---------- Allow-list (lines containing these are NOT flagged) ----------
# A line that matches a $secretPatterns regex but ALSO contains an allow-list
# pattern is treated as a placeholder, not a real secret.
$allowListPatterns = @(
    '\$\{[A-Z_][A-Z0-9_]*\}',                     # ${VAR}
    '\$\{\{[^}]+\}\}',                            # ${{ VAR }} (GitHub Actions)
    '\{\{[A-Z_][A-Z0-9_]*\}\}',                   # {{TOKEN}} (template placeholders)
    '<REDACTED>',
    '(?i)your[-_]?(api[-_]?)?(key|token|secret|credential)[-_]?here',
    '(?i)example[_-]?(api[_-]?)?(key|token|secret)',
    '(?i)xxx[_-]?(test|live|prod|dev)?[_-]?xxx',
    '(?i)\.{3,}',                                 # ellipsis (`eyJ...truncated`)
    'os\.environ',
    'process\.env',
    'getenv\(',
    'EnvironmentVariable',
    'config\.get\(',
    '(?i)YOUR[_-]?(API[_-]?)?(KEY|TOKEN|SECRET)',
    '(?i)<(your|api|token|secret)[^>]+>',         # <your-key>, <api-key>
    '(?i)redacted',
    '(?i)\bplaceholder\b',
    '(?i)\bfake[_-]?(key|token|secret)\b',
    '(?i)\bdummy[_-]?(key|token|secret)\b',
    '(?i)\bsample[_-]?(key|token|secret)\b',
    '(?i)\btest[_-]?value\b',
    '(?i)\b(do[_-]?not[_-]?use|never[_-]?use)\b',
    '(?i)credentials\.json\b',                    # filename references, not values
    'sk-XXXX',
    'sk_test_xxxxx'
)

# ---------- Files we never scan (binary, lockfiles, the scanner itself) ----------
$skipFilePatterns = @(
    '\.lock$',
    'package-lock\.json$',
    'pnpm-lock\.yaml$',
    'yarn\.lock$',
    'composer\.lock$',
    'Cargo\.lock$',
    'Gemfile\.lock$',
    'poetry\.lock$',
    'uv\.lock$',
    '\.min\.(js|css)$',
    '\.bundle\.(js|css)$',
    '\.(png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|otf|eot|pdf|zip|tar|gz|tgz|bz2|7z|exe|dll|so|dylib|class|jar|pyc|pyo|whl|mp3|mp4|mov|avi)$',
    '[\\/]node_modules[\\/]',
    '[\\/]dist[\\/]',
    '[\\/]build[\\/]',
    '[\\/]\.next[\\/]',
    '[\\/]\.venv[\\/]',
    '[\\/]venv[\\/]',
    '[\\/]__pycache__[\\/]',
    '[\\/]target[\\/]',
    '[\\/]vendor[\\/]',
    'CHANGELOG\.md$',                              # historical incident reports may quote secrets
    'scan-secrets\.(ps1|sh)$',                     # the scanner itself (this file)
    'CODING_STANDARDS\.md$',                       # the rule file enumerates the patterns
    'yolo-honesty-checks\.md$'                     # honesty section enumerates the patterns
)

# ---------- File enumeration ----------
function Get-FilesToScan {
    param([string]$Mode, [string[]]$ExtraPaths)

    switch ($Mode) {
        "staged" {
            $output = git diff --cached --name-only --diff-filter=ACM 2>$null
            if (-not $output) { return @() }
            return @($output | Where-Object { $_ -and (Test-Path $_) -and -not (Test-Path $_ -PathType Container) })
        }
        "tracked" {
            $output = git ls-files 2>$null
            if (-not $output) { return @() }
            return @($output | Where-Object { $_ -and (Test-Path $_) -and -not (Test-Path $_ -PathType Container) })
        }
        "all" {
            $tracked   = git ls-files 2>$null
            $untracked = git ls-files --others --exclude-standard 2>$null
            $combined  = @()
            if ($tracked)   { $combined += $tracked }
            if ($untracked) { $combined += $untracked }
            return @($combined | Where-Object { $_ -and (Test-Path $_) -and -not (Test-Path $_ -PathType Container) })
        }
        "paths" {
            return @($ExtraPaths | Where-Object { $_ -and (Test-Path $_) -and -not (Test-Path $_ -PathType Container) })
        }
    }
}

function Should-SkipFile {
    param([string]$Path)
    foreach ($skip in $skipFilePatterns) {
        if ($Path -match $skip) { return $true }
    }
    return $false
}

function Test-AllowListed {
    param([string]$Snippet)
    foreach ($allow in $allowListPatterns) {
        if ($Snippet -match $allow) { return $true }
    }
    return $false
}

# ---------- Main ----------
$matchesFound = New-Object System.Collections.ArrayList
$files = Get-FilesToScan -Mode $Mode -ExtraPaths $Paths
$scannedCount = 0

if (-not $files -or $files.Count -eq 0) {
    $emptyReport = @{ matches = @(); files_scanned = 0; mode = $Mode; status = "clean" }
    Write-Output ($emptyReport | ConvertTo-Json -Depth 5 -Compress:$false)
    exit 0
}

foreach ($file in $files) {
    if (Should-SkipFile -Path $file) { continue }
    $scannedCount++

    try {
        # Wrap in @(...) so single-line files don't degrade to a string (which
        # would then be character-indexed in the for-loop below). This is a
        # well-known PowerShell quirk with Get-Content.
        $lines = @(Get-Content -Path $file -ErrorAction Stop)
    } catch {
        continue
    }

    if (-not $lines -or $lines.Count -eq 0) { continue }

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ([string]::IsNullOrWhiteSpace($line)) { continue }

        # Allow-list check FIRST: if the line contains a placeholder pattern,
        # don't flag any secret-shape match on this line.
        if (Test-AllowListed -Snippet $line) { continue }

        foreach ($pat in $secretPatterns) {
            if ($line -match $pat.Pattern) {
                $snippet = $line.Trim()
                if ($snippet.Length -gt 200) { $snippet = $snippet.Substring(0, 200) + "..." }
                [void]$matchesFound.Add(@{
                    file    = $file
                    line    = $i + 1
                    pattern = $pat.Name
                    snippet = $snippet
                })
                break # one match per line is enough
            }
        }
    }
}

$status = if ($matchesFound.Count -gt 0) { "secrets_detected" } else { "clean" }
$report = @{
    matches       = @($matchesFound)
    files_scanned = $scannedCount
    mode          = $Mode
    status        = $status
}

Write-Output ($report | ConvertTo-Json -Depth 5 -Compress:$false)

if ($matchesFound.Count -gt 0) { exit 1 } else { exit 0 }
