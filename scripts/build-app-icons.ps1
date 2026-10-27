param([Parameter(Mandatory=$true)][string]$ThemeFile,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$themes = [IO.File]::ReadAllText($ThemeFile,[Text.Encoding]::UTF8) | ConvertFrom-Json
foreach ($theme in $themes) {
  $bitmap = New-Object Drawing.Bitmap(512,512)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $shape = New-Object Drawing.Drawing2D.GraphicsPath
  $accent = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml($theme.color))
  $dark = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#171819'))
  $pen = New-Object Drawing.Pen($dark,44)
  $font = New-Object Drawing.Font('Microsoft YaHei UI',60,[Drawing.FontStyle]::Bold,[Drawing.GraphicsUnit]::Pixel)
  $format = New-Object Drawing.StringFormat
  try {
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.Clear($dark.Color)
    $shape.AddArc(86,86,160,160,180,90)
    $shape.AddArc(266,86,160,160,270,90)
    $shape.AddArc(266,266,160,160,0,90)
    $shape.AddArc(86,266,160,160,90,90)
    $shape.CloseFigure()
    $graphics.FillPath($accent,$shape)
    $pen.StartCap = [Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
    $graphics.DrawArc($pen,162,158,170,170,45,270)
    $graphics.FillEllipse($dark,300,300,112,112)
    $format.Alignment = [Drawing.StringAlignment]::Center
    $format.LineAlignment = [Drawing.StringAlignment]::Center
    $graphics.DrawString([string]$theme.badge,$font,$accent,[Drawing.RectangleF]::new(300,300,112,112),$format)
    foreach ($size in @(192,512)) {
      $scaled = New-Object Drawing.Bitmap($size,$size)
      $scaledGraphics = [Drawing.Graphics]::FromImage($scaled)
      try {
        $scaledGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $scaledGraphics.DrawImage($bitmap,0,0,$size,$size)
        $scaled.Save((Join-Path $OutputDirectory ('app-icon-'+$theme.id+'-'+$size+'.png')),[Drawing.Imaging.ImageFormat]::Png)
      } finally { $scaledGraphics.Dispose();$scaled.Dispose() }
    }
  } finally { $format.Dispose();$font.Dispose();$pen.Dispose();$dark.Dispose();$accent.Dispose();$shape.Dispose();$graphics.Dispose();$bitmap.Dispose() }
}
