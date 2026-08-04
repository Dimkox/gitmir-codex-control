# Install GitMir Codex plugin skills into $HOME\.agents\skills
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Src  = Join-Path $Root "plugin\skills"
$Dest = Join-Path $HOME ".agents\skills"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Get-ChildItem $Src -Directory | ForEach-Object {
  $target = Join-Path $Dest $_.Name
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  New-Item -ItemType Junction -Path $target -Target $_.FullName | Out-Null
  Write-Host "linked $($_.Name)"
}
Write-Host ""
Write-Host "Done. Restart Codex, then try: `$gitmir-model"
