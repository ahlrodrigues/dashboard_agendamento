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
const PACKAGE_PATH = path.join(BASE_DIR, "package.json");
const MANUAL_SCHEDULES_PATH = path.join(DATA_DIR, "manual-agendamentos.json");
const BLOCKED_SLOTS_PATH = path.join(DATA_DIR, "blocked-slots.json");
const CONFIRMATION_DISPATCH_LOG_PATH = path.join(DATA_DIR, "confirmation-dispatch-log.json");

const DEFAULT_STATUSES = [0, 1];
const DEFAULT_SLOTS = ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"];
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_SEND_INTERVAL_MS = 30000;
const CONFIRMATION_RESEND_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CONFIRMATION_RESEND_FIRST_MS = 2 * 60 * 60 * 1000;
const CONFIRMATION_RESEND_SECOND_MS = 4 * 60 * 60 * 1000;
const CONFIRMATION_MANUAL_AFTER_MS = 6 * 60 * 60 * 1000;
const CONFIRMATION_CACHE_TTL_MS = 5 * 60 * 1000;
const confirmationStatusCache = new Map();
let sgpDispatchQueue = Promise.resolve();
let lastSgpDispatchAt = 0;
let confirmationResendJobTimer = null;
let confirmationResendJobRunning = false;

const DASHBOARD_VERSION = (() => {
  try {
    const { getDashboardVersionLabel } = require("./version");
    return getDashboardVersionLabel();
  } catch (error) {
    return "dev";
  }
})();

function toLocalIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MANUAL_SCHEDULES_PATH)) {
    fs.writeFileSync(MANUAL_SCHEDULES_PATH, "[]\n", "utf8");
  }
  if (!fs.existsSync(BLOCKED_SLOTS_PATH)) {
    fs.writeFileSync(BLOCKED_SLOTS_PATH, "[]\n", "utf8");
  }
  if (!fs.existsSync(CONFIRMATION_DISPATCH_LOG_PATH)) {
    fs.writeFileSync(CONFIRMATION_DISPATCH_LOG_PATH, "{}\n", "utf8");
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

function readBlockedSlots() {
  const data = readJson(BLOCKED_SLOTS_PATH, []);
  return Array.isArray(data) ? data : [];
}

function writeBlockedSlots(items) {
  writeJson(BLOCKED_SLOTS_PATH, Array.isArray(items) ? items : []);
}

function normalizeBlockedSlot(entry) {
  const rota = String(entry.rota || "").trim() || "Sem POP";
  const data = isoDateOnly(entry.data);
  const start = hhmm(entry.horario_inicio || entry.horario);
  const end = hhmm(entry.horario_fim || entry.horario);
  const motivo = String(entry.motivo || entry.observacao || "").trim();
  const slotTime = hhmm(entry.__slot_time || "");
  const rangeLabel = start && end && start !== end ? `${start}-${end}` : (start || end);
  const horario = slotTime ? normalizeSlot(slotTime) : normalizeSlot(rangeLabel);
  const observacao = slotTime
    ? [rangeLabel ? `Bloqueio: ${rangeLabel}` : "", motivo].filter(Boolean).join(" · ")
    : motivo;

  return {
    id: entry.id || `block-${cryptoRandomId()}`,
    osId: "",
    protocolo: "",
    cliente: "Horario bloqueado",
    contrato: "",
    telefone: "",
    rota,
    tecnico: "",
    data,
    horario,
    hasScheduledDate: Boolean(data),
    status: "bloqueado",
    clienteUrl: "",
    confirmationUrl: "",
    confirmationStatus: "sem_confirmacao",
    confirmationTitle: "",
    confirmationSent: false,
    confirmationRequestedAt: "",
    endereco: "",
    observacao,
    origem: "bloqueio",
    raw: entry
  };
}

function saveBlockedSlot(entry) {
  const items = readBlockedSlots();
  const saved = {
    id: String(entry.id || "").trim() || `block-${Date.now()}`,
    rota: String(entry.rota || "").trim(),
    data: isoDateOnly(entry.data),
    horario_inicio: hhmm(entry.horario_inicio || entry.horario),
    horario_fim: hhmm(entry.horario_fim || entry.horario),
    motivo: String(entry.motivo || "").trim(),
    created_at: entry.created_at || new Date().toISOString()
  };
  items.push(saved);
  writeBlockedSlots(items);
  return saved;
}

function deleteBlockedSlot(id) {
  const items = readBlockedSlots();
  const normalizedId = String(id || "").trim();
  const next = items.filter((item) => String(item.id || "").trim() !== normalizedId);
  if (next.length === items.length) {
    return false;
  }
  writeBlockedSlots(next);
  return true;
}

function createSimpleJwt(payload, secret) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = simpleHmac(`${header}.${body}`, secret);
  return `${header}.${body}.${signature}`;
}

function simpleHmac(data, secret) {
  const crypto = require("crypto");
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

function verifySimpleJwt(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const [header, body, signature] = parts;
    const expectedSig = simpleHmac(`${header}.${body}`, secret);
    if (signature !== expectedSig) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.exp && Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function extractBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return null;
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
      intervalo_envio_base_ms: DEFAULT_SEND_INTERVAL_MS,
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
    },
    auth: {
      jwt_secret: "dashboard-secret-change-in-production",
      admin_group: "agendamento",
      ...(config.auth || {})
    }
  };
}

async function fetchSgpUserInfo(config, username, password) {
  const baseUrl = String(config.url_base || "").replace(/\/+$/, "");
  const authToken = Buffer.from(`${username}:${password}`).toString("base64");
  
  const response = await fetch(`${baseUrl}/api/auth/info/`, {
    headers: {
      Authorization: `Basic ${authToken}`,
      "Content-Type": "application/json"
    },
    signal: AbortSignal.timeout(Number(config.dashboard?.timeout_sgp_ms || DEFAULT_TIMEOUT_MS))
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("Credenciais invalidas");
    }
    throw new Error(`Erro ao autenticar no SGP: ${response.status}`);
  }

  return response.json();
}

function userHasAdminGroup(userInfo, config) {
  const adminGroup = String(config.auth?.admin_group || "agendamento").toLowerCase();
  const grupos = userInfo?.grupos || [];
  return grupos.some(g => 
    String(g.descricao || "").toLowerCase() === adminGroup
  );
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
  const app = String(config.app_token_auth?.app || "").trim();
  const token = String(config.app_token_auth?.token || "").trim();
  if (!app || !token) {
    return {};
  }
  return {
    app,
    token
  };
}

function hasAppTokenAuth(config) {
  return Boolean(
    String(config.app_token_auth?.app || "").trim() &&
    String(config.app_token_auth?.token || "").trim()
  );
}

function logSgpScheduleUpdate(stage, details) {
  try {
    console.log(`[SGP_UPDATE] ${stage} ${JSON.stringify(details)}`);
  } catch (error) {
    console.log(`[SGP_UPDATE] ${stage}`);
  }
}

function readConfirmationCache(osId) {
  const key = String(osId || "").trim();
  const cached = confirmationStatusCache.get(key);
  if (!cached) {
    return null;
  }
  if ((Date.now() - cached.createdAt) > CONFIRMATION_CACHE_TTL_MS) {
    confirmationStatusCache.delete(key);
    return null;
  }
  return cached.value;
}

function writeConfirmationCache(osId, value) {
  const key = String(osId || "").trim();
  if (!key) {
    return;
  }
  confirmationStatusCache.set(key, {
    createdAt: Date.now(),
    value
  });
}

function readConfirmationDispatchLog() {
  const value = readJson(CONFIRMATION_DISPATCH_LOG_PATH, {});
  return value && typeof value === "object" ? value : {};
}

function writeConfirmationDispatchLog(value) {
  writeJson(CONFIRMATION_DISPATCH_LOG_PATH, value && typeof value === "object" ? value : {});
}

function readConfirmationDispatchEntry(osId) {
  const key = String(osId || "").trim();
  if (!key) {
    return null;
  }
  const log = readConfirmationDispatchLog();
  const entry = log[key];
  return entry && typeof entry === "object" ? entry : null;
}

function writeConfirmationDispatchEntry(osId, entry) {
  const key = String(osId || "").trim();
  if (!key) {
    return;
  }
  const log = readConfirmationDispatchLog();
  log[key] = {
    ...((log[key] && typeof log[key] === "object") ? log[key] : {}),
    ...(entry && typeof entry === "object" ? entry : {})
  };
  writeConfirmationDispatchLog(log);
  const cached = readConfirmationCache(key);
  if (cached) {
    writeConfirmationCache(key, applyConfirmationDispatchState(cached, log[key]));
  }
}

function splitSetCookieHeader(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : String(value).split(/,(?=[^;]+?=)/);
}

function mergeCookieHeaders(...cookieSources) {
  const entries = new Map();
  for (const source of cookieSources) {
    for (const raw of splitSetCookieHeader(source)) {
      const pair = String(raw || "").split(";")[0].trim();
      if (!pair) {
        continue;
      }
      const eq = pair.indexOf("=");
      const key = eq >= 0 ? pair.slice(0, eq) : pair;
      entries.set(key, pair);
    }
  }
  return Array.from(entries.values()).join("; ");
}

function extractHtmlFieldValue(html, name) {
  const safeName = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const input = html.match(new RegExp(`<input[^>]*name=['"]${safeName}['"][^>]*value=['"]([^'"]*)['"][^>]*>`, "i"));
  if (input) {
    return input[1];
  }

  const textarea = html.match(new RegExp(`<textarea[^>]*name=['"]${safeName}['"][^>]*>([\\s\\S]*?)<\\/textarea>`, "i"));
  if (textarea) {
    return textarea[1];
  }

  const select = html.match(new RegExp(`<select[^>]*name=['"]${safeName}['"][^>]*>([\\s\\S]*?)<\\/select>`, "i"));
  if (select) {
    const options = [...select[1].matchAll(/<option([^>]*)value=['"]([^'"]*)['"]([^>]*)>/gi)];
    const selected = options.find((match) => /selected/i.test(`${match[1]} ${match[3]}`));
    return selected ? selected[2] : "";
  }

  return "";
}

