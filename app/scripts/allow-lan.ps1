<#
.SYNOPSIS
  One-shot Windows Firewall setup for Director's Flick LAN access (T-48).

.DESCRIPTION
  Adds inbound allow rules (Private network profile only) for the two ports
  the phone needs to reach this PC:
    - 5173  Vite dev server (the mobile review UI)
    - 4000  Backend API/WebSocket
  Idempotent: existing rules with the same names are left untouched.
  Requires an elevated (Administrator) PowerShell — the script exits with
  instructions if not elevated. Supports -WhatIf for a dry run.

.EXAMPLE
  Right-click PowerShell -> Run as administrator, then:
    powershell -File app\scripts\allow-lan.ps1
  Dry run (no changes):
    powershell -File app\scripts\allow-lan.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param()

$rules = @(
    @{ Name = "Directors Flick UI (vite 5173)"; Port = 5173 },
    @{ Name = "Directors Flick API (4000)";     Port = 4000 }
)

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "This script must run in an elevated (Administrator) PowerShell." -ForegroundColor Yellow
    Write-Host "Right-click PowerShell -> 'Run as administrator', then re-run:" -ForegroundColor Yellow
    Write-Host "  powershell -File `"$PSCommandPath`""
    exit 1
}

foreach ($rule in $rules) {
    $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "OK  rule already present: $($rule.Name)"
        continue
    }
    if ($PSCmdlet.ShouldProcess($rule.Name, "New-NetFirewallRule (inbound TCP $($rule.Port), Private profile)")) {
        New-NetFirewallRule -DisplayName $rule.Name `
            -Direction Inbound -Action Allow -Protocol TCP `
            -LocalPort $rule.Port -Profile Private | Out-Null
        Write-Host "ADD rule created: $($rule.Name) (TCP $($rule.Port), Private)"
    }
}

Write-Host ""
Write-Host "Done. Your phone (same Wi-Fi) can now open the QR link from the app's 'Phone' button."
