# =====================================================================
# Tiny static-file HTTP server for the VTC Web app.
# Uses System.Net.HttpListener (built into Windows — no installs).
#
# Run by double-clicking serve.bat, or from a PowerShell prompt:
#     powershell -ExecutionPolicy Bypass -File serve.ps1
# =====================================================================

$ErrorActionPreference = 'Stop'

# Serve this folder (so "./VCT Grid/" paths resolve to the bundled assets).
$root = (Resolve-Path $PSScriptRoot).Path
$port = 8000
$prefix = "http://localhost:$port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try { $listener.Start() } catch {
    Write-Host ""
    Write-Host "ERROR: could not start listener on $prefix" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host "If port 8000 is already in use, edit serve.ps1 and change `$port = 8000."
    Write-Host "Press any key to close..."
    [void][System.Console]::ReadKey($true)
    exit 1
}

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.gif'  = 'image/gif'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
    '.bin'  = 'application/octet-stream'
    '.txt'  = 'text/plain; charset=utf-8'
    '.md'   = 'text/plain; charset=utf-8'
}

Write-Host ""
Write-Host "  VTC Web server" -ForegroundColor Cyan
Write-Host "  Serving: $root"
Write-Host ""
Write-Host "  Open this in your browser:" -ForegroundColor Yellow
Write-Host "    http://localhost:$port/" -ForegroundColor Green
Write-Host ""
Write-Host "  Press Ctrl+C in this window to stop."
Write-Host ""

# Optional: auto-open the browser on first run
Start-Process "http://localhost:$port/"

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response
        $relPath = ''
        try {
            $relPath = [System.Net.WebUtility]::UrlDecode($req.Url.AbsolutePath).TrimStart('/')
            if ([string]::IsNullOrEmpty($relPath)) { $relPath = 'index.html' }
            $full = Join-Path $root $relPath

            # Block path traversal
            $fullResolved = [IO.Path]::GetFullPath($full)
            if (-not $fullResolved.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
                $res.StatusCode = 403
                Write-Host "403 $relPath" -ForegroundColor Red
            }
            elseif ((Test-Path -LiteralPath $fullResolved -PathType Container)) {
                $idx = Join-Path $fullResolved 'index.html'
                if (Test-Path -LiteralPath $idx -PathType Leaf) {
                    $fullResolved = $idx
                    $ext = '.html'
                    $ct = $mime[$ext]
                    $bytes = [IO.File]::ReadAllBytes($fullResolved)
                    $res.ContentType = $ct
                    $res.ContentLength64 = $bytes.Length
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    Write-Host "200 $relPath  ($($bytes.Length) bytes)"
                } else {
                    $res.StatusCode = 404
                    Write-Host "404 $relPath  (dir, no index.html)" -ForegroundColor DarkGray
                }
            }
            elseif (Test-Path -LiteralPath $fullResolved -PathType Leaf) {
                $ext = [IO.Path]::GetExtension($fullResolved).ToLower()
                $ct  = $mime[$ext]
                if (-not $ct) { $ct = 'application/octet-stream' }
                $res.ContentType = $ct
                $bytes = [IO.File]::ReadAllBytes($fullResolved)
                $res.ContentLength64 = $bytes.Length
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
                Write-Host "200 $relPath  ($($bytes.Length) bytes)"
            }
            else {
                $res.StatusCode = 404
                Write-Host "404 $relPath" -ForegroundColor DarkGray
            }
        } catch {
            try { $res.StatusCode = 500 } catch {}
            Write-Host "500 $relPath  $($_.Exception.Message)" -ForegroundColor Red
        } finally {
            try { $res.Close() } catch {}
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
