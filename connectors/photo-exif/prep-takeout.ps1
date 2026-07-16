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

.EXAMPLE
    powershell -File prep-takeout.ps1 -WhatIf
    powershell -File prep-takeout.ps1
#>
param(
    [string]   $PhotoRoot       = 'C:\Artifacts\life-context\photo',
    [string]   $ZipPattern      = 'takeout-*.zip',
    [string[]] $VideoExtensions = @('.mp4', '.mov', '.m4v', '.avi', '.mkv', '.wmv', '.mpg', '.mpeg', '.3gp', '.webm'),
    [switch]   $WhatIf
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic

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
    Write-Error "PhotoRoot not found: $PhotoRoot"
    exit 1
}

# Fast, case-insensitive extension lookup.
$videoSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($ext in $VideoExtensions) { [void] $videoSet.Add($ext) }

$zips = @(Get-ChildItem -LiteralPath $PhotoRoot -Filter $ZipPattern -File)
if ($zips.Count -eq 0) {
    Write-Host "no zips to process in $PhotoRoot (pattern $ZipPattern)"
    exit 0
}

$extracted = 0; $recycledZips = 0; $failed = 0
foreach ($zip in $zips) {
    Write-Host "extracting $($zip.Name)"
    try {
        if ($WhatIf) {
            Write-Host "[WhatIf] Expand-Archive $($zip.Name) -> $PhotoRoot"
        } else {
            Expand-Archive -LiteralPath $zip.FullName -DestinationPath $PhotoRoot -Force
        }
        $extracted++
    } catch {
        # Leave the zip in place (not recycled) so nothing is lost to a half-run; keep going.
        Write-Warning "extract failed, leaving in place: $($zip.Name) -- $($_.Exception.Message)"
        $failed++
        continue
    }
    Move-ToRecycleBin -Path $zip.FullName
    if (-not $WhatIf) { Write-Host "recycled $($zip.Name)" }
    $recycledZips++
}

# Only after extraction: strip videos from the merged tree so they never reach scan.js.
$recycledVideos = 0
$videos = @(Get-ChildItem -LiteralPath $PhotoRoot -Recurse -File |
    Where-Object { $videoSet.Contains($_.Extension) })
foreach ($video in $videos) {
    Move-ToRecycleBin -Path $video.FullName
    if (-not $WhatIf) { Write-Host "recycled video $($video.FullName)" }
    $recycledVideos++
}

Write-Host "zips extracted=$extracted recycled=$recycledZips failed=$failed videos recycled=$recycledVideos"
