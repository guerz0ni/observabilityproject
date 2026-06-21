# Observabilidade — API Node.js

Ambiente de observabilidade com Docker para monitorar uma API Node.js: métricas (Prometheus), logs (Loki) e dashboards (Grafana).

## Stack

| Serviço | Função |
|---------|--------|
| API Node.js | Aplicação monitorada |
| Prometheus | Coleta de métricas |
| Node Exporter | Métricas de CPU, memória e rede |
| Loki | Armazenamento de logs |
| Promtail | Envio de logs ao Loki |
| Grafana | Visualização e dashboards |

## API

- CRUD de usuários (`POST /register`, `GET /users`, `PUT /users/:id`, `DELETE /users/:id`)
- Login com JWT (`POST /login`)
- Persistência de usuários em arquivo JSON (volume Docker)
- Logs estruturados em JSON (`console.log` / `console.error`)
- Métricas Prometheus em `/metrics`
- Health check em `/health`

## Monitoramento aprimorado (métricas e logs)

### Métricas adicionais

| Métrica | Descrição |
|---------|-----------|
| `crud_operations_total` | Operações create/read/update/delete |
| `auth_attempts_total` | Tentativas de login/registro/token |
| `http_client_errors_total` | Erros HTTP 4xx |
| `http_server_errors_total` | Erros HTTP 5xx |
| `slow_requests_total` | Requisições acima de 1s |
| `http_requests_in_flight` | Requisições em processamento |
| `registered_users_total` | Total de usuários cadastrados |
| `log_events_total` | Contagem de eventos de log por nível/tipo |

### Logs aprimorados

- **`request_id`**: correlação por requisição (header `X-Request-Id`)
- **`event_type`**: `http`, `auth`, `crud`, `security`, `incident`, `system`, `persistence`
- Eventos: `slow_request`, `auth_denied`, `users_listed`, falhas de validação, etc.

### Dashboard

Bloco **MONITORAMENTO APRIMORADO** com painéis de CRUD, autenticação, 4xx/5xx, requisições lentas, logs por nível e por tipo de evento.

## Observabilidade

**Métricas:** requisições HTTP, latência, erros de login, erros da aplicação, disponibilidade (`service_up`), CPU, memória e rede.

**Logs:** requisições, falhas de login, erros da aplicação e eventos de sistema/incidentes.

**Dashboard Grafana:** resumo executivo, infraestrutura, aplicação (inclui taxa de erro em %), incidentes e monitoramento aprimorado.

## Simulação de incidentes

1. **Alta taxa de erro** — logins retornando HTTP 500  
2. **Sobrecarga** — aumento de CPU via requisições pesadas  
3. **Instabilidade** — delays, timeouts e logs intermitentes  

Scripts em `scripts/` e rotas em `/incidents/*`.

## Portas

| Serviço | Porta |
|---------|-------|
| API | 3000 |
| Grafana | 3001 |
| Prometheus | 9090 |
| Loki | 3100 |
| Node Exporter | 9100 |

## Tecnologias

Node.js, Express, Prometheus, Grafana, Loki, Promtail, Docker Compose.
