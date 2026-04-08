const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8780);
const BASE_DIR = __dirname;
const PUBLIC_DIR = path.join(BASE_DIR, "public");
const DATA_DIR = path.join(BASE_DIR, "data");
const CONFIG_PATH = path.join(BASE_DIR, "config.json");
const CONFIG_LOCAL_PATH = path.join(BASE_DIR, "config.local.json");
const MANUAL_SCHEDULES_PATH = path.join(DATA_DIR, "manual-agendamentos.json");

const DEFAULT_STATUSES = [0, 1];
const DEFAULT_SLOTS = ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"];
const DEFAULT_TIMEOUT_MS = 12000;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MANUAL_SCHEDULES_PATH)) {
    fs.writeFileSync(MANUAL_SCHEDULES_PATH, "[]\n", "utf8");
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function loadConfig() {
  const configPath = fs.existsSync(CONFIG_LOCAL_PATH) ? CONFIG_LOCAL_PATH : CONFIG_PATH;
  const config = readJson(configPath, {});
  return {
    ...config,
    dashboard: {
      atualizacao_segundos: 300,
      janela_dias_passado: 7,
      janela_dias_futuro: 14,
      horarios_padrao: DEFAULT_SLOTS,
      timeout_sgp_ms: DEFAULT_TIMEOUT_MS,
      ...(config.dashboard || {})
    },
    agendamento: {
      endpoint_lista: "/api/ura/ordemservico/list/",
      endpoint_contrato: "/api/suporte/contrato/list/",
      endpoint_agendar: "/api/ura/chamado/",
      ocorrencia_tipo_padrao: 5,
      motivo_os_padrao: 1,
      setor_padrao: 1,
      prioridade_os_padrao: 2,
      statuses_consulta: DEFAULT_STATUSES,
      permite_pre_agendamento_local: true,
      ...(config.agendamento || {})
    }
  };
}

function buildAuthHeaders(config) {
  if (String(config.auth_mode || "").toLowerCase() !== "basic") {
    return {};
  }
  const username = config.basic_auth?.username || "";
  const password = config.basic_auth?.password || "";
  if (!username && !password) {
    return {};
  }
  const token = Buffer.from(`${username}:${password}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

function buildBasePayload(config) {
  if (String(config.auth_mode || "").toLowerCase() !== "app_token") {
    return {};
  }
  return {
    app: config.app_token_auth?.app || "",
    token: config.app_token_auth?.token || ""
  };
}

async function postToSgp(config, endpointPath, payload) {
  const baseUrl = String(config.url_base || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("url_base nao configurada.");
  }

  const url = `${baseUrl}${endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`}`;
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries({ ...buildBasePayload(config), ...payload })) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        body.append(key, String(item));
      }
      continue;
    }
    body.append(key, String(value));
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...buildAuthHeaders(config)
    },
    body,
    signal: AbortSignal.timeout(Number(config.dashboard?.timeout_sgp_ms || DEFAULT_TIMEOUT_MS))
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errorText = await response.text();
      if (errorText) {
        try {
          const errorJson = JSON.parse(errorText);
          detail = errorJson.message || errorJson.msg || errorJson.detail || errorText;
        } catch (error) {
          detail = errorText;
        }
      }
    } catch (error) {
      detail = "";
    }
    throw new Error(detail ? `Falha no SGP (${response.status}): ${detail}` : `Falha no SGP (${response.status} ${response.statusText})`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Resposta nao JSON retornada pelo SGP.");
  }
}

function extractListFromResponse(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (!data || typeof data !== "object") {
    return [];
  }
  return (
    data.data ||
    data.results ||
    data.ordens_servicos ||
    data.ordens_servico ||
    data.response ||
    []
  );
}

