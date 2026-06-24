# Observabilidade — E-commerce API

API de e-commerce monitorada com Docker: Prometheus (métricas), Loki (logs) e Grafana (dashboards).

## Stack

| Serviço | Função |
|---------|--------|
| API Node.js (E-commerce) | Aplicação monitorada |
| Prometheus | Coleta de métricas |
| Loki | Armazenamento de logs |
| Promtail | Envio de logs ao Loki |
| Grafana | Dashboards + simulação |

## E-commerce

Fluxo: cadastro/login → catálogo → carrinho → checkout → pedidos.

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/register`, `/login` | Autenticação |
| GET | `/products` | Catálogo |
| POST | `/cart/items` | Adicionar ao carrinho |
| POST | `/orders` | Checkout (pedido pendente → pagamento) |
| POST | `/orders/:id/confirm` | Confirmar pagamento |
| GET | `/orders` | Listar pedidos |

## Simulação (botões no Grafana)

| GET | Rota | Efeito |
|-----|------|--------|
| `/simulate/brute-force?count=30` | Força bruta no login |
| `/simulate/checkout-success?count=3` | Compras realizadas |
| `/simulate/pending-orders?count=5` | Pedidos em aberto |
| `/simulate/users-online?count=8` | Usuários online |
| `/simulate/payment-storm/start` | Falha de pagamento |
| `/simulate/payment-storm/stop` | Normalizar pagamentos |

## Métricas de negócio

`users_online_total`, `orders_pending_total`, `payments_successful_total`, `payments_failed_total`, `brute_force_attempts_total`, `orders_created_total`, `checkout_failures_total`, `cart_additions_total`, `order_value_reais`

## Portas

API `3000` · Grafana `3001` · Prometheus `9090`

## CI/CD

GitHub Actions em `.github/workflows/ci.yml` — valida sintaxe e build Docker.

## Tecnologias

Node.js, Express, Prometheus, Grafana, Loki, Promtail, Docker Compose.
