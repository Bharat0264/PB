param(
    [Parameter(Mandatory=$true)][string]$Printer,
    [Parameter(Mandatory=$true)][string]$Sumatra,
    [string]$Origin = "http://127.0.0.1:4188"
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$python = (Get-Command python.exe).Source
$sumatraPath = (Resolve-Path -LiteralPath $Sumatra).Path
$uri = [uri]$Origin
if ($uri.Scheme -ne "https" -and !($uri.Scheme -eq "http" -and $uri.IsLoopback)) {
    throw "Use HTTPS or a loopback address."
}
if (!$env:PRINTBEE_PRINT_AGENT_KEY) { throw "Set PRINTBEE_PRINT_AGENT_KEY in your user environment." }
if (@($root, $Printer, $sumatraPath, $Origin) | Where-Object { $_ -match '["\r\n]' -or $_.EndsWith('\') }) {
    throw "Use arguments without quotes, line breaks, or trailing backslashes."
}
$arguments = '"{0}\print_agent.py" --origin "{1}" --printer "{2}" --sumatra "{3}"' -f $root, $Origin, $Printer, $sumatraPath
$action = New-ScheduledTaskAction -Execute $python -Argument $arguments -WorkingDirectory $root
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([Timespan]::Zero)
Register-ScheduledTask -TaskName "PrintBee Warehouse Print Agent" -Action $action -Trigger $trigger -Settings $settings -User $user -Force | Out-Null
Write-Output "Installed for this user's next Windows sign-in. Set the user-scoped key and sign out and back in before testing."
