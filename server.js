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
const SCHEDULE_FLAGS_PATH = path.join(DATA_DIR, "schedule-flags.json");

const DASHBOARD_USER_MARK_RE = /\[dashboard_user=([^\]\n\r]{1,120})\]/i;
const DASHBOARD_USER_AUDIT_RE = /^Agendado por:\s*(.+?)\s*em\s*(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}:\d{2}:\d{2})\s*$/im;

function sanitizeDashboardUserLabel(value) {
  return String(value || "")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ")
    .replaceAll("]", "")
    .trim()
    .slice(0, 120);
}

function formatBrazilAuditTimestamp(date) {
  const now = date instanceof Date ? date : new Date();
  const isoDate = toLocalIsoDate(now);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const formatted = toBrazilDateTime(isoDate, `${hh}:${mm}:${ss}`);
  return formatted ? formatted.replace(" ", " - ") : "";
}

function extractDashboardCreatedBy(text) {
  let raw = String(text || "");
  let createdBy = "";

  const auditMatch = raw.match(DASHBOARD_USER_AUDIT_RE);
  if (auditMatch) {
    createdBy = sanitizeDashboardUserLabel(auditMatch[1]);
  }
  raw = raw.replace(DASHBOARD_USER_AUDIT_RE, "");

  if (!createdBy) {
    const markMatch = raw.match(DASHBOARD_USER_MARK_RE);
    if (markMatch) {
      createdBy = sanitizeDashboardUserLabel(markMatch[1]);
    }
  }
  raw = raw.replace(DASHBOARD_USER_MARK_RE, "");

  const without = raw.replace(/\n{3,}/g, "\n\n").trim();
  return { text: without, createdBy };
}

function normalizeMultilineText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function mergeSgpObservation(existing, incoming) {
  const current = normalizeMultilineText(existing);
  const next = normalizeMultilineText(incoming);
  if (!next) {
    return current;
  }
  if (!current) {
    return next;
  }
  if (current === next || current.includes(next)) {
    return current;
  }
  if (next.includes(current)) {
    return next;
  }
  return `${current}\n\n${next}`;
}

function observationContainsExpected(actual, expected) {
  const actualNormalized = normalizeMultilineText(actual);
  const expectedNormalized = normalizeMultilineText(expected);
  if (!expectedNormalized) {
    return true;
  }
  if (!actualNormalized) {
    return false;
  }
  if (actualNormalized === expectedNormalized || actualNormalized.includes(expectedNormalized)) {
    return true;
  }

  const actualWithoutAudit = extractDashboardCreatedBy(actualNormalized).text;
  const expectedWithoutAudit = extractDashboardCreatedBy(expectedNormalized).text;
  if (!expectedWithoutAudit) {
    return true;
  }
  return actualWithoutAudit === expectedWithoutAudit || actualWithoutAudit.includes(expectedWithoutAudit);
}

function hasDashboardCreatedByMetadata(text) {
  const raw = String(text || "");
  return DASHBOARD_USER_AUDIT_RE.test(raw) || DASHBOARD_USER_MARK_RE.test(raw);
}

function isClosedStatusText(value) {
  const statusText = String(value || "").trim().toLowerCase();
  if (!statusText) return false;
  return (
    statusText.includes("encerr") ||
    statusText.includes("finaliz") ||
    statusText.includes("conclu") ||
    statusText.includes("fechad") ||
    statusText.includes("cancel") ||
    statusText.includes("baixad")
  );
}

function isOpenStatusText(value) {
  const statusText = String(value || "").trim().toLowerCase();
  if (!statusText) return false;
  if (statusText === "aberta" || statusText === "pendente") return true;
  return statusText.includes("aberta") || statusText.includes("pendent");
}

function ensureDashboardCreatedByAudit(text, createdBy, date = new Date()) {
  const base = String(text || "").trim();
  const label = sanitizeDashboardUserLabel(createdBy);
  if (!label) {
    return base;
  }
  if (hasDashboardCreatedByMetadata(base)) {
    return base;
  }
  const stamp = formatBrazilAuditTimestamp(date);
  const auditLine = stamp ? `Agendado por: ${label} em ${stamp}` : `Agendado por: ${label}`;
  return base ? `${base}\n${auditLine}` : auditLine;
}

const DEFAULT_STATUSES = [0, 3];
const DEFAULT_SLOTS = ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"];
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_SEND_INTERVAL_MS = 30000;
const DEFAULT_LOGIN_TTL_MS = 2 * 60 * 60 * 1000;
const CONFIRMATION_RESEND_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CONFIRMATION_RESEND_FIRST_MS = 2 * 60 * 60 * 1000;
const CONFIRMATION_RESEND_SECOND_MS = 4 * 60 * 60 * 1000;
const CONFIRMATION_MANUAL_AFTER_MS = 6 * 60 * 60 * 1000;
const CONFIRMATION_CACHE_TTL_MS = 5 * 60 * 1000;
const confirmationStatusCache = new Map();
const dashboardDataCache = new Map();
const dashboardDataInflight = new Map();
const sgpPopsCache = new Map();
let sgpDispatchQueue = Promise.resolve();
let lastSgpDispatchAt = 0;
let confirmationResendJobTimer = null;
let confirmationResendJobRunning = false;

const sgpOperatorSessions = new Map();
const sgpWebSessionCache = new Map();
const sgpWebBlockedSessions = new Map();

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
  if (!fs.existsSync(SCHEDULE_FLAGS_PATH)) {
    fs.writeFileSync(SCHEDULE_FLAGS_PATH, "{}\n", "utf8");
  }
}

function deepCloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
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

function readScheduleFlags() {
  ensureDataDir();
  const data = readJson(SCHEDULE_FLAGS_PATH, {});
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {};
  }
  return data;
}

function writeScheduleFlags(data) {
  writeJson(SCHEDULE_FLAGS_PATH, data && typeof data === "object" && !Array.isArray(data) ? data : {});
  invalidateDashboardDataCache();
}

function truthyFlag(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "sim";
}

function setDuplicatePeriodFlag({ osId = "", protocolo = "", id = "" }) {
  const flags = readScheduleFlags();
  const now = new Date().toISOString();
  const keys = [];
  const osKey = String(osId || "").trim();
  const protoKey = String(protocolo || "").trim();
  const idKey = String(id || "").trim();
  if (osKey) keys.push(`os:${osKey}`);
  if (protoKey) keys.push(`protocolo:${protoKey}`);
  if (idKey) keys.push(`id:${idKey}`);
  if (!keys.length) return false;

  for (const key of keys) {
    flags[key] = {
      ...(flags[key] || {}),
      duplicatePeriod: true,
      updated_at: now
    };
  }
  writeScheduleFlags(flags);
  return true;
}

function setCreatedByFlag({ osId = "", protocolo = "", id = "", createdBy = "" }) {
  const label = sanitizeDashboardUserLabel(createdBy);
  if (!label) return false;
  const flags = readScheduleFlags();
  const now = new Date().toISOString();
  const keys = [];
  const osKey = String(osId || "").trim();
  const protoKey = String(protocolo || "").trim();
  const idKey = String(id || "").trim();
  if (osKey) keys.push(`os:${osKey}`);
  if (protoKey) keys.push(`protocolo:${protoKey}`);
  if (idKey) keys.push(`id:${idKey}`);
  if (!keys.length) return false;

  for (const key of keys) {
    flags[key] = {
      ...(flags[key] || {}),
      createdBy: label,
      updated_at: now
    };
  }
  writeScheduleFlags(flags);
  return true;
}

function applyScheduleFlags(schedules) {
  const flags = readScheduleFlags();
  for (const item of schedules || []) {
    if (!item || item.origem === "bloqueio" || item.status === "bloqueado") {
      continue;
    }
    if (item.duplicatePeriod) {
      // keep
    }
    const osKey = String(item.osId || "").trim();
    const protoKey = String(item.protocolo || "").trim();
    const idKey = String(item.id || "").trim();
    const osFlags = osKey ? flags[`os:${osKey}`] : null;
    const protoFlags = protoKey ? flags[`protocolo:${protoKey}`] : null;
    const idFlags = idKey ? flags[`id:${idKey}`] : null;

    if (!item.duplicatePeriod && (osFlags?.duplicatePeriod || protoFlags?.duplicatePeriod || idFlags?.duplicatePeriod)) {
      item.duplicatePeriod = true;
    }
    if (!item.createdBy) {
      const createdBy = osFlags?.createdBy || protoFlags?.createdBy || idFlags?.createdBy || "";
      if (createdBy) {
        item.createdBy = createdBy;
      }
    }
  }
}

function readBlockedSlots() {
  const data = readJson(BLOCKED_SLOTS_PATH, []);
  return Array.isArray(data) ? data : [];
}

function writeBlockedSlots(items) {
  writeJson(BLOCKED_SLOTS_PATH, Array.isArray(items) ? items : []);
  invalidateDashboardDataCache();
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

function generateSessionId() {
  return `sess-${Date.now()}-${cryptoRandomId()}`;
}

function storeSgpOperatorSession({ sessionId, username, password, ttlMs }) {
  const normalizedSessionId = String(sessionId || "").trim();
  const normalizedUsername = String(username || "").trim();
  const normalizedPassword = String(password || "").trim();
  if (!normalizedSessionId || !normalizedUsername || !normalizedPassword) {
    return false;
  }
  const token = Buffer.from(`${normalizedUsername}:${normalizedPassword}`).toString("base64");
  sgpOperatorSessions.set(normalizedSessionId, {
    username: normalizedUsername,
    password: normalizedPassword,
    basicAuthHeader: `Basic ${token}`,
    expiresAt: Date.now() + Math.max(60_000, Number(ttlMs) || DEFAULT_LOGIN_TTL_MS)
  });
  return true;
}

function readSgpOperatorSession(sessionId) {
  const key = String(sessionId || "").trim();
  if (!key) return null;
  const entry = sgpOperatorSessions.get(key);
  if (!entry) return null;
  if (Date.now() > Number(entry.expiresAt || 0)) {
    sgpOperatorSessions.delete(key);
    return null;
  }
  return entry;
}

function clearSgpOperatorSession(sessionId) {
  const key = String(sessionId || "").trim();
  if (!key) return false;
  return sgpOperatorSessions.delete(key);
}

function getSgpAuthFromUserPayload(userPayload) {
  const sessionId = String(userPayload?.sgpSessionId || "").trim();
  const session = readSgpOperatorSession(sessionId);
  if (!session) {
    return null;
  }
  return {
    username: session.username,
    password: session.password,
    headers: {
      Authorization: session.basicAuthHeader
    }
  };
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
      cache_dashboard_ms: 45000,
      cache_pops_ms: 600000,
      ...(config.dashboard || {})
    },
    agendamento: {
      endpoint_lista: "/api/ura/ordemservico/list/",
      endpoint_pops: "/api/ura/pops/",
      endpoint_contrato: "/api/suporte/contrato/list/",
      endpoint_agendar: "/api/ura/chamado/",
      ocorrencia_tipo_padrao: 5,
      motivo_os_padrao: 1,
      setor_padrao: 1,
      prioridade_os_padrao: 2,
      prioridade_os_ao_agendar: 3,
      status_os_ao_agendar: 0,
      statuses_consulta: DEFAULT_STATUSES,
      permite_pre_agendamento_local: true,
      confirmacao_credenciais: "robo",
      ...(config.agendamento || {})
    },
    auth: {
      jwt_secret: "dashboard-secret-change-in-production",
      admin_group: "agendamento",
      ...(config.auth || {})
    }
  };
}

function resolveDashboardCacheTtlMs(config) {
  const value = Number(config.dashboard?.cache_dashboard_ms);
  if (Number.isFinite(value) && value >= 0) {
    return value;
  }
  return 45000;
}

function resolveSgpPopsCacheTtlMs(config) {
  const value = Number(config.dashboard?.cache_pops_ms);
  if (Number.isFinite(value) && value >= 0) {
    return value;
  }
  return 600000;
}

function buildSgpCacheIdentity(config, operatorAuth = null) {
  if (hasRobotSgpCredentials(config) || hasAppTokenAuth(config)) {
    return "integration";
  }
  return String(operatorAuth?.username || "anonymous").trim() || "anonymous";
}

function buildDashboardCacheKey({ startDate, endDate, selectedDate, authIdentity }) {
  return JSON.stringify({
    selectedDate: String(selectedDate || "").trim(),
    startDate: String(startDate || "").trim(),
    endDate: String(endDate || "").trim(),
    authIdentity: String(authIdentity || "").trim()
  });
}

function readDashboardCache(key, ttlMs) {
  const entry = dashboardDataCache.get(key);
  if (!entry) {
    return null;
  }
  if ((Date.now() - entry.createdAt) > ttlMs) {
    dashboardDataCache.delete(key);
    return null;
  }
  return deepCloneJson(entry.value);
}

function writeDashboardCache(key, value) {
  dashboardDataCache.set(key, {
    createdAt: Date.now(),
    value: deepCloneJson(value)
  });
}

function invalidateDashboardDataCache() {
  dashboardDataCache.clear();
  dashboardDataInflight.clear();
}

async function getOrCreateDashboardCache(key, ttlMs, buildValue) {
  const cached = readDashboardCache(key, ttlMs);
  if (cached) {
    return cached;
  }

  const inflight = dashboardDataInflight.get(key);
  if (inflight) {
    return deepCloneJson(await inflight);
  }

  const promise = (async () => {
    const value = await buildValue();
    writeDashboardCache(key, value);
    return value;
  })();

  dashboardDataInflight.set(key, promise);
  try {
    return deepCloneJson(await promise);
  } finally {
    dashboardDataInflight.delete(key);
  }
}

function readSgpPopsCache(key, ttlMs) {
  const entry = sgpPopsCache.get(key);
  if (!entry) {
    return null;
  }
  if ((Date.now() - entry.createdAt) > ttlMs) {
    sgpPopsCache.delete(key);
    return null;
  }
  return [...entry.value];
}