async function listServiceOrders(config, { startDate, endDate }) {
  const endpoint = config.agendamento?.endpoint_lista || "/api/ura/ordemservico/list/";
  const statuses = Array.isArray(config.agendamento?.statuses_consulta) && config.agendamento.statuses_consulta.length
    ? config.agendamento.statuses_consulta
    : DEFAULT_STATUSES;
  const results = [];

  for (const status of statuses) {
    let offset = 0;
    const limit = 500;
    while (true) {
      const payload = {
        status,
        offset,
        limit,
        data_agendamento_inicio: startDate,
        data_agendamento_fim: endDate
      };

      const response = await postToSgp(config, endpoint, payload);
      const chunk = extractListFromResponse(response);
      if (!Array.isArray(chunk)) {
        throw new Error("Formato inesperado na lista de ordens de servico.");
      }

      results.push(...chunk);
      if (chunk.length < limit) {
        break;
      }
      offset += limit;
    }
  }

  return dedupeBy(results, (item) => String(item.id || item.os_id || item.pk || JSON.stringify(item)));
}

async function lookupContract(config, contractId) {
  const endpoint = String(config.agendamento?.endpoint_contrato || "/api/suporte/contrato/list/").trim();
  if (!endpoint) {
    throw new Error("Endpoint de consulta de contrato nao configurado.");
  }

  const baseUrl = String(config.url_base || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("url_base nao configurada.");
  }

  const url = `${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildAuthHeaders(config)
    },
    body: JSON.stringify({
      contrato_id: String(contractId || "").trim()
    }),
    signal: AbortSignal.timeout(Number(config.dashboard?.timeout_sgp_ms || DEFAULT_TIMEOUT_MS))
  });

  if (!response.ok) {
    throw new Error(`Falha no SGP (${response.status} ${response.statusText})`);
  }

  const data = await response.json();
  const rows = extractListFromResponse(data);

  if (!Array.isArray(rows)) {
    throw new Error("Formato inesperado na consulta de contrato.");
  }

  const normalizedContractId = String(contractId || "").trim();
  const raw =
    rows.find((item) => String(item.contrato_id || item.contrato || "").trim() === normalizedContractId) ||
    rows[0];

  if (!raw) {
    throw new Error("Contrato nao encontrado no SGP.");
  }

  return normalizeContractLookup(config, raw);
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }
  return output;
}

function readManualSchedules() {
  ensureDataDir();
  return readJson(MANUAL_SCHEDULES_PATH, []);
}

function saveManualSchedule(entry) {
  const rows = readManualSchedules();
  rows.push(entry);
  writeJson(MANUAL_SCHEDULES_PATH, rows);
  return entry;
}

function deleteManualSchedule(entryId) {
  const rows = readManualSchedules();
  const nextRows = rows.filter((item) => String(item.id || "") !== String(entryId || ""));
  if (nextRows.length === rows.length) {
    return false;
  }
  writeJson(MANUAL_SCHEDULES_PATH, nextRows);
  return true;
}

function isoDateOnly(value) {
  if (!value) {
    return "";
  }
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  const brazilMatch = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brazilMatch) {
    return `${brazilMatch[3]}-${brazilMatch[2]}-${brazilMatch[1]}`;
  }
  return "";
}

function hhmm(value) {
  if (!value) {
    return "";
  }
  const match = String(value).match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : "";
}

function normalizeSlot(value) {
  const time = hhmm(value);
  if (!time || time === "00:00") {
    return "A definir";
  }
  return time;
}

function plusDays(baseDate, days) {
  const date = new Date(`${baseDate}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeStatus(raw) {
  const text = String(
    raw.status_descricao ||
      raw.status_nome ||
      raw.status_label ||
      raw.status ||
      raw.situacao ||
      ""
  ).toLowerCase();

  if (text.includes("agend")) {
    return "agendado";
  }
  return "pre_agendado";
}

function pickClientName(raw) {
  return (
    raw.nome_razao_social ||
    raw.nome_cliente ||
    raw.cliente_nome ||
    raw.cliente ||
    raw.razao_social ||
    raw.nome ||
    "Cliente nao identificado"
  );
}

function pickProtocol(raw) {
  return String(
    raw.id ||
    raw.os_id ||
    raw.numero ||
    raw.protocolo ||
    raw.cod_os ||
    raw.codigo ||
    ""
  );
}

function normalizeRoute(raw) {
  return (
    raw.rota ||
    raw.nome_rota ||
    raw.cidade ||
    raw.bairro ||
    raw.pop ||
    "Sem rota"
  );
}

function normalizeTechnician(raw) {
  return (
    raw.tecnico_nome ||
    raw.tecnico ||
    raw.finalizado_por ||
    raw.responsavel ||
    "Nao definido"
  );
}

function pickClientId(raw) {
  const value =
    raw.id_cliente ||
    raw.cliente_id ||
    raw.idpessoa ||
    raw.pessoa_id ||
    raw.cod_cliente ||
    raw.codigo_cliente ||
    "";
  return String(value || "").trim();
}

function buildClientUrl(config, raw) {
  const baseUrl = String(config.url_base || "").replace(/\/+$/, "");
  if (!baseUrl) {
    return "";
  }

  const osId = String(raw.os_id || raw.id || "").trim();
  if (osId) {
    return `${baseUrl}/admin/atendimento/ocorrencia/os/${encodeURIComponent(osId)}/edit/`;
  }

  const clientId = pickClientId(raw);
  if (clientId) {
    return `${baseUrl}/admin/cliente/${encodeURIComponent(clientId)}/`;
  }

  return `${baseUrl}/admin/cliente/list/`;
}

function buildAddressText(raw) {
  const parts = [
    raw.endereco_logradouro,
    raw.endereco_numero,
    raw.endereco_complemento,
    raw.endereco_bairro,
    raw.endereco_cidade,
    raw.endereco_uf
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return parts.join(", ");
}

function normalizeContractLookup(config, raw) {
  const clientId = String(raw.cliente_id || raw.id_cliente || "").trim();
  return {
    contrato: String(raw.contrato_id || raw.contrato || "").trim(),
    cliente: String(raw.cliente_nome || raw.cliente || raw.razaosocial || "").trim(),
    telefone: String(raw.cliente_contato || raw.telefone || raw.celular || raw.fone || "").trim(),
    rota: String(raw.contrato_pop_nome || raw.contrato_pop || raw.pop || "").trim(),
    endereco: buildAddressText(raw),
    clienteId: clientId,
    clienteUrl: buildClientUrl(config, { cliente_id: clientId })
  };
}

function normalizeSchedule(config, raw, source = "sgp") {
  const date = isoDateOnly(
    raw.data_agendamento ||
    raw.data_agendada ||
    raw.data_marcada ||
    raw.data ||
    ""
  );
  const time = hhmm(
    raw.hora_agendamento ||
    raw.hora_marcada ||
    raw.hora ||
    ""
  );
  const status = normalizeStatus(raw);

  return {
    id: `${source}-${pickProtocol(raw) || cryptoRandomId()}`,
    osId: String(raw.os_id || raw.id || ""),
    protocolo: pickProtocol(raw),
    cliente: pickClientName(raw),
    contrato: String(raw.id_contrato || raw.contrato || raw.codigo_cliente || ""),
    telefone: String(raw.telefone || raw.celular || raw.fone || ""),
    rota: normalizeRoute(raw),
    tecnico: normalizeTechnician(raw),
    data: date,
    horario: normalizeSlot(time),
    hasScheduledDate: Boolean(date),
    status,
    clienteUrl: buildClientUrl(config, raw),
    endereco: raw.endereco || raw.logradouro || "",
    observacao: raw.observacao || raw.descricao || raw.motivo || "",
    origem: source,
    raw
  };
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
}

function normalizeManualSchedule(entry) {
  return {
    id: entry.id || `manual-${cryptoRandomId()}`,
    osId: "",
    protocolo: entry.protocolo || "",
    cliente: entry.cliente || "Cliente nao identificado",
    contrato: entry.contrato || "",
    telefone: entry.telefone || "",
    rota: entry.rota || "Call Center",
    tecnico: entry.tecnico || "A definir",
    data: isoDateOnly(entry.data),
    horario: normalizeSlot(entry.horario),
    hasScheduledDate: Boolean(isoDateOnly(entry.data)),
    status: entry.status || "pre_agendado",
    clienteUrl: entry.clienteUrl || "",
    endereco: entry.endereco || "",
    observacao: entry.observacao || "",
    origem: "pre_agendamento_local",
    raw: entry
  };
}

function buildMockSchedules(referenceDate, slots) {
  const base = referenceDate;
  return [
    {
      id: "mock-1001",
      protocolo: "1001",
      cliente: "Maria de Fatima",
      contrato: "CTR-8452",
      telefone: "(83) 99123-0001",
      rota: "Centro",
      tecnico: "Cabral",
      data: base,
      horario: "08:00",
      status: "agendado",
      clienteUrl: "",
      endereco: "Rua das Flores, 120",
      observacao: "Confirmado pelo Call Center",
      origem: "mock"
    },
    {
      id: "mock-1002",
      protocolo: "1002",
      cliente: "Jose Roberto",
      contrato: "CTR-1120",
      telefone: "(83) 99123-0002",
      rota: "Norte",
      tecnico: "Eriki",
      data: plusDays(base, 1),
      horario: "10:00",
      status: "agendado",
      clienteUrl: "",
      endereco: "Rua da Feira, 44",
      observacao: "Cliente solicitou visita na parte da manha",
      origem: "mock"
    },
    {
      id: "mock-1003",
      protocolo: "1003",
      cliente: "Ana Claudia",
      contrato: "CTR-9901",
      telefone: "(83) 99123-0003",
      rota: "Sul",
      tecnico: "Wilton",
      data: plusDays(base, 2),
      horario: "14:00",
      status: "pre_agendado",
      clienteUrl: "",
      endereco: "Avenida Principal, 900",
      observacao: "Area bloqueada por manutencao",
      origem: "mock"
    },
    {
      id: "mock-1004",
      protocolo: "1004",
      cliente: "Carlos Henrique",
      contrato: "CTR-4567",
      telefone: "(83) 99123-0004",
      rota: "Centro",
      tecnico: "Micael",
      data: plusDays(base, 3),
      horario: slots[0] || "08:00",
      status: "pre_agendado",
      clienteUrl: "",
      endereco: "",
      observacao: "Janela ainda aberta para encaixe",
      origem: "mock"
    }
  ];
}

function startOfWeek(dateText) {
  const date = new Date(`${dateText}T12:00:00`);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date.toISOString().slice(0, 10);
}

function endOfWeek(dateText) {
  return plusDays(startOfWeek(dateText), 6);
}

function buildWeekDays(dateText) {
  const monday = startOfWeek(dateText);
  return Array.from({ length: 7 }, (_, index) => plusDays(monday, index));
}

function formatDateLabel(dateText) {
  const formatter = new Intl.DateTimeFormat("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit"
  });
  return formatter.format(new Date(`${dateText}T12:00:00`));
}

function buildGrid(schedules, selectedDate, slots) {
  const days = buildWeekDays(selectedDate);
  const dynamicSlots = new Set(slots);
  for (const item of schedules) {
    if (days.includes(item.data)) {
      dynamicSlots.add(item.horario || "A definir");
    }
  }
  const mergedSlots = Array.from(dynamicSlots).sort(compareSlots);
  const cells = {};
  for (const day of days) {
    cells[day] = {};
    for (const slot of mergedSlots) {
      cells[day][slot] = [];
    }
  }

  for (const item of schedules) {
    if (!cells[item.data]) {
      continue;
    }
    const slot = item.horario || "A definir";
    if (!cells[item.data][slot]) {
      cells[item.data][slot] = [];
    }
    cells[item.data][slot].push(item);
  }

  return {
    days: days.map((date) => ({
      date,
      label: formatDateLabel(date)
    })),
    slots: mergedSlots,
    cells
  };
}

function compareSlots(a, b) {
  if (a === "A definir") {
    return 1;
  }
  if (b === "A definir") {
    return -1;
  }
  return a.localeCompare(b);
}

function summarizeSchedules(schedules) {
  const summary = {
    total: schedules.length,
    agendado: 0,
    pre_agendado: 0
  };

  for (const item of schedules) {
    if (summary[item.status] !== undefined) {
      summary[item.status] += 1;
    }
  }
  return summary;
}

function filterSchedules(schedules, { search, status }) {
  return schedules.filter((item) => {
    if (status && status !== "todos" && item.status !== status) {
      return false;
    }
    if (!search) {
      return true;
    }
    const haystack = [
      item.cliente,
      item.protocolo,
      item.contrato,
      item.telefone,
      item.rota,
      item.tecnico
    ].join(" ").toLowerCase();
    return haystack.includes(search.toLowerCase());
  });
}

function serializeSchedule(item) {
  return {
    id: item.id,
    osId: item.osId || "",
    protocolo: item.protocolo,
    cliente: item.cliente,
    contrato: item.contrato,
    telefone: item.telefone,
    rota: item.rota,
    tecnico: item.tecnico,
    data: item.data,
    horario: item.horario,
    hasScheduledDate: Boolean(item.hasScheduledDate),
    status: item.status,
    clienteUrl: item.clienteUrl || "",
    endereco: item.endereco,
    observacao: item.observacao,
    origem: item.origem
  };
}

async function getDashboardData(query) {
  const config = loadConfig();
  const today = new Date().toISOString().slice(0, 10);
  const selectedDate = isoDateOnly(query.get("data")) || today;
  const startDate = isoDateOnly(query.get("inicio")) || plusDays(selectedDate, -Number(config.dashboard.janela_dias_passado || 7));
  const endDate = isoDateOnly(query.get("fim")) || plusDays(selectedDate, Number(config.dashboard.janela_dias_futuro || 14));
  const search = String(query.get("busca") || "").trim();
  const status = String(query.get("status") || "todos").trim().toLowerCase();
  const slots = Array.isArray(config.dashboard.horarios_padrao) && config.dashboard.horarios_padrao.length
    ? config.dashboard.horarios_padrao
    : DEFAULT_SLOTS;

  let sourceMode = "sgp";
  let notices = [];
  let schedules = [];

  try {
    const sgpRows = await listServiceOrders(config, { startDate, endDate });
    schedules = sgpRows.map((item) => normalizeSchedule(config, item, "sgp")).filter((item) => item.data);
    if (!schedules.length) {
      sourceMode = "mock";
      notices.push("Nenhum agendamento retornado pelo SGP para o periodo consultado. Exibindo dados de demonstracao.");
      schedules = buildMockSchedules(selectedDate, slots);
    }
  } catch (error) {
    sourceMode = "fallback";
    notices.push(`Nao foi possivel consultar o SGP agora: ${error.message}`);
    schedules = buildMockSchedules(selectedDate, slots);
  }

  const manualSchedules = readManualSchedules().map(normalizeManualSchedule);
  schedules = schedules.concat(manualSchedules);
  schedules = schedules.filter((item) => item.hasScheduledDate && item.data >= startDate && item.data <= endDate);
  schedules.sort((a, b) => `${a.data} ${a.horario}`.localeCompare(`${b.data} ${b.horario}`));

  const filtered = filterSchedules(schedules, { search, status });
  const serializedSchedules = filtered.map(serializeSchedule);
  const summary = summarizeSchedules(serializedSchedules);
  const grid = buildGrid(serializedSchedules, selectedDate, slots);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    selectedDate,
    period: {
      startDate,
      endDate,
      weekStart: startOfWeek(selectedDate),
      weekEnd: endOfWeek(selectedDate)
    },
    sourceMode,
    notices,
    capabilities: {
      canWriteToSgp: Boolean(String(config.agendamento?.endpoint_agendar || "").trim()),
      canSavePreScheduling: Boolean(config.agendamento?.permite_pre_agendamento_local)
    },
    summary,
    filters: {
      search,
      status
    },
    grid,
    schedules: serializedSchedules
  };
}

