# Demo E-commerce - fluxo completo (PowerShell)
param(
    [string]$BaseUrl = "http://localhost:3000"
)

Write-Host "=== Demo E-commerce ===" -ForegroundColor Cyan

# 1. Cadastro
$email = "cliente$(Get-Random)@loja.com"
$reg = @{ email = $email; password = "senha123"; name = "Cliente Demo" } | ConvertTo-Json
$user = Invoke-RestMethod -Method POST -Uri "$BaseUrl/register" -ContentType "application/json" -Body $reg
Write-Host "Cadastro OK: $($user.email)"

# 2. Login
$login = Invoke-RestMethod -Method POST -Uri "$BaseUrl/login" -ContentType "application/json" `
    -Body (@{ email = $email; password = "senha123" } | ConvertTo-Json)
$token = $login.token
$headers = @{ Authorization = "Bearer $token" }
Write-Host "Login OK"

# 3. Catalogo
$products = Invoke-RestMethod -Uri "$BaseUrl/products"
Write-Host "Produtos: $($products.Count)"
$products | Select-Object -First 3 | Format-Table id, name, price, stock

# 4. Carrinho
$p1 = $products[0].id
$p2 = $products[1].id
Invoke-RestMethod -Method POST -Uri "$BaseUrl/cart/items" -ContentType "application/json" `
    -Headers $headers -Body (@{ productId = $p1; quantity = 1 } | ConvertTo-Json) | Out-Null
Invoke-RestMethod -Method POST -Uri "$BaseUrl/cart/items" -ContentType "application/json" `
    -Headers $headers -Body (@{ productId = $p2; quantity = 2 } | ConvertTo-Json) | Out-Null
$cart = Invoke-RestMethod -Uri "$BaseUrl/cart" -Headers $headers
Write-Host ("Carrinho: {0} itens, total R$ {1}" -f $cart.itemCount, $cart.total)

# 5. Checkout
$order = Invoke-RestMethod -Method POST -Uri "$BaseUrl/orders" -Headers $headers
Write-Host ("Pedido criado: {0} - R$ {1}" -f $order.id, $order.total) -ForegroundColor Green

# 6. Listar pedidos
$orders = Invoke-RestMethod -Uri "$BaseUrl/orders" -Headers $headers
Write-Host "Total de pedidos: $($orders.Count)"
Write-Host ""
Write-Host "Veja no Grafana: bloco E-COMMERCE e Logs E-commerce" -ForegroundColor Yellow
