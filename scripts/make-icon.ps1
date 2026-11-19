# Draws the OneChat icon (coral tile, cream speech bubble, three dots = several AIs)
# and writes public\icon.png plus public\icon.ico (PNG-in-ICO, 256 px).
# ASCII only: Windows PowerShell 5.1 reads .ps1 files as ANSI.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$png = Join-Path $root 'public\icon.png'
$ico = Join-Path $root 'public\icon.ico'

function New-RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return ,$p
}
function Get-Color([string]$hex) { return [System.Drawing.ColorTranslator]::FromHtml($hex) }

$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

$tile = New-RoundRect 8 8 240 240 56
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF 256, 256), (Get-Color '#dd9173'), (Get-Color '#a9583e')
$g.FillPath($grad, $tile)

$cream = New-Object System.Drawing.SolidBrush (Get-Color '#faf9f5')
$bubble = New-RoundRect 46 60 164 112 38
$g.FillPath($cream, $bubble)
$tail = [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF 82, 160), (New-Object System.Drawing.PointF 74, 208), (New-Object System.Drawing.PointF 128, 168))
$g.FillPolygon($cream, $tail)

$dots = @(@('#cc785c', 92), @('#3f9d8b', 128), @('#e8a55a', 164))
foreach ($d in $dots) {
  $b = New-Object System.Drawing.SolidBrush (Get-Color $d[0])
  $g.FillEllipse($b, [float]($d[1] - 14), [float](116 - 14), [float]28, [float]28)
  $b.Dispose()
}
$g.Dispose()
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# The .ico holds every size the taskbar, title bar and Alt+Tab ask for, each drawn at its own
# size (a single 256 px picture shrunk on the fly looks blurry at 16-32 px).
$src = [System.Drawing.Image]::FromFile($png)
$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$blobs = New-Object System.Collections.ArrayList
foreach ($s in $sizes) {
  $b2 = New-Object System.Drawing.Bitmap $s, $s
  $g2 = [System.Drawing.Graphics]::FromImage($b2)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g2.Clear([System.Drawing.Color]::Transparent)
  $g2.DrawImage($src, 0, 0, $s, $s)
  $g2.Dispose()
  $m2 = New-Object System.IO.MemoryStream
  $b2.Save($m2, [System.Drawing.Imaging.ImageFormat]::Png)
  $b2.Dispose()
  [void]$blobs.Add($m2.ToArray())
  $m2.Dispose()
}
$src.Dispose()

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)  # ICONDIR: reserved, type=icon, count
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }                      # 0 means 256
  $bw.Write([Byte]$dim); $bw.Write([Byte]$dim); $bw.Write([Byte]0); $bw.Write([Byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)                                   # planes, bits per pixel
  $bw.Write([UInt32]$blobs[$i].Length); $bw.Write([UInt32]$offset)              # size, offset
  $offset += $blobs[$i].Length
}
foreach ($blob in $blobs) { $bw.Write([Byte[]]$blob) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($ico, $ms.ToArray())
$bw.Dispose()

Write-Output "icon.png $((Get-Item $png).Length) bytes, icon.ico $((Get-Item $ico).Length) bytes"