function toScheduledDateTime(date, time) {
  if (!date || !time || time === "A definir") {
    return "";
  }
  return `${date} ${time.slice(0, 5)}`;
}

function currentDateTimeForSgp() {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ];
  const time = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0")
  ];
  return `${parts.join("-")} ${time.join(":")}`;
}

function buildCreateCallPayload(config, entry) {
  const content = entry.observacao || `Agendamento solicitado para ${entry.data} ${entry.horario}.`;
  const payload = {
    contrato: entry.contrato,
    conteudo: content,
    observacao: entry.observacao || "",
    ocorrenciatipo: Number(config.agendamento?.ocorrencia_tipo_padrao || 5),
    motivoos: Number(config.agendamento?.motivo_os_padrao || 1),
    setor: Number(config.agendamento?.setor_padrao || 1),
    os_prioridade: Number(config.agendamento?.prioridade_os_padrao || 2),
    contato_nome: entry.cliente,
    contato_telefone: entry.telefone || "",
    data_hora_agendamento: toScheduledDateTime(entry.data, entry.horario)
  };

  if (entry.tecnico) {
    payload.responsavel = entry.tecnico;
  }

  return payload;
}

async function postJsonToSgp(config, endpointPath, payload) {
  const baseUrl = String(config.url_base || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("url_base nao configurada.");
  }

  const url = `${baseUrl}${endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildAuthHeaders(config)
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Number(config.dashboard?.timeout_sgp_ms || DEFAULT_TIMEOUT_MS))
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errorText = await response.text();
      if (errorText) {
        try {
          const errorJson = JSON.parse(errorText);
          detail = errorJson.message || errorJson.msg || errorJson.detail || errorText;
        } catch (error) {
          detail = errorText;
        }
      }
    } catch (error) {
      detail = "";
    }
    throw new Error(detail ? `Falha no SGP (${response.status}): ${detail}` : `Falha no SGP (${response.status} ${response.statusText})`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Resposta nao JSON retornada pelo SGP.");
  }
}

async function closeSgpSchedule(config, osId) {
  const app = String(config.app_token_auth?.app || "").trim();
  const token = String(config.app_token_auth?.token || "").trim();

  if (String(config.auth_mode || "").toLowerCase() === "app_token" && app && token) {
    const endpoint = `/api/central/chamado/update/${encodeURIComponent(String(osId || "").trim())}/`;
    return {
      mode: "central_chamado_update",
      response: await postToSgp(config, endpoint, {
        os_status: 1,
        ocorrencia_encerrar: 1,
        os_data_agendamento: "",
        notificar_cliente: ""
      })
    };
  }

  const endpoint = `/api/os/update/id/${encodeURIComponent(String(osId || "").trim())}/`;
  return {
    mode: "os_update_only",
    response: await postToSgp(config, endpoint, {
      os_status: 1,
      os_data_finalizacao: currentDateTimeForSgp()
    })
  };
}

async function createSchedule(payload) {
  const config = loadConfig();
  const entry = {
    cliente: String(payload.cliente || "").trim(),
    contrato: String(payload.contrato || "").trim(),
    telefone: String(payload.telefone || "").trim(),
    protocolo: String(payload.protocolo || "").trim(),
    rota: String(payload.rota || "").trim(),
    tecnico: String(payload.tecnico || "").trim(),
    data: isoDateOnly(payload.data),
    horario: hhmm(payload.horario),
    endereco: String(payload.endereco || "").trim(),
    observacao: String(payload.observacao || "").trim()
  };

  if (!entry.cliente || !entry.contrato || !entry.data || !entry.horario) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        message: "Informe pelo menos cliente, contrato, data e horario."
      }
    };
  }

  const endpoint = String(config.agendamento?.endpoint_agendar || "").trim();
  if (endpoint) {
    try {
      const response = await postJsonToSgp(config, endpoint, buildCreateCallPayload(config, entry));
      const rows = extractListFromResponse(response);
      const created = Array.isArray(rows) && rows.length ? rows[0] : response;
      return {
        statusCode: 201,
        body: {
          ok: true,
          mode: "sgp",
          message: "Ocorrencia e agendamento enviados ao SGP com sucesso.",
          response: created
        }
      };
    } catch (error) {
      if (!config.agendamento?.permite_pre_agendamento_local) {
        return {
          statusCode: 502,
          body: {
            ok: false,
            message: `Falha ao gravar no SGP: ${error.message}`
          }
        };
      }
    }
  }

  if (!config.agendamento?.permite_pre_agendamento_local) {
    return {
      statusCode: 501,
      body: {
        ok: false,
        message: "A escrita no SGP nao esta configurada e o pre-agendamento local esta desabilitado."
      }
    };
  }

  const saved = saveManualSchedule({
    ...entry,
    id: `manual-${Date.now()}`,
    status: "pre_agendado",
    created_at: new Date().toISOString()
  });

  return {
    statusCode: 201,
    body: {
      ok: true,
      mode: "local",
      message: "Pre-agendamento salvo localmente. Falta sincronizar com o SGP.",
      schedule: saved
    }
  };
}

async function getContractData(contractId) {
  const normalizedContractId = String(contractId || "").trim();
  if (!normalizedContractId) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        message: "Informe o ID do contrato."
      }
    };
  }

  const config = loadConfig();
  const [contract, openOses] = await Promise.all([
    lookupContract(config, normalizedContractId),
    lookupOpenOsForContract(config, normalizedContractId).catch(err => {
      console.error("OS lookup falhou (nao critico):", err.message);
      return [];
    })
  ]);

  return {
    statusCode: 200,
    body: {
      ok: true,
      contract,
      openOses
    }
  };
}

async function deleteSchedule(payload) {
  const id = String(payload.id || "").trim();
  const origem = String(payload.origem || "").trim();
  const osId = String(payload.osId || "").trim();

  if (!id) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        message: "Agendamento nao informado."
      }
    };
  }

  if (origem === "pre_agendamento_local") {
    const deleted = deleteManualSchedule(id);
    return deleted
      ? {
          statusCode: 200,
          body: {
            ok: true,
            mode: "local",
            message: "Agendamento local removido com sucesso."
          }
        }
      : {
          statusCode: 404,
          body: {
            ok: false,
            message: "Agendamento local nao encontrado."
          }
        };
  }

  if (origem === "sgp") {
    if (!osId) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          message: "OS do agendamento nao identificada para encerramento no SGP."
        }
      };
    }

    const config = loadConfig();
    const result = await closeSgpSchedule(config, osId);
    const message = result.mode === "central_chamado_update"
      ? "Agendamento encerrado no SGP com OS e ocorrencia fechadas."
      : "Agendamento encerrado no SGP com fechamento da OS. A ocorrencia nao foi encerrada porque a configuracao atual nao usa app/token.";
    return {
      statusCode: 200,
      body: {
        ok: true,
        mode: "sgp",
        message,
        response: result.response
      }
    };
  }

  return {
    statusCode: 400,
    body: {
      ok: false,
      message: "Origem do agendamento nao suportada para exclusao."
    }
  };
}

function sendJson(res, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function sendFile(res, filePath) {
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { ok: false, message: "Acesso negado." });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { ok: false, message: "Arquivo nao encontrado." });
      return;
    }

    const ext = path.extname(filePath);
    const typeMap = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    };

    res.writeHead(200, {
      "Content-Type": typeMap[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  });
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(new Error("JSON invalido no corpo da requisicao."));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    ensureDataDir();
    const parsedUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === "GET" && parsedUrl.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, service: "dashboard-agendamento-sgp" });
      return;
    }

    if (req.method === "GET" && parsedUrl.pathname === "/api/dashboard-data") {
      const data = await getDashboardData(parsedUrl.searchParams);
      sendJson(res, 200, data);
      return;
    }

    if (req.method === "GET" && parsedUrl.pathname === "/api/contrato") {
      const result = await getContractData(parsedUrl.searchParams.get("contrato"));
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/agendamentos") {
      const payload = await collectRequestBody(req);
      const result = await createSchedule(payload);
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/agendamentos/delete") {
      const payload = await collectRequestBody(req);
      const result = await deleteSchedule(payload);
      sendJson(res, result.statusCode, result.body);
      return;
    }

    const pathname = parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname;
    const filePath = path.join(PUBLIC_DIR, pathname);
    sendFile(res, filePath);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      message: error.message || "Erro inesperado no servidor."
    });
  }
});

server.listen(PORT, HOST, () => {
  ensureDataDir();
  console.log(`Dashboard disponivel em http://${HOST}:${PORT}`);
});


