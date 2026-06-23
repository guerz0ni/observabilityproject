# Observabilidade — E-commerce API

API de e-commerce monitorada com Docker: Prometheus (métricas), Loki (logs) e Grafana (dashboards).

## Stack

| Serviço | Função |
|---------|--------|
| API Node.js (E-commerce) | Aplicação monitorada |
| Prometheus | Coleta de métricas |
| Node Exporter | CPU, memória e rede |
| Loki | Armazenamento de logs |
| Promtail | Envio de logs ao Loki |
| Grafana | Dashboards |

## E-commerce

Fluxo típico de loja online:

1. **Cadastro/login** — cliente autenticado
2. **Catálogo** — listar produtos
3. **Carrinho** — adicionar/remover itens
4. **Checkout** — criar pedido (`POST /orders`)
5. **Pedidos** — consultar histórico

### Endpoints

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| POST | `/register` | Não | Cadastro |
| POST | `/login` | Não | Login JWT |
| GET/PUT/DELETE | `/users` | Sim | CRUD usuários |
| GET | `/products` | Não | Catálogo |
| GET | `/products/:id` | Não | Detalhe do produto |
| GET | `/cart` | Sim | Ver carrinho |
| POST | `/cart/items` | Sim | Adicionar ao carrinho |
| DELETE | `/cart/items/:id` | Sim | Remover item |
| DELETE | `/cart` | Sim | Limpar carrinho |
| POST | `/orders` | Sim | Checkout |
| GET | `/orders` | Sim | Listar pedidos |
| GET | `/orders/:id` | Sim | Detalhe do pedido |

Persistência em JSON: `users.json`, `products.json`, `orders.json`, `carts.json` (volume Docker).

## Monitoramento

**Métricas de negócio:** `orders_created_total`, `checkout_failures_total`, `cart_additions_total`, `order_value_reais`, `active_carts_total`, `products_in_stock_total`.

**Logs:** `event_type: ecommerce` — `cart_item_added`, `checkout_started`, `order_created`, `checkout_failed`, etc.

**Dashboard:** blocos Infraestrutura, Aplicação, Incidentes, Monitoramento Aprimorado e **E-commerce**.

## Incidentes

1. Erros 500 no login  
2. Sobrecarga de CPU  
3. Instabilidade (timeout/delay)  
4. **Falha de pagamento** — `POST /incidents/payment-storm/start` (checkout 500)

## Portas

| Serviço | Porta |
|---------|-------|
| API | 3000 |
| Grafana | 3001 |
| Prometheus | 9090 |
| Loki | 3100 |

## Tecnologias

Node.js, Express, Prometheus, Grafana, Loki, Promtail, Docker Compose.
