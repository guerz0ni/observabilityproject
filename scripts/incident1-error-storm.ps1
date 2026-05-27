# alta taxa de erro de logins 
param(
    [string]$BaseUrl = "http://localhost:3000",
    [int]$Count = 50
)

Write-Host "Ativando tempestade de erros em $BaseUrl ..."
Invoke-RestMethod -Method POST -Uri "$BaseUrl/incidents/error-storm/start" -ContentType "application/json" -Body (@{ count = $Count } | ConvertTo-Json)

for ($i = 0; $i -lt $Count; $i++) {
    try {
        Invoke-RestMethod -Method POST -Uri "$BaseUrl/login" -ContentType "application/json" -Body (@{ email = "storm$i@demo.com"; password = "x" } | ConvertTo-Json) -ErrorAction SilentlyContinue
    } catch {
        # esperado: 500
    }
    if ($i % 10 -eq 0) { Write-Host "  $i requisições enviadas..." }
}

Write-Host "Concluído. Verifique Grafana (taxa de erro) e Loki (logs de login_failed_simulated_storm)."