function htmlFieldChecked(html, name) {
  const safeName = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const input = html.match(new RegExp(`<input[^>]*name=['"]${safeName}['"][^>]*>`, "i"));
  return Boolean(input && /checked/i.test(input[0]));
}

function extractHtmlSelectOptions(html, name) {
  const safeName = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const select = html.match(new RegExp(`<select[^>]*name=['"]${safeName}['"][^>]*>([\\s\\S]*?)<\\/select>`, "i"));
  if (!select) {
    return [];
  }

  return [...select[1].matchAll(/<option([^>]*)value=['"]([^'"]*)['"]([^>]*)>([\s\S]*?)<\/option>/gi)].map((match) => ({
    value: String(match[2] || "").trim(),
    label: String(match[4] || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").trim(),
    selected: /selected/i.test(`${match[1]} ${match[3]}`)
  }));
}

function normalizePhoneDigits(value) {
  return String(value || "").replace(/\D+/g, "");
}

function pickSmsClientValues(html, requestedPhone) {
  const options = extractHtmlSelectOptions(html, "sms_cliente").filter((item) => item.value);
  if (!options.length) {
    return [];
  }

  const targetDigits = normalizePhoneDigits(requestedPhone);
  if (targetDigits) {
    const exact = options.find((item) => {
      const labelDigits = normalizePhoneDigits(item.label);
      return labelDigits === targetDigits || labelDigits.endsWith(targetDigits) || targetDigits.endsWith(labelDigits);
    });
    if (exact) {
      return [exact.value];
    }
  }

  const selected = options.filter((item) => item.selected).map((item) => item.value);
  if (selected.length) {
    return selected;
  }

  return [options[0].value];
}

function pickGatewayValue(html, preferredLabel = "AGENDAMENTO") {
  const options = extractHtmlSelectOptions(html, "gateway_sms").filter((item) => item.value);
  if (!options.length) {
    return "";
  }

  const normalizedLabel = String(preferredLabel || "").trim().toLowerCase();
  const match = options.find((item) => String(item.label || "").trim().toLowerCase() === normalizedLabel);
  if (match) {
    return match.value;
  }

  const contains = options.find((item) => String(item.label || "").toLowerCase().includes(normalizedLabel));
  if (contains) {
    return contains.value;
  }

  const selected = options.find((item) => item.selected);
  return selected ? selected.value : options[0].value;
}

function resolveSendIntervalMs(config) {
  const value = Number(config.dashboard?.intervalo_envio_base_ms || DEFAULT_SEND_INTERVAL_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SEND_INTERVAL_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function enqueueSgpDispatch(config, task) {
  const run = async () => {
    const waitMs = Math.max(0, (lastSgpDispatchAt + resolveSendIntervalMs(config)) - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    try {
      return await task();
    } finally {
      lastSgpDispatchAt = Date.now();
    }
  };

  const scheduled = sgpDispatchQueue.then(run, run);
  sgpDispatchQueue = scheduled.catch(() => undefined);
  return scheduled;
}

async function runWithConcurrencyLimit(items, limit, worker) {
  const queue = Array.isArray(items) ? items.slice() : [];
  const concurrency = Math.max(1, Number(limit) || 1);
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function toBrazilDateTime(date, time) {
  const isoDate = isoDateOnly(date);
  const normalizedTime = String(time || "").trim();
  const fullTime = /^\d{2}:\d{2}:\d{2}$/.test(normalizedTime)
    ? normalizedTime
    : /^\d{2}:\d{2}$/.test(normalizedTime)
      ? `${normalizedTime}:00`
      : "";
  if (!isoDate || !fullTime) {
    return "";
  }
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year} ${fullTime}`;
}

async function createSgpWebSession(config) {
  const baseUrl = String(config.url_base || "").replace(/\/+$/, "");
  const username = String(config.basic_auth?.username || "").trim();
  const password = String(config.basic_auth?.password || "").trim();
  if (!baseUrl || !username || !password) {
    throw new Error("Credenciais web do SGP nao configuradas para editar OS pela interface.");
  }

  const loginUrl = `${baseUrl}/accounts/login/`;
  const loginPage = await fetch(loginUrl, {
    signal: AbortSignal.timeout(Number(config.dashboard?.timeout_sgp_ms || DEFAULT_TIMEOUT_MS))
  });
  const loginHtml = await loginPage.text();
  const loginCsrf = extractHtmlFieldValue(loginHtml, "csrfmiddlewaretoken");
  const loginCookies = mergeCookieHeaders(
    loginPage.headers.getSetCookie?.(),
    loginPage.headers.get("set-cookie")
  );
  if (!loginCsrf) {
    throw new Error("Nao foi possivel obter CSRF da tela de login do SGP.");
  }

  const body = new URLSearchParams({
    csrfmiddlewaretoken: loginCsrf,
    username,
    password,
    next: "/"
  });
  const loginResponse = await fetch(loginUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: loginCookies,
      Referer: loginUrl
    },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(Number(config.dashboard?.timeout_sgp_ms || DEFAULT_TIMEOUT_MS))
  });

  const sessionCookies = mergeCookieHeaders(
    loginCookies,
    loginResponse.headers.getSetCookie?.(),
    loginResponse.headers.get("set-cookie")
  );
  if (!sessionCookies.includes("sessionid=")) {
    throw new Error("Falha ao autenticar na interface web do SGP.");
  }
  return {
    baseUrl,
    cookies: sessionCookies
  };
}

async function fetchSgpOsEditForm(config, session, osId) {
  const editUrl = `${session.baseUrl}/admin/atendimento/ocorrencia/os/${encodeURIComponent(String(osId).trim())}/edit/`;
  const response = await fetch(editUrl, {
    headers: {
      Cookie: session.cookies
    },
    signal: AbortSignal.timeout(Number(config.dashboard?.timeout_sgp_ms || DEFAULT_TIMEOUT_MS))
  });
  const html = await response.text();
  if (!response.ok || !/name=['"]data_agendamento['"]/i.test(html)) {
    throw new Error("Nao foi possivel abrir o formulario web da OS no SGP.");
  }
  return {
    url: editUrl,
    html
  };
}

function extractOccurrenceEditPathFromOsHtml(html) {
  const match = String(html || "").match(/\/admin\/atendimento\/ocorrencia\/\d+\/edit\//i);
  return match ? match[0] : "";
}

function parseConfirmationState(answerFlag, confirmationHash) {
  const flag = String(answerFlag || "").trim();

  if (flag === "True") {
    return "confirmado";
  }
  if (flag === "False") {
    return "rejeitado";
  }
  return "sem_confirmacao";
}

function applyConfirmationDispatchState(details, dispatchEntry) {
  const next = {
    confirmationUrl: details.confirmationUrl || "",
    confirmationStatus: details.confirmationStatus || "sem_confirmacao",
    confirmationTitle: details.confirmationTitle || "",
    confirmationSent: Boolean(details.confirmationSent),
    confirmationRequestedAt: String(details.confirmationRequestedAt || "").trim()
  };

  if (next.confirmationStatus === "confirmado" || next.confirmationStatus === "rejeitado") {
    next.confirmationSent = true;
    return next;
  }

  const dispatchState = String(dispatchEntry?.state || "").trim();
  const resendCount = Math.max(0, Number(dispatchEntry?.resendCount || 0));
  if (dispatchState === "queued") {
    next.confirmationStatus = "na_fila_envio";
    next.confirmationSent = false;
    next.confirmationRequestedAt = "";
    return next;
  }

  if (dispatchState === "processing") {
    next.confirmationStatus = "processando_envio";
    next.confirmationSent = false;
    next.confirmationRequestedAt = "";
    return next;
  }

  if (dispatchState === "error") {
    next.confirmationStatus = "erro_envio";
    next.confirmationSent = false;
    next.confirmationRequestedAt = "";
    return next;
  }

  if (dispatchState === "manual") {
    next.confirmationStatus = "envio_manual";
    next.confirmationSent = false;
    next.confirmationRequestedAt = "";
    return next;
  }

  if (dispatchEntry?.requestedAt || dispatchState === "requested") {
    next.confirmationStatus = resendCount >= 2
      ? "reenvio_2"
      : resendCount === 1
        ? "reenvio_1"
        : "aguardando_confirmacao";
    next.confirmationSent = true;
    next.confirmationRequestedAt = String(dispatchEntry.requestedAt || "").trim();
  }

  return next;
}

function extractConfirmationDetailsFromOccurrenceHtml(baseUrl, html, osId, dispatchEntry = null) {
  const normalizedOsId = String(osId || "").trim();
  if (!normalizedOsId) {
    return {
      confirmationUrl: "",
      confirmationStatus: "sem_confirmacao",
      confirmationTitle: "",
      confirmationSent: false,
      confirmationRequestedAt: ""
    };
  }

  const listMatch = String(html || "").match(/<ul id="id_os">([\s\S]*?)<\/ul>/i);
  if (!listMatch) {
    return {
      confirmationUrl: "",
      confirmationStatus: "sem_confirmacao",
      confirmationTitle: "",
      confirmationSent: false,
      confirmationRequestedAt: ""
    };
  }

  const base = String(baseUrl || "").replace(/\/+$/, "");
  const items = [...listMatch[1].matchAll(/<li>[\s\S]*?<label[^>]*>([\s\S]*?)<\/label>[\s\S]*?<\/li>/gi)];
  for (const item of items) {
    const labelHtml = item[1] || "";
    const rawText = labelHtml
      .replace(/<input[\s\S]*?>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .trim();
    const parts = rawText.split("||").map((value) => String(value || "").trim());
    if (parts[0] !== normalizedOsId) {
      continue;
    }

    const confirmationHash = parts[6] || "";
    const confirmationUrl = confirmationHash && confirmationHash !== "None"
      ? `${base}/public/os/validacao/${encodeURIComponent(confirmationHash)}/`
      : "";
    return applyConfirmationDispatchState({
      confirmationUrl,
      confirmationStatus: parseConfirmationState(parts[5] || "", confirmationHash),
      confirmationTitle: String(parts[4] || "").trim(),
      confirmationSent: false,
      confirmationRequestedAt: ""
    }, dispatchEntry);
  }

  return {
    confirmationUrl: "",
    confirmationStatus: "sem_confirmacao",
    confirmationTitle: "",
    confirmationSent: false,
    confirmationRequestedAt: ""
  };
}

async function fetchConfirmationUrlForOs(config, osId) {
  const details = await fetchConfirmationDetailsForOs(config, osId);
  return details.confirmationUrl || "";
}

async function fetchConfirmationDetailsForOs(config, osId) {
  const normalizedOsId = String(osId || "").trim();
  if (!normalizedOsId) {
    return {
      confirmationUrl: "",
      confirmationStatus: "sem_confirmacao",
      confirmationTitle: "",
      confirmationRequestedAt: ""
    };
  }

  const cached = readConfirmationCache(normalizedOsId);
  if (cached) {
    return applyConfirmationDispatchState(cached, readConfirmationDispatchEntry(normalizedOsId));
  }

  const session = await createSgpWebSession(config);
  const details = await fetchConfirmationDetailsForOsWithSession(config, session, normalizedOsId);
  writeConfirmationCache(normalizedOsId, details);
  return details;
}

async function fetchConfirmationDetailsForOsWithSession(config, session, osId) {
  const normalizedOsId = String(osId || "").trim();
  if (!normalizedOsId) {
    return {
      confirmationUrl: "",
      confirmationStatus: "sem_confirmacao",
      confirmationTitle: "",
      confirmationRequestedAt: ""
    };
  }

  const osForm = await fetchSgpOsEditForm(config, session, normalizedOsId);
  const occurrencePath = extractOccurrenceEditPathFromOsHtml(osForm.html);
  if (!occurrencePath) {
    return {
      confirmationUrl: "",
      confirmationStatus: "sem_confirmacao",
      confirmationTitle: "",
      confirmationRequestedAt: ""
    };
  }

  const occurrenceUrl = `${session.baseUrl}${occurrencePath}`;
  const response = await fetch(occurrenceUrl, {
    headers: {
      Cookie: session.cookies
    },
    signal: AbortSignal.timeout(Number(config.dashboard?.timeout_sgp_ms || DEFAULT_TIMEOUT_MS))
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error("Nao foi possivel abrir a ocorrencia da OS no SGP para obter o link de confirmacao.");
  }

  const dispatchEntry = readConfirmationDispatchEntry(normalizedOsId);
  return extractConfirmationDetailsFromOccurrenceHtml(session.baseUrl, html, normalizedOsId, dispatchEntry);
}

async function updateScheduleViaSgpWebForm(config, osId, entry) {
  const session = await createSgpWebSession(config);
  const form = await fetchSgpOsEditForm(config, session, osId);
  const html = form.html;
  const forcedPriority = resolvePriorityForScheduledOs(config, entry);
  const shouldRequestConfirmation = canRequestCustomerConfirmation(entry);
  const hasDefinedScheduleTime = Boolean(entry?.data && entry?.horario && entry.horario !== "A definir");
  const existingScheduleValue = extractHtmlFieldValue(html, "data_agendamento");
  const smsClientValues = shouldRequestConfirmation ? pickSmsClientValues(html, entry.telefone) : [];
  const gatewayValue = shouldRequestConfirmation
    ? pickGatewayValue(
        html,
        String(config.agendamento?.gateway_sms_agendamento_label || "AGENDAMENTO").trim() || "AGENDAMENTO"
      )
    : "";
  const payload = {
    csrfmiddlewaretoken: extractHtmlFieldValue(html, "csrfmiddlewaretoken"),
    dpb_token: extractHtmlFieldValue(html, "dpb_token"),
    setor: extractHtmlFieldValue(html, "setor") || "1",
    tipoos: extractHtmlFieldValue(html, "tipoos") || "1",
    motivoos: extractHtmlFieldValue(html, "motivoos") || "58",
    prioridade: forcedPriority != null ? String(forcedPriority) : (extractHtmlFieldValue(html, "prioridade") || "2"),
    data_agendamento: hasDefinedScheduleTime
      ? toBrazilDateTime(entry.data, entry.horario)
      : existingScheduleValue,
    data_previsao_finalizacao: extractHtmlFieldValue(html, "data_previsao_finalizacao"),
    data_agendamento_oc: extractHtmlFieldValue(html, "data_agendamento_oc"),
    responsavel: hasMeaningfulTechnician(entry.tecnico)
      ? entry.tecnico
      : extractHtmlFieldValue(html, "responsavel"),
    conteudo: extractHtmlFieldValue(html, "conteudo"),
    servicoprestado: extractHtmlFieldValue(html, "servicoprestado"),
    // Observação interna (SGP)
    observacao: entry.justificativa || entry.observacao || extractHtmlFieldValue(html, "observacao"),
    anotacao: extractHtmlFieldValue(html, "anotacao"),
    anotacao_publica: extractHtmlFieldValue(html, "anotacao_publica"),
    status: extractHtmlFieldValue(html, "status") || "0",
    veiculo: extractHtmlFieldValue(html, "veiculo"),
    veiculo_km: extractHtmlFieldValue(html, "veiculo_km"),
    sistema_sync: extractHtmlFieldValue(html, "sistema_sync"),
    data_checkin: extractHtmlFieldValue(html, "data_checkin"),
    ...(shouldRequestConfirmation && (gatewayValue || extractHtmlFieldValue(html, "gateway_sms"))
      ? { gateway_sms: gatewayValue || extractHtmlFieldValue(html, "gateway_sms") }
      : {})
  };
  if (htmlFieldChecked(html, "sms_tecnico")) {
    payload.sms_tecnico = "on";
  }
  if (htmlFieldChecked(html, "encerra_ocorrencia")) {
    payload.encerra_ocorrencia = "on";
  }
  if (shouldRequestConfirmation && smsClientValues.length) {
    payload.sms_cliente = smsClientValues;
  }

  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        body.append(key, String(item ?? ""));
      }
      continue;
    }
    body.append(key, String(value ?? ""));
  }

  const response = await fetch(form.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: session.cookies,
      Referer: form.url
    },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(Number(config.dashboard?.timeout_sgp_ms || DEFAULT_TIMEOUT_MS))
  });

  const dispatchRequested = Boolean(smsClientValues.length && payload.gateway_sms);
  if (dispatchRequested && response.status >= 200 && response.status < 400) {
    const existingEntry = readConfirmationDispatchEntry(osId) || {};
    const dispatchKind = String(entry?.dispatchKind || existingEntry.dispatchKind || "inicial").trim() || "inicial";
    const nowIso = new Date().toISOString();
    const resendCount = dispatchKind === "reenvio_2"
      ? 2
      : dispatchKind === "reenvio_1"
        ? Math.max(1, Number(existingEntry.resendCount || 0) || 0)
        : Math.max(0, Number(existingEntry.resendCount || 0) || 0);
    writeConfirmationDispatchEntry(osId, {
      state: "requested",
      requestedAt: nowIso,
      firstRequestedAt: existingEntry.firstRequestedAt || nowIso,
      lastSentAt: nowIso,
      telefone: entry.telefone,
      gateway: payload.gateway_sms,
      dispatchKind,
      resendCount
    });
  }

  return {
    endpoint: form.url,
    payload,
    status: response.status,
    location: response.headers.get("location") || "",
    confirmationDispatchRequested: dispatchRequested
  };
}

async function queueConfirmationDispatch(config, item) {
  const osId = String(item?.osId || "").trim();
  if (!osId) {
    throw new Error("OS nao informada para envio da confirmacao.");
  }

  const existingEntry = readConfirmationDispatchEntry(osId) || {};
  const dispatchKind = String(item?.dispatchKind || "").trim() || "inicial";
  const nextResendCount = dispatchKind === "reenvio_2"
    ? 2
    : dispatchKind === "reenvio_1"
      ? Math.max(1, Number(existingEntry.resendCount || 0) || 0)
      : Math.max(0, Number(existingEntry.resendCount || 0) || 0);

  writeConfirmationDispatchEntry(osId, {
    state: "queued",
    queuedAt: new Date().toISOString(),
    requestedAt: existingEntry.requestedAt || "",
    firstRequestedAt: existingEntry.firstRequestedAt || "",
    lastSentAt: existingEntry.lastSentAt || "",
    errorMessage: "",
    telefone: String(item?.telefone || "").trim(),
    dispatchKind,
    resendCount: nextResendCount
  });

  const entry = {
    cliente: String(item?.cliente || "").trim(),
    contrato: String(item?.contrato || "").trim(),
    telefone: String(item?.telefone || "").trim(),
    protocolo: String(item?.protocolo || "").trim(),
    rota: String(item?.rota || "").trim(),
    tecnico: String(item?.tecnico || "").trim(),
    data: isoDateOnly(item?.data),
    horario: hhmm(item?.horario),
    endereco: String(item?.endereco || "").trim(),
    observacao: String(item?.observacao || "").trim()
  };

  void enqueueSgpDispatch(config, async () => {
    writeConfirmationDispatchEntry(osId, {
      state: "processing",
      processingAt: new Date().toISOString(),
      errorMessage: "",
      dispatchKind,
      resendCount: nextResendCount
    });

    try {
      const response = await updateScheduleViaSgpWebForm(config, osId, entry);
      const mutationError = getSgpMutationError(response);
      if (mutationError) {
        throw new Error(mutationError);
      }
      if (!response?.confirmationDispatchRequested) {
        writeConfirmationDispatchEntry(osId, {
          state: "manual",
          manualAt: new Date().toISOString(),
          errorMessage: "Confirmacao nao solicitada (gateway/sms_cliente ausente no SGP ou criterio nao atendido)."
        });
        return;
      }
      writeConfirmationCache(osId, await fetchConfirmationDetailsForOs(config, osId).catch(() => ({
        confirmationUrl: "",
        confirmationStatus: "aguardando_confirmacao",
        confirmationTitle: "",
        confirmationSent: true,
        confirmationRequestedAt: new Date().toISOString()
      })));
    } catch (error) {
      writeConfirmationDispatchEntry(osId, {
        state: "error",
        errorAt: new Date().toISOString(),
        errorMessage: String(error.message || "Falha ao solicitar envio ao SGP.").trim()
      });
    }
  });
}

function determineConfirmationResendAction(dispatchEntry, nowMs = Date.now()) {
  const state = String(dispatchEntry?.state || "").trim();
  if (!dispatchEntry || !["requested", ""].includes(state)) {
    return "";
  }

  const firstRequestedAt = Date.parse(String(dispatchEntry.firstRequestedAt || dispatchEntry.requestedAt || "").trim());
  if (!Number.isFinite(firstRequestedAt)) {
    return "";
  }

  const resendCount = Math.max(0, Number(dispatchEntry.resendCount || 0) || 0);
  const elapsedMs = nowMs - firstRequestedAt;
  if (resendCount < 1 && elapsedMs >= CONFIRMATION_RESEND_FIRST_MS) {
    return "reenvio_1";
  }
  if (resendCount < 2 && elapsedMs >= CONFIRMATION_RESEND_SECOND_MS) {
    return "reenvio_2";
  }
  if (resendCount >= 2 && elapsedMs >= CONFIRMATION_MANUAL_AFTER_MS) {
    return "manual";
  }
  return "";
}

async function processPendingConfirmationResends() {
  if (confirmationResendJobRunning) {
    return;
  }

  confirmationResendJobRunning = true;
  try {
    const config = loadConfig();
    const entries = Object.entries(readConfirmationDispatchLog());
    if (!entries.length) {
      return;
    }

    for (const [osId, dispatchEntry] of entries) {
      const currentEntry = dispatchEntry && typeof dispatchEntry === "object" ? dispatchEntry : {};
      if (["queued", "processing", "error", "manual", "answered"].includes(String(currentEntry.state || "").trim())) {
        continue;
      }

      const details = await fetchConfirmationDetailsForOs(config, osId).catch(() => null);
      const confirmationStatus = String(details?.confirmationStatus || "").trim();
      if (confirmationStatus === "confirmado" || confirmationStatus === "rejeitado") {
        writeConfirmationDispatchEntry(osId, {
          state: "answered",
          answeredAt: new Date().toISOString()
        });
        continue;
      }

      const action = determineConfirmationResendAction(currentEntry, Date.now());
      if (!action) {
        continue;
      }

      if (action === "manual") {
        writeConfirmationDispatchEntry(osId, {
          state: "manual",
          manualAt: new Date().toISOString()
        });
        continue;
      }

      const serviceOrder = await fetchServiceOrderById(config, osId).catch(() => null);
      if (serviceOrder && !isExternalServiceOrder(serviceOrder)) {
        continue;
      }
      const scheduleDate = isoDateOnly(
        serviceOrder?.data_agendamento ||
        serviceOrder?.data_agendada ||
        serviceOrder?.data ||
        ""
      );
      const scheduleTime = hhmm(
        serviceOrder?.hora_agendamento ||
        serviceOrder?.hora_agendada ||
        serviceOrder?.hora ||
        ""
      );
      const technician = String(serviceOrder?.responsavel || "").trim();

      if (!canRequestCustomerConfirmation({ data: scheduleDate, horario: scheduleTime, tecnico: technician })) {
        continue;
      }

      await queueConfirmationDispatch(config, {
        osId,
        cliente: String(serviceOrder?.cliente || "").trim(),
        contrato: String(serviceOrder?.contrato || "").trim(),
        telefone: String(currentEntry.telefone || "").trim(),
        protocolo: String(serviceOrder?.ocorrencia || serviceOrder?.protocolo || "").trim(),
        rota: String(serviceOrder?.pop || "").trim(),
        tecnico: technician,
        data: scheduleDate,
        horario: scheduleTime,
        endereco: "",
        observacao: "",
        dispatchKind: action
      });
    }
  } finally {
    confirmationResendJobRunning = false;
  }
}

function ensureConfirmationResendJobStarted() {
  if (confirmationResendJobTimer) {
    return;
  }
  confirmationResendJobTimer = setInterval(() => {
    void processPendingConfirmationResends();
  }, CONFIRMATION_RESEND_CHECK_INTERVAL_MS);
  void processPendingConfirmationResends();
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

function getSgpMutationError(data) {
  if (typeof data === "number") {
    return data >= 400 ? `SGP retornou codigo ${data}.` : "";
  }

  if (!data || typeof data !== "object") {
    return "";
  }

  if (data.ok === false) {
    return data.message || data.msg || data.detail || "SGP retornou falha na operacao.";
  }

  if (typeof data.status === "number" && data.status >= 400) {
    return data.message || data.msg || data.detail || `SGP retornou status ${data.status}.`;
  }

  if (typeof data.code === "number" && data.code >= 400) {
    return data.message || data.msg || data.detail || `SGP retornou codigo ${data.code}.`;
  }

  if (typeof data.response === "number" && data.response >= 400) {
    return data.message || data.msg || data.detail || `SGP retornou codigo ${data.response}.`;
  }

  return "";
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

async function fetchServiceOrderById(config, osId) {
  const endpoint = config.agendamento?.endpoint_lista || "/api/ura/ordemservico/list/";
  const statuses = Array.isArray(config.agendamento?.statuses_consulta) && config.agendamento.statuses_consulta.length
    ? config.agendamento.statuses_consulta
    : DEFAULT_STATUSES;
  const normalizedOsId = String(osId || "").trim();

  for (const status of statuses) {
    let offset = 0;
    const limit = 500;
    while (true) {
      const payload = { status, offset, limit };
      const response = await postToSgp(config, endpoint, payload);
      const chunk = extractListFromResponse(response);
      if (!Array.isArray(chunk)) {
        throw new Error("Formato inesperado na busca da OS por ID.");
      }

      const found = chunk.find((item) => String(item.id || item.os_id || "").trim() === normalizedOsId);
      if (found) {
        return found;
      }

      if (chunk.length < limit) {
        break;
      }
      offset += limit;
    }
  }

  return null;
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

function updateManualSchedule(entryId, nextEntry) {
  const rows = readManualSchedules();
  let updated = null;
  const nextRows = rows.map((item) => {
    if (String(item.id || "") !== String(entryId || "")) {
      return item;
    }
    updated = {
      ...item,
      ...nextEntry,
      id: item.id || entryId
    };
    return updated;
  });

  if (!updated) {
    return null;
  }

  writeJson(MANUAL_SCHEDULES_PATH, nextRows);
  return updated;
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

function removeManualSchedulesByMatcher(matcher) {
  const rows = readManualSchedules();
  const nextRows = rows.filter((item) => !matcher(item));
  if (nextRows.length === rows.length) {
    return 0;
  }
  writeJson(MANUAL_SCHEDULES_PATH, nextRows);
  return rows.length - nextRows.length;
}

function filterDuplicatedManualSchedules(sgpSchedules, manualSchedules) {
  const sgpRefs = new Set();
  for (const item of sgpSchedules) {
    if (item.origem !== "sgp") {
      continue;
    }
    const osId = String(item.osId || "").trim();
    const protocolo = String(item.protocolo || "").trim();
    if (osId) {
      sgpRefs.add(`os:${osId}`);
      sgpRefs.add(`protocolo:${osId}`);
    }
    if (protocolo) {
      sgpRefs.add(`protocolo:${protocolo}`);
      sgpRefs.add(`os:${protocolo}`);
    }
  }

  return manualSchedules.filter((item) => {
    const osId = String(item.osId || "").trim();
    const protocolo = String(item.protocolo || "").trim();
    return !(
      (osId && sgpRefs.has(`os:${osId}`)) ||
      (osId && sgpRefs.has(`protocolo:${osId}`)) ||
      (protocolo && sgpRefs.has(`protocolo:${protocolo}`)) ||
      (protocolo && sgpRefs.has(`os:${protocolo}`))
    );
  });
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

function normalizeScheduleTimeInput(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "manha" || text === "manhã") {
    return "08:00";
  }
  if (text === "tarde") {
    return "13:00";
  }
  return hhmm(value);
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
  return toLocalIsoDate(date);
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
  const hasScheduleDate = Boolean(isoDateOnly(
    raw.data_agendamento ||
    raw.data_agendada ||
    raw.data_marcada ||
    raw.data ||
    ""
  ));
  const hasScheduleTime = normalizeSlot(
    raw.hora_agendamento ||
    raw.hora_marcada ||
    raw.hora ||
    ""
  ) !== "A definir";
  const hasAssignedTechnician = hasMeaningfulTechnician(normalizeTechnician(raw));

  // Regra do dashboard:
  // - Itinerario: possui data + tecnico responsavel (sem horario definido)
  // - Agendamentos: possui data + tecnico responsavel + horario definido
  if (hasScheduleDate && hasAssignedTechnician) {
    return hasScheduleTime ? "agendado" : "itinerario";
  }
  return "pre_agendado";
}

function normalizeOsType(raw) {
  return String(
    raw?.tipo ||
      raw?.tipo_os ||
      raw?.tipoOS ||
      raw?.tipo_descricao ||
      raw?.tipo_nome ||
      ""
  )
    .trim()
    .toUpperCase();
}

function isExternalServiceOrder(raw) {
  // Regra do dashboard: considerar apenas OS do tipo EXTERNA (campo `tipo` retornado na lista do SGP).
  return normalizeOsType(raw) === "EXTERNA";
}

function isOpenServiceOrder(raw) {
  const statusId = String(raw?.status_id ?? "").trim();
  const statusText = String(
    raw?.status_descricao ||
      raw?.status_nome ||
    raw?.status_label ||
    raw?.status ||
    raw?.situacao ||
    ""
  ).trim().toLowerCase();

  // Dashboard: considerar OS ativas (abertas ou pendentes).
  // Observacao: o SGP costuma expor status_id 0=aberta e 1=pendente (podendo variar por instancia).
  if (statusId === "0" || statusId === "1") {
    return true;
  }
  if (statusText === "aberta" || statusText === "pendente") {
    return true;
  }
  return statusText.includes("aberta") || statusText.includes("pendent");
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

function hasMeaningfulTechnician(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return !new Set(["nao definido", "não definido", "a definir", "-"]).has(normalized);
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
  const motivo = normalizeMotivo(raw);
  const sgpStatus = source === "sgp" ? normalizeSgpStatus(raw) : "";

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
    confirmationUrl: String(raw.confirmationUrl || "").trim(),
    confirmationStatus: String(raw.confirmationStatus || "").trim() || "sem_confirmacao",
    confirmationTitle: String(raw.confirmationTitle || "").trim(),
    confirmationSent: Boolean(raw.confirmationSent),
    confirmationRequestedAt: String(raw.confirmationRequestedAt || "").trim(),
    endereco: raw.endereco || raw.logradouro || "",
    motivo,
    sgpStatus,
    observacao: raw.observacao || raw.descricao || raw.motivo || "",
    origem: source,
    raw
  };
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
}

function normalizeMotivo(raw) {
  const candidates = [
    raw?.motivo,
    raw?.motivo_os,
    raw?.motivoos,
    raw?.motivo_nome,
    raw?.motivo_os_nome,
    raw?.motivoos_nome
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) {
      return value;
    }
  }

  return "";
}

function normalizeSgpStatus(raw) {
  const candidates = [
    raw?.status_descricao,
    raw?.status_nome,
    raw?.status_label,
    raw?.status,
    raw?.situacao
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) {
      return value;
    }
  }

  return "";
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
    confirmationUrl: entry.confirmationUrl || "",
    confirmationStatus: entry.confirmationStatus || "sem_confirmacao",
    confirmationTitle: entry.confirmationTitle || "",
    confirmationSent: Boolean(entry.confirmationSent),
    confirmationRequestedAt: entry.confirmationRequestedAt || "",
    endereco: entry.endereco || "",
    motivo: String(entry.motivo || "").trim(),
    sgpStatus: "",
    observacao: entry.justificativa || entry.observacao || "",
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
  return toLocalIsoDate(date);
}

function endOfWeek(dateText) {
  return plusDays(startOfWeek(dateText), 6);
}

function buildWindowDays(startDateText) {
  const base = isoDateOnly(startDateText);
  if (!base) {
    return buildWeekDays(toLocalIsoDate(new Date()));
  }
  return Array.from({ length: 7 }, (_, index) => plusDays(base, index));
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

function buildGrid(schedules, windowStartDate, slots) {
  const days = buildWindowDays(windowStartDate);
  const dynamicSlots = new Set(slots);
  for (const item of schedules) {
    if (days.includes(item.data)) {
      dynamicSlots.add(item.status === "itinerario" ? "Itinerario" : (item.horario || "A definir"));
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
    const slot = item.status === "itinerario" ? "Itinerario" : (item.horario || "A definir");
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
  if (a === "Itinerario") {
    return -1;
  }
  if (b === "Itinerario") {
    return 1;
  }
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
    itinerario: 0,
    pre_agendado: 0,
    sem_solicitacao: 0,
    na_fila_envio: 0,
    processando_envio: 0,
    aguardando_confirmacao: 0,
    reenvio_1: 0,
    reenvio_2: 0,
    envio_manual: 0,
    rejeitado: 0,
    erro_envio: 0
  };

  for (const item of schedules) {
    if (summary[item.status] !== undefined) {
      summary[item.status] += 1;
    }
    const confirmationStatus = String(item.confirmationStatus || "").trim() || "sem_confirmacao";
    if (confirmationStatus === "sem_confirmacao") {
      summary.sem_solicitacao += 1;
      continue;
    }
    if (summary[confirmationStatus] !== undefined) {
      summary[confirmationStatus] += 1;
    }
  }
  return summary;
}

function filterSchedules(schedules, { search, status, pops = [] }) {
  return schedules.filter((item) => {
    const confirmationStatus = String(item.confirmationStatus || "").trim();
    const route = String(item.rota || "").trim();

    if (status && status !== "todos") {
      if (status === "confirmacao_solicitada") {
        if (!["na_fila_envio", "processando_envio", "aguardando_confirmacao", "reenvio_1", "reenvio_2"].includes(confirmationStatus)) {
          return false;
        }
      } else if (status === "confirmacao_confirmada") {
        if (confirmationStatus !== "confirmado") {
          return false;
        }
      } else if (item.status !== status) {
        return false;
      }
    }
    if (Array.isArray(pops) && pops.length && !pops.includes(route)) {
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
    confirmationUrl: item.confirmationUrl || "",
    confirmationStatus: item.confirmationStatus || "sem_confirmacao",
    confirmationTitle: item.confirmationTitle || "",
    confirmationSent: Boolean(item.confirmationSent),
    confirmationRequestedAt: item.confirmationRequestedAt || "",
    endereco: item.endereco,
    motivo: item.motivo || "",
    sgpStatus: item.sgpStatus || "",
    observacao: item.observacao,
    origem: item.origem
  };
}

async function enrichSchedulesWithConfirmation(config, schedules) {
  const sgpSchedules = schedules.filter((item) => item.origem === "sgp" && String(item.osId || "").trim());
  if (!sgpSchedules.length) {
    return schedules;
  }

  const pending = [];
  for (const item of sgpSchedules) {
    const cached = readConfirmationCache(item.osId);
    if (cached) {
      item.confirmationUrl = cached.confirmationUrl || "";
      item.confirmationStatus = cached.confirmationStatus || "sem_confirmacao";
      item.confirmationTitle = cached.confirmationTitle || "";
      item.confirmationSent = Boolean(cached.confirmationSent);
      item.confirmationRequestedAt = cached.confirmationRequestedAt || "";
      continue;
    }
    pending.push(item);
  }

  if (!pending.length) {
    return schedules;
  }

  const session = await createSgpWebSession(config);
  await runWithConcurrencyLimit(pending, 3, async (item) => {
    try {
      const details = await fetchConfirmationDetailsForOsWithSession(config, session, item.osId);
      item.confirmationUrl = details.confirmationUrl || "";
      item.confirmationStatus = details.confirmationStatus || "sem_confirmacao";
      item.confirmationTitle = details.confirmationTitle || "";
      item.confirmationSent = Boolean(details.confirmationSent);
      item.confirmationRequestedAt = details.confirmationRequestedAt || "";
      writeConfirmationCache(item.osId, details);
    } catch (error) {
      const cached = readConfirmationCache(item.osId);
      item.confirmationUrl = cached?.confirmationUrl || "";
      item.confirmationStatus = cached?.confirmationStatus || "sem_confirmacao";
      item.confirmationTitle = cached?.confirmationTitle || "";
      item.confirmationSent = Boolean(cached?.confirmationSent);
      item.confirmationRequestedAt = cached?.confirmationRequestedAt || "";
    }
  });

  return schedules;
}

async function getDashboardData(query, authUser = null) {
  const config = loadConfig();
  const today = toLocalIsoDate(new Date());
  const selectedDate = isoDateOnly(query.get("data")) || today;
  const startDate = isoDateOnly(query.get("inicio")) || plusDays(selectedDate, -Number(config.dashboard.janela_dias_passado || 7));
  const endDate = isoDateOnly(query.get("fim")) || plusDays(selectedDate, Number(config.dashboard.janela_dias_futuro || 14));
  const search = String(query.get("busca") || "").trim();
  const status = String(query.get("status") || "todos").trim().toLowerCase();
  const pops = String(query.get("pops") || "")
    .split(",")
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const slots = Array.isArray(config.dashboard.horarios_padrao) && config.dashboard.horarios_padrao.length
    ? config.dashboard.horarios_padrao
    : DEFAULT_SLOTS;

  let sourceMode = "sgp";
  let notices = [];
  let schedules = [];

  try {
    const sgpRows = await listServiceOrders(config, { startDate, endDate });
    schedules = sgpRows
      .filter((item) => isExternalServiceOrder(item))
      .filter((item) => isOpenServiceOrder(item))
      .map((item) => normalizeSchedule(config, item, "sgp"))
      .filter((item) => item.data);
    schedules = await enrichSchedulesWithConfirmation(config, schedules);
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

  const manualSchedules = filterDuplicatedManualSchedules(
    schedules,
    readManualSchedules().map(normalizeManualSchedule)
  );
  schedules = schedules.concat(manualSchedules);

  const slotTimesForBlocks = Array.from(
    new Set(
      schedules
        .map((item) => String(item.horario || "").trim())
        .concat(slots)
        .filter((value) => value && value !== "A definir")
        .map((value) => normalizeSlot(value))
        .filter((value) => value && value !== "A definir")
    )
  ).sort(compareSlots);

  const blockedExpanded = [];
  for (const block of readBlockedSlots()) {
    const blockDate = isoDateOnly(block.data);
    if (!blockDate) continue;
    const start = hhmm(block.horario_inicio || block.horario);
    const end = hhmm(block.horario_fim || block.horario);
    for (const time of slotTimesForBlocks) {
      if (timeInRangeInclusive(time, start, end)) {
        blockedExpanded.push(
          normalizeBlockedSlot({
            ...block,
            __slot_time: time
          })
        );
      }
    }
  }
  schedules = schedules.concat(blockedExpanded);

  schedules = schedules.filter((item) => item.hasScheduledDate && item.data >= startDate && item.data <= endDate);
  schedules.sort((a, b) => `${a.data} ${a.horario}`.localeCompare(`${b.data} ${b.horario}`));

  const filtered = filterSchedules(schedules, { search, status, pops });
  const serializedSchedules = schedules.map(serializeSchedule);
  const filteredSerializedSchedules = filtered.map(serializeSchedule);
  const summary = summarizeSchedules(serializedSchedules);
  const grid = buildGrid(serializedSchedules, startDate, slots);
  const availableRoutes = Array.from(new Set(serializedSchedules.map((item) => String(item.rota || "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    dashboardVersion: DASHBOARD_VERSION,
    autoRefreshSeconds: Number(config.dashboard.atualizacao_segundos || 300),
    selectedDate,
    period: {
      startDate,
      endDate,
      weekStart: startDate,
      weekEnd: endDate
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
      status,
      pops
    },
    availableRoutes,
    grid,
    schedules: filteredSerializedSchedules,
    isAdmin: Boolean(authUser?.isAdmin)
  };
}

function toScheduledDateTime(date, time) {
  if (!date || !time || time === "A definir") {
    return "";
  }
  return `${date} ${time.slice(0, 5)}:00`;
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

function resolvePriorityForScheduledOs(config, entry) {
  const desired = Number(config.agendamento?.prioridade_os_ao_agendar);
  if (!Number.isFinite(desired) || desired <= 0) {
    return null;
  }
  if (!entry?.data || !entry?.horario || entry.horario === "A definir") {
    return null;
  }
  if (!hasMeaningfulTechnician(entry.tecnico)) {
    return null;
  }
  return desired;
}

function canRequestCustomerConfirmation(entry) {
  if (!entry?.data) {
    return false;
  }
  return hasMeaningfulTechnician(entry.tecnico);
}

function buildCreateCallPayload(config, entry) {
  const content = `Agendamento solicitado para ${entry.data} ${entry.horario}.`;
  const forcedPriority = resolvePriorityForScheduledOs(config, entry);
  const payload = {
    contrato: entry.contrato,
    conteudo: content,
    // Observação interna (SGP)
    observacao: entry.justificativa || entry.observacao || "",
    ocorrenciatipo: Number(config.agendamento?.ocorrencia_tipo_padrao || 5),
    motivoos: Number(config.agendamento?.motivo_os_padrao || 1),
    setor: Number(config.agendamento?.setor_padrao || 1),
    os_prioridade: forcedPriority ?? Number(config.agendamento?.prioridade_os_padrao || 2),
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
  if (hasAppTokenAuth(config)) {
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

function normalizePopKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeConflictTime(value) {
  return normalizeScheduleTimeInput(value);
}

function compareTimes(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

function timeInRangeInclusive(time, start, end) {
  const t = hhmm(time);
  const s = hhmm(start);
  const e = hhmm(end);
  if (!t || !s) {
    return false;
  }
  if (!e || e === s) {
    return t === s;
  }
  return compareTimes(t, s) >= 0 && compareTimes(t, e) <= 0;
}

function intervalsOverlapInclusive(aStart, aEnd, bStart, bEnd) {
  const as = hhmm(aStart);
  const ae = hhmm(aEnd) || as;
  const bs = hhmm(bStart);
  const be = hhmm(bEnd) || bs;
  if (!as || !bs) {
    return false;
  }
  return compareTimes(as, be) <= 0 && compareTimes(bs, ae) <= 0;
}

function summarizeConflictItems(items) {
  return (items || [])
    .slice(0, 3)
    .map((item) => {
      const ref = String(item.osId || item.protocolo || "").trim();
      const label = ref ? `OS ${ref}` : "OS";
      const client = String(item.cliente || "").trim();
      const status = String(item.status || "").trim();
      return `${label}${client ? ` (${client})` : ""}${status ? ` [${status}]` : ""}`;
    })
    .join(", ");
}

async function createBlockedSlot(payload) {
  const config = loadConfig();
  const entry = {
    rota: String(payload.rota || payload.pop || "").trim(),
    data: isoDateOnly(payload.data),
    horario_inicio: hhmm(payload.horario_inicio || payload.horarioInicial || payload.horario || ""),
    horario_fim: hhmm(payload.horario_fim || payload.horarioFinal || payload.horario || ""),
    motivo: String(payload.motivo || payload.observacao || "").trim()
  };

  if (!entry.rota || !entry.data || !entry.horario_inicio || !entry.horario_fim) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        message: "Informe POP, data, horario inicial e horario final para bloquear."
      }
    };
  }

  if (compareTimes(entry.horario_fim, entry.horario_inicio) < 0) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        message: "Horario final deve ser maior ou igual ao horario inicial."
      }
    };
  }

  const normalizedRotaKey = normalizePopKey(entry.rota);
  const existingBlock = readBlockedSlots().find((item) => {
    if (normalizePopKey(item.rota) !== normalizedRotaKey) return false;
    if (isoDateOnly(item.data) !== entry.data) return false;
    return intervalsOverlapInclusive(
      item.horario_inicio || item.horario,
      item.horario_fim || item.horario,
      entry.horario_inicio,
      entry.horario_fim
    );
  });
  if (existingBlock) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        code: "SLOT_ALREADY_BLOCKED",
        message: `Ja existe bloqueio em ${entry.rota} para ${entry.data} nesse intervalo de horario.`,
        block: normalizeBlockedSlot(existingBlock)
      }
    };
  }

  // Se houver qualquer OS no intervalo, nao permite criar bloqueio.
  const candidateTimes = [entry.horario_inicio, entry.horario_fim].filter(Boolean);
  for (const timeKey of candidateTimes) {
    const conflictCheck = await findPopSlotConflicts(config, { rota: entry.rota, data: entry.data, horario: timeKey }, { includeBlocks: false });
    if (conflictCheck.conflicts.length) {
      const summary = summarizeConflictItems(conflictCheck.conflicts);
      return {
        statusCode: 409,
        body: {
          ok: false,
          code: "SLOT_OCCUPIED",
          message: `Ja existe agendamento em ${entry.rota} para ${entry.data} dentro do intervalo informado.`,
          conflicts: conflictCheck.conflicts.slice(0, 5).map(serializeSchedule),
          detail: summary ? `Conflitos: ${summary}` : "",
          checkedSgp: Boolean(conflictCheck.checkedSgp)
        }
      };
    }
  }

  const saved = saveBlockedSlot({
    id: `block-${Date.now()}`,
    ...entry,
    created_at: new Date().toISOString()
  });

  return {
    statusCode: 201,
    body: {
      ok: true,
      message: `Horario bloqueado em ${entry.rota} para ${entry.data} (${entry.horario_inicio}-${entry.horario_fim}).`,
      block: normalizeBlockedSlot(saved)
    }
  };
}

async function removeBlockedSlot(payload) {
  const id = String(payload.id || "").trim();
  if (!id) {
    return {
      statusCode: 400,
      body: { ok: false, message: "Bloqueio nao informado." }
    };
  }
  const removed = deleteBlockedSlot(id);
  return removed
    ? { statusCode: 200, body: { ok: true, message: "Bloqueio removido com sucesso." } }
    : { statusCode: 404, body: { ok: false, message: "Bloqueio nao encontrado." } };
}

async function findPopSlotConflicts(
  config,
  { rota, data, horario },
  { ignoreId = "", ignoreOsId = "", ignoreProtocolo = "", includeBlocks = true, includeSchedules = true } = {}
) {
  const rotaKey = normalizePopKey(rota);
  const dateKey = isoDateOnly(data);
  const timeKey = normalizeConflictTime(horario);

  if (!rotaKey || !dateKey || !timeKey) {
    return { conflicts: [], checkedSgp: false };
  }

  const ignore = {
    id: String(ignoreId || "").trim(),
    osId: String(ignoreOsId || "").trim(),
    protocolo: String(ignoreProtocolo || "").trim()
  };

  const schedules = [];
  let checkedSgp = false;

  if (includeSchedules) {
    try {
      const sgpRows = await listServiceOrders(config, { startDate: dateKey, endDate: dateKey });
      checkedSgp = true;
      schedules.push(
        ...sgpRows
          .filter((item) => isExternalServiceOrder(item))
          .filter((item) => isOpenServiceOrder(item))
          .map((item) => normalizeSchedule(config, item, "sgp"))
          .filter((item) => item.data && item.horario && item.horario !== "A definir")
      );
    } catch (error) {
      checkedSgp = false;
    }

    schedules.push(...readManualSchedules().map(normalizeManualSchedule).filter((item) => item.data));
  }
  const blocked = includeBlocks ? readBlockedSlots() : [];

  const conflicts = schedules.filter((item) => {
    if (ignore.id && String(item.id || "").trim() === ignore.id) {
      return false;
    }
    if (ignore.osId && String(item.osId || "").trim() === ignore.osId) {
      return false;
    }
    if (ignore.protocolo && String(item.protocolo || "").trim() === ignore.protocolo) {
      return false;
    }

    const itemRotaKey = normalizePopKey(item.rota);
    const itemDateKey = isoDateOnly(item.data);
    const itemTimeKey = normalizeConflictTime(item.horario);
    return itemRotaKey === rotaKey && itemDateKey === dateKey && itemTimeKey === timeKey;
  });

  if (includeBlocks && blocked.length) {
    const blockMatches = blocked.filter((entry) => {
      if (normalizePopKey(entry.rota) !== rotaKey) return false;
      if (isoDateOnly(entry.data) !== dateKey) return false;
      return timeInRangeInclusive(timeKey, entry.horario_inicio || entry.horario, entry.horario_fim || entry.horario);
    });
    for (const match of blockMatches) {
      conflicts.push(normalizeBlockedSlot(match));
    }
  }

  return { conflicts, checkedSgp };
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
    horario: normalizeScheduleTimeInput(payload.horario),
    endereco: String(payload.endereco || "").trim(),
    justificativa: String(payload.justificativa || payload.observacao || "").trim()
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

  const conflictCheck = await findPopSlotConflicts(config, entry, { includeSchedules: false, includeBlocks: true });
  if (conflictCheck.conflicts.length) {
    const rotaLabel = String(entry.rota || "").trim() || "POP";
    const summary = summarizeConflictItems(conflictCheck.conflicts);
    return {
      statusCode: 409,
      body: {
        ok: false,
        code: "SLOT_OCCUPIED",
        message: `Horario ocupado em ${rotaLabel} para ${entry.data} ${entry.horario}.`,
        conflicts: conflictCheck.conflicts.slice(0, 5).map(serializeSchedule),
        detail: summary ? `Conflitos: ${summary}` : "",
        checkedSgp: Boolean(conflictCheck.checkedSgp)
      }
    };
  }

  const endpoint = String(config.agendamento?.endpoint_agendar || "").trim();
  if (endpoint) {
    try {
      const response = await postJsonToSgp(config, endpoint, buildCreateCallPayload(config, entry));
      const rows = extractListFromResponse(response);
      const created = Array.isArray(rows) && rows.length ? rows[0] : response;
      const createdOsId = String(created?.os_id || created?.id || created?.osId || "").trim();
      let confirmationDetails = {
        confirmationUrl: "",
        confirmationStatus: "sem_confirmacao",
        confirmationTitle: "",
        confirmationRequestedAt: "",
        confirmationSent: false
      };
      let autoQueued = false;

      if (createdOsId) {
        try {
          confirmationDetails = await fetchConfirmationDetailsForOs(config, createdOsId);
        } catch (error) {
          confirmationDetails = {
            confirmationUrl: "",
            confirmationStatus: "sem_confirmacao",
            confirmationTitle: "",
            confirmationRequestedAt: "",
            confirmationSent: false
          };
        }

        if (
          canRequestCustomerConfirmation(entry) &&
          String(config.basic_auth?.username || "").trim() &&
          String(config.basic_auth?.password || "").trim()
        ) {
          try {
            await queueConfirmationDispatch(config, {
              id: createdOsId,
              osId: createdOsId,
              origem: "sgp",
              ...entry
            });
            autoQueued = true;
            confirmationDetails.confirmationUrl = "";
            confirmationDetails.confirmationStatus = "na_fila_envio";
            confirmationDetails.confirmationTitle = "";
            confirmationDetails.confirmationRequestedAt = "";
            confirmationDetails.confirmationSent = false;
          } catch (error) {
            autoQueued = false;
          }
        }
      }

      return {
        statusCode: 201,
        body: {
          ok: true,
          mode: "sgp",
          message: "Ocorrencia e agendamento enviados ao SGP com sucesso.",
          response: created,
          autoConfirmationQueued: autoQueued,
          confirmationUrl: confirmationDetails.confirmationUrl,
          confirmationStatus: confirmationDetails.confirmationStatus,
          confirmationTitle: confirmationDetails.confirmationTitle,
          confirmationRequestedAt: confirmationDetails.confirmationRequestedAt,
          confirmationSent: Boolean(confirmationDetails.confirmationSent)
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

async function updateSchedule(payload) {
  const config = loadConfig();
  const id = String(payload.id || "").trim();
  const origem = String(payload.origem || "").trim();
  const osId = String(payload.osId || "").trim();
  const entry = {
    cliente: String(payload.cliente || "").trim(),
    contrato: String(payload.contrato || "").trim(),
    telefone: String(payload.telefone || "").trim(),
    protocolo: String(payload.protocolo || "").trim(),
    rota: String(payload.rota || "").trim(),
    tecnico: String(payload.tecnico || "").trim(),
    data: isoDateOnly(payload.data),
    horario: normalizeScheduleTimeInput(payload.horario),
    endereco: String(payload.endereco || "").trim(),
    justificativa: String(payload.justificativa || payload.observacao || "").trim()
  };

  if (!id) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        message: "Agendamento nao informado."
      }
    };
  }

  if (!entry.cliente || !entry.contrato || !entry.data || !entry.horario) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        message: "Informe pelo menos cliente, contrato, data e horario."
      }
    };
  }

  const conflictCheck = await findPopSlotConflicts(config, entry, {
    ignoreId: id,
    ignoreOsId: osId,
    ignoreProtocolo: String(payload.protocolo || "").trim(),
    includeSchedules: false,
    includeBlocks: true
  });
  if (conflictCheck.conflicts.length) {
    const rotaLabel = String(entry.rota || "").trim() || "POP";
    const summary = summarizeConflictItems(conflictCheck.conflicts);
    return {
      statusCode: 409,
      body: {
        ok: false,
        code: "SLOT_OCCUPIED",
        message: `Horario ocupado em ${rotaLabel} para ${entry.data} ${entry.horario}.`,
        conflicts: conflictCheck.conflicts.slice(0, 5).map(serializeSchedule),
        detail: summary ? `Conflitos: ${summary}` : "",
        checkedSgp: Boolean(conflictCheck.checkedSgp)
      }
    };
  }

  if (origem === "pre_agendamento_local") {
    const updated = updateManualSchedule(id, entry);
    return updated
      ? {
          statusCode: 200,
          body: {
            ok: true,
            mode: "local",
            message: "Pre-agendamento local atualizado com sucesso.",
            schedule: updated
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
          message: "OS do agendamento nao identificada para edicao no SGP."
        }
      };
    }

    const serviceOrder = await fetchServiceOrderById(config, osId).catch(() => null);
    if (serviceOrder && !isExternalServiceOrder(serviceOrder)) {
      return {
        statusCode: 403,
        body: {
          ok: false,
          mode: "sgp",
          message: `A OS ${osId} nao e do tipo EXTERNA e nao pode ser agendada pelo dashboard.`,
          tipo: normalizeOsType(serviceOrder)
        }
      };
    }

    if (!String(config.basic_auth?.username || "").trim() || !String(config.basic_auth?.password || "").trim()) {
      return {
        statusCode: 501,
        body: {
          ok: false,
          message: "A configuracao atual do SGP nao permite alterar data/horario de OS aberta pela interface web. Preencha basic_auth.username e basic_auth.password com valores validos."
        }
      };
    }

		    const endpoint = `/admin/atendimento/ocorrencia/os/${encodeURIComponent(osId)}/edit/`;
		    const forcedPriority = resolvePriorityForScheduledOs(config, entry);
		    const sgpPayload = {
		      data_agendamento: toBrazilDateTime(entry.data, entry.horario),
		      ...(forcedPriority != null ? { prioridade: forcedPriority } : {}),
		      // Observação interna (SGP)
		      observacao: entry.justificativa || entry.observacao || "",
		      responsavel: hasMeaningfulTechnician(entry.tecnico) ? entry.tecnico : ""
		    };

    logSgpScheduleUpdate("request", { osId, endpoint, payload: sgpPayload });

    let response;
    try {
      response = await enqueueSgpDispatch(config, () => updateScheduleViaSgpWebForm(config, osId, entry));
    } catch (error) {
      logSgpScheduleUpdate("error", {
        osId,
        endpoint,
        payload: sgpPayload,
        error: error.message
      });
      throw error;
    }

    logSgpScheduleUpdate("response", {
      osId,
      endpoint: response.endpoint || endpoint,
      payload: response.payload || sgpPayload,
      response
    });

    const mutationError = getSgpMutationError(response);
    if (mutationError) {
      return {
        statusCode: 502,
        body: {
          ok: false,
          mode: "sgp",
          message: `Falha ao atualizar agendamento no SGP: ${mutationError}`,
          response
        }
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    const confirmedRow = await fetchServiceOrderById(config, osId);
    const confirmedDate = isoDateOnly(confirmedRow?.data_agendamento || confirmedRow?.data_agendada || confirmedRow?.data || "");
    const confirmedTime = hhmm(confirmedRow?.hora_agendamento || confirmedRow?.hora_agendada || confirmedRow?.hora || "");
    const expectedDate = isoDateOnly(entry.data);
    const expectedTime = hhmm(entry.horario);

    logSgpScheduleUpdate("verification", {
      osId,
      expected: {
        data_agendamento: expectedDate,
        hora_agendamento: expectedTime
      },
      confirmed: {
        data_agendamento: confirmedDate,
        hora_agendamento: confirmedTime
      }
    });

    if (confirmedDate !== expectedDate || confirmedTime !== expectedTime) {
      return {
        statusCode: 502,
        body: {
          ok: false,
          mode: "sgp",
          message: `O SGP respondeu sucesso, mas a OS ${osId} continuou com agendamento ${confirmedDate || "-"} ${confirmedTime || "-"}.`,
          response,
          verification: {
            expected: {
              data_agendamento: expectedDate,
              hora_agendamento: expectedTime
            },
            confirmed: {
              data_agendamento: confirmedDate,
              hora_agendamento: confirmedTime
            }
          }
        }
      };
    }

    removeManualSchedulesByMatcher((item) => {
      const manualId = String(item.id || "").trim();
      const manualProtocol = String(item.protocolo || "").trim();
      const manualContract = String(item.contrato || "").trim();
      return (
        (manualId && manualId === id) ||
        (manualProtocol && (manualProtocol === osId || manualProtocol === entry.protocolo)) ||
        (manualContract && manualContract === entry.contrato && isoDateOnly(item.data) === entry.data)
      );
    });

    return {
      statusCode: 200,
      body: {
        ok: true,
        mode: "sgp",
        message: `OS ${osId} atualizada no SGP com sucesso.`,
        response,
        ...(await fetchConfirmationDetailsForOs(config, osId).catch(() => ({
          confirmationUrl: "",
          confirmationStatus: "sem_confirmacao",
          confirmationTitle: "",
          confirmationRequestedAt: "",
          confirmationSent: false
        })))
      }
    };
  }

  return {
    statusCode: 400,
    body: {
      ok: false,
      message: "Origem do agendamento nao suportada para edicao."
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

async function requestConfirmationDispatch(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        message: "Nenhuma OS foi selecionada para envio da confirmacao."
      }
    };
  }

  const config = loadConfig();
  if (!String(config.basic_auth?.username || "").trim() || !String(config.basic_auth?.password || "").trim()) {
    return {
      statusCode: 501,
      body: {
        ok: false,
        message: "A configuracao atual do SGP nao permite solicitar envio pela interface web."
      }
    };
  }

  const validItems = [];
  const skipped = [];
  for (const raw of items) {
    const item = {
      id: String(raw?.id || "").trim(),
      osId: String(raw?.osId || "").trim(),
      origem: String(raw?.origem || "").trim(),
      cliente: String(raw?.cliente || "").trim(),
      contrato: String(raw?.contrato || "").trim(),
      telefone: String(raw?.telefone || "").trim(),
      protocolo: String(raw?.protocolo || "").trim(),
      rota: String(raw?.rota || "").trim(),
      tecnico: String(raw?.tecnico || "").trim(),
      data: isoDateOnly(raw?.data),
      horario: hhmm(raw?.horario),
      endereco: String(raw?.endereco || "").trim(),
      observacao: String(raw?.observacao || "").trim()
    };

    if (item.origem !== "sgp" || !item.osId) {
      skipped.push({
        id: item.id || item.osId || "",
        reason: "Apenas OS vindas do SGP podem receber confirmacao em lote."
      });
      continue;
    }
    if (!canRequestCustomerConfirmation(item)) {
      skipped.push({
        id: item.id || item.osId || "",
        reason: "Confirmacao so pode ser enviada quando data de agendamento e tecnico estiverem preenchidos."
      });
      continue;
    }
    validItems.push(item);
  }

  if (!validItems.length) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        message: "Nenhuma OS valida para envio da confirmacao.",
        queued: [],
        skipped
      }
    };
  }

  await Promise.all(validItems.map((item) => queueConfirmationDispatch(config, item)));

  return {
    statusCode: 202,
    body: {
      ok: true,
      message: `${validItems.length} OS enfileirada(s) para envio de confirmacao via SGP.`,
      queued: validItems.map((item) => ({ id: item.id, osId: item.osId })),
      skipped
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
    const normalizedPathname = parsedUrl.pathname.replace(/\/+$/, "") || "/";
    const config = loadConfig();

    if (req.method === "GET" && parsedUrl.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, service: "dashboard-agendamento-sgp", version: DASHBOARD_VERSION });
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/auth/login") {
      try {
        const body = await collectRequestBody(req);
        const { username, password } = body || {};
        
        if (!username || !password) {
          sendJson(res, 400, { ok: false, message: "Usuario e senha sao obrigatorios." });
          return;
        }

        const userInfo = await fetchSgpUserInfo(config, username, password);
        const isAdmin = userHasAdminGroup(userInfo, config);
        
        const tokenPayload = {
          sub: userInfo.usuario,
          nome: userInfo.nome,
          email: userInfo.email,
          grupos: userInfo.grupos || [],
          isAdmin,
          iat: Date.now(),
          exp: Date.now() + (8 * 60 * 60 * 1000)
        };
        
        const token = createSimpleJwt(tokenPayload, config.auth.jwt_secret);
        
        sendJson(res, 200, {
          ok: true,
          token,
          user: {
            username: userInfo.usuario,
            nome: userInfo.nome,
            email: userInfo.email,
            isAdmin
          }
        });
      } catch (error) {
        sendJson(res, 401, { ok: false, message: error.message || "Falha na autenticacao." });
      }
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/auth/logout") {
      sendJson(res, 200, { ok: true, message: "Logout realizado." });
      return;
    }

    if (req.method === "GET" && parsedUrl.pathname === "/api/auth/me") {
      const token = extractBearerToken(req);
      if (!token) {
        sendJson(res, 401, { ok: false, message: "Token nao fornecido." });
        return;
      }

      const payload = verifySimpleJwt(token, config.auth.jwt_secret);
      if (!payload) {
        sendJson(res, 401, { ok: false, message: "Token invalido ou expirado." });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        user: {
          username: payload.sub,
          nome: payload.nome,
          email: payload.email,
          isAdmin: payload.isAdmin
        }
      });
      return;
    }

    const isProtectedRoute = normalizedPathname.startsWith("/api/") && 
      !normalizedPathname.startsWith("/api/auth/") &&
      normalizedPathname !== "/api/health";
    
    if (isProtectedRoute) {
      const token = extractBearerToken(req);
      if (!token) {
        sendJson(res, 401, { ok: false, message: "Autenticacao necessaria." });
        return;
      }

      const payload = verifySimpleJwt(token, config.auth.jwt_secret);
      if (!payload) {
        sendJson(res, 401, { ok: false, message: "Token invalido ou expirado." });
        return;
      }

      req.authUser = payload;
    }

    if (req.method === "GET" && parsedUrl.pathname === "/api/dashboard-data") {
      const data = await getDashboardData(parsedUrl.searchParams, req.authUser);
      sendJson(res, 200, data);
      return;
    }

    if (req.method === "GET" && parsedUrl.pathname === "/api/contrato") {
      const result = await getContractData(parsedUrl.searchParams.get("contrato"));
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/agendamentos") {
      if (!req.authUser?.isAdmin) {
        sendJson(res, 403, { ok: false, message: "Acesso permitido apenas para administradores." });
        return;
      }
      const payload = await collectRequestBody(req);
      const result = await createSchedule(payload);
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/agendamentos/edit") {
      if (!req.authUser?.isAdmin) {
        sendJson(res, 403, { ok: false, message: "Acesso permitido apenas para administradores." });
        return;
      }
      const payload = await collectRequestBody(req);
      const result = await updateSchedule(payload);
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/agendamentos/delete") {
      if (!req.authUser?.isAdmin) {
        sendJson(res, 403, { ok: false, message: "Acesso permitido apenas para administradores." });
        return;
      }
      const payload = await collectRequestBody(req);
      const result = await deleteSchedule(payload);
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/bloqueios") {
      if (!req.authUser?.isAdmin) {
        sendJson(res, 403, { ok: false, message: "Acesso permitido apenas para administradores." });
        return;
      }
      const payload = await collectRequestBody(req);
      const result = await createBlockedSlot(payload);
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/bloqueios/delete") {
      if (!req.authUser?.isAdmin) {
        sendJson(res, 403, { ok: false, message: "Acesso permitido apenas para administradores." });
        return;
      }
      const payload = await collectRequestBody(req);
      const result = await removeBlockedSlot(payload);
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (normalizedPathname === "/api/agendamentos/send-confirmation") {
      console.log(`[CONFIRMATION_DISPATCH_API] ${req.method} ${parsedUrl.pathname}`);
    }

    if (req.method === "POST" && normalizedPathname === "/api/agendamentos/send-confirmation") {
      const payload = await collectRequestBody(req);
      const result = await requestConfirmationDispatch(payload);
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (req.method === "GET" && normalizedPathname === "/api/agendamentos/send-confirmation") {
      sendJson(res, 405, {
        ok: false,
        message: "Use POST em /api/agendamentos/send-confirmation."
      });
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
  ensureConfirmationResendJobStarted();
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
    const normalizedContractId = String(contractId || "").trim();
    
    const allRows = [];
    for (const status of statuses) {
      const payload = {
        status,
        limit: 10,
        contrato: normalizedContractId
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

    const contractRows = allRows.filter((row) => {
      const rowContractId = String(row.contrato || row.contrato_id || row.id_contrato || "").trim();
      return rowContractId === normalizedContractId;
    });

    if (!contractRows.length) return [];

    const uniqueRows = dedupeBy(
      contractRows.filter((row) => isExternalServiceOrder(row)),
      (row) => String(row.id || row.os_id || "")
    );
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
        hora_agendamento: String(raw.hora_agendamento || ""),
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
