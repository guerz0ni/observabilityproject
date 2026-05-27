# sobrecarga
param(
    [string]$BaseUrl = "http://localhost:3000",
    [int]$DurationSec = 60,
    [int]$Concurrency = 6
)

$endAt = (Get-Date).AddSeconds($DurationSec)
$jobs = @()

Write-Host "Iniciando carga CPU por ${DurationSec}s com concorrência $Concurrency ..."

1..$Concurrency | ForEach-Object {
    $jobs += Start-Job -ScriptBlock {
        param($Url, $Until)
        while ((Get-Date) -lt $Until) {
            $ms = Get-Random -Minimum 8000 -Maximum 15000
            try {
                Invoke-WebRequest -Uri "$Url/incidents/cpu-burn?durationMs=$ms" -TimeoutSec ($ms / 1000 + 30) | Out-Null
            } catch { }
        }
    } -ArgumentList $BaseUrl, $endAt
}

while ((Get-Date) -lt $endAt) {
    $active = ($jobs | Where-Object { $_.State -eq 'Running' }).Count
    Write-Host "  Jobs ativos: $active"
    Start-Sleep -Seconds 3
}

$jobs | Wait-Job | Out-Null
$jobs | Remove-Job -Force
Write-Host "Carga finalizada. Verifique CPU no Grafana."
