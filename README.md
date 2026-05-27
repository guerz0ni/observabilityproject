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

## Observabilidade

**Métricas:** requisições HTTP, latência, erros de login, erros da aplicação, disponibilidade (`service_up`), CPU, memória e rede.

**Logs:** requisições, falhas de login, erros da aplicação e eventos de sistema/incidentes.

**Dashboard Grafana:** resumo executivo, infraestrutura, aplicação (inclui taxa de erro em %) e incidentes.

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