function writeSgpPopsCache(key, value) {
  sgpPopsCache.set(key, {
    createdAt: Date.now(),
    value: Array.isArray(value) ? [...value] : []
  });
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
  const username = config.basic_auth?.username || "";
  const password = config.basic_auth?.password || "";
  if (!username && !password) {
    return {};
  }
  const token = Buffer.from(`${username}:${password}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

function hasRobotSgpCredentials(config) {
  return Boolean(
    String(config.basic_auth?.username || "").trim() &&
    String(config.basic_auth?.password || "").trim()
  );
}

function resolveSgpInteractionAuth(config, operatorAuth = null) {
  return hasRobotSgpCredentials(config) ? null : operatorAuth;
}

function canUseSgpInteractionAuth(config, operatorAuth = null) {
  return Boolean(resolveSgpInteractionAuth(config, operatorAuth) || hasRobotSgpCredentials(config) || hasAppTokenAuth(config));
}

function buildSgpAuthHeaders(config, operatorAuth) {
  // Para endpoints JSON do SGP (app+token), algumas instancias exigem o usuário de integração (robo),
  // e retornam HTML (login/erro) quando usamos credenciais de operador.
  if (hasAppTokenAuth(config) || hasRobotSgpCredentials(config)) {
    return buildAuthHeaders(config);
  }
  if (operatorAuth?.headers?.Authorization) {
    return { Authorization: operatorAuth.headers.Authorization };
  }
  return buildAuthHeaders(config);
}

function resolveConfirmationDispatchCredentials(config, operatorAuth = null) {
  if (hasRobotSgpCredentials(config)) {
    return null;
  }
  const mode = String(config.agendamento?.confirmacao_credenciais || "robo").trim().toLowerCase();
  if (["operador", "operator", "usuario_logado", "usuário_logado", "logged_user"].includes(mode)) {
    return operatorAuth;
  }
  return null;
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

function resolveSgpWebSessionTtlMs(config) {
  const value = Number(config.dashboard?.sgp_web_session_ttl_ms);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return 15 * 60 * 1000;
}

function resolveSgpWebTwoFactorBlockMs(config) {
  const ms =
    Number(config.dashboard?.sgp_web_2fa_block_ms) ||
    Number(config.dashboard?.sgp_web_block_ms) ||
    0;
  if (Number.isFinite(ms) && ms > 0) {
    return ms;
  }
  const minutes =
    Number(config.dashboard?.sgp_web_2fa_block_minutes) ||
    Number(config.dashboard?.sgp_web_block_minutes) ||
    0;
  if (Number.isFinite(minutes) && minutes > 0) {
    return minutes * 60 * 1000;
  }
  return 10 * 60 * 1000;
}

function resolveSgpWebCredentialParts(config, credentials = null) {
  return {
    baseUrl: String(config.url_base || "").replace(/\/+$/, ""),
    username: String(credentials?.username || config.basic_auth?.username || "").trim(),
    password: String(credentials?.password || config.basic_auth?.password || "").trim()
  };
}

function getSgpWebBlockKey(config, credentials = null) {
  const parts = resolveSgpWebCredentialParts(config, credentials);
  return `${parts.baseUrl}::${parts.username}`;
}

function getSgpWebBlockState(config, credentials = null) {
  const key = getSgpWebBlockKey(config, credentials);
  const entry = sgpWebBlockedSessions.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() >= Number(entry.blockedUntil || 0)) {
    sgpWebBlockedSessions.delete(key);
    return null;
  }
  return entry;
}

function isSgpWebTemporarilyBlocked(config, credentials = null) {
  return Boolean(getSgpWebBlockState(config, credentials));
}

function markSgpWebTemporarilyBlocked(config, reason, detail = "", credentials = null) {
  const blockMs = resolveSgpWebTwoFactorBlockMs(config);
  const until = Date.now() + blockMs;
  const key = getSgpWebBlockKey(config, credentials);
  const current = sgpWebBlockedSessions.get(key);
  if (current && until <= Number(current.blockedUntil || 0)) {
    return;
  }
  const blockedReason = String(reason || "").trim() || "unknown";
  sgpWebBlockedSessions.set(key, {
    blockedUntil: until,
    reason: blockedReason
  });
  const minutes = Math.max(1, Math.round(blockMs / 60000));
  console.warn(`[SGP_WEB] Bloqueado por ${minutes}min (${blockedReason})${detail ? `: ${detail}` : ""}`);
}

function buildSgpTwoFactorError(message, detail) {
  const error = new Error(message || "Nao foi possivel abrir o formulario web da OS no SGP (o SGP exigiu confirmacao 2FA).");
  if (detail) {
    error.detail = detail;
  }
  return error;
}

function logSgpScheduleUpdate(stage, details) {
  try {
    console.log(`[SGP_UPDATE] ${stage} ${JSON.stringify(details)}`);
  } catch (error) {
    console.log(`[SGP_UPDATE] ${stage}`);
  }
}

function isSgpTwoFactorBlock(error) {
  const message = String(error?.message || "").toLowerCase();
  const detail = String(error?.detail || "").toLowerCase();
  return (
    message.includes("2fa") ||
    message.includes("two factor") ||
    message.includes("two-factor") ||
    detail.includes("confirm-2fa") ||
    detail.includes("two-factor") ||
    detail.includes("two_factor") ||
    detail.includes("/accounts/confirm-2fa") ||
    detail.includes("/accounts/confirm_2fa")
  );
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
  invalidateDashboardDataCache();
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

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)));
}

function extractHtmlFieldValue(html, name) {
  const safeName = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const namedTag = new RegExp(`<input(?=[^>]*name=['"]${safeName}['"])[^>]*>`, "i");
  const input = html.match(namedTag);
  if (input) {
    const value = input[0].match(/value=['"]([^'"]*)['"]/i);
    return value ? decodeHtmlEntities(value[1]) : "";
  }

  const textarea = html.match(new RegExp(`<textarea[^>]*name=['"]${safeName}['"][^>]*>([\\s\\S]*?)<\\/textarea>`, "i"));
  if (textarea) {
    return decodeHtmlEntities(textarea[1]);
  }

  const select = html.match(new RegExp(`<select[^>]*name=['"]${safeName}['"][^>]*>([\\s\\S]*?)<\\/select>`, "i"));
  if (select) {
    const options = [...select[1].matchAll(/<option([^>]*)value=['"]([^'"]*)['"]([^>]*)>/gi)];
    const selected = options.find((match) => /selected/i.test(`${match[1]} ${match[3]}`));
    return selected ? decodeHtmlEntities(selected[2]) : "";
  }

  return "";
}

function extractSgpObservacaoValueFromHtml(html) {
  return (
    extractHtmlFieldValue(html, "observacao") ||
    extractHtmlFieldValue(html, "os_observacao") ||
    extractHtmlFieldValue(html, "observacao_os") ||
    ""
  );
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

function extractHtmlSelectSelectedLabel(html, name) {
  const options = extractHtmlSelectOptions(html, name);
  const selected = options.find((opt) => opt.selected) || null;
  return selected ? selected.label : "";
}

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function resolveHtmlSelectValue(html, name, requestedValue) {
  const requested = String(requestedValue || "").trim();
  if (!requested) {
    return "";
  }

  const options = extractHtmlSelectOptions(html, name).filter((item) => item.value);
  if (!options.length) {
    return requested;
  }

  const requestedComparable = normalizeComparableText(requested);
  const exactValue = options.find((item) => String(item.value || "").trim() === requested);
  if (exactValue) {
    return exactValue.value;
  }

  const exactLabel = options.find((item) => normalizeComparableText(item.label) === requestedComparable);
  if (exactLabel) {
    return exactLabel.value;
  }

  const containsLabel = options.find((item) => {
    const labelComparable = normalizeComparableText(item.label);
    return labelComparable && (labelComparable.includes(requestedComparable) || requestedComparable.includes(labelComparable));
  });
  if (containsLabel) {
    return containsLabel.value;
  }

  return requested;
}

function technicianMatchesExpected(expected, actual) {
  if (!hasMeaningfulTechnician(expected)) {
    return true;
  }
  if (!hasMeaningfulTechnician(actual)) {
    return false;
  }
  const expectedComparable = normalizeComparableText(expected);
  const actualComparable = normalizeComparableText(actual);
  return actualComparable === expectedComparable ||
    actualComparable.includes(expectedComparable) ||
    expectedComparable.includes(actualComparable);
}

function summarizeSgpHtmlResponse(html) {
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 280);
}

function htmlToPlainText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractHtmlContextAroundField(html, fieldName, contextLength = 1400) {
  const normalizedHtml = String(html || "");
  const safeName = String(fieldName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = normalizedHtml.match(
    new RegExp(`(<(?:input|select|textarea)[^>]*name=['"]${safeName}['"][\\s\\S]*?(?:<\\/select>|<\\/textarea>|>))`, "i")
  );
  if (!match || typeof match.index !== "number") {
    return "";
  }
  const start = Math.max(0, match.index - Math.floor(contextLength / 2));
  const end = Math.min(normalizedHtml.length, match.index + match[0].length + Math.floor(contextLength / 2));
  return htmlToPlainText(normalizedHtml.slice(start, end)).slice(0, contextLength);
}

function extractHtmlAlertSnippets(html, limit = 3, snippetLength = 900) {
  const normalizedHtml = String(html || "");
  const patterns = [
    /<[^>]*class=['"][^'"]*(?:alert|danger|warning|error|invalid|help-block|errorlist)[^'"]*['"][^>]*>[\s\S]*?<\/[^>]+>/gi,
    /<ul[^>]*class=['"][^'"]*errorlist[^'"]*['"][^>]*>[\s\S]*?<\/ul>/gi
  ];
  const snippets = [];

  for (const pattern of patterns) {
    const matches = normalizedHtml.match(pattern) || [];
    for (const match of matches) {
      const text = htmlToPlainText(match).slice(0, snippetLength);
      if (text && !snippets.includes(text)) {
        snippets.push(text);
      }
      if (snippets.length >= limit) {
        return snippets;
      }
    }
  }

  return snippets;
}

function extractSgpHtmlDiagnostics(html, { summaryLimit = 280, excerptLimit = 1600 } = {}) {
  const normalizedHtml = String(html || "");
  const text = htmlToPlainText(normalizedHtml);

  const keywords = [
    "alert",
    "danger",
    "error",
    "erro",
    "warning",
    "aviso",
    "invalid",
    "invalido",
    "inválido",
    "required",
    "obrigatorio",
    "obrigatório",
    "nao foi possivel",
    "não foi possível",
    "falha",
    "sucesso"
  ];
  const lowerText = text.toLowerCase();
  let excerpt = text.slice(0, excerptLimit);

  for (const keyword of keywords) {
    const index = lowerText.indexOf(keyword);
    if (index >= 0) {
      const start = Math.max(0, index - 220);
      const end = Math.min(text.length, index + excerptLimit);
      excerpt = text.slice(start, end);
      break;
    }
  }

  return {
    summary: text.slice(0, summaryLimit),
    excerpt,
    alertSnippets: extractHtmlAlertSnippets(normalizedHtml),
    responsibleFieldContext: extractHtmlContextAroundField(normalizedHtml, "responsavel"),
    responsibleSelectedValue: extractHtmlFieldValue(normalizedHtml, "responsavel"),
    responsibleSelectedLabel: extractHtmlSelectSelectedLabel(normalizedHtml, "responsavel")
  };
}

function normalizePhoneDigits(value) {
  return String(value || "").replace(/\D+/g, "");
}

function summarizeOptionLabels(options, limit = 5) {
  const items = Array.isArray(options) ? options : [];
  return items
    .slice(0, Math.max(0, Number(limit) || 0))
    .map((item) => String(item?.label || "").trim())
    .filter(Boolean);
}

function pickSmsClientSelection(html, requestedPhone) {
  const options = extractHtmlSelectOptions(html, "sms_cliente").filter((item) => item.value);
  if (!options.length) {
    return {
      values: [],
      labels: [],
      matchType: "missing_options",
      reason: "Campo sms_cliente sem opcoes disponiveis no formulario do SGP.",
      requestedPhone: String(requestedPhone || "").trim(),
      requestedDigits: normalizePhoneDigits(requestedPhone),
      availableLabels: []
    };
  }

  const targetDigits = normalizePhoneDigits(requestedPhone);
  const withMeta = options.map((item) => {
    const label = String(item.label || "").trim();
    const comparable = normalizeComparableText(label);
    const digits = normalizePhoneDigits(label);
    const scoreParts = [];
    let score = 0;

    if (targetDigits) {
      if (digits === targetDigits) {
        score += 120;
        scoreParts.push("exact_digits");
      } else if (digits.endsWith(targetDigits) || targetDigits.endsWith(digits)) {
        score += 90;
        scoreParts.push("suffix_digits");
      } else if (digits.includes(targetDigits) || targetDigits.includes(digits)) {
        score += 60;
        scoreParts.push("contains_digits");
      }
    }

    if (/\b(celular|whatsapp|whats|movel|m[óo]vel)\b/i.test(label)) {
      score += 20;
      scoreParts.push("mobile_label");
    }
    if (/\b(cobranca|cobran[çc]a)\b/i.test(label)) {
      score += 10;
      scoreParts.push("billing_label");
    }
    if (item.selected) {
      score += 5;
      scoreParts.push("selected");
    }

    return { ...item, comparable, digits, score, scoreParts };
  });

  const exactMatch = withMeta
    .filter((item) => item.scoreParts.includes("exact_digits") || item.scoreParts.includes("suffix_digits"))
    .sort((a, b) => b.score - a.score)[0];
  if (exactMatch) {
    return {
      values: [exactMatch.value],
      labels: [exactMatch.label],
      matchType: exactMatch.scoreParts.includes("exact_digits") ? "exact_phone" : "suffix_phone",
      reason: `Contato selecionado por telefone: ${exactMatch.label}`,
      requestedPhone: String(requestedPhone || "").trim(),
      requestedDigits: targetDigits,
      availableLabels: summarizeOptionLabels(options)
    };
  }

  const selected = withMeta.filter((item) => item.selected);
  if (selected.length) {
    return {
      values: selected.map((item) => item.value),
      labels: selected.map((item) => item.label),
      matchType: "selected",
      reason: `Contato selecionado pelo valor ja marcado no SGP: ${selected.map((item) => item.label).join(", ")}`,
      requestedPhone: String(requestedPhone || "").trim(),
      requestedDigits: targetDigits,
      availableLabels: summarizeOptionLabels(options)
    };
  }

  const bestScored = withMeta.sort((a, b) => b.score - a.score)[0];
  if (bestScored && bestScored.score > 0) {
    return {
      values: [bestScored.value],
      labels: [bestScored.label],
      matchType: "best_scored",
      reason: `Contato selecionado por melhor correspondencia: ${bestScored.label}`,
      requestedPhone: String(requestedPhone || "").trim(),
      requestedDigits: targetDigits,
      availableLabels: summarizeOptionLabels(options)
    };
  }

  return {
    values: [],
    labels: [],
    matchType: "no_phone_match",
    reason: targetDigits
      ? `Nenhum contato SMS do formulario corresponde ao telefone ${targetDigits}.`
      : "OS sem telefone elegivel para selecionar sms_cliente.",
    requestedPhone: String(requestedPhone || "").trim(),
    requestedDigits: targetDigits,
    availableLabels: summarizeOptionLabels(options)
  };
}

function pickGatewaySelection(html, preferredLabel = "AGENDAMENTO") {
  const options = extractHtmlSelectOptions(html, "gateway_sms").filter((item) => item.value);
  if (!options.length) {
    return {
      value: "",
      label: "",
      matchType: "missing_options",
      reason: "Campo gateway_sms sem opcoes disponiveis no formulario do SGP.",
      availableLabels: []
    };
  }

  const preferredLabels = String(preferredLabel || "AGENDAMENTO")
    .split(/[;,|]/)
    .map((item) => normalizeComparableText(item))
    .filter(Boolean);
  const normalizedOptions = options.map((item) => ({
    ...item,
    comparable: normalizeComparableText(item.label)
  }));

  for (const preferred of preferredLabels) {
    const exact = normalizedOptions.find((item) => item.comparable === preferred);
    if (exact) {
      return {
        value: exact.value,
        label: exact.label,
        matchType: "exact_label",
        reason: `Gateway selecionado por correspondencia exata: ${exact.label}`,
        availableLabels: summarizeOptionLabels(options)
      };
    }
  }

  for (const preferred of preferredLabels) {
    const contains = normalizedOptions.find((item) => item.comparable.includes(preferred) || preferred.includes(item.comparable));
    if (contains) {
      return {
        value: contains.value,
        label: contains.label,
        matchType: "contains_label",
        reason: `Gateway selecionado por correspondencia parcial: ${contains.label}`,
        availableLabels: summarizeOptionLabels(options)
      };
    }
  }

  const heuristic = normalizedOptions
    .map((item) => {
      let score = 0;
      if (item.comparable.includes("agend")) score += 60;
      if (item.comparable.includes("sms")) score += 20;
      if (item.comparable.includes("whats")) score += 15;
      if (item.comparable.includes("cliente")) score += 10;
      if (item.selected) score += 5;
      return { ...item, score };
    })
    .sort((a, b) => b.score - a.score)[0];
  if (heuristic && heuristic.score > 0) {
    return {
      value: heuristic.value,
      label: heuristic.label,
      matchType: "heuristic",
      reason: `Gateway selecionado por heuristica: ${heuristic.label}`,
      availableLabels: summarizeOptionLabels(options)
    };
  }

  const selected = normalizedOptions.find((item) => item.selected);
  if (selected) {
    return {
      value: selected.value,
      label: selected.label,
      matchType: "selected",
      reason: `Gateway selecionado pelo valor ja marcado no SGP: ${selected.label}`,
      availableLabels: summarizeOptionLabels(options)
    };
  }

  return {
    value: "",
    label: "",
    matchType: "no_gateway_match",
    reason: `Nenhum gateway compativel encontrado para o criterio "${preferredLabel}".`,
    availableLabels: summarizeOptionLabels(options)
  };
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

async function runWithConcurrencyLimit(items, limit, worker, shouldStop = null) {
  const queue = Array.isArray(items) ? items.slice() : [];
  const concurrency = Math.max(1, Number(limit) || 1);
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      if (typeof shouldStop === "function" && shouldStop()) {
        break;
      }
      const item = queue.shift();
      if (typeof shouldStop === "function" && shouldStop()) {
        break;
      }
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

async function refreshSgpWebSession(config, session) {
  const { baseUrl, username, password } = resolveSgpWebCredentialParts(config, null);
  if (!baseUrl || !username || !password) {
    throw new Error("Credenciais web do SGP nao configuradas para re-login.");
  }

  const loginUrl = `${baseUrl}/accounts/login/`;
  console.log("[refreshSgpWebSession] Obtendo nova sessão...");

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
    throw new Error("Nao foi possivel obter CSRF para re-login.");
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
    throw new Error("Falha ao fazer re-login no SGP.");
  }

  console.log("[refreshSgpWebSession] Nova sessão obtida com sucesso.");
  return {
    baseUrl,
    username,
    cookies: sessionCookies
  };
}

async function createSgpWebSession(config, credentials = null, forceRefresh = false) {
  const { baseUrl, username, password } = resolveSgpWebCredentialParts(config, credentials);
  if (!baseUrl || !username || !password) {
    throw new Error("Credenciais web do SGP nao configuradas para editar OS pela interface.");
  }

  const blocked = getSgpWebBlockState(config, { username, password });
  if (blocked) {
    const detail = `SGP web bloqueado ate ${new Date(blocked.blockedUntil).toISOString()} (${blocked.reason || "2FA"}).`;
    throw buildSgpTwoFactorError(
      "SGP web indisponivel no momento (bloqueado por 2FA).",
      detail
    );
  }

  const sessionKey = `${baseUrl}::${username}::${password}`;
  if (!forceRefresh) {
    const cached = sgpWebSessionCache.get(sessionKey);
    const ttlMs = resolveSgpWebSessionTtlMs(config);
    if (cached && (Date.now() - cached.createdAt) < ttlMs) {
      return cached.session;
    }
  }

  const loginUrl = `${baseUrl}/accounts/login/`;
  console.log("[createSgpWebSession] Buscando página de login:", loginUrl);
  const loginPage = await fetch(loginUrl, {
    signal: AbortSignal.timeout(Number(config.dashboard?.timeout_sgp_ms || DEFAULT_TIMEOUT_MS))
  });
  const loginHtml = await loginPage.text();
  const loginCsrf = extractHtmlFieldValue(loginHtml, "csrfmiddlewaretoken");
  const loginCookies = mergeCookieHeaders(
    loginPage.headers.getSetCookie?.(),
    loginPage.headers.get("set-cookie")
  );
  console.log("[createSgpWebSession] CSRF obtido:", loginCsrf ? "sim" : "nao");
  if (!loginCsrf) {
    throw new Error("Nao foi possivel obter CSRF da tela de login do SGP.");
  }

  const body = new URLSearchParams({
    csrfmiddlewaretoken: loginCsrf,
    username,
    password,
    next: "/"
  });
  console.log("[createSgpWebSession] Enviando login...");
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

  console.log("[createSgpWebSession] Login response status:", loginResponse.status);
  console.log("[createSgpWebSession] Login redirect to:", loginResponse.headers.get("location"));
  
  const sessionCookies = mergeCookieHeaders(
    loginCookies,
    loginResponse.headers.getSetCookie?.(),
    loginResponse.headers.get("set-cookie")
  );
  console.log("[createSgpWebSession] Session cookie found:", sessionCookies.includes("sessionid="));
  if (!sessionCookies.includes("sessionid=")) {
    throw new Error("Falha ao autenticar na interface web do SGP.");
  }
  const session = {
    baseUrl,
    username,
    cookies: sessionCookies
  };
  sgpWebSessionCache.set(sessionKey, { createdAt: Date.now(), session });
  return session;
}

async function fetchSgpOsEditForm(config, session, osId) {
  const normalizedOsId = String(osId).trim();
  const baseUrl = String(session.baseUrl || "").replace(/\/+$/, "");
  const basePath = `/admin/atendimento/ocorrencia/os/${encodeURIComponent(normalizedOsId)}/`;
  const candidates = [`${basePath}edit/`, `${basePath}change/`];

  const timeoutMs = Number(config.dashboard?.timeout_sgp_ms || DEFAULT_TIMEOUT_MS);
  const hasScheduleField = (html) => /name=['"](?:data_agendamento|anotacao|conteudo)['"]/i.test(String(html || ""));
  const looksLikeTwoFactorPage = (html, finalUrl) => {
    const url = String(finalUrl || "").toLowerCase();
    if (url.includes("/accounts/confirm-2fa") || url.includes("/accounts/confirm_2fa")) return true;
    if (url.includes("two-factor") || url.includes("two_factor") || url.includes("2fa")) return true;
    const text = String(html || "");
    return /confirm-2fa|two[-_ ]factor|autenticador|authenticator|otp|token/i.test(text) && /csrfmiddlewaretoken/i.test(text);
  };
  const looksLikeLoginPage = (html, finalUrl) => {
    const url = String(finalUrl || "").toLowerCase();
    if (url.includes("/accounts/login")) return true;
    const text = String(html || "");
    return /name=['"]username['"]/i.test(text) && /csrfmiddlewaretoken/i.test(text);
  };

  let lastAttempt = null;
  const maxRetries = 1;

  for (let retryCount = 0; retryCount <= maxRetries; retryCount++) {
    if (retryCount > 0) {
      console.log("[fetchSgpOsEditForm] Sessão expirada, fazendo re-login...");
      const newSession = await refreshSgpWebSession(config, session);
      session.cookies = newSession.cookies;
      console.log("[fetchSgpOsEditForm] Retry", retryCount, "de", maxRetries);
    }

    console.log("[fetchSgpOsEditForm] URLs tentadas:", candidates);
    for (const pathSuffix of candidates) {
      const url = `${baseUrl}${pathSuffix}`;
      console.log("[fetchSgpOsEditForm] Tentando URL:", url);
      const response = await fetch(url, {
        headers: {
          Cookie: session.cookies
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      const html = await response.text();
      const finalUrl = response.url || url;

      console.log("[fetchSgpOsEditForm] Response status:", response.status, "URL final:", finalUrl);

      lastAttempt = {
        url,
        finalUrl,
        status: response.status,
        ok: response.ok,
        loginLike: looksLikeLoginPage(html, finalUrl),
        twoFactorLike: looksLikeTwoFactorPage(html, finalUrl),
        hasField: hasScheduleField(html)
      };

      if (response.ok && hasScheduleField(html)) {
        console.log("[fetchSgpOsEditForm] Formulário encontrado!");
        return { url, html };
      }

      if (lastAttempt.loginLike) {
        console.log("[fetchSgpOsEditForm] Página de login detectada, encerrando tentativas.");
        break;
      }
    }

    if (retryCount < maxRetries && lastAttempt?.loginLike) {
      continue;
    }
    break;
  }

  if (lastAttempt?.twoFactorLike) {
    const detail = `OS ${normalizedOsId}. URL: ${lastAttempt.finalUrl || lastAttempt.url}. HTTP ${lastAttempt.status}.`;
    markSgpWebTemporarilyBlocked(config, "2FA_required", detail, session);
    throw buildSgpTwoFactorError(
      "Nao foi possivel abrir o formulario web da OS no SGP (o SGP exigiu confirmacao 2FA).",
      detail
    );
  }

  if (lastAttempt?.loginLike) {
    const error = new Error("Nao foi possivel abrir o formulario web da OS no SGP (sessao expirada ou login bloqueado).");
    error.detail = `OS ${normalizedOsId}. URL: ${lastAttempt.finalUrl || lastAttempt.url}. HTTP ${lastAttempt.status}.`;
    throw error;
  }

  if (lastAttempt?.status === 403) {
    const error = new Error("Nao foi possivel abrir o formulario web da OS no SGP (sem permissao).");
    error.detail = `OS ${normalizedOsId}. URL: ${lastAttempt.finalUrl || lastAttempt.url}. HTTP 403.`;
    throw error;
  }

  if (lastAttempt?.status === 404) {
    const error = new Error("Nao foi possivel abrir o formulario web da OS no SGP (pagina nao encontrada).");
    error.detail = `OS ${normalizedOsId}. Tentativas: ${candidates.join(" ou ")}. HTTP 404.`;
    throw error;
  }

  const error = new Error("Nao foi possivel abrir o formulario web da OS no SGP.");
  if (lastAttempt) {
    error.detail = `OS ${normalizedOsId}. URL: ${lastAttempt.finalUrl || lastAttempt.url}. HTTP ${lastAttempt.status}. Formato inesperado do formulario (campo data_agendamento ausente).`;
  }
  throw error;
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
    confirmationRequestedAt: String(details.confirmationRequestedAt || "").trim(),
    confirmationResolved: Boolean(details?.confirmationResolved)
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

async function fetchConfirmationDetailsForOs(config, osId, credentials = null) {
  const normalizedOsId = String(osId || "").trim();
  if (!normalizedOsId) {
    return {
      confirmationUrl: "",
      confirmationStatus: "sem_confirmacao",
      confirmationTitle: "",
      confirmationRequestedAt: "",
      confirmationResolved: false
    };
  }

  const cached = readConfirmationCache(normalizedOsId);
  if (cached) {
    return applyConfirmationDispatchState(cached, readConfirmationDispatchEntry(normalizedOsId));
  }

  if (isSgpWebTemporarilyBlocked(config, credentials)) {
    return applyConfirmationDispatchState({
      confirmationUrl: "",
      confirmationStatus: "sem_confirmacao",
      confirmationTitle: "",
      confirmationSent: false,
      confirmationRequestedAt: "",
      confirmationResolved: false
    }, readConfirmationDispatchEntry(normalizedOsId));
  }

  const session = await createSgpWebSession(config, credentials);
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
      confirmationRequestedAt: "",
      confirmationResolved: false
    };
  }

  const osForm = await fetchSgpOsEditForm(config, session, normalizedOsId);
  const occurrencePath = extractOccurrenceEditPathFromOsHtml(osForm.html);
  if (!occurrencePath) {
    return {
      confirmationUrl: "",
      confirmationStatus: "sem_confirmacao",
      confirmationTitle: "",
      confirmationRequestedAt: "",
      confirmationResolved: true
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
  return {
    ...extractConfirmationDetailsFromOccurrenceHtml(session.baseUrl, html, normalizedOsId, dispatchEntry),
    confirmationResolved: true
  };
}

function applyCachedConfirmationToSchedules(schedules) {
  for (const item of schedules || []) {
    if (item?.origem !== "sgp" || !String(item.osId || "").trim()) {
      item.confirmationResolved = true;
      continue;
    }
    const cached = readConfirmationCache(item.osId);
    if (!cached) {
      item.confirmationResolved = false;
      continue;
    }
    item.confirmationUrl = cached.confirmationUrl || "";
    item.confirmationStatus = cached.confirmationStatus || "sem_confirmacao";
    item.confirmationTitle = cached.confirmationTitle || "";
    item.confirmationSent = Boolean(cached.confirmationSent);
    item.confirmationRequestedAt = cached.confirmationRequestedAt || "";
    item.confirmationResolved = true;
  }
}

async function fetchConfirmationBatch(config, osIds = [], credentials = null) {
  const normalizedIds = Array.from(
    new Set((Array.isArray(osIds) ? osIds : []).map((value) => String(value || "").trim()).filter(Boolean))
  );
  const items = [];
  if (!normalizedIds.length) {
    return { ok: true, items };
  }

  const pending = [];
  for (const osId of normalizedIds) {
    const cached = readConfirmationCache(osId);
    if (cached) {
      items.push({
        osId,
        ...applyConfirmationDispatchState(cached, readConfirmationDispatchEntry(osId)),
        confirmationResolved: true
      });
      continue;
    }
    pending.push(osId);
  }

  if (!pending.length) {
    return { ok: true, items };
  }

  if (isSgpWebTemporarilyBlocked(config, credentials)) {
    return { ok: true, items };
  }

  let session;
  try {
    session = await createSgpWebSession(config, credentials);
  } catch (error) {
    if (isSgpTwoFactorBlock(error)) {
      markSgpWebTemporarilyBlocked(config, "2FA_required", String(error.detail || error.message || ""), credentials);
      return { ok: true, items };
    }
    throw error;
  }

  const concurrency = Math.max(1, Math.min(3, Number(config.dashboard?.confirmation_fetch_concurrency || 1)));
  let stop = false;
  await runWithConcurrencyLimit(
    pending,
    concurrency,
    async (osId) => {
      if (stop) {
        return;
      }
      try {
        const details = await fetchConfirmationDetailsForOsWithSession(config, session, osId);
        writeConfirmationCache(osId, details);
        items.push({
          osId,
          ...details,
          confirmationResolved: true
        });
      } catch (error) {
        if (isSgpTwoFactorBlock(error)) {
          stop = true;
          markSgpWebTemporarilyBlocked(config, "2FA_required", String(error.detail || error.message || ""), credentials);
          return;
        }
        const cached = readConfirmationCache(osId);
        if (cached) {
          items.push({
            osId,
            ...applyConfirmationDispatchState(cached, readConfirmationDispatchEntry(osId)),
            confirmationResolved: true
          });
        }
      }
    },
    () => stop
  );

  return { ok: true, items };
}

async function getOsDetails(config, osId, credentials = null) {
  console.log("[getOsDetails] Iniciando para OS:", osId);
  let apiDetails = null;

  // Preferir API (quando configurada) para reduzir hits na web/2FA.
  if (hasAppTokenAuth(config)) {
    try {
      apiDetails = await getOsDetailsViaApi(config, osId, credentials);
      if (apiDetails && Array.isArray(apiDetails.classification_options) && apiDetails.classification_options.length) {
        return apiDetails;
      }
    } catch (apiError) {
      console.error("[getOsDetails] API fallback falhou:", apiError.message);
    }
  }

  const blocked = getSgpWebBlockState(config, credentials);
  if (blocked) {
    throw buildSgpTwoFactorError(
      "Nao foi possivel obter detalhes via web do SGP (2FA ativo).",
      `SGP web bloqueado ate ${new Date(blocked.blockedUntil).toISOString()} (${blocked.reason || "2FA"}).`
    );
  }

  // Tentativa via formulário web
  try {
    const session = await createSgpWebSession(config, credentials);
    console.log("[getOsDetails] Sessão criada, buscando formulário...");
    const form = await fetchSgpOsEditForm(config, session, osId);
    console.log("[getOsDetails] Formulário obtido, HTML length:", form.html.length);
    
    const hasAnotacao = /name=['"]anotacao['"]/i.test(form.html);
    const hasDataAgendamento = /name=['"]data_agendamento['"]/i.test(form.html);
    console.log("[getOsDetails] HTML tem campo anotacao:", hasAnotacao, "data_agendamento:", hasDataAgendamento);
    
    const html = form.html;
    const anotacao = extractHtmlFieldValue(html, "anotacao") || "";
    const observacao = extractSgpObservacaoValueFromHtml(html) || "";
    const conteudo = extractHtmlFieldValue(html, "conteudo") || "";
    const responsavel = extractHtmlFieldValue(html, "responsavel") || "";
    const responsavelLabel = extractHtmlSelectSelectedLabel(html, "responsavel") || responsavel;
    const dataAgendamento = extractHtmlFieldValue(html, "data_agendamento") || "";
    const statusLabel = extractHtmlSelectSelectedLabel(html, "status");
    const classificationValue = extractHtmlFieldValue(html, "tipo_classificacoes") || "";
    const classificationLabel = extractHtmlSelectSelectedLabel(html, "tipo_classificacoes") || classificationValue;
    const classificationOptions = extractHtmlSelectOptions(html, "tipo_classificacoes")
      .filter((item) => String(item?.value || "").trim())
      .map((item) => ({
        value: String(item.value || "").trim(),
        label: String(item.label || "").trim(),
        selected: Boolean(item.selected)
      }));
    const parsedSchedule = extractSgpScheduledDateTime({
      data_agendamento: dataAgendamento
    });
    
    console.log("[getOsDetails] Campos extraidos - anotacao:", JSON.stringify(anotacao.substring(0, 100)));
    
    return {
      ...(apiDetails && typeof apiDetails === "object" ? apiDetails : {}),
      ok: true,
      anotacao,
      observacao,
      conteudo,
      responsavel,
      responsavel_label: responsavelLabel,
      data_agendamento: dataAgendamento,
      data_agendamento_date: parsedSchedule.date,
      hora_agendamento: parsedSchedule.time,
      status_label: statusLabel,
      classification_type: classificationValue,
      classification_label: classificationLabel,
      classification_options: classificationOptions,
      classification_required: classificationOptions.length > 0 && !classificationValue
    };
  } catch (error) {
    console.error("[getOsDetails] Erro:", error.message, error.detail || "");
    if (apiDetails) {
      return apiDetails;
    }
    throw error;
  }
}

async function getOsDetailsViaApi(config, osId, credentials = null) {
  const osIdStr = String(osId || "").trim();
  if (!osIdStr) return null;

  const resolveSgpAnotacaoFromRow = (row) => String(
    row?.anotacao ||
      row?.os_anotacao ||
      ""
  );

  const row = await fetchServiceOrderById(config, osIdStr, credentials).catch(() => null);
  if (!row) {
    return null;
  }
  return {
    ok: true,
    anotacao: resolveSgpAnotacaoFromRow(row),
    observacao: pickSgpObservationFromRaw(row),
    conteudo: String(row.conteudo || row.descritivo || ""),
    responsavel: String(row.responsavel || ""),
    responsavel_label: String(row.responsavel || row.tecnico_nome || row.tecnico || ""),
    data_agendamento: String(row.data_agendamento || row.os_data_agendamento || row.data_hora_agendamento || ""),
    data_agendamento_date: extractSgpScheduledDateTime(row).date,
    hora_agendamento: extractSgpScheduledDateTime(row).time,
    status_label: String(row.status_descricao || row.status_nome || row.status_label || ""),
    classification_type: "",
    classification_label: "",
    classification_options: [],
    classification_required: false
  };
}

async function updateScheduleViaSgpWebForm(config, osId, entry, credentials = null) {
  const session = await createSgpWebSession(config, credentials);
  const form = await fetchSgpOsEditForm(config, session, osId);
  const html = form.html;
  const forcedPriority = resolvePriorityForScheduledOs(config, entry);
  const forcedStatus = resolveStatusForScheduledOs(config, entry);
  const shouldRequestConfirmation = canRequestCustomerConfirmation(entry);
  const hasDefinedScheduleTime = Boolean(entry?.data && entry?.horario && entry.horario !== "A definir");
  const existingScheduleValue = extractHtmlFieldValue(html, "data_agendamento");
  const smsClientSelection = shouldRequestConfirmation
    ? pickSmsClientSelection(html, entry.telefone)
    : {
        values: [],
        labels: [],
        matchType: "not_requested",
        reason: "Confirmacao nao solicitada para esta OS.",
        requestedPhone: String(entry?.telefone || "").trim(),
        requestedDigits: normalizePhoneDigits(entry?.telefone),
        availableLabels: []
      };
  const gatewaySelection = shouldRequestConfirmation
    ? pickGatewaySelection(
        html,
        String(config.agendamento?.gateway_sms_agendamento_label || "AGENDAMENTO").trim() || "AGENDAMENTO"
      )
    : {
        value: "",
        label: "",
        matchType: "not_requested",
        reason: "Confirmacao nao solicitada para esta OS.",
        availableLabels: []
      };
  const smsClientValues = Array.isArray(smsClientSelection.values) ? smsClientSelection.values : [];
  const gatewayValue = String(gatewaySelection.value || "").trim();
  const responsibleValue = hasMeaningfulTechnician(entry.tecnico)
    ? resolveHtmlSelectValue(html, "responsavel", entry.tecnico)
    : extractHtmlFieldValue(html, "responsavel");
  const baseJustificativa = String(entry.justificativa || entry.observacao || "").trim();
  const incomingObservacao = baseJustificativa
    ? ensureDashboardCreatedByAudit(baseJustificativa, entry.createdBy)
    : "";
  const existingObservacaoFromHtml = extractSgpObservacaoValueFromHtml(html);
  const existingObservacao = existingObservacaoFromHtml ||
    await fetchExistingSgpObservation(config, osId, credentials);
  const mergedObservacao = mergeSgpObservation(existingObservacao, incomingObservacao);
  const classificationValue = String(
    entry?.tipoClassificacoes ||
    extractHtmlFieldValue(html, "tipo_classificacoes") ||
    ""
  ).trim();
  const payload = {
    csrfmiddlewaretoken: extractHtmlFieldValue(html, "csrfmiddlewaretoken"),
    dpb_token: extractHtmlFieldValue(html, "dpb_token"),
    setor: extractHtmlFieldValue(html, "setor") || "1",
    tipoos: extractHtmlFieldValue(html, "tipoos") || "1",
    motivoos: extractHtmlFieldValue(html, "motivoos") || "58",
    tipo_classificacoes: classificationValue,
    prioridade: forcedPriority != null ? String(forcedPriority) : (extractHtmlFieldValue(html, "prioridade") || "2"),
    data_agendamento: hasDefinedScheduleTime
      ? toBrazilDateTime(entry.data, entry.horario)
      : existingScheduleValue,
    data_previsao_finalizacao: extractHtmlFieldValue(html, "data_previsao_finalizacao"),
    data_agendamento_oc: extractHtmlFieldValue(html, "data_agendamento_oc"),
    responsavel: responsibleValue,
    conteudo: extractHtmlFieldValue(html, "conteudo"),
    servicoprestado: extractHtmlFieldValue(html, "servicoprestado"),
    // Observação (SGP) - campo correto é 'observacao'
    observacao: mergedObservacao,
    // Observação interna (SGP) - manter o valor atual
    anotacao: extractHtmlFieldValue(html, "anotacao"),
    anotacao_publica: extractHtmlFieldValue(html, "anotacao_publica"),
    status: forcedStatus != null ? String(forcedStatus) : (extractHtmlFieldValue(html, "status") || "0"),
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

  const gatewayLabel = gatewaySelection.label || "";
  const smsClientLabels = smsClientSelection.labels || [];
  const confirmationDispatchRequested = Boolean(shouldRequestConfirmation && smsClientValues.length && payload.gateway_sms);
  const dispatchBlockedReason = !shouldRequestConfirmation
    ? "Confirmacao nao elegivel: data/técnico ausentes."
    : !payload.gateway_sms
      ? gatewaySelection.reason
      : !smsClientValues.length
        ? smsClientSelection.reason
        : "";

  console.log("[updateScheduleViaSgpWebForm] Payload observacao:", payload.observacao);
  console.log("[CONFIRMATION_DISPATCH_DEBUG] request", JSON.stringify({
    osId: String(osId || "").trim(),
    credentialUser: String(session.username || "").trim() || "desconhecido",
    gatewaySms: String(payload.gateway_sms || "").trim(),
    gatewayLabel,
    gatewayMatchType: gatewaySelection.matchType,
    gatewayReason: gatewaySelection.reason,
    gatewayAvailableLabels: gatewaySelection.availableLabels,
    smsCliente: smsClientValues,
    smsClienteLabels: smsClientLabels,
    smsClienteMatchType: smsClientSelection.matchType,
    smsClienteReason: smsClientSelection.reason,
    smsClienteRequestedPhone: smsClientSelection.requestedPhone,
    smsClienteAvailableLabels: smsClientSelection.availableLabels,
    responsavel: String(payload.responsavel || "").trim(),
    tecnicoSolicitado: String(entry.tecnico || "").trim(),
    hasSmsTecnico: Boolean(payload.sms_tecnico),
    hasEncerraOcorrencia: Boolean(payload.encerra_ocorrencia),
    confirmationDispatchRequested,
    dispatchBlockedReason
  }));
  
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

const checkSessionExpired = (response, htmlText) => {
    const redirect = response.headers.get("location") || "";
    if (redirect.includes("/accounts/login")) {
      return true;
    }
    const finalUrl = response.url || "";
    if (finalUrl.includes("/accounts/login")) {
      return true;
    }
    if (/name=['"]username['"]/i.test(htmlText) && /name=['"]csrfmiddlewaretoken['"]/i.test(htmlText)) {
      return true;
    }
    return false;
  };

  let response;
  let responseText;
  let retryCount = 0;
  const maxRetries = 1;

  while (retryCount <= maxRetries) {
    response = await fetch(form.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": session.cookies,
        Referer: form.url
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(Number(config.dashboard?.timeout_sgp_ms || DEFAULT_TIMEOUT_MS))
    });
    responseText = await response.text();

    if (retryCount < maxRetries && checkSessionExpired(response, responseText)) {
      console.log("[updateScheduleViaSgpWebForm] Sessão expirada, fazendo re-login...");
      const newSession = await refreshSgpWebSession(config, session);
      session.cookies = newSession.cookies;
      retryCount++;
      console.log("[updateScheduleViaSgpWebForm] Retry", retryCount, "de", maxRetries);
      continue;
    }
    break;
  }

  const responseDiagnostics = extractSgpHtmlDiagnostics(responseText);
  const responseSummary = responseDiagnostics.summary;
  const shouldLogExtendedHtml = response.status === 200 && !(response.headers.get("location") || "").trim();

  console.log("[CONFIRMATION_DISPATCH_DEBUG] response", JSON.stringify({
    osId: String(osId || "").trim(),
    status: response.status,
    location: response.headers.get("location") || "",
    finalUrl: response.url || "",
    bodyLength: responseText.length,
    bodySummary: responseSummary,
    ...(shouldLogExtendedHtml ? {
      bodyExcerpt: responseDiagnostics.excerpt,
      htmlAlerts: responseDiagnostics.alertSnippets,
      responsavelSelectedValue: responseDiagnostics.responsibleSelectedValue,
      responsavelSelectedLabel: responseDiagnostics.responsibleSelectedLabel,
      responsavelFieldContext: responseDiagnostics.responsibleFieldContext
    } : {})
  }));

  if (confirmationDispatchRequested && response.status >= 200 && response.status < 400) {
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
      gatewayLabel,
      smsCliente: smsClientValues,
      smsClienteLabels: smsClientLabels,
      dispatchKind,
      resendCount,
      responseStatus: response.status,
      responseLocation: response.headers.get("location") || "",
      responseSummary,
      credentialUser: String(session.username || "").trim() || "",
      gatewayMatchType: gatewaySelection.matchType,
      smsClienteMatchType: smsClientSelection.matchType
    });
  }

  return {
    endpoint: form.url,
    payload,
    status: response.status,
    location: response.headers.get("location") || "",
    htmlAlerts: shouldLogExtendedHtml ? responseDiagnostics.alertSnippets : [],
    responsavelSelectedValue: shouldLogExtendedHtml ? responseDiagnostics.responsibleSelectedValue : "",
    responsavelSelectedLabel: shouldLogExtendedHtml ? responseDiagnostics.responsibleSelectedLabel : "",
    confirmationDispatchRequested,
    dispatchBlockedReason,
    credentialUser: String(session.username || "").trim() || "",
    selection: {
      gateway: gatewaySelection,
      smsCliente: smsClientSelection
    }
  };
}

async function updateScheduleViaSgpApi(config, osId, entry, operatorAuth = null) {
  const normalizedOsId = String(osId || "").trim();
  if (!normalizedOsId) {
    throw new Error("OS nao informada para atualizacao via API do SGP.");
  }

  const forcedPriority = resolvePriorityForScheduledOs(config, entry);
  const forcedStatus = resolveStatusForScheduledOs(config, entry);
  const baseJustificativa = String(entry.justificativa || entry.observacao || "").trim();
  const existingObservation = await fetchExistingSgpObservation(config, normalizedOsId, operatorAuth);
  const observationWithAudit = baseJustificativa
    ? ensureDashboardCreatedByAudit(baseJustificativa, entry.createdBy)
    : "";
  const observacaoForSgp = mergeSgpObservation(existingObservation, observationWithAudit);
  const scheduledDateTime = toScheduledDateTime(entry.data, entry.horario);
  const scheduledDateTimeBr = toBrazilDateTime(entry.data, entry.horario);
  const scheduledDate = isoDateOnly(entry.data);
  const scheduledTime = hhmm(entry.horario);

  const osUpdateEndpoint = `/api/os/update/id/${encodeURIComponent(normalizedOsId)}/`;
  const centralUpdateEndpoint = `/api/central/chamado/update/${encodeURIComponent(normalizedOsId)}/`;
  const expectedDate = scheduledDate;
  const expectedTime = scheduledTime;

		  const buildOsUpdatePayload = (label, dateTimeValue) => {
		    const dataAgendamentoValue = label === "br" && scheduledDateTimeBr ? scheduledDateTimeBr : dateTimeValue;
		    const payload = {
		      // Alguns endpoints aceitam apenas um formato/campo; enviamos variantes para maximizar compatibilidade.
		      os_data_agendamento: dateTimeValue,
		      data_hora_agendamento: dateTimeValue,
		      // No admin web, o campo se chama "data_agendamento" e geralmente espera data+hora.
		      data_agendamento: dataAgendamentoValue,
		      hora_agendamento: scheduledTime ? `${scheduledTime}:00` : "",
		      // Observação (SGP), preservando o histórico existente.
		      ...(observacaoForSgp ? { observacao: observacaoForSgp, os_observacao: observacaoForSgp } : {}),
		      contato_nome: String(entry?.cliente || "").trim(),
		      contato_telefone: String(entry?.telefone || "").trim()
		    };
    if (forcedPriority != null) {
      payload.os_prioridade = forcedPriority;
      payload.prioridade = forcedPriority;
    }
    if (forcedStatus != null) {
      payload.os_status = forcedStatus;
    }
    if (hasMeaningfulTechnician(entry.tecnico)) {
      payload.os_tecnico_responsavel = entry.tecnico;
      payload.responsavel = entry.tecnico;
    }
    return payload;
  };

		  const buildCentralUpdatePayload = (dateTimeValue) => {
    // O endpoint central costuma validar tecnico por ID em algumas instancias.
    // Para evitar "Tecnico nao localizado", nao enviamos campos de tecnico/responsavel aqui.
    // O objetivo principal e persistir data/hora do agendamento.
		    const payload = {
		      os_data_agendamento: dateTimeValue,
		      data_hora_agendamento: dateTimeValue,
		      data_agendamento: scheduledDate,
		      hora_agendamento: scheduledTime ? `${scheduledTime}:00` : "",
		      ...(observacaoForSgp ? { observacao: observacaoForSgp, os_observacao: observacaoForSgp } : {})
		    };
    if (forcedPriority != null) {
      payload.os_prioridade = forcedPriority;
      payload.prioridade = forcedPriority;
    }
    if (forcedStatus != null) {
      payload.os_status = forcedStatus;
    }
    return payload;
  };

  const attempts = [];
  const verifyIfExpected = async () => {
    if (expectedDate && expectedTime) {
      const confirmed = await verifySgpScheduleUpdate(config, normalizedOsId, expectedDate, expectedTime, operatorAuth, entry.tecnico);
      if (
        confirmed.date === expectedDate &&
        confirmed.time === expectedTime &&
        technicianMatchesExpected(entry.tecnico, confirmed.technician)
      ) {
        const observationVerification = await verifySgpObservationUpdate(config, normalizedOsId, observacaoForSgp, operatorAuth);
        if (observationVerification.ok) {
          return {
            ...confirmed,
            observation: observationVerification.observation
          };
        }
      }
    }
    return null;
  };

  const tryCentralJsonUpdate = async (label, dateTimeValue) => {
    const payload = buildCentralUpdatePayload(dateTimeValue);
    try {
      const response = await postJsonToSgp(config, centralUpdateEndpoint, payload, operatorAuth, { includeBasePayload: true });
      attempts.push({ label: `central_json_${label}`, endpoint: centralUpdateEndpoint, payload, response });
    } catch (error) {
      attempts.push({
        label: `central_json_${label}`,
        endpoint: centralUpdateEndpoint,
        payload,
        error: error?.message || String(error)
      });
      return { ok: false, confirmed: null };
    }
    const confirmed = await verifyIfExpected();
    return confirmed ? { ok: true, confirmed } : { ok: false, confirmed: null };
  };

  const tryCentralFormUpdate = async (label, dateTimeValue) => {
    const payload = buildCentralUpdatePayload(dateTimeValue);
    try {
      const response = await postToSgp(config, centralUpdateEndpoint, payload, operatorAuth);
      attempts.push({ label: `central_form_${label}`, endpoint: centralUpdateEndpoint, payload, response });
    } catch (error) {
      attempts.push({
        label: `central_form_${label}`,
        endpoint: centralUpdateEndpoint,
        payload,
        error: error?.message || String(error)
      });
      return { ok: false, confirmed: null };
    }
    const confirmed = await verifyIfExpected();
    return confirmed ? { ok: true, confirmed } : { ok: false, confirmed: null };
  };

  const tryOsUpdateForm = async (label, dateTimeValue) => {
    const payload = buildOsUpdatePayload(label, dateTimeValue);
    const response = await postToSgp(config, osUpdateEndpoint, payload, operatorAuth);
    attempts.push({ label: `os_update_${label}`, endpoint: osUpdateEndpoint, payload, response });
    const confirmed = await verifyIfExpected();
    return confirmed ? { ok: true, confirmed } : { ok: false, confirmed: null };
  };

  // Em alguns SGPs, /api/os/update/id/ responde sucesso mas nao persiste a hora.
  // Quando app/token estiver configurado, tentamos primeiro o endpoint central (JSON).
  if (hasAppTokenAuth(config)) {
    const centralIsoForm = await tryCentralFormUpdate("iso", scheduledDateTime);
    if (centralIsoForm.ok) {
      const last = attempts[attempts.length - 1];
      return {
        endpoint: last.endpoint,
        payload: last.payload,
        response: last.response,
        attempts,
        verified: centralIsoForm.confirmed,
        verifiedBy: last.label
      };
    }

    const centralIsoJson = await tryCentralJsonUpdate("iso", scheduledDateTime);
    if (centralIsoJson.ok) {
      const last = attempts[attempts.length - 1];
      return {
        endpoint: last.endpoint,
        payload: last.payload,
        response: last.response,
        attempts,
        verified: centralIsoJson.confirmed,
        verifiedBy: last.label
      };
    }
  }

  const isoAttempt = await tryOsUpdateForm("iso", scheduledDateTime);
  if (isoAttempt.ok) {
    const lastIso = attempts[attempts.length - 1];
    return {
      endpoint: lastIso.endpoint,
      payload: lastIso.payload,
      response: lastIso.response,
      attempts,
      verified: isoAttempt.confirmed,
      verifiedBy: lastIso.label
    };
  }

  if (scheduledDateTimeBr && scheduledDateTimeBr !== scheduledDateTime) {
    const brAttempt = await tryOsUpdateForm("br", scheduledDateTimeBr);
    if (brAttempt.ok) {
      const lastBr = attempts[attempts.length - 1];
      return {
        endpoint: lastBr.endpoint,
        payload: lastBr.payload,
        response: lastBr.response,
        attempts,
        verified: brAttempt.confirmed,
        verifiedBy: lastBr.label
      };
    }
  }

  const last = attempts[attempts.length - 1] || {
    endpoint: osUpdateEndpoint,
    payload: buildOsUpdatePayload("iso", scheduledDateTime),
    response: null
  };
  return { endpoint: last.endpoint, payload: last.payload, response: last.response, attempts };
}

async function queueConfirmationDispatch(config, item, credentials = null, options = {}) {
  const osId = String(item?.osId || "").trim();
  if (!osId) {
    throw new Error("OS nao informada para envio da confirmacao.");
  }
  const itemId = String(item?.id || "").trim();

  const existingEntry = readConfirmationDispatchEntry(osId) || {};
  const dispatchKind = String(item?.dispatchKind || "").trim() || "inicial";
  const nextResendCount = dispatchKind === "reenvio_2"
    ? 2
    : dispatchKind === "reenvio_1"
      ? Math.max(1, Number(existingEntry.resendCount || 0) || 0)
      : Math.max(0, Number(existingEntry.resendCount || 0) || 0);

  const queuedAt = new Date().toISOString();
  writeConfirmationDispatchEntry(osId, {
    state: "queued",
    queuedAt,
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
  const dispatchCredentials = resolveConfirmationDispatchCredentials(config, credentials);

  const scheduled = enqueueSgpDispatch(config, async () => {
    writeConfirmationDispatchEntry(osId, {
      state: "processing",
      processingAt: new Date().toISOString(),
      errorMessage: "",
      dispatchKind,
      resendCount: nextResendCount
    });

    const tryDispatch = async (currentCredentials, label) => {
      const response = await updateScheduleViaSgpWebForm(config, osId, entry, currentCredentials);
      const mutationError = getSgpMutationError(response);
      if (mutationError) {
        throw new Error(mutationError);
      }
      if (!response?.confirmationDispatchRequested) {
        const manualMessage = String(
          response?.dispatchBlockedReason ||
          "Confirmacao nao solicitada (gateway/sms_cliente ausente no SGP ou criterio nao atendido)."
        ).trim();
        writeConfirmationDispatchEntry(osId, {
          state: "manual",
          manualAt: new Date().toISOString(),
          errorMessage: manualMessage,
          credentialUser: String(response?.credentialUser || "").trim(),
          gatewayMatchType: String(response?.selection?.gateway?.matchType || "").trim(),
          gatewayReason: String(response?.selection?.gateway?.reason || "").trim(),
          gatewayAvailableLabels: response?.selection?.gateway?.availableLabels || [],
          smsClienteMatchType: String(response?.selection?.smsCliente?.matchType || "").trim(),
          smsClienteReason: String(response?.selection?.smsCliente?.reason || "").trim(),
          smsClienteAvailableLabels: response?.selection?.smsCliente?.availableLabels || []
        });
        return {
          ok: false,
          state: "manual",
          id: itemId,
          osId,
          message: manualMessage,
          credentialUser: String(response?.credentialUser || "").trim(),
          selection: response?.selection || null
        };
      }
      writeConfirmationCache(osId, await fetchConfirmationDetailsForOs(config, osId, currentCredentials).catch(() => ({
        confirmationUrl: "",
        confirmationStatus: "aguardando_confirmacao",
        confirmationTitle: "",
        confirmationSent: true,
        confirmationRequestedAt: new Date().toISOString()
      })));
      console.log(`[CONFIRMATION_DISPATCH] OS ${osId} enviada com credenciais ${label}.`);
      return {
        ok: true,
        state: "requested",
        id: itemId,
        osId,
        message: "Confirmacao solicitada ao SGP.",
        credentialUser: String(response?.credentialUser || "").trim(),
        selection: response?.selection || null
      };
    };

    try {
      return await tryDispatch(dispatchCredentials, dispatchCredentials ? "operador" : "robo");
    } catch (error) {
      if (isSgpTwoFactorBlock(error)) {
        writeConfirmationDispatchEntry(osId, {
          state: "manual",
          manualAt: new Date().toISOString(),
          errorMessage: "SGP exigiu 2FA para acessar o formulario web. Envio automatico de confirmacao indisponivel; faca manualmente no SGP."
        });
        return {
          ok: false,
          state: "manual",
          id: itemId,
          osId,
          message: "SGP exigiu 2FA para acessar o formulario web. Envio automatico de confirmacao indisponivel; faca manualmente no SGP."
        };
      }
      const errorMessage = String(error.message || "Falha ao solicitar envio ao SGP.").trim();
      writeConfirmationDispatchEntry(osId, {
        state: "error",
        errorAt: new Date().toISOString(),
        errorMessage
      });
      return {
        ok: false,
        state: "error",
        id: itemId,
        osId,
        message: errorMessage
      };
    }
  });

  if (options?.wait) {
    return scheduled;
  }

  void scheduled;
  return {
    ok: true,
    state: "queued",
    id: itemId,
    osId,
    queuedAt,
    message: "Confirmacao enfileirada para envio via SGP."
  };
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

async function postToSgp(config, endpointPath, payload, operatorAuth = null) {
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
      ...buildSgpAuthHeaders(config, operatorAuth)
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
    data.pops ||
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

  if (Array.isArray(data.htmlAlerts) && data.htmlAlerts.length) {
    const normalizedAlerts = data.htmlAlerts
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (normalizedAlerts.length) {
      const mergedAlerts = [];
      for (const alert of normalizedAlerts) {
        if (!mergedAlerts.length) {
          mergedAlerts.push(alert);
          continue;
        }
        const previous = mergedAlerts[mergedAlerts.length - 1];
        if (previous.endsWith(":")) {
          mergedAlerts[mergedAlerts.length - 1] = `${previous} ${alert}`.trim();
        } else if (!mergedAlerts.includes(alert)) {
          mergedAlerts.push(alert);
        }
      }
      return mergedAlerts.join(" ");
    }
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

async function listServiceOrders(config, { startDate, endDate }, operatorAuth = null) {
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

      const response = await postToSgp(config, endpoint, payload, operatorAuth);
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

function normalizePopName(raw) {
  if (typeof raw === "string" || typeof raw === "number") {
    return String(raw || "").trim();
  }
  if (!raw || typeof raw !== "object") {
    return "";
  }
  return String(
    raw.nome ||
      raw.name ||
      raw.descricao ||
      raw.description ||
      raw.pop ||
      raw.nome_pop ||
      raw.pop_nome ||
      raw.contrato_pop_nome ||
      raw.fantasia ||
      raw.razao ||
      raw.label ||
      ""
  ).trim();
}

function parseBooleanish(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) {
    return null;
  }
  if (["1", "true", "sim", "s", "yes", "y", "ativo", "ativa", "active", "habilitado", "habilitada"].includes(text)) {
    return true;
  }
  if (["0", "false", "nao", "não", "n", "no", "inativo", "inativa", "inactive", "desativado", "desativada", "desabilitado", "desabilitada"].includes(text)) {
    return false;
  }
  return null;
}

function isPopActive(raw) {
  if (!raw || typeof raw !== "object") {
    return true;
  }

  const inactiveValue = parseBooleanish(raw.inativo ?? raw.inactive ?? raw.desativado ?? raw.disabled);
  if (inactiveValue === true) {
    return false;
  }

  const activeValue = parseBooleanish(raw.ativo ?? raw.active ?? raw.is_active ?? raw.habilitado ?? raw.enabled);
  if (activeValue !== null) {
    return activeValue;
  }

  const statusValue = parseBooleanish(raw.status_pop ?? raw.pop_status ?? raw.status_nome ?? raw.status_label ?? raw.situacao_nome ?? raw.situacao);
  if (statusValue !== null) {
    return statusValue;
  }

  return true;
}

async function listSgpPops(config, operatorAuth = null) {
  const endpoint = String(config.agendamento?.endpoint_pops || "/api/ura/pops/").trim();
  if (!endpoint) {
    return [];
  }

  const cacheKey = `${buildSgpCacheIdentity(config, operatorAuth)}::${endpoint}`;
  const ttlMs = resolveSgpPopsCacheTtlMs(config);
  const cached = readSgpPopsCache(cacheKey, ttlMs);
  if (cached) {
    return cached;
  }

  const response = await postToSgp(config, endpoint, {}, operatorAuth);
  const rows = extractListFromResponse(response);
  if (!Array.isArray(rows)) {
    throw new Error("Formato inesperado na lista de POPs.");
  }

  const normalized = dedupeBy(
    rows
      .filter(isPopActive)
      .map(normalizePopName)
      .filter(Boolean),
    (value) => value
  ).sort((a, b) => a.localeCompare(b));
  writeSgpPopsCache(cacheKey, normalized);
  return normalized;
}

async function fetchServiceOrderById(config, osId, operatorAuth = null) {
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
      const response = await postToSgp(config, endpoint, payload, operatorAuth);
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

function pickSgpScheduleDebugFields(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const keys = [
    "id",
    "os_id",
    "contrato",
    "status",
    "status_id",
    "tipo",
    "tipo_id",
    "data_agendamento",
    "hora_agendamento",
    "data_hora_agendamento",
    "os_data_agendamento",
    "data_agendada",
    "hora_agendada",
    "prioridade",
    "os_prioridade",
    "prioridade_id",
    "prioridade_nome",
    "prioridade_descricao",
    "data_cadastro",
    "hora_cadastro",
    "data",
    "hora",
    "observacao",
    "os_observacao",
    "anotacao",
    "os_anotacao",
    "responsavel",
    "tecnico",
    "tecnico_nome",
    "finalizado_por"
  ];
  const output = {};
  for (const key of keys) {
    const value = row[key];
    if (value === undefined || value === null || value === "") continue;
    output[key] = value;
  }
  return output;
}

function extractSgpPriorityState(raw) {
  const valueCandidates = [
    raw?.prioridade,
    raw?.os_prioridade,
    raw?.prioridade_id
  ];
  const labelCandidates = [
    raw?.prioridade_descricao,
    raw?.prioridade_nome,
    raw?.prioridade_label
  ];

  let value = "";
  for (const candidate of valueCandidates) {
    const text = String(candidate ?? "").trim();
    if (text) {
      value = text;
      break;
    }
  }

  let label = "";
  for (const candidate of labelCandidates) {
    const text = String(candidate ?? "").trim();
    if (text) {
      label = text;
      break;
    }
  }

  return { value, label };
}

function priorityMatchesExpected(expectedPriority, confirmedPriority) {
  if (expectedPriority === null || expectedPriority === undefined || expectedPriority === "") {
    return true;
  }
  const expectedText = String(expectedPriority).trim();
  const confirmedValue = String(confirmedPriority?.value || "").trim();
  const confirmedLabel = normalizeComparableText(confirmedPriority?.label || "");

  if (confirmedValue && confirmedValue === expectedText) {
    return true;
  }
  if (expectedText === "3" && confirmedLabel.includes("alta")) {
    return true;
  }
  return false;
}

async function readSgpPriorityState(config, osId, operatorAuth = null) {
  const row = await fetchServiceOrderById(config, osId, operatorAuth).catch(() => null);
  const fromApi = extractSgpPriorityState(row);
  if (fromApi.value || fromApi.label) {
    return fromApi;
  }

  try {
    const session = await createSgpWebSession(config, operatorAuth);
    const form = await fetchSgpOsEditForm(config, session, osId);
    return {
      value: String(extractHtmlFieldValue(form.html, "prioridade") || "").trim(),
      label: String(extractHtmlSelectSelectedLabel(form.html, "prioridade") || "").trim()
    };
  } catch {
    return { value: "", label: "" };
  }
}

async function verifySgpScheduleUpdate(config, osId, expectedDate, expectedTime, operatorAuth = null, expectedTechnician = "") {
  const waits = [600, 2200, 5200, 9200];
  let last = { date: "", time: "", technician: "" };
  for (const waitMs of waits) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const row = await fetchServiceOrderById(config, osId, operatorAuth).catch(() => null);
    last = {
      ...extractSgpScheduledDateTime(row),
      technician: normalizeTechnician(row || {})
    };
    if (
      last.date === expectedDate &&
      last.time === expectedTime &&
      technicianMatchesExpected(expectedTechnician, last.technician)
    ) {
      return last;
    }
  }
  return last;
}

async function verifySgpPriorityUpdate(config, osId, expectedPriority, operatorAuth = null) {
  if (expectedPriority === null || expectedPriority === undefined || expectedPriority === "") {
    return {
      ok: true,
      priority: { value: "", label: "" }
    };
  }

  const waits = [600, 2200, 5200, 9200];
  let last = { value: "", label: "" };
  for (const waitMs of waits) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    last = await readSgpPriorityState(config, osId, operatorAuth);
    if (priorityMatchesExpected(expectedPriority, last)) {
      return {
        ok: true,
        priority: last
      };
    }
  }

  return {
    ok: false,
    priority: last
  };
}

async function verifySgpObservationUpdate(config, osId, expectedObservation, operatorAuth = null) {
  const waits = [600, 2200, 5200, 9200];
  let lastObservation = "";
  for (const waitMs of waits) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastObservation = await fetchExistingSgpObservation(config, osId, operatorAuth).catch(() => "");
    if (observationContainsExpected(lastObservation, expectedObservation)) {
      return {
        ok: true,
        observation: lastObservation
      };
    }
  }
  return {
    ok: false,
    observation: lastObservation
  };
}

async function lookupContract(config, contractId, operatorAuth = null) {
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
      ...buildSgpAuthHeaders(config, operatorAuth)
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
  invalidateDashboardDataCache();
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
  invalidateDashboardDataCache();
  return updated;
}

function deleteManualSchedule(entryId) {
  const rows = readManualSchedules();
  const nextRows = rows.filter((item) => String(item.id || "") !== String(entryId || ""));
  if (nextRows.length === rows.length) {
    return false;
  }
  writeJson(MANUAL_SCHEDULES_PATH, nextRows);
  invalidateDashboardDataCache();
  return true;
}

function removeManualSchedulesByMatcher(matcher) {
  const rows = readManualSchedules();
  const nextRows = rows.filter((item) => !matcher(item));
  if (nextRows.length === rows.length) {
    return 0;
  }
  writeJson(MANUAL_SCHEDULES_PATH, nextRows);
  invalidateDashboardDataCache();
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
  const normalized = normalizeOsType(raw);
  return normalized === "EXTERNA" || normalized.includes("EXTERNA");
}

function normalizeContractId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D+/g, "");
  return digits || raw;
}

function isOpenServiceOrder(raw, allowedStatusIds = null) {
  if (allowedStatusIds && typeof allowedStatusIds === "object") {
    const idCandidate = raw?.status_id ?? raw?.statusId ?? raw?.status ?? raw?.situacao ?? "";
    const idText = String(idCandidate ?? "").trim();
    return Boolean(idText && /^\d+$/.test(idText) && allowedStatusIds.has(idText));
  }

  const statusText = String(
    raw?.status_descricao ||
      raw?.status_nome ||
      raw?.status_label ||
      raw?.status ||
      raw?.situacao ||
      ""
  )
    .trim()
    .toLowerCase();

  if (!statusText) return false;
  if (isClosedStatusText(statusText)) return false;
  return isOpenStatusText(statusText);
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

function pickServiceOrderId(raw) {
  return String(
    raw?.os_id ||
    raw?.id ||
    raw?.cod_os ||
    raw?.codigo ||
    ""
  ).trim();
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

function pickSgpObservationFromRaw(raw) {
  return String(
    raw?.observacao ||
      raw?.os_observacao ||
      raw?.observacao_os ||
      raw?.observacao_sgp ||
      raw?.anotacao ||
      raw?.os_anotacao ||
      ""
  ).trim();
}

async function fetchExistingSgpObservation(config, osId, credentials = null) {
  const normalizedOsId = String(osId || "").trim();
  if (!normalizedOsId) {
    return "";
  }

  const row = await fetchServiceOrderById(config, normalizedOsId, credentials).catch(() => null);
  const apiObservation = pickSgpObservationFromRaw(row);
  if (apiObservation) {
    return apiObservation;
  }

  try {
    const session = await createSgpWebSession(config, credentials);
    const form = await fetchSgpOsEditForm(config, session, normalizedOsId);
    return extractSgpObservacaoValueFromHtml(form.html);
  } catch (error) {
    return "";
  }
}

function normalizeSchedule(config, raw, source = "sgp") {
  const scheduleDateTime = extractSgpScheduledDateTime(raw);
  const date = scheduleDateTime.date;
  const time = scheduleDateTime.time;
  const status = normalizeStatus(raw);
  const motivo = normalizeMotivo(raw);
  const sgpStatus = source === "sgp" ? normalizeSgpStatus(raw) : "";
  const extractedObs = extractDashboardCreatedBy(pickSgpObservationFromRaw(raw));

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
    confirmationResolved: Boolean(raw.confirmationResolved),
    endereco: raw.endereco || raw.logradouro || "",
    motivo,
    sgpStatus,
    observacao: extractedObs.text,
    createdBy: extractedObs.createdBy,
    origem: source,
    raw
  };
}

function mergeSgpDetailsIntoScheduleItem(item, details) {
  if (!item || !details || typeof details !== "object") {
    return item;
  }

  const nextTechnician = String(
    details.responsavel_label ||
    details.responsavel ||
    item.tecnico ||
    ""
  ).trim();
  const nextDate = isoDateOnly(
    details.data_agendamento_date ||
    details.data_agendamento ||
    item.data
  );
  const nextTime = normalizeSlot(details.hora_agendamento || item.horario);
  const nextObservation = String(details.observacao || item.observacao || "").trim();

  item.tecnico = nextTechnician || item.tecnico;
  item.data = nextDate || item.data;
  item.horario = nextTime || item.horario;
  item.hasScheduledDate = Boolean(item.data);
  if (nextObservation) {
    const extractedObs = extractDashboardCreatedBy(nextObservation);
    item.observacao = extractedObs.text;
    if (extractedObs.createdBy) {
      item.createdBy = extractedObs.createdBy;
    }
  }
  item.status = item.data && hasMeaningfulTechnician(item.tecnico)
    ? (item.horario && item.horario !== "A definir" ? "agendado" : "itinerario")
    : "pre_agendado";
  return item;
}

async function enrichSchedulesWithSgpDetails(config, schedules, credentials = null) {
  const pending = (Array.isArray(schedules) ? schedules : []).filter((item) => {
    if (item?.origem !== "sgp" || !String(item.osId || "").trim()) {
      return false;
    }
    const missingDate = !isoDateOnly(item.data);
    const missingTime = !hhmm(item.horario) || item.horario === "A definir";
    const missingTechnician = !hasMeaningfulTechnician(item.tecnico);
    return missingDate || missingTime || missingTechnician;
  });

  if (!pending.length) {
    return schedules;
  }

  const concurrency = 2;
  await runWithConcurrencyLimit(
    pending,
    concurrency,
    async (item) => {
      const details = await getOsDetails(config, item.osId, credentials).catch(() => null);
      if (details?.ok) {
        mergeSgpDetailsIntoScheduleItem(item, details);
      }
    }
  );

  return schedules;
}

function extractSgpScheduledDateTime(raw) {
  const dateOnlyCandidates = [
    raw?.data_agendamento,
    raw?.data_agendada,
    raw?.data_marcada,
    raw?.data
  ];
  const timeOnlyCandidates = [
    raw?.hora_agendamento,
    raw?.hora_agendada,
    raw?.hora_marcada,
    raw?.hora,
    raw?.horaAgendamento
  ];
  const dateTimeCandidates = [
    raw?.data_hora_agendamento,
    raw?.dataHoraAgendamento,
    raw?.os_data_agendamento,
    raw?.data_agendamento,
    raw?.data_agendada
  ];

  const parseDateOnly = (value) => {
    const text = String(value || "").trim();
    if (!text) return "";
    const isoMatch = text.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) return isoMatch[1];
    const brMatch = text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (brMatch) return `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}`;
    return isoDateOnly(text);
  };

  const parseDateTime = (value) => {
    const text = String(value || "").trim();
    if (!text) return { date: "", time: "" };
    // "YYYY-MM-DD HH:MM(:SS)?" or "YYYY-MM-DDTHH:MM(:SS)?"
    const match = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?/);
    if (match) return { date: match[1], time: match[2] };
    // "DD/MM/YYYY HH:MM(:SS)?"
    const brMatch = text.match(/^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}:\d{2})(?::\d{2})?/);
    if (brMatch) return { date: `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}`, time: brMatch[4] };
    return { date: parseDateOnly(text), time: "" };
  };

  let date = "";
  for (const candidate of dateOnlyCandidates) {
    const parsed = parseDateOnly(candidate);
    if (parsed) {
      date = parsed;
      break;
    }
  }

  let time = "";
  for (const candidate of timeOnlyCandidates) {
    const parsedTime = hhmm(candidate);
    if (parsedTime) {
      time = parsedTime;
      break;
    }
  }

  // Preferir campos separados (data_agendamento + hora_agendamento). Muitos retornos trazem
  // "os_data_agendamento" com horario de criacao/atualizacao, nao necessariamente o horario do agendamento.
  if (date && time) {
    return { date, time };
  }

  for (const candidate of dateTimeCandidates) {
    const parsed = parseDateTime(candidate);
    if (!date && parsed.date) {
      date = parsed.date;
    }
    if (!time && parsed.time) {
      time = parsed.time;
    }
    if (date && time) {
      return { date, time };
    }
  }

  return { date: date || "", time: time || "" };
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
  const extractedObs = extractDashboardCreatedBy(entry.justificativa || entry.observacao || "");
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
    confirmationResolved: Boolean(entry.confirmationResolved),
    endereco: entry.endereco || "",
    motivo: String(entry.motivo || "").trim(),
    sgpStatus: "",
    observacao: extractedObs.text,
    createdBy: sanitizeDashboardUserLabel(entry.created_by || entry.createdBy || extractedObs.createdBy),
    duplicatePeriod: Boolean(entry.duplicatePeriod),
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
  const normalizedSelectedPops = new Set(
    (Array.isArray(pops) ? pops : [])
      .map((value) => normalizePopKey(value))
      .filter(Boolean)
  );

  return schedules.filter((item) => {
    const confirmationStatus = String(item.confirmationStatus || "").trim();
    const route = normalizePopKey(item.rota);

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
    if (normalizedSelectedPops.size && !normalizedSelectedPops.has(route)) {
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
    confirmationResolved: Boolean(item.confirmationResolved),
    endereco: item.endereco,
    motivo: item.motivo || "",
    sgpStatus: item.sgpStatus || "",
    observacao: item.observacao,
    createdBy: item.createdBy || "",
    duplicatePeriod: Boolean(item.duplicatePeriod),
    origem: item.origem
  };
}

async function enrichSchedulesWithConfirmation(config, schedules, credentials = null) {
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

  if (isSgpWebTemporarilyBlocked(config, credentials)) {
    return schedules;
  }

  let session;
  try {
    session = await createSgpWebSession(config, credentials);
  } catch (error) {
    if (isSgpTwoFactorBlock(error)) {
      markSgpWebTemporarilyBlocked(config, "2FA_required", String(error.detail || error.message || ""), credentials);
      return schedules;
    }
    return schedules;
  }

  const concurrency = Math.max(1, Math.min(3, Number(config.dashboard?.confirmation_fetch_concurrency || 1)));
  let stop = false;
  await runWithConcurrencyLimit(
    pending,
    concurrency,
    async (item) => {
      if (stop) {
        return;
      }
      try {
        const details = await fetchConfirmationDetailsForOsWithSession(config, session, item.osId);
        item.confirmationUrl = details.confirmationUrl || "";
        item.confirmationStatus = details.confirmationStatus || "sem_confirmacao";
        item.confirmationTitle = details.confirmationTitle || "";
        item.confirmationSent = Boolean(details.confirmationSent);
        item.confirmationRequestedAt = details.confirmationRequestedAt || "";
        writeConfirmationCache(item.osId, details);
      } catch (error) {
        if (isSgpTwoFactorBlock(error)) {
          stop = true;
          markSgpWebTemporarilyBlocked(config, "2FA_required", String(error.detail || error.message || ""), credentials);
        }
        const cached = readConfirmationCache(item.osId);
        item.confirmationUrl = cached?.confirmationUrl || "";
        item.confirmationStatus = cached?.confirmationStatus || "sem_confirmacao";
        item.confirmationTitle = cached?.confirmationTitle || "";
        item.confirmationSent = Boolean(cached?.confirmationSent);
        item.confirmationRequestedAt = cached?.confirmationRequestedAt || "";
      }
    },
    () => stop
  );

  return schedules;
}

async function buildDashboardBaseData(config, { startDate, endDate, selectedDate }, operatorAuth = null) {
  const sgpAuth = resolveSgpInteractionAuth(config, operatorAuth);
  const openStatusIds = new Set(
    (Array.isArray(config.agendamento?.statuses_consulta) && config.agendamento.statuses_consulta.length
      ? config.agendamento.statuses_consulta
      : DEFAULT_STATUSES
    ).map((value) => String(value))
  );
  const slots = Array.isArray(config.dashboard.horarios_padrao) && config.dashboard.horarios_padrao.length
    ? config.dashboard.horarios_padrao
    : DEFAULT_SLOTS;
  let sourceMode = "sgp";
  let notices = [];
  let schedules = [];

  try {
	    const sgpRows = await listServiceOrders(config, { startDate, endDate }, sgpAuth);
	    schedules = sgpRows
	      .filter((item) => isExternalServiceOrder(item))
	      .filter((item) => isOpenServiceOrder(item, openStatusIds))
	      .map((item) => normalizeSchedule(config, item, "sgp"));
	    schedules = await enrichSchedulesWithSgpDetails(config, schedules, sgpAuth);
	    schedules = schedules.filter((item) => item.data);
      applyCachedConfirmationToSchedules(schedules);
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

  applyScheduleFlags(schedules);

  schedules = schedules.filter((item) => item.hasScheduledDate && item.data >= startDate && item.data <= endDate);
  schedules.sort((a, b) => `${a.data} ${a.horario}`.localeCompare(`${b.data} ${b.horario}`));

  const serializedSchedules = schedules.map(serializeSchedule);
  const summary = summarizeSchedules(serializedSchedules);
  const grid = buildGrid(serializedSchedules, startDate, slots);
  const scheduleRoutes = Array.from(new Set(serializedSchedules.map((item) => String(item.rota || "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const sgpPops = await listSgpPops(config, operatorAuth).catch(() => null);
  const availableRoutes = Array.from(new Set((Array.isArray(sgpPops) ? sgpPops : scheduleRoutes))).sort((a, b) => a.localeCompare(b));

  return {
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
      search: "",
      status: "todos",
      pops: []
    },
    availableRoutes,
    grid,
    schedules: serializedSchedules
  };
}

async function getDashboardData(query, authUser = null) {
  const config = loadConfig();
  const operatorAuth = authUser ? getSgpAuthFromUserPayload(authUser) : null;
  const today = toLocalIsoDate(new Date());
  const selectedDate = isoDateOnly(query.get("data")) || today;
  const startDate = isoDateOnly(query.get("inicio")) || plusDays(selectedDate, -Number(config.dashboard.janela_dias_passado || 7));
  const endDate = isoDateOnly(query.get("fim")) || plusDays(selectedDate, Number(config.dashboard.janela_dias_futuro || 14));
  const authIdentity = buildSgpCacheIdentity(config, operatorAuth);
  const cacheKey = buildDashboardCacheKey({ startDate, endDate, selectedDate, authIdentity });
  const ttlMs = resolveDashboardCacheTtlMs(config);
  const baseData = await getOrCreateDashboardCache(
    cacheKey,
    ttlMs,
    () => buildDashboardBaseData(config, { startDate, endDate, selectedDate }, operatorAuth)
  );

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    dashboardVersion: DASHBOARD_VERSION,
    autoRefreshSeconds: Number(config.dashboard.atualizacao_segundos || 300),
    ...baseData,
    isAdmin: Boolean(authUser?.isAdmin),
    isOperator: Boolean(authUser?.isOperator)
  };
}

function toScheduledDateTime(date, time) {
  if (!date || !time || time === "A definir") {
    return "";
  }
  return `${date} ${time.slice(0, 5)}:00`;
}

function isScheduleDateTimeInPast(date, time, now = new Date()) {
  const isoDate = isoDateOnly(date);
  const hhmmValue = hhmm(time);
  if (!isoDate || !hhmmValue) {
    return false;
  }
  const scheduled = new Date(`${isoDate}T${hhmmValue}:00`);
  if (!Number.isFinite(scheduled.getTime())) {
    return false;
  }
  // Tolerância pequena para evitar flutuações de relógio/rede.
  return scheduled.getTime() < (now.getTime() - 60_000);
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
  if (!entry?.data || !entry?.horario || entry.horario === "A definir") {
    return null;
  }
  if (!hasMeaningfulTechnician(entry.tecnico)) {
    return null;
  }
  const desired = Number(config.agendamento?.prioridade_os_ao_agendar);
  if (Number.isFinite(desired) && desired > 0) {
    return desired;
  }
  // No SGP desta integracao, prioridade 3 corresponde a ALTA.
  return 3;
}

function resolveStatusForScheduledOs(config, entry) {
  const desired = Number(config.agendamento?.status_os_ao_agendar);
  if (!Number.isFinite(desired) || desired < 0) {
    return null;
  }
  if (!entry?.data || !entry?.horario || entry.horario === "A definir") {
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
  const forcedStatus = resolveStatusForScheduledOs(config, entry);
  const payload = {
    contrato: entry.contrato,
    conteudo: content,
    // Observação importante (SGP)
    observacao: entry.justificativa || entry.observacao || "",
    ocorrenciatipo: Number(config.agendamento?.ocorrencia_tipo_padrao || 5),
    motivoos: Number(config.agendamento?.motivo_os_padrao || 1),
    setor: Number(config.agendamento?.setor_padrao || 1),
    os_prioridade: forcedPriority ?? Number(config.agendamento?.prioridade_os_padrao || 2),
    contato_nome: entry.cliente,
    contato_telefone: entry.telefone || "",
    data_hora_agendamento: toScheduledDateTime(entry.data, entry.horario),
    // Algumas instancias do SGP usam este campo para persistir a data/hora do agendamento.
    os_data_agendamento: toScheduledDateTime(entry.data, entry.horario)
  };
  if (forcedStatus != null) {
    payload.os_status = forcedStatus;
  }

  if (entry.tecnico) {
    payload.responsavel = entry.tecnico;
  }

  return payload;
}

async function postJsonToSgp(config, endpointPath, payload, operatorAuth = null, options = {}) {
  const baseUrl = String(config.url_base || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("url_base nao configurada.");
  }

  const url = `${baseUrl}${endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`}`;
  const includeBasePayload = Boolean(options?.includeBasePayload);
  const finalPayload = includeBasePayload ? { ...buildBasePayload(config), ...(payload || {}) } : payload;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildSgpAuthHeaders(config, operatorAuth)
    },
    body: JSON.stringify(finalPayload),
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

async function closeSgpSchedule(config, osId, operatorAuth = null) {
  if (hasAppTokenAuth(config)) {
    const endpoint = `/api/central/chamado/update/${encodeURIComponent(String(osId || "").trim())}/`;
    return {
      mode: "central_chamado_update",
      response: await postToSgp(config, endpoint, {
        os_status: 1,
        ocorrencia_encerrar: 1,
        os_data_agendamento: "",
        notificar_cliente: ""
      }, operatorAuth)
    };
  }

  const endpoint = `/api/os/update/id/${encodeURIComponent(String(osId || "").trim())}/`;
  return {
    mode: "os_update_only",
    response: await postToSgp(config, endpoint, {
      os_status: 1,
      os_data_finalizacao: currentDateTimeForSgp()
    }, operatorAuth)
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

async function createBlockedSlot(payload, authUser = null) {
  const config = loadConfig();
  const operatorAuth = authUser ? getSgpAuthFromUserPayload(authUser) : null;
  const sgpAuth = resolveSgpInteractionAuth(config, operatorAuth);
  if (!canUseSgpInteractionAuth(config, operatorAuth)) {
    return {
      statusCode: 401,
      body: { ok: false, message: "Sessao do SGP expirada. Faca login novamente." }
    };
  }
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
    const conflictCheck = await findPopSlotConflicts(
      config,
      { rota: entry.rota, data: entry.data, horario: timeKey },
      { includeBlocks: false, operatorAuth: sgpAuth }
    );
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
  { ignoreId = "", ignoreOsId = "", ignoreProtocolo = "", includeBlocks = true, includeSchedules = true, operatorAuth = null } = {}
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
	      const openStatusIds = new Set(
	        (Array.isArray(config.agendamento?.statuses_consulta) && config.agendamento.statuses_consulta.length
	          ? config.agendamento.statuses_consulta
	          : DEFAULT_STATUSES
	        ).map((value) => String(value))
	      );
	      const sgpRows = await listServiceOrders(config, { startDate: dateKey, endDate: dateKey }, operatorAuth);
	      checkedSgp = true;
	      schedules.push(
	        ...sgpRows
	          .filter((item) => isExternalServiceOrder(item))
	          .filter((item) => isOpenServiceOrder(item, openStatusIds))
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

async function createSchedule(payload, authUser = null) {
  const config = loadConfig();
  const operatorAuth = authUser ? getSgpAuthFromUserPayload(authUser) : null;
  const sgpAuth = resolveSgpInteractionAuth(config, operatorAuth);
  if (!canUseSgpInteractionAuth(config, operatorAuth)) {
    return {
      statusCode: 401,
      body: {
        ok: false,
        message: "Sessao do SGP expirada. Faca login novamente."
      }
    };
  }
  const duplicatePeriod = truthyFlag(payload?.duplicatePeriod);
  const createdBy = sanitizeDashboardUserLabel(authUser?.sub || "");
  const payloadCreatedBy = sanitizeDashboardUserLabel(payload?.createdBy || "");
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
    justificativa: String(payload.justificativa || payload.observacao || "").trim(),
    duplicatePeriod,
    createdBy: createdBy || payloadCreatedBy
  };

  const endpoint = String(config.agendamento?.endpoint_agendar || "").trim();
  if (endpoint && !String(payload?.osId || "").trim()) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        code: "OS_REQUIRED",
        message: "Selecione uma OS aberta para agendar. Se nao houver OS aberta, verifique no SGP."
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

  if (isScheduleDateTimeInPast(entry.data, entry.horario)) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        code: "SCHEDULE_IN_PAST",
        message: `Horario selecionado ja passou: ${entry.data} ${hhmm(entry.horario)}. Escolha um horario futuro.`
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

  if (endpoint) {
    try {
      const entryForSgp = {
        ...entry,
        justificativa: ensureDashboardCreatedByAudit(entry.justificativa, entry.createdBy)
      };
      const response = await postJsonToSgp(config, endpoint, buildCreateCallPayload(config, entryForSgp), sgpAuth);
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

      if (entry.duplicatePeriod) {
        setDuplicatePeriodFlag({ osId: createdOsId, protocolo: entry.protocolo });
      }
      if (entry.createdBy) {
        setCreatedByFlag({ osId: createdOsId, protocolo: entry.protocolo, createdBy: entry.createdBy });
      }

      if (createdOsId) {
        try {
          await updateScheduleViaSgpApi(config, createdOsId, entryForSgp, sgpAuth);
        } catch (error) {
          return {
            statusCode: 502,
            body: {
              ok: false,
              mode: "sgp",
              message: `OS criada no SGP (OS ${createdOsId}), mas falhou ao definir data/hora do agendamento: ${error.message}`,
              response: created
            }
          };
        }

        try {
          confirmationDetails = await fetchConfirmationDetailsForOs(config, createdOsId, sgpAuth);
        } catch (error) {
          confirmationDetails = {
            confirmationUrl: "",
            confirmationStatus: "sem_confirmacao",
            confirmationTitle: "",
            confirmationRequestedAt: "",
            confirmationSent: false
          };
        }

        const confirmationCredentials = resolveConfirmationDispatchCredentials(config, sgpAuth);
        const canUseConfirmationCredentials = confirmationCredentials
          ? Boolean(String(confirmationCredentials.username || "").trim() && String(confirmationCredentials.password || "").trim())
          : Boolean(String(config.basic_auth?.username || "").trim() && String(config.basic_auth?.password || "").trim());

        if (canRequestCustomerConfirmation(entry) && canUseConfirmationCredentials) {
	          try {
	            await queueConfirmationDispatch(config, {
	              id: createdOsId,
	              osId: createdOsId,
	              origem: "sgp",
	              ...entry
	            }, sgpAuth);
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
    created_at: new Date().toISOString(),
    created_by: entry.createdBy
  });
  if (entry.duplicatePeriod) {
    setDuplicatePeriodFlag({ id: saved.id, protocolo: entry.protocolo });
  }
  if (entry.createdBy) {
    setCreatedByFlag({ id: saved.id, protocolo: entry.protocolo, createdBy: entry.createdBy });
  }

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

async function updateSchedule(payload, authUser = null) {
  const config = loadConfig();
  const operatorAuth = authUser ? getSgpAuthFromUserPayload(authUser) : null;
  const sgpAuth = resolveSgpInteractionAuth(config, operatorAuth);
  if (!canUseSgpInteractionAuth(config, operatorAuth)) {
    return {
      statusCode: 401,
      body: {
        ok: false,
        message: "Sessao do SGP expirada. Faca login novamente."
      }
    };
  }
  const id = String(payload.id || "").trim();
  const origem = String(payload.origem || "").trim();
  const osId = String(payload.osId || "").trim();
  const payloadCreatedBy = sanitizeDashboardUserLabel(payload?.createdBy || "");
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
    justificativa: String(payload.justificativa || payload.observacao || "").trim(),
    createdBy: payloadCreatedBy,
    tipoClassificacoes: String(payload.tipo_classificacoes || "").trim()
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

  if (isScheduleDateTimeInPast(entry.data, entry.horario)) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        code: "SCHEDULE_IN_PAST",
        message: `Horario selecionado ja passou: ${entry.data} ${hhmm(entry.horario)}. Escolha um horario futuro.`
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
    const manualEntry = { ...entry };
    if (payloadCreatedBy) {
      manualEntry.created_by = payloadCreatedBy;
    }
    delete manualEntry.createdBy;
    const updated = updateManualSchedule(id, manualEntry);
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

    const serviceOrder = await fetchServiceOrderById(config, osId, sgpAuth).catch(() => null);
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

    if (!hasRobotSgpCredentials(config) && !String(operatorAuth?.username || "").trim()) {
      return {
        statusCode: 501,
        body: {
          ok: false,
          message: "Sessao do SGP indisponivel para editar OS pela interface web. Faca login novamente."
        }
      };
    }

    const endpoint = `/admin/atendimento/ocorrencia/os/${encodeURIComponent(osId)}/edit/`;
    const forcedPriority = resolvePriorityForScheduledOs(config, entry);
    const forcedStatus = resolveStatusForScheduledOs(config, entry);
    const requestObservation = String(entry.justificativa || entry.observacao || "").trim();
    const sgpPayload = {
      data_agendamento: toBrazilDateTime(entry.data, entry.horario),
      ...(forcedPriority != null ? { prioridade: forcedPriority } : {}),
      ...(forcedStatus != null ? { status: forcedStatus } : {}),
      ...(requestObservation ? { observacao: requestObservation } : {}),
      responsavel: hasMeaningfulTechnician(entry.tecnico) ? entry.tecnico : ""
    };

    logSgpScheduleUpdate("request", { osId, endpoint, payload: sgpPayload });

    let response;
    try {
      response = await enqueueSgpDispatch(config, async () => {
        try {
          return await updateScheduleViaSgpWebForm(config, osId, entry, sgpAuth);
        } catch (error) {
          if (!isSgpTwoFactorBlock(error)) {
            throw error;
          }
          logSgpScheduleUpdate("fallback_api", {
            osId,
            endpoint: `/api/os/update/id/${encodeURIComponent(String(osId || "").trim())}/`,
            reason: "2FA_required_on_web"
          });
          const api = await updateScheduleViaSgpApi(config, osId, entry, sgpAuth);
          return {
            mode: "api",
            ...api
          };
        }
      });
    } catch (error) {
      logSgpScheduleUpdate("error", {
        osId,
        endpoint,
        payload: sgpPayload,
        error: error.message,
        ...(error?.detail ? { detail: String(error.detail) } : {})
      });
      throw error;
    }

    logSgpScheduleUpdate("response", {
      osId,
      endpoint: response.endpoint || endpoint,
      payload: response.payload || sgpPayload,
      response
    });

    const mutationError = response?.mode === "api" ? getSgpMutationError(response.response) : getSgpMutationError(response);
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

    const expectedDate = isoDateOnly(entry.data);
    const expectedTime = hhmm(entry.horario);
    const expectedPriority = forcedPriority != null ? String(forcedPriority) : "";
    const expectedObservation = normalizeMultilineText(
      response?.payload?.observacao ||
      response?.payload?.os_observacao ||
      ""
    );
    const confirmed = response?.mode === "api" && response?.verified?.date && response?.verified?.time
      ? response.verified
      : await verifySgpScheduleUpdate(config, osId, expectedDate, expectedTime, sgpAuth, entry.tecnico);
    const confirmedDate = confirmed.date;
    const confirmedTime = confirmed.time;
    const observationVerification = expectedObservation
      ? (
          response?.mode === "api" && response?.verified?.observation
            ? {
                ok: observationContainsExpected(response.verified.observation, expectedObservation),
                observation: response.verified.observation
              }
            : await verifySgpObservationUpdate(config, osId, expectedObservation, sgpAuth)
        )
      : { ok: true, observation: "" };
    const priorityVerification = await verifySgpPriorityUpdate(config, osId, expectedPriority, sgpAuth);

    logSgpScheduleUpdate("verification", {
      osId,
      expected: {
        data_agendamento: expectedDate,
        hora_agendamento: expectedTime,
        tecnico: entry.tecnico,
        prioridade: expectedPriority,
        observacao: expectedObservation
      },
      confirmed: {
        data_agendamento: confirmedDate,
        hora_agendamento: confirmedTime,
        tecnico: confirmed.technician,
        prioridade: priorityVerification.priority,
        observacao: observationVerification.observation
      }
    });

    if (
      confirmedDate !== expectedDate ||
      confirmedTime !== expectedTime ||
      !technicianMatchesExpected(entry.tecnico, confirmed.technician) ||
      !priorityVerification.ok ||
      !observationVerification.ok
    ) {
      const confirmedRow = await fetchServiceOrderById(config, osId, sgpAuth).catch(() => null);
      logSgpScheduleUpdate("verification_raw", {
        osId,
        expected: {
          data_agendamento: expectedDate,
          hora_agendamento: expectedTime,
          tecnico: entry.tecnico,
          prioridade: expectedPriority,
          observacao: expectedObservation
        },
        confirmed: {
          data_agendamento: confirmedDate,
          hora_agendamento: confirmedTime,
          tecnico: confirmed.technician,
          prioridade: priorityVerification.priority,
          observacao: observationVerification.observation
        },
        fields: pickSgpScheduleDebugFields(confirmedRow)
      });
      return {
        statusCode: 502,
        body: {
          ok: false,
          mode: "sgp",
          message: `O SGP respondeu sucesso, mas a OS ${osId} nao confirmou todos os dados esperados (agendamento, tecnico ou observacao).`,
          response,
          verification: {
            expected: {
              data_agendamento: expectedDate,
              hora_agendamento: expectedTime,
              tecnico: entry.tecnico,
              prioridade: expectedPriority,
              observacao: expectedObservation
            },
            confirmed: {
              data_agendamento: confirmedDate,
              hora_agendamento: confirmedTime,
              tecnico: confirmed.technician,
              prioridade: priorityVerification.priority,
              observacao: observationVerification.observation
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
        ...(await fetchConfirmationDetailsForOs(config, osId, sgpAuth).catch(() => ({
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

async function getContractData(contractId, authUser = null) {
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
  const operatorAuth = authUser ? getSgpAuthFromUserPayload(authUser) : null;
  const sgpAuth = resolveSgpInteractionAuth(config, operatorAuth);
  if (!canUseSgpInteractionAuth(config, operatorAuth)) {
    return {
      statusCode: 401,
      body: {
        ok: false,
        message: "Sessao do SGP expirada. Faca login novamente."
      }
    };
  }
  const contract = await lookupContract(config, normalizedContractId, sgpAuth);
  let openOses = [];
  let openOsesError = "";
  try {
    openOses = await lookupOpenOsForContract(config, normalizedContractId, sgpAuth);
  } catch (err) {
    openOsesError = String(err?.message || err || "");
    console.error("OS lookup falhou (nao critico):", openOsesError);
    openOses = [];
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      contract,
      openOses,
      ...(openOsesError ? { openOsesError } : {})
    }
  };
}

async function deleteSchedule(payload, authUser = null) {
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
    const operatorAuth = authUser ? getSgpAuthFromUserPayload(authUser) : null;
    const sgpAuth = resolveSgpInteractionAuth(config, operatorAuth);
    if (!canUseSgpInteractionAuth(config, operatorAuth)) {
      return {
        statusCode: 401,
        body: {
          ok: false,
          message: "Sessao do SGP expirada. Faca login novamente."
        }
      };
    }
    const result = await closeSgpSchedule(config, osId, sgpAuth);
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

async function requestConfirmationDispatch(payload, authUser = null) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  console.log("requestConfirmationDispatch - items recebidos:", items.length);
  console.log("requestConfirmationDispatch - authUser:", authUser?.sub);
  
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
  const operatorAuth = authUser ? getSgpAuthFromUserPayload(authUser) : null;
  const sgpAuth = resolveSgpInteractionAuth(config, operatorAuth);
  console.log("requestConfirmationDispatch - operatorAuth:", operatorAuth ? "OK" : "NULL");
  
  if (!canUseSgpInteractionAuth(config, operatorAuth)) {
    return {
      statusCode: 401,
      body: {
        ok: false,
        message: "Sessao do SGP expirada. Faca login novamente."
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

  const results = await Promise.all(validItems.map((item) => queueConfirmationDispatch(config, item, sgpAuth, { wait: true })));
  const sent = results.filter((item) => item?.ok);
  const failed = results
    .filter((item) => !item?.ok)
    .map((item) => ({
      id: String(item?.id || "").trim(),
      osId: String(item?.osId || "").trim(),
      state: String(item?.state || "error").trim(),
      reason: String(item?.message || "Falha ao solicitar envio ao SGP.").trim(),
      credentialUser: String(item?.credentialUser || "").trim(),
      selection: item?.selection || null
    }));

  if (!sent.length) {
    return {
      statusCode: 207,
      body: {
        ok: true,
        message: failed[0]?.reason || "Nao foi possivel enviar confirmacao pelo SGP.",
        queued: [],
        sent: [],
        failed,
        skipped
      }
    };
  }

  return {
    statusCode: failed.length ? 207 : 200,
    body: {
      ok: true,
      message: failed.length
        ? `${sent.length} OS enviada(s) para confirmacao; ${failed.length} falhou(aram).`
        : `${sent.length} OS enviada(s) para confirmacao via SGP.`,
      queued: [],
      sent: sent.map((item) => ({
        id: item.id,
        osId: item.osId,
        credentialUser: String(item?.credentialUser || "").trim(),
        selection: item?.selection || null
      })),
      failed,
      skipped
    }
  };
}

async function getBatchConfirmationStatus(payload, authUser = null) {
  const osIds = Array.isArray(payload?.osIds) ? payload.osIds : [];
  if (!osIds.length) {
    return {
      statusCode: 200,
      body: {
        ok: true,
        items: []
      }
    };
  }

  const config = loadConfig();
  const operatorAuth = authUser ? getSgpAuthFromUserPayload(authUser) : null;
  if (!canUseSgpInteractionAuth(config, operatorAuth)) {
    return {
      statusCode: 401,
      body: {
        ok: false,
        message: "Sessao do SGP expirada. Faca login novamente."
      }
    };
  }

  const result = await fetchConfirmationBatch(config, osIds, resolveSgpInteractionAuth(config, operatorAuth));
  invalidateDashboardDataCache();
  return {
    statusCode: 200,
    body: result
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

function readRecentLogLines(filePath, maxLines = 240) {
  const safeMax = Math.max(20, Math.min(1000, Number(maxLines || 240)));
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-safeMax);
  } catch (error) {
    return [];
  }
}

function getActionLogData(searchParams = new URLSearchParams()) {
  const lines = readRecentLogLines(path.join(BASE_DIR, "dashboard_server.log"), searchParams.get("lines"));
  const queue = readConfirmationDispatchLog();
  const confirmationQueue = Object.entries(queue)
    .map(([osId, entry]) => ({
      osId,
      state: String(entry?.state || "").trim() || "-",
      queuedAt: String(entry?.queuedAt || "").trim(),
      requestedAt: String(entry?.requestedAt || "").trim(),
      lastSentAt: String(entry?.lastSentAt || "").trim(),
      manualAt: String(entry?.manualAt || "").trim(),
      resendCount: Number(entry?.resendCount || 0) || 0,
      dispatchKind: String(entry?.dispatchKind || "").trim(),
      gateway: String(entry?.gateway || "").trim(),
      gatewayLabel: String(entry?.gatewayLabel || entry?.gateway || "").trim(),
      smsCliente: Array.isArray(entry?.smsCliente) ? entry.smsCliente : [],
      smsClienteLabels: Array.isArray(entry?.smsClienteLabels) ? entry.smsClienteLabels : [],
      responseStatus: entry?.responseStatus || "",
      responseLocation: String(entry?.responseLocation || "").trim(),
      responseSummary: String(entry?.responseSummary || "").trim(),
      errorMessage: String(entry?.errorMessage || "").trim()
    }))
    .sort((a, b) => Date.parse(b.lastSentAt || b.requestedAt || b.queuedAt || "") - Date.parse(a.lastSentAt || a.requestedAt || a.queuedAt || ""));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    lines,
    confirmationQueue
  };
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
        const isOperator = !isAdmin;
        console.log("Login - isAdmin:", isAdmin, "isOperator:", isOperator);

        const sessionId = generateSessionId();
        const ttlMs = DEFAULT_LOGIN_TTL_MS;
        storeSgpOperatorSession({ sessionId, username, password, ttlMs });
        
        const tokenPayload = {
          sub: userInfo.usuario,
          nome: userInfo.nome,
          email: userInfo.email,
          grupos: userInfo.grupos || [],
          isAdmin,
          isOperator,
          sgpSessionId: sessionId,
          iat: Date.now(),
          exp: Date.now() + ttlMs
        };
        
        const token = createSimpleJwt(tokenPayload, config.auth.jwt_secret);
        
        sendJson(res, 200, {
          ok: true,
          token,
          user: {
            username: userInfo.usuario,
            nome: userInfo.nome,
            email: userInfo.email,
            isAdmin,
            isOperator
          }
        });
      } catch (error) {
        sendJson(res, 401, { ok: false, message: error.message || "Falha na autenticacao." });
      }
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/auth/logout") {
      const token = extractBearerToken(req);
      if (token) {
        const payload = verifySimpleJwt(token, config.auth.jwt_secret);
        if (payload?.sgpSessionId) {
          clearSgpOperatorSession(payload.sgpSessionId);
        }
      }
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

      console.log("/api/auth/me - payload.isAdmin:", payload.isAdmin, "payload.isOperator:", payload.isOperator);

      sendJson(res, 200, {
        ok: true,
        user: {
          username: payload.sub,
          nome: payload.nome,
          email: payload.email,
          isAdmin: payload.isAdmin,
          isOperator: payload.isOperator
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

    if (req.method === "GET" && parsedUrl.pathname === "/api/logs") {
      if (!req.authUser?.isAdmin) {
        sendJson(res, 403, { ok: false, message: "Acesso permitido apenas para administradores." });
        return;
      }
      sendJson(res, 200, getActionLogData(parsedUrl.searchParams));
      return;
    }

    if (req.method === "GET" && parsedUrl.pathname === "/api/contrato") {
      if (!req.authUser?.isAdmin && !req.authUser?.isOperator) {
        sendJson(res, 403, { ok: false, message: "Acesso permitido apenas para administradores e operadores." });
        return;
      }
      const result = await getContractData(parsedUrl.searchParams.get("contrato"), req.authUser);
      sendJson(res, result.statusCode, result.body);
      return;
    }

		    if (req.method === "GET" && parsedUrl.pathname.startsWith("/api/os/")) {
	      if (!req.authUser?.isAdmin && !req.authUser?.isOperator) {
	        sendJson(res, 403, { ok: false, message: "Acesso permitido apenas para administradores e operadores." });
	        return;
	      }
	      const osId = parsedUrl.pathname.replace("/api/os/", "").replace(/\/$/, "");
	      if (!osId) {
	        sendJson(res, 400, { ok: false, message: "ID da OS não informado." });
	        return;
	      }
	      const config = loadConfig();
		      try {
		        // Para preencher a justificativa com a Observação do SGP, preferimos sempre a credencial de integração (robo)
		        // na navegação web, evitando bloqueios/2FA que podem impedir a leitura do formulário.
		        const result = await getOsDetails(config, osId, null);
		        if (isClosedStatusText(result?.status_label)) {
		          sendJson(res, 409, { ok: false, code: "OS_CLOSED", message: "OS encerrada/fechada. Selecione uma OS aberta ou pendente." });
		          return;
		        }
		        sendJson(res, 200, result);
		      } catch (error) {
		        sendJson(res, 500, { ok: false, message: error.message });
		      }
		      return;
		    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/agendamentos") {
      if (!req.authUser?.isAdmin && !req.authUser?.isOperator) {
        sendJson(res, 403, { ok: false, message: "Acesso permitido apenas para administradores e operadores." });
        return;
      }
      const payload = await collectRequestBody(req);
      const result = await createSchedule(payload, req.authUser);
      if (result.body?.ok) {
        invalidateDashboardDataCache();
      }
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/agendamentos/edit") {
      if (!req.authUser?.isAdmin && !req.authUser?.isOperator) {
        sendJson(res, 403, { ok: false, message: "Acesso permitido apenas para administradores e operadores." });
        return;
      }
      const payload = await collectRequestBody(req);
      const result = await updateSchedule(payload, req.authUser);
      if (result.body?.ok) {
        invalidateDashboardDataCache();
      }
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/agendamentos/delete") {
      if (!req.authUser?.isAdmin) {
        sendJson(res, 403, { ok: false, message: "Acesso permitido apenas para administradores." });
        return;
      }
      const payload = await collectRequestBody(req);
      const result = await deleteSchedule(payload, req.authUser);
      if (result.body?.ok) {
        invalidateDashboardDataCache();
      }
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/bloqueios") {
      if (!req.authUser?.isAdmin) {
        sendJson(res, 403, { ok: false, message: "Acesso permitido apenas para administradores." });
        return;
      }
      const payload = await collectRequestBody(req);
      const result = await createBlockedSlot(payload, req.authUser);
      if (result.body?.ok) {
        invalidateDashboardDataCache();
      }
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
      if (result.body?.ok) {
        invalidateDashboardDataCache();
      }
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (normalizedPathname === "/api/agendamentos/send-confirmation") {
      console.log(`[CONFIRMATION_DISPATCH_API] ${req.method} ${parsedUrl.pathname}`);
    }

    if (req.method === "POST" && normalizedPathname === "/api/agendamentos/confirmation-status") {
      const payload = await collectRequestBody(req);
      const result = await getBatchConfirmationStatus(payload, req.authUser);
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (req.method === "POST" && normalizedPathname === "/api/agendamentos/send-confirmation") {
      if (!req.authUser?.isAdmin) {
        sendJson(res, 403, { ok: false, message: "Acesso permitido apenas para administradores." });
        return;
      }
      const payload = await collectRequestBody(req);
      const result = await requestConfirmationDispatch(payload, req.authUser);
      if (result.body?.ok) {
        invalidateDashboardDataCache();
      }
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
      message: error.message || "Erro inesperado no servidor.",
      ...(error?.detail ? { detail: String(error.detail) } : {})
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


async function lookupOpenOsForContract(config, contractId, operatorAuth = null) {
  try {
    const endpoint = config.agendamento?.endpoint_lista || "/api/ura/ordemservico/list/";
    const statuses = Array.isArray(config.agendamento?.statuses_consulta) && config.agendamento.statuses_consulta.length
      ? config.agendamento.statuses_consulta
      : [0, 1];
    const normalizedContractId = String(contractId || "").trim();
    const statusesTried = (Array.isArray(statuses) ? statuses : []).map((value) => Number(value)).filter((n) => Number.isFinite(n));
    const openStatusIds = new Set(statusesTried.map((value) => String(value)));
			    
    const allRows = [];
    for (const status of statusesTried) {
      const payload = {
        status,
        limit: 10,
        contrato: normalizedContractId,
        contrato_id: normalizedContractId,
        id_contrato: normalizedContractId
      };
      try {
        const response = await postToSgp(config, endpoint, payload, operatorAuth);
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
      const rowContractId = normalizeContractId(row.contrato || row.contrato_id || row.id_contrato || row.contratoId || "");
      return rowContractId && rowContractId === normalizeContractId(normalizedContractId);
    });

    if (!contractRows.length) return [];

    const pickUniqueOpenRows = (rows) =>
      dedupeBy(
        rows.filter((row) => isExternalServiceOrder(row)).filter((row) => isOpenServiceOrder(row, openStatusIds)),
        (row) => pickServiceOrderId(row)
      );

    const uniqueRows = pickUniqueOpenRows(contractRows);

    uniqueRows.sort((a, b) => Number(pickServiceOrderId(b) || 0) - Number(pickServiceOrderId(a) || 0));

    const picked = uniqueRows.slice(0, 3);

    const mapped = picked.map(raw => {
      const osId = pickServiceOrderId(raw);
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
	        observacao:      String(raw.observacao || raw.anotacao || ""),
	        osUrl:           buildOsUrl(config, osId)
	      };
	    }).filter(x => x.osId);

    await runWithConcurrencyLimit(
      mapped,
      2,
      async (item) => {
        const details = await getOsDetails(config, item.osId, operatorAuth).catch(() => null);
        if (!details?.ok) {
          return;
        }
        item.responsavel = String(details.responsavel_label || details.responsavel || item.responsavel || "").trim();
        item.data_agendamento = String(details.data_agendamento_date || item.data_agendamento || "").trim();
        item.hora_agendamento = String(details.hora_agendamento || item.hora_agendamento || "").trim();
        if (String(details.observacao || "").trim()) {
          item.observacao = String(details.observacao || "").trim();
        }
      }
    );

    return mapped;
  } catch (error) {
    console.error("Falha ao organizar OS abertas/pendentes:", error.message);
    return [];
  }
}
