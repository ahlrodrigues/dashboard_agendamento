# Dashboard de Agendamento

Dashboard web para o Call Center acompanhar agendamentos cadastrados no SGP, com foco em visao semanal, filtros operacionais e apoio ao cadastro de novas datas de atendimento.

## Objetivo

Este projeto foi criado para dar ao Call Center uma visao simples e operacional dos agendamentos do SGP.

Hoje ele permite:

- consultar agendamentos reais pela API do SGP
- visualizar cards de resumo por status
- navegar por uma grade semanal de horarios
- pesquisar por cliente, contrato e protocolo
- registrar pre-agendamentos locais quando a escrita oficial no SGP ainda nao estiver configurada

## Conceitos do projeto

- `POP`: corresponde ao agrupamento operacional que aparece no SGP e que inicialmente estava sendo chamado de `rota`
- `pre-agendamento local`: registro salvo localmente para nao perder a solicitacao do cliente enquanto a integracao de escrita com o SGP nao estiver habilitada
- `modo contingencia`: fallback automatico quando o SGP nao responde ou nao retorna dados para o periodo consultado

## Estrutura

- `server.js`: servidor HTTP e integracao com a API do SGP
- `public/index.html`: estrutura da interface
- `public/styles.css`: layout e identidade visual do dashboard
- `public/app.js`: logica do frontend
- `config.example.json`: modelo de configuracao versionado
- `data/manual-agendamentos.json`: armazenamento local dos pre-agendamentos

## Configuracao

Crie um `config.json` local a partir do `config.example.json`.

Exemplo:

```json
{
  "url_base": "https://sgp.exemplo.com.br/",
  "auth_mode": "basic",
  "basic_auth": {
    "username": "SEU_USUARIO",
    "password": "SUA_SENHA"
  },
  "dashboard": {
    "atualizacao_segundos": 300,
    "janela_dias_passado": 7,
    "janela_dias_futuro": 14,
    "timeout_sgp_ms": 12000,
    "horarios_padrao": ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"]
  },
  "agendamento": {
    "endpoint_lista": "/api/ura/ordemservico/list/",
    "endpoint_agendar": "",
    "statuses_consulta": [0, 1],
    "permite_pre_agendamento_local": true
  }
}
```

## Como executar

```bash
npm start
```

Depois abra:

```text
http://127.0.0.1:8780
```

Para desenvolvimento:

```bash
npm run dev
```

## Estado atual

- leitura do SGP: pronta
- interface inicial do dashboard: pronta
- pre-agendamento local: pronto
- escrita oficial no SGP: pendente de confirmacao do endpoint de criacao/edicao

## Seguranca

- `config.json` nao deve ser versionado
- o repositorio inclui apenas `config.example.json`
- antes de publicar em ambiente real, o ideal e migrar credenciais para variaveis de ambiente ou um arquivo local separado

## Licenca

Este projeto esta licenciado sob a licenca MIT. Veja o arquivo `LICENSE`.
