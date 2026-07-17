<#
.SYNOPSIS
    Prep a downloaded Google Takeout photo export for the photo-exif scanner.

.DESCRIPTION
    Runs BEFORE scan.js. For each `takeout-*.zip` in -PhotoRoot: extracts it into
    -PhotoRoot (multi-part Takeout zips are independent archives that merge into the
    shared `Takeout\` tree, so -Force overwrites byte-identical dupes across parts),
    then — only on a successful extract — sends that zip to the Recycle Bin. After all
    zips are extracted, recurses -PhotoRoot and sends every movie file to the Recycle
    Bin so videos never reach the library.

    Recycle Bin, never permanent delete: recoverable, and consistent with this box's
    delete-blocked posture (the `rm`/`Remove-Item` deny) and the repo's append-only
    ethos. Uses Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(SendToRecycleBin),
    not Remove-Item. NOTE: the Recycle Bin still occupies disk until emptied — to
    reclaim the space, empty it manually after verifying the extraction (permanent
    delete is blocked, so this script cannot free it).

.PARAMETER PhotoRoot
    Folder holding the zips; also the extraction target. Default C:\Artifacts\life-context\photo.

.PARAMETER ZipPattern
    Which zips to process. Default takeout-*.zip.

.PARAMETER VideoExtensions
    Movie file extensions (with leading dot) to recycle from the extracted tree.

.PARAMETER WhatIf
    Dry-run: log every action prefixed [WhatIf], change nothing on disk.

.PARAMETER LogPath
    Persistent, append-only run log. Default <PhotoRoot>\prep-takeout.log. Every run
    appends (never truncates), so the file accumulates the full history of every part
    ever processed. Each line is `UTC-timestamp LEVEL message` (LEVEL = INFO/WARN);
    logged alongside the stdout output (tee), and -WhatIf lines carry a [WhatIf] marker.
    Logging is best-effort: an unwritable log degrades to a stdout warning and never
    aborts the run. The .log is neither a takeout-*.zip nor a video, so it is inert to
    the script's own extract/recycle scans.

.EXAMPLE
    powershell -File prep-takeout.ps1 -WhatIf
    powershell -File prep-takeout.ps1
#>
param(
    [string]   $PhotoRoot       = 'C:\Artifacts\life-context\photo',
    [string]   $ZipPattern      = 'takeout-*.zip',
    [string[]] $VideoExtensions = @('.mp4', '.mov', '.m4v', '.avi', '.mkv', '.wmv', '.mpg', '.mpeg', '.3gp', '.webm'),
    [switch]   $WhatIf,
    [string]   $LogPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic

# Default the log next to the data it describes, once -PhotoRoot is known. Resolved
# before the -PhotoRoot existence check so an early exit still has a target if set.
if (-not $LogPath) { $LogPath = Join-Path $PhotoRoot 'prep-takeout.log' }

# Append one line to the run log. Best-effort: a locked/unwritable log degrades to a
# stdout warning and NEVER throws, so a logging failure can't lose a real extraction.
function Write-Log {
    param([string] $Message, [string] $Level = 'INFO')
    try {
        $line = "{0:yyyy-MM-ddTHH:mm:ssZ} {1,-5} {2}" -f (Get-Date).ToUniversalTime(), $Level, $Message
        Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
    } catch {
        Write-Warning "log write failed ($LogPath): $($_.Exception.Message)"
    }
}

# Send a single file to the Recycle Bin (no permanent delete). Honors -WhatIf.
function Move-ToRecycleBin {
    param([string] $Path)
    if ($WhatIf) { Write-Host "[WhatIf] recycle $Path"; return }
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
        $Path,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
}

if (-not (Test-Path -LiteralPath $PhotoRoot -PathType Container)) {
    Write-Log "PhotoRoot not found: $PhotoRoot" 'WARN'
    Write-Error "PhotoRoot not found: $PhotoRoot"
    exit 1
}

# Fast, case-insensitive extension lookup.
$videoSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($ext in $VideoExtensions) { [void] $videoSet.Add($ext) }

$zips = @(Get-ChildItem -LiteralPath $PhotoRoot -Filter $ZipPattern -File)
Write-Log "run start PhotoRoot=$PhotoRoot zips=$($zips.Count) whatif=$([bool]$WhatIf)"
if ($zips.Count -eq 0) {
    Write-Host "no zips to process in $PhotoRoot (pattern $ZipPattern)"
    Write-Log "no zips to process (pattern $ZipPattern)"
    Write-Log "run end zips: extracted=0 recycled=0 failed=0 | videos: recycled=0 failed=0"
    exit 0
}

$extracted = 0; $recycledZips = 0; $failed = 0; $recycledVideos = 0; $videosFailed = 0
foreach ($zip in $zips) {
    Write-Host "extracting $($zip.Name)"
    try {
        if ($WhatIf) {
            Write-Host "[WhatIf] Expand-Archive $($zip.Name) -> $PhotoRoot"
            Write-Log "[WhatIf] extract ok $($zip.Name)"
        } else {
            Expand-Archive -LiteralPath $zip.FullName -DestinationPath $PhotoRoot -Force
            Write-Log "extract ok $($zip.Name)"
        }
        $extracted++
    } catch {
        # Leave the zip in place (not recycled) so nothing is lost to a half-run; keep going.
        Write-Warning "extract failed, leaving in place: $($zip.Name) -- $($_.Exception.Message)"
        Write-Log "extract FAIL $($zip.Name) -- $($_.Exception.Message)" 'WARN'
        $failed++
        continue
    }
    # Recycle is its own try/catch: $ErrorActionPreference='Stop' would otherwise let one
    # locked/undeletable zip abort the entire run. Leave a failed one in place and continue.
    try {
        Move-ToRecycleBin -Path $zip.FullName
        if (-not $WhatIf) { Write-Host "recycled $($zip.Name)" }
        Write-Log "$(if ($WhatIf) { '[WhatIf] ' })recycle ok $($zip.Name)"
        $recycledZips++
    } catch {
        Write-Warning "recycle failed, leaving in place: $($zip.Name) -- $($_.Exception.Message)"
        Write-Log "recycle FAIL $($zip.Name) -- $($_.Exception.Message)" 'WARN'
        $failed++
    }
}

# Only after extraction: strip videos from the merged tree so they never reach scan.js.
# Streamed (not materialized into an array) so a huge library doesn't build the whole
# FileInfo list in memory. Capture $path before the try so the catch's $_ (the error
# record, not the pipeline item) doesn't shadow it; counters use $script: to update the
# script-scope totals from inside the ForEach-Object child scope.
Get-ChildItem -LiteralPath $PhotoRoot -Recurse -File |
    Where-Object { $videoSet.Contains($_.Extension) } |
    ForEach-Object {
        # Same per-item guard as the zips: one locked video must not abort the whole cleanup.
        $path = $_.FullName
        try {
            Move-ToRecycleBin -Path $path
            if (-not $WhatIf) { Write-Host "recycled video $path" }
            $script:recycledVideos++
        } catch {
            Write-Warning "video recycle failed: $path -- $($_.Exception.Message)"
            $script:videosFailed++
        }
    }

# One SUMMARY line for videos (not one per video — a library can hold thousands).
Write-Log "$(if ($WhatIf) { '[WhatIf] ' })videos recycled=$recycledVideos failed=$videosFailed"

$note = if ($WhatIf) { ' (dry-run -- nothing changed)' } else { '' }
Write-Host "zips: extracted=$extracted recycled=$recycledZips failed=$failed | videos: recycled=$recycledVideos failed=$videosFailed$note"
Write-Log "run end zips: extracted=$extracted recycled=$recycledZips failed=$failed | videos: recycled=$recycledVideos failed=$videosFailed$note"