function buildOsUrl(config, osId) {
  const baseUrl = String(config.url_base || "").replace(/\/+$/, "");
  if (!baseUrl || !osId) return "";
  return `${baseUrl}/admin/atendimento/ocorrencia/os/${encodeURIComponent(String(osId).trim())}/edit/`;
}


async function lookupOpenOsForContract(config, contractId) {
  try {
    const endpoint = config.agendamento?.endpoint_lista || "/api/ura/ordemservico/list/";
    const statuses = Array.isArray(config.agendamento?.statuses_consulta) ? config.agendamento.statuses_consulta : [0, 1];
    
    const allRows = [];
    for (const status of statuses) {
      const payload = {
        status,
        limit: 10,
        contrato_id: contractId
      };
      try {
        const response = await postToSgp(config, endpoint, payload);
        const chunk = extractListFromResponse(response);
        if (Array.isArray(chunk)) {
          allRows.push(...chunk);
        }
      } catch (err) {
        console.error("Falha ao buscar OS com status " + status + ":", err.message);
      }
    }

    if (!allRows.length) return [];

    const uniqueRows = dedupeBy(allRows, row => String(row.id || row.os_id || ""));
    uniqueRows.sort((a, b) => Number(b.id || b.os_id || 0) - Number(a.id || a.os_id || 0));

    return uniqueRows.slice(0, 3).map(raw => {
      const osId = String(raw.id || raw.os_id || "");
      return {
        osId,
        protocolo:       String(raw.ocorrencia || raw.protocolo || raw.id || ""),
        assunto:         String(raw.motivo || ""),
        tipo:            String(raw.tipo || ""),
        data_abertura:   String(raw.data_cadastro || ""),
        hora_abertura:   String(raw.hora_cadastro || ""),
        data_agendamento: String(raw.data_agendamento || ""),
        status:          String(raw.status || ""),
        pop:             String(raw.pop || ""),
        responsavel:     String(raw.responsavel || ""),
        descritivo:      String(raw.conteudo || "").substring(0, 200),
        osUrl:           buildOsUrl(config, osId)
      };
    }).filter(x => x.osId);
  } catch (error) {
    console.error("Falha ao organizar OS abertas/pendentes:", error.message);
    return [];
  }
}
