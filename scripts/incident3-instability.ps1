#instabilidade
param(
    [string]$BaseUrl = "http://localhost:3000",
    [int]$Runs = 5
)

Write-Host "Disparando instabilidade em $BaseUrl ..."
for ($r = 1; $r -le $Runs; $r++) {
    Write-Host "Execução $r/$Runs"
    try {
        $iterations = Get-Random -Minimum 3 -Maximum 8
        Invoke-WebRequest -Uri "$BaseUrl/incidents/instability?iterations=$iterations" -TimeoutSec 120 -ErrorAction Stop | Out-Null
        Write-Host "  OK"
    } catch {
        Write-Host "  Timeout/erro esperado: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds (Get-Random -Minimum 1 -Maximum 4)
}
Write-Host "Concluído. Verifique painel de logs em tempo real no Grafana."
