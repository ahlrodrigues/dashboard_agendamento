const state = {
  data: null,
  schedulesById: new Map(),
  selectedScheduleIds: new Set(),
  expandedCalendarCells: new Set(),
  sendingConfirmation: false,
  pendingMutations: 0,
  autoRefreshTimer: null,
  autoRefreshMs: 300000,
  refreshing: false,
  slotConflictActive: false,
  user: null,
  isAdmin: false,
  compactView: true,
  darkMode: false
};

const summaryConfig = [
  { key: "agendado", label: "Agendamentos", className: "blue" },
  { key: "itinerario", label: "Itinerario", className: "indigo" },
  { key: "pre_agendado", label: "Pre-agendadas", className: "amber" },
  { key: "sem_solicitacao", label: "Sem solicitacao", className: "slate", adminOnly: true },
  { key: "na_fila_envio", label: "Na fila", className: "gold", adminOnly: true },
  { key: "processando_envio", label: "Enviando", className: "sky", adminOnly: true },
  { key: "aguardando_confirmacao", label: "Aguardando", className: "pink", adminOnly: true },
  { key: "reenvio_1", label: "1o reenvio", className: "violet", adminOnly: true },
  { key: "reenvio_2", label: "2o reenvio", className: "violet", adminOnly: true },
  { key: "envio_manual", label: "Envio manual", className: "orange", adminOnly: true },
  { key: "rejeitado", label: "Negativas", className: "red", adminOnly: true },
  { key: "erro_envio", label: "Erros envio", className: "orange-deep", adminOnly: true }
];

const elements = {
  startDateFilter: document.querySelector("#startDateFilter"),
  endDateFilter: document.querySelector("#endDateFilter"),
  statusFilter: document.querySelector("#statusFilter"),
  routeModeTechnician: document.querySelector("#routeModeTechnician"),
  routeModePop: document.querySelector("#routeModePop"),
  routeFilter: document.querySelector("#routeFilter"),
  searchFilter: document.querySelector("#searchFilter"),
  refreshButton: document.querySelector("#refreshButton"),
  prevWeekButton: document.querySelector("#prevWeekButton"),
  nextWeekButton: document.querySelector("#nextWeekButton"),
  summaryCards: document.querySelector("#summaryCards"),
  calendarGrid: document.querySelector("#calendarGrid"),
  sendConfirmationButton: document.querySelector("#sendConfirmationButton"),
  sendSelectionCount: document.querySelector("#sendSelectionCount"),
  scheduleTableBody: document.querySelector("#scheduleTableBody"),
  tableCount: document.querySelector("#tableCount"),
  weekRange: document.querySelector("#weekRange"),
  sourceBadge: document.querySelector("#sourceBadge"),
  snapshotLabel: document.querySelector("#snapshotLabel"),
  writeModeBadge: document.querySelector("#writeModeBadge"),
  noticeArea: document.querySelector("#noticeArea"),
  scheduleForm: document.querySelector("#scheduleForm"),
  scheduleFormTitle: document.querySelector("#scheduleFormTitle"),
  scheduleSubmitButton: document.querySelector("#scheduleSubmitButton"),
  cancelEditButton: document.querySelector("#cancelEditButton"),
  lookupContractButton: document.querySelector("#lookupContractButton"),
  contractLookupStatus: document.querySelector("#contractLookupStatus"),
  slotConflictHint: document.querySelector("#slotConflictHint"),
  blockSlotForm: document.querySelector("#blockSlotForm"),
  blockRotaSelect: document.querySelector("#blockRotaSelect"),
  blockSlotHint: document.querySelector("#blockSlotHint"),
  blockSlotSubmitButton: document.querySelector("#blockSlotSubmitButton"),
  scheduleModal: document.querySelector("#scheduleModal"),
  closeModalBtn: document.querySelector("#closeModalBtn"),
  tabButtons: document.querySelectorAll(".tab-button"),
  tabContents: document.querySelectorAll(".tab-content"),
  editScheduleForm: document.querySelector("#editScheduleForm"),
  cancelScheduleForm: document.querySelector("#cancelScheduleForm"),
  osLookupList: document.querySelector("#osLookupList"),
  loginScreen: document.querySelector("#loginScreen"),
  mainApp: document.querySelector("#mainApp"),
  loginForm: document.querySelector("#loginForm"),
  loginUsername: document.querySelector("#loginUsername"),
  loginPassword: document.querySelector("#loginPassword"),
  loginButton: document.querySelector("#loginButton"),
  loginError: document.querySelector("#loginError"),
  logoutButton: document.querySelector("#logoutButton"),
  userBadge: document.querySelector("#userBadge"),
  toggleCompactView: document.querySelector("#toggleCompactView"),
  toggleDarkMode: document.querySelector("#toggleDarkMode"),
  scheduleTurnoGroup: document.querySelector("#scheduleTurnoGroup"),
  scheduleTurnoManha: document.querySelector("#scheduleTurnoManha"),
  scheduleTurnoTarde: document.querySelector("#scheduleTurnoTarde"),
	  editTurnoGroup: document.querySelector("#editTurnoGroup"),
	  editTurnoManha: document.querySelector("#editTurnoManha"),
	  editTurnoTarde: document.querySelector("#editTurnoTarde"),
	  periodConflictModal: document.querySelector("#periodConflictModal"),
	  periodConflictMessage: document.querySelector("#periodConflictMessage"),
	  periodConflictCancelButton: document.querySelector("#periodConflictCancelButton"),
	  periodConflictProceedButton: document.querySelector("#periodConflictProceedButton")
	};

const TURNOS = {
  manha: { time: "08:00" },
  tarde: { time: "13:00" }
};

let periodConflictModalResolver = null;

function closePeriodConflictModal(shouldProceed) {
  if (!elements.periodConflictModal) {
    return;
  }
  elements.periodConflictModal.classList.remove("active");
  const resolve = periodConflictModalResolver;
  periodConflictModalResolver = null;
  if (typeof resolve === "function") {
    resolve(Boolean(shouldProceed));
  }
}

function showPeriodConflictModal(message) {
  if (!elements.periodConflictModal || !elements.periodConflictMessage) {
    alert(message);
    return Promise.resolve(true);
  }

  if (typeof periodConflictModalResolver === "function") {
    periodConflictModalResolver(false);
  }
  periodConflictModalResolver = null;

  elements.periodConflictMessage.textContent = String(message || "");
  return new Promise((resolve) => {
    periodConflictModalResolver = resolve;
    elements.periodConflictModal.classList.add("active");
    if (elements.periodConflictProceedButton) {
      elements.periodConflictProceedButton.focus();
    }
  });
}

function getAuthToken() {
  return localStorage.getItem("dashboard_token");
}

function setAuthToken(token) {
  localStorage.setItem("dashboard_token", token);
}

function clearAuthToken() {
  localStorage.removeItem("dashboard_token");
  localStorage.removeItem("dashboard_user");
}

function getStoredUser() {
  const data = localStorage.getItem("dashboard_user");
  return data ? JSON.parse(data) : null;
}

function setStoredUser(user) {
  localStorage.setItem("dashboard_user", JSON.stringify(user));
}

function clearStoredUser() {
  localStorage.removeItem("dashboard_user");
}

async function checkAuth() {
  const token = getAuthToken();
  if (!token) {
    return null;
  }

  try {
    const response = await fetch("/api/auth/me", {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      clearAuthToken();
      clearStoredUser();
      return null;
    }

    const data = await response.json();
    if (data.ok && data.user) {
      state.user = data.user;
      state.isAdmin = data.user.isAdmin;
      setStoredUser(data.user);
      return data.user;
    }

    clearAuthToken();
    clearStoredUser();
    return null;
  } catch (error) {
    clearAuthToken();
    clearStoredUser();
    return null;
  }
}

async function login(username, password) {
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.message || "Falha na autenticacao.");
    }

    setAuthToken(data.token);
    setStoredUser(data.user);
    state.user = data.user;
    state.isAdmin = data.user.isAdmin;

    return data.user;
  } catch (error) {
    throw error;
  }
}

async function logout() {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getAuthToken()}`
      }
    });
  } catch (error) {
  }

  clearAuthToken();
  clearStoredUser();
  state.user = null;
  state.isAdmin = false;
}

async function apiFetch(url, options = {}) {
  const token = getAuthToken();
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers
  };

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    clearAuthToken();
    clearStoredUser();
    showLoginScreen();
    throw new Error("Sessao expirada. Faca login novamente.");
  }

  return response;
}

function showLoginScreen() {
  if (elements.loginScreen) {
    elements.loginScreen.style.display = "flex";
  }
  if (elements.mainApp) {
    elements.mainApp.style.display = "none";
  }
}

function showMainApp() {
  if (elements.loginScreen) {
    elements.loginScreen.style.display = "none";
  }
  if (elements.mainApp) {
    elements.mainApp.style.display = "grid";
  }
}

function formatDate(dateText) {
  if (!dateText) {
    return "-";
  }
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short"
  }).format(new Date(`${dateText}T12:00:00`));
}

function formatDateTime(dateText) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(dateText));
}

function toLocalIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDate(dateText, days) {
  const date = new Date(`${dateText}T12:00:00`);
  date.setDate(date.getDate() + days);
  return toLocalIsoDate(date);
}

function applySevenDayWindowFromStartDate(dateText) {
  const base = dateText || toLocalIsoDate(new Date());
  elements.startDateFilter.value = base;
  elements.endDateFilter.value = shiftDate(base, 6);
}

function hhmm(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : "";
}

function inferTurnoFromTime(value) {
  const time = hhmm(value);
  if (!time) return "";
  const hour = Number(time.slice(0, 2));
  if (!Number.isFinite(hour)) return "";
  return hour < 12 ? "manha" : "tarde";
}

function setToggleSelected(input, selected) {
  const wrapper = input?.closest?.(".toggle-button");
  if (wrapper) {
    wrapper.classList.toggle("is-selected", Boolean(selected));
  }
}

function setFormTurno(formElement, turno) {
  const form = formElement?.elements;
  if (!form) return;
  const normalized = turno === "manha" || turno === "tarde" ? turno : "";
  const desiredTime = normalized ? TURNOS[normalized].time : "";

  const turnInputs = formElement.querySelectorAll('input[type="checkbox"][data-turno]');
  turnInputs.forEach((input) => {
    const isSelected = normalized && input.dataset.turno === normalized;
    input.checked = Boolean(isSelected);
    setToggleSelected(input, isSelected);
  });

  if (form.horario) {
    form.horario.value = desiredTime;
  }
}

function getFormTurno(formElement) {
  const inputs = formElement?.querySelectorAll?.('input[type="checkbox"][data-turno]');
  if (!inputs) return "";
  for (const input of inputs) {
    if (input.checked) {
      return input.dataset.turno === "tarde" ? "tarde" : "manha";
    }
  }
  return "";
}

function wireTurnoGroup(formElement, onChange) {
  const inputs = formElement?.querySelectorAll?.('input[type="checkbox"][data-turno]');
  if (!inputs || !inputs.length) return;
  inputs.forEach((input) => {
    input.addEventListener("change", () => {
      const turno = input.checked ? (input.dataset.turno === "tarde" ? "tarde" : "manha") : "";
      setFormTurno(formElement, turno);
      if (typeof onChange === "function") {
        onChange(turno);
      }
    });
    setToggleSelected(input, input.checked);
  });
}

function normalizePopKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeTechnicianKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function updateScheduleSubmitButtonState() {
  const button = elements.scheduleSubmitButton || elements.scheduleForm?.querySelector("button[type=submit]");
  if (!button) {
    return;
  }
  const hasConflict = Boolean(state.slotConflictActive);
  button.disabled = state.pendingMutations > 0 || hasConflict;
  button.title = hasConflict ? "Horario ocupado para o POP selecionado." : "";
}

function setSlotConflictStatus(message = "", tone = "") {
  if (!elements.slotConflictHint) {
    return;
  }
  elements.slotConflictHint.textContent = message || "";
  elements.slotConflictHint.className = `field-hint${tone ? ` ${tone}` : ""}`;
}

function isBlockedItem(item) {
  return item?.origem === "bloqueio" || item?.status === "bloqueado";
}

function setScheduleFormInvalidState(isInvalid) {
  const inputs = [
    elements.scheduleForm?.elements?.rota,
    elements.scheduleForm?.elements?.data,
    elements.scheduleForm?.elements?.horario
  ].filter(Boolean);
  for (const input of inputs) {
    input.classList.toggle("is-invalid", Boolean(isInvalid));
  }
  if (elements.scheduleTurnoGroup) {
    elements.scheduleTurnoGroup.classList.toggle("is-invalid", Boolean(isInvalid));
  }
}

function setBlockSlotStatus(message = "", tone = "") {
  if (!elements.blockSlotHint) {
    return;
  }
  elements.blockSlotHint.textContent = message || "";
  elements.blockSlotHint.className = `field-hint${tone ? ` ${tone}` : ""}`;
}

function getScheduleFormConflictContext() {
  const form = elements.scheduleForm?.elements;
  if (!form) {
    return null;
  }
  return {
    rota: String(form.rota?.value || "").trim(),
    data: String(form.data?.value || "").trim(),
    horario: hhmm(form.horario?.value || ""),
    ignoreId: String(form.id?.value || "").trim(),
    ignoreOsId: String(form.osId?.value || "").trim(),
    ignoreProtocolo: String(form.protocolo?.value || "").trim()
  };
}

function findLocalSlotConflicts(context) {
  if (!context || !state.data?.grid?.cells) {
    return { conflicts: [], checked: false };
  }
  const rotaKey = normalizePopKey(context.rota);
  const slot = context.horario;
  if (!rotaKey || !context.data || !slot) {
    return { conflicts: [], checked: true };
  }
  const dayCells = state.data.grid.cells[context.data];
  if (!dayCells || !dayCells[slot]) {
    if (!dayCells) {
      return { conflicts: [], checked: false };
    }
    return { conflicts: [], checked: true };
  }
  const items = dayCells[slot] || [];
  const conflicts = items.filter((item) => {
    if (context.ignoreId && String(item.id || "").trim() === context.ignoreId) {
      return false;
    }
    if (context.ignoreOsId && String(item.osId || "").trim() === context.ignoreOsId) {
      return false;
    }
    if (context.ignoreProtocolo && String(item.protocolo || "").trim() === context.ignoreProtocolo) {
      return false;
    }
    return normalizePopKey(item.rota) === rotaKey && hhmm(item.horario) === slot;
  });
  return { conflicts, checked: true };
}

function summarizeConflicts(items) {
  const blocked = (item) => isBlockedItem(item);
  return (items || [])
    .filter((item) => !blocked(item))
    .slice(0, 2)
    .map((item) => {
      const ref = String(item.osId || item.protocolo || "").trim();
      const label = ref ? `OS ${ref}` : "OS";
      const client = String(item.cliente || "").trim();
      return `${label}${client ? ` (${client})` : ""}`;
    })
    .join(", ");
}

function applySlotConflictUi(conflicts, context) {
  if (conflicts && conflicts.length) {
    state.slotConflictActive = true;
    const rotaLabel = context?.rota ? ` em ${context.rota}` : "";
    const isBlocked = isBlockedItem(conflicts[0]);
    const summary = summarizeConflicts(conflicts);
    const label = isBlocked ? "Horario bloqueado" : "Horario ocupado";
    setSlotConflictStatus(`${label}${rotaLabel}${summary ? `: ${summary}.` : "."}`, "error");
    setScheduleFormInvalidState(true);
  } else {
    state.slotConflictActive = false;
    setSlotConflictStatus("");
    setScheduleFormInvalidState(false);
  }
  updateScheduleSubmitButtonState();
}

function updateSlotConflictFromForm() {
  const context = getScheduleFormConflictContext();
  if (!context) {
    return;
  }
  if (!context.rota || !context.data || !context.horario) {
    applySlotConflictUi([], context);
    return;
  }
  const { conflicts, checked } = findLocalSlotConflicts(context);
  if (!checked) {
    state.slotConflictActive = true;
    setSlotConflictStatus("Nao foi possivel validar conflito (data fora do periodo carregado). Ajuste Data inicial/final e clique Atualizar.", "error");
    setScheduleFormInvalidState(true);
    updateScheduleSubmitButtonState();
    return;
  }
  const blocking = (conflicts || []).filter((item) => isBlockedItem(item));
  applySlotConflictUi(blocking, context);
}

function findLocalPeriodScheduleConflicts({ rota, data, periodo, ignoreId = "", ignoreOsId = "", ignoreProtocolo = "" }) {
  if (!rota || !data || !periodo || !state.data?.grid?.cells) {
    return { conflicts: [], checked: false };
  }
  const rotaKey = normalizePopKey(rota);
  const dayCells = state.data.grid.cells[data];
  if (!dayCells) {
    return { conflicts: [], checked: false };
  }

  const conflicts = [];
  const slots = Object.keys(dayCells);
  for (const slot of slots) {
    const hour = Number(String(slot).slice(0, 2));
    if (!Number.isFinite(hour)) continue;
    const inPeriod = periodo === "manha" ? hour < 12 : hour >= 12;
    if (!inPeriod) continue;
    const items = dayCells[slot] || [];
    for (const item of items) {
      if (isBlockedItem(item)) continue;
      if (ignoreId && String(item.id || "").trim() === String(ignoreId || "").trim()) continue;
      if (ignoreOsId && String(item.osId || "").trim() === String(ignoreOsId || "").trim()) continue;
      if (ignoreProtocolo && String(item.protocolo || "").trim() === String(ignoreProtocolo || "").trim()) continue;
      if (normalizePopKey(item.rota) !== rotaKey) continue;
      conflicts.push(item);
    }
  }
  return { conflicts, checked: true };
}

async function maybeWarnPeriodConflictsForScheduleForm() {
  const form = elements.scheduleForm?.elements;
  if (!form) return { shouldProceed: true, duplicatePeriod: false };
  const rota = String(form.rota?.value || "").trim();
  const data = String(form.data?.value || "").trim();
  const contrato = String(form.contrato?.value || "").trim();
  const periodo = getFormTurno(elements.scheduleForm);
  if (!rota || !data || !periodo || !contrato) return { shouldProceed: true, duplicatePeriod: false };

  const context = getScheduleFormConflictContext() || {};
  const { conflicts, checked } = findLocalPeriodScheduleConflicts({
    rota,
    data,
    periodo,
    ignoreId: context.ignoreId,
    ignoreOsId: context.ignoreOsId,
    ignoreProtocolo: context.ignoreProtocolo
  });
  if (!checked || !conflicts.length) return { shouldProceed: true, duplicatePeriod: false };

  const differentContract = conflicts.filter((item) => {
    const existing = String(item.contrato || "").trim();
    return existing && existing !== contrato;
  });
  if (!differentContract.length) {
    return { shouldProceed: true, duplicatePeriod: false };
  }

  const periodoLabel = periodo === "manha" ? "manhã" : "tarde";
  const uniqueContracts = Array.from(
    new Set(differentContract.map((item) => String(item.contrato || "").trim()).filter(Boolean))
  ).slice(0, 5);

  const message = `Aviso: já existem agendamentos no POP ${rota} em ${data} no período da ${periodoLabel} para outros contratos: ${uniqueContracts.join(
    ", "
  )}.`;

  const shouldProceed = await showPeriodConflictModal(message);
  return { shouldProceed, duplicatePeriod: shouldProceed };
}

function badgeClassForSource(sourceMode) {
  if (sourceMode === "sgp") {
    return "success";
  }
  if (sourceMode === "fallback") {
    return "warning";
  }
  return "neutral";
}

function sourceLabel(sourceMode) {
  if (sourceMode === "sgp") {
    return "Dados do SGP";
  }
  if (sourceMode === "fallback") {
    return "Modo contingencia";
  }
  return "Modo demonstracao";
}

function renderSummary(summary) {
  const filteredConfig = summaryConfig.filter(item => !item.adminOnly || state.isAdmin);
  elements.summaryCards.innerHTML = filteredConfig
    .map(
      (item) => `
        <article class="summary-card ${item.className}">
          <span>${item.label}</span>
          <strong>${summary[item.key] || 0}</strong>
        </article>
      `
    )
    .join("");
}

function renderNotices(notices) {
  if (!notices || !notices.length) {
    elements.noticeArea.innerHTML = "";
    return;
  }
  elements.noticeArea.innerHTML = notices
    .map((notice) => `<div class="notice">${notice}</div>`)
    .join("");
}

function renderBlockPopSelect(routes = []) {
  if (!elements.blockRotaSelect) {
    return;
  }
  const current = String(elements.blockRotaSelect.value || "").trim();
  const options = [`<option value="">Selecione...</option>`]
    .concat(
      (routes || []).map((route) => {
        const value = String(route || "").trim();
        return `<option value="${escapeHtml(value)}"${value && value === current ? " selected" : ""}>${escapeHtml(value)}</option>`;
      })
    )
    .join("");
  elements.blockRotaSelect.innerHTML = options;
}

function renderCalendar(grid) {
  const fragments = [];
  elements.calendarGrid.style.setProperty("--calendar-day-count", String(grid.days.length || 7));
  fragments.push(`<div class="calendar-head">Horario</div>`);
  for (const day of grid.days) {
    fragments.push(`<div class="calendar-head">${day.label}</div>`);
  }

  for (const slot of grid.slots) {
    fragments.push(`<div class="slot-label">${slot}</div>`);
    for (const day of grid.days) {
      const cellKey = `${day.date}__${slot}`;
      const items = (grid.cells[day.date]?.[slot] || []).map((item) => state.schedulesById.get(item.id) || item);
      const visibility = items.map((item) => ({ item, isVisible: matchesCurrentFilters(item) }));
      const visibleItems = visibility.filter((entry) => entry.isVisible).map((entry) => entry.item);
      const blockedItems = visibleItems.filter(isBlockedScheduleItem);
      const scheduleItems = visibleItems.filter((item) => !isBlockedScheduleItem(item));
      const hiddenOverflowItems = scheduleItems.length > 1 ? scheduleItems.slice(1) : [];
      const shouldExpand = hiddenOverflowItems.length ? state.expandedCalendarCells.has(cellKey) : false;

      const cellClass = hiddenOverflowItems.length ? "calendar-cell has-overflow" : "calendar-cell";
      const buttonLabel = hiddenOverflowItems.length === 1 ? "Ver +1 OS" : `Ver +${hiddenOverflowItems.length} OS`;

      fragments.push(`
        <div class="${cellClass}${shouldExpand ? " is-expanded" : ""}" data-cell-key="${escapeHtml(cellKey)}">
          ${(blockedItems || []).map(renderChip).join("")}
          ${scheduleItems.length ? renderChip(scheduleItems[0]) : ""}
          ${
            hiddenOverflowItems.length
              ? `
                <div class="calendar-cell-overflow"${shouldExpand ? "" : " hidden"}>
                  ${hiddenOverflowItems.map(renderChip).join("")}
                </div>
                <button class="cell-expand-button" type="button" data-action="toggle-cell-overflow" data-cell-key="${escapeHtml(cellKey)}" aria-expanded="${shouldExpand ? "true" : "false"}" title="${escapeHtml(buttonLabel)}">
                  ${escapeHtml(shouldExpand ? "Recolher" : buttonLabel)}
                </button>
              `
              : ""
          }
          ${
            scheduleItems.length === 0 && blockedItems.length === 0
              ? items.map(renderChip).join("")
              : ""
          }
        </div>
      `);
    }
  }

  elements.calendarGrid.innerHTML = fragments.join("");
}

function isBlockedScheduleItem(item) {
  return item?.origem === "bloqueio" || item?.status === "bloqueado";
}

function renderChip(item) {
  if (item.origem === "bloqueio" || item.status === "bloqueado") {
    const routeLabel = escapeHtml(item.rota || "");
    const reason = String(item.observacao || "").trim();
    const title = reason ? ` title="${escapeHtml(reason)}"` : "";
    const hiddenByFilter = !matchesCurrentFilters(item);
    return `
      <div class="chip bloqueado${hiddenByFilter ? " is-hidden-by-filter" : ""}"${title} tabindex="-1">
        <div class="chip-actions">
          <span></span>
          <button class="chip-unblock-button" type="button" data-block-id="${escapeHtml(item.id)}" aria-label="Desbloquear horario" title="Desbloquear horario">×</button>
        </div>
        <strong>Horario bloqueado</strong>
        <small>${routeLabel}${reason ? `<br />${escapeHtml(reason)}` : ""}</small>
        <span class="chip-flag">Bloqueio</span>
      </div>
    `;
  }

  const clientName = renderClientLink(item, item.cliente);
  const routeLabel = escapeHtml(item.rota || "");
  const technicianName = getDisplayTechnicianName(item.tecnico);
  const technicianLabel = technicianName ? `Tecnico: ${escapeHtml(technicianName)}` : "Tecnico:";
  const reasonLabel = `Motivo: ${escapeHtml(String(item.motivo || "").trim() || "-")}`;
  const sgpStatusLabel = `Status SGP: ${escapeHtml(String(item.sgpStatus || "").trim() || "-")}`;
  const createdByLabel = item.createdBy ? `Criado por: ${escapeHtml(String(item.createdBy || "").trim())}` : "";
  const confirmationLabel = confirmationStatusLabel(item.confirmationStatus, item.confirmationSent);
  const confirmationTitle = item.confirmationTitle ? ` title="${escapeHtml(item.confirmationTitle)}"` : "";
  const selected = state.selectedScheduleIds.has(item.id);
  const canSendConfirmation = canRequestConfirmation(item);
  const hiddenByFilter = !matchesCurrentFilters(item);
  const duplicatePeriodClass = item.duplicatePeriod ? " is-duplicate-period" : "";
  const selectTitle = canSendConfirmation
    ? (selected ? "Desmarcar OS para envio" : "Marcar OS para envio")
    : "OS indisponivel para envio";
  const deleteButton = canDeleteSchedule(item)
    ? `<button class="chip-delete-button" type="button" data-schedule-id="${escapeHtml(item.id)}" aria-label="Acoes do agendamento">&#9998;</button>`
    : "";
  return `
    <div class="chip ${item.status} ${confirmationStatusClass(item.confirmationStatus)}${selected ? " is-selected" : ""}${hiddenByFilter ? " is-hidden-by-filter" : ""}${duplicatePeriodClass}"${confirmationTitle} tabindex="-1">
      <div class="chip-actions">
        <button class="chip-select-button${selected ? " is-selected" : ""}${canSendConfirmation ? "" : " is-disabled"}" type="button" data-select-schedule-id="${escapeHtml(item.id)}" aria-pressed="${selected ? "true" : "false"}" aria-label="${escapeHtml(selectTitle)}" title="${escapeHtml(selectTitle)}">${selected ? "✓" : "+"}</button>
        ${deleteButton}
      </div>
      <strong>${clientName}</strong>
      <small>${routeLabel}<br />${technicianLabel}<br />${reasonLabel}<br />${sgpStatusLabel}${createdByLabel ? `<br />${createdByLabel}` : ""}<br />Confirmacao: ${confirmationLabel}</small>
      <span class="chip-flag">${canSendConfirmation ? `OS ${escapeHtml(item.osId || item.protocolo || "")}` : "Envio indisponivel"}</span>
    </div>
  `;
}

function matchesCurrentFilters(item) {
  const search = String(elements.searchFilter?.value || "").trim().toLowerCase();
  const status = String(elements.statusFilter?.value || "todos").trim().toLowerCase();
  const selectedRoutes = new Set(Array.from(elements.routeFilter?.selectedOptions || []).map((option) => String(option.value || "").trim()).filter(Boolean));
  const confirmationStatus = String(item.confirmationStatus || "").trim();

  if (status && status !== "todos") {
    if (status === "confirmacao_solicitada") {
      if (!["na_fila_envio", "processando_envio", "aguardando_confirmacao", "reenvio_1", "reenvio_2"].includes(confirmationStatus)) {
        return false;
      }
    } else if (status === "confirmacao_confirmada") {
      if (confirmationStatus !== "confirmado") {
        return false;
      }
    } else if ([
      "sem_confirmacao",
      "na_fila_envio",
      "processando_envio",
      "aguardando_confirmacao",
      "reenvio_1",
      "reenvio_2",
      "envio_manual",
      "rejeitado",
      "erro_envio"
    ].includes(status)) {
      if (confirmationStatus !== status) {
        return false;
      }
    } else if (item.status !== status) {
      return false;
    }
  }

  if (!search) {
    if (!selectedRoutes.size) {
      return true;
    }
  } else {
    const haystack = [
      item.cliente,
      item.protocolo,
      item.contrato,
      item.telefone,
      item.rota,
      item.tecnico
    ].join(" ").toLowerCase();
    if (!haystack.includes(search)) {
      return false;
    }
  }

  if (selectedRoutes.size && !selectedRoutes.has(String(item.rota || "").trim())) {
    return false;
  }

  return true;
}

function getSelectedRoutes() {
  return Array.from(elements.routeFilter?.selectedOptions || []).map((option) => String(option.value || "").trim()).filter(Boolean);
}

function isTechnicianRouteModeEnabled() {
  return Boolean(elements.routeModeTechnician?.checked);
}

function collectSchedulesFromGrid() {
  const grid = state.data?.grid;
  if (!grid?.cells) {
    return [];
  }
  const byId = new Map();
  for (const day of Object.keys(grid.cells || {})) {
    const slots = grid.cells[day] || {};
    for (const slot of Object.keys(slots || {})) {
      const items = slots[slot] || [];
      for (const item of items) {
        const id = String(item?.id || "").trim();
        if (!id || byId.has(id)) {
          continue;
        }
        byId.set(id, item);
      }
    }
  }
  return Array.from(byId.values());
}

function findTechnicianForPop(selectedPop) {
  const popKey = normalizePopKey(selectedPop);
  if (!popKey) {
    return "";
  }
  const candidates = new Map();
  for (const item of collectSchedulesFromGrid()) {
    if (item?.origem === "bloqueio" || item?.status === "bloqueado") {
      continue;
    }
    if (normalizePopKey(item?.rota) !== popKey) {
      continue;
    }
    const technicianName = getDisplayTechnicianName(item?.tecnico);
    if (!technicianName) {
      continue;
    }
    const technicianKey = normalizeTechnicianKey(technicianName);
    const current = candidates.get(technicianKey) || { count: 0, name: technicianName };
    current.count += 1;
    current.name = current.name || technicianName;
    candidates.set(technicianKey, current);
  }
  let best = null;
  for (const entry of candidates.values()) {
    if (!best || entry.count > best.count) {
      best = entry;
    }
  }
  return best?.name || "";
}

function findPopsForTechnician(technicianName) {
  const technicianKey = normalizeTechnicianKey(getDisplayTechnicianName(technicianName));
  if (!technicianKey) {
    return [];
  }
  const pops = new Set();
  for (const item of collectSchedulesFromGrid()) {
    if (item?.origem === "bloqueio" || item?.status === "bloqueado") {
      continue;
    }
    const itemTechKey = normalizeTechnicianKey(getDisplayTechnicianName(item?.tecnico));
    if (!itemTechKey || itemTechKey !== technicianKey) {
      continue;
    }
    const pop = String(item?.rota || "").trim();
    if (pop) {
      pops.add(pop);
    }
  }
  return Array.from(pops).sort((a, b) => a.localeCompare(b));
}

function applySelectedRoutes(values) {
  if (!elements.routeFilter) {
    return;
  }
  const selected = new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean));
  for (const option of Array.from(elements.routeFilter.options || [])) {
    option.selected = selected.has(String(option.value || "").trim());
  }
}

function renderRouteFilter(options = [], selectedValues = []) {
  if (!elements.routeFilter) {
    return;
  }

  const selected = new Set(selectedValues.map((value) => String(value || "").trim()).filter(Boolean));
  elements.routeFilter.innerHTML = options.length
    ? options.map((value) => `<option value="${escapeHtml(value)}"${selected.has(value) ? " selected" : ""}>${escapeHtml(value)}</option>`).join("")
    : "";
}

function confirmationStatusClass(status) {
  const value = String(status || "").trim();
  if (value === "na_fila_envio") {
    return "confirmation-fila";
  }
  if (value === "processando_envio") {
    return "confirmation-processando";
  }
  if (value === "reenvio_1" || value === "reenvio_2") {
    return "confirmation-reenvio";
  }
  if (value === "confirmado") {
    return "confirmation-confirmado";
  }
  if (value === "rejeitado") {
    return "confirmation-rejeitado";
  }
  if (value === "aguardando_confirmacao") {
    return "confirmation-aguardando";
  }
  if (value === "erro_envio") {
    return "confirmation-erro";
  }
  if (value === "envio_manual") {
    return "confirmation-manual";
  }
  return "confirmation-sem";
}

function confirmationStatusLabel(status, sent = false) {
  const value = String(status || "").trim();
  if (value === "na_fila_envio") {
    return "Na fila";
  }
  if (value === "processando_envio") {
    return "Enviando";
  }
  if (value === "reenvio_1") {
    return "1o reenvio";
  }
  if (value === "reenvio_2") {
    return "2o reenvio";
  }
  if (value === "confirmado") {
    return "Positiva";
  }
  if (value === "rejeitado") {
    return "Negativa";
  }
  if (value === "aguardando_confirmacao") {
    return "Aguardando";
  }
  if (value === "erro_envio") {
    return "Erro ao enviar";
  }
  if (value === "envio_manual") {
    return "Envio manual";
  }
  return sent ? "Solicitado ao SGP" : "Sem solicitacao";
}

function canRequestConfirmation(item) {
  if (item.origem !== "sgp" || !String(item.osId || "").trim()) {
    return false;
  }
  if (!item.data) return false;
  return Boolean(getDisplayTechnicianName(item.tecnico));
}

function updateSelectionControls() {
  if (!elements.sendConfirmationButton || !elements.sendSelectionCount) {
    return;
  }

  let count = 0;
  for (const id of state.selectedScheduleIds) {
    const item = state.schedulesById.get(id);
    if (item && canRequestConfirmation(item)) {
      count += 1;
    }
  }

  elements.sendSelectionCount.textContent = count ? `${count} selecionada(s)` : "Nenhuma selecionada";
  elements.sendConfirmationButton.disabled = count === 0 || state.sendingConfirmation;
  elements.sendConfirmationButton.textContent = state.sendingConfirmation ? "Enviando..." : "Enviar confirmacao";
}

function canDeleteSchedule(item) {
  return item.origem === "pre_agendamento_local" || (item.origem === "sgp" && item.osId);
}

function getDisplayTechnicianName(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const placeholderValues = new Set(["nao definido", "não definido", "a definir", "-"]);
  if (placeholderValues.has(normalized.toLowerCase())) {
    return "";
  }

  return normalized;
}

function buildScheduleSuccessMessage(data, payload, editing) {
  const reference = data.response?.os_id || data.response?.protocolo || data.response?.contratoId || payload.protocolo || payload.osId || "";
  const defaultMessage = editing
    ? (data.mode === "sgp"
        ? `OS ${payload.osId || payload.protocolo || ""} atualizada no SGP com sucesso.`
        : "Pre-agendamento local atualizado com sucesso.")
    : (data.mode === "sgp"
        ? "Ocorrencia e agendamento enviados ao SGP com sucesso."
        : "Pre-agendamento local salvo com sucesso.");
  const message = data.message || defaultMessage;
  const lines = [message];
  if (reference) {
    lines.push(`Referencia: ${reference}`);
  }
  if (data.confirmationUrl) {
    lines.push(`Link de confirmacao: ${data.confirmationUrl}`);
  }
  if (data.confirmationStatus) {
    lines.push(`Status da confirmacao: ${confirmationStatusLabel(data.confirmationStatus, data.confirmationSent)}`);
  }
  return lines.join("\n");
}

function formatTimeForInput(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized === "A definir") {
    return "";
  }
  return hhmm(normalized);
}

function renderClientLink(item, label) {
  if (!item.clienteUrl) {
    return escapeHtml(label);
  }
  return `<a class="client-link" href="${escapeHtml(item.clienteUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setContractLookupStatus(message, tone = "") {
  elements.contractLookupStatus.textContent = message || "";
  elements.contractLookupStatus.className = `field-hint${tone ? ` ${tone}` : ""}`;
}

function resetContractLookupState() {
  elements.scheduleForm.dataset.loadedContract = "";
  setContractLookupStatus("");
  elements.lookupContractButton.disabled = false;
  if (elements.osLookupList) {
    elements.osLookupList.innerHTML = "";
  }
  if (elements.scheduleForm.elements.osId) {
    elements.scheduleForm.elements.osId.value = "";
  }
}

function isEditingSchedule() {
  return Boolean(String(elements.scheduleForm.elements.id?.value || "").trim());
}

function setScheduleFormMode(mode) {
  const editing = mode === "edit";
  if (elements.scheduleFormTitle) {
    elements.scheduleFormTitle.textContent = editing ? "Editar Agendamento" : "Novo Agendamento";
  }
  if (elements.scheduleSubmitButton) {
    elements.scheduleSubmitButton.textContent = "Salvar";
  }
  if (elements.cancelEditButton) {
    elements.cancelEditButton.style.display = editing ? "" : "none";
  }
}

function fillScheduleFormFromSchedule(item) {
  const form = elements.scheduleForm.elements;
  form.id.value = item.id || "";
  form.osId.value = item.osId || "";
  form.origem.value = item.origem || "";
  form.cliente.value = item.cliente || "";
  form.contrato.value = item.contrato || "";
  form.telefone.value = item.telefone || "";
  form.protocolo.value = item.protocolo || item.osId || "";
  form.rota.value = item.rota || "";
  form.tecnico.value = getDisplayTechnicianName(item.tecnico);
  form.data.value = item.data || "";
  setFormTurno(elements.scheduleForm, inferTurnoFromTime(item.horario));
  form.endereco.value = item.endereco || "";
  form.observacao.value = item.observacao || "";
  elements.scheduleForm.dataset.loadedContract = item.contrato || "";
  setContractLookupStatus("Agendamento carregado para edicao.", "success");
  setScheduleFormMode("edit");
  elements.scheduleForm.scrollIntoView({ behavior: "smooth", block: "start" });
  updateSlotConflictFromForm();
}

function resetScheduleForm() {
  const today = toLocalIsoDate(new Date());
  elements.scheduleForm.reset();
  elements.scheduleForm.elements.id.value = "";
  elements.scheduleForm.elements.osId.value = "";
  elements.scheduleForm.elements.origem.value = "";
  elements.scheduleForm.elements.data.value = elements.startDateFilter.value || today;
  setFormTurno(elements.scheduleForm, "");
  resetContractLookupState();
  setScheduleFormMode("create");
  applySlotConflictUi([], getScheduleFormConflictContext());
}

function markScheduleFormForSgpEdit(osId) {
  const form = elements.scheduleForm;
  form.querySelector('input[name="id"]').value = `sgp-${osId}`;
  form.querySelector('input[name="osId"]').value = osId;
  form.querySelector('input[name="origem"]').value = "sgp";
  setScheduleFormMode("edit");
}

function statusLabel(status) {
  const map = {
    disponivel: "Pre-agendada",
    agendado: "Agendamento",
    itinerario: "Itinerario",
    pre_agendado: "Pre-agendada",
    indisponivel: "Pre-agendada",
    bloqueado: "Bloqueado",
    total: "Total"
  };
  return map[status] || status;
}

function renderTable(rows) {
  elements.tableCount.textContent = `${rows.length} registros`;
  if (!rows.length) {
    elements.scheduleTableBody.innerHTML = `<tr><td class="empty-state" colspan="6">Nenhum agendamento encontrado para os filtros atuais.</td></tr>`;
    return;
  }

  elements.scheduleTableBody.innerHTML = rows
    .map(
      (item) => `
        <tr class="schedule-row${item.duplicatePeriod ? " is-duplicate-period" : ""}">
          <td>${formatDate(item.data)}</td>
          <td>${item.horario || "-"}</td>
          <td>
            <strong>${renderClientLink(item, item.cliente)}</strong><br />
            <span class="muted">${item.protocolo || item.contrato || "-"}${item.createdBy ? `<br />Por: ${escapeHtml(String(item.createdBy))}` : ""}</span>
          </td>
          <td>${item.rota || "-"}</td>
          <td>${item.tecnico || "-"}</td>
          <td><span class="badge neutral">${statusLabel(item.status)}</span></td>
        </tr>
      `
    )
    .join("");
}

function updateMeta(data) {
  const rawVersion = String(data.dashboardVersion || data.version || "").trim();
  const versionLabel = rawVersion ? (rawVersion.startsWith("v") ? rawVersion : `v${rawVersion}`) : "";
  elements.snapshotLabel.innerHTML = versionLabel
    ? `Atualizado em ${escapeHtml(formatDateTime(data.generatedAt))}<br /><span class="dash-version">Versao ${escapeHtml(versionLabel)}</span>`
    : `Atualizado em ${escapeHtml(formatDateTime(data.generatedAt))}`;
  elements.sourceBadge.className = `badge ${badgeClassForSource(data.sourceMode)}`;
  elements.sourceBadge.textContent = sourceLabel(data.sourceMode);
  elements.weekRange.textContent = `${formatDate(data.period.weekStart)} ate ${formatDate(data.period.weekEnd)}`;

  if (data.capabilities.canWriteToSgp) {
    elements.writeModeBadge.className = "badge success";
    elements.writeModeBadge.textContent = "Escrita no SGP";
  } else if (data.capabilities.canSavePreScheduling) {
    elements.writeModeBadge.className = "badge warning";
    elements.writeModeBadge.textContent = "Pre-agendamento local";
  } else {
    elements.writeModeBadge.className = "badge danger";
    elements.writeModeBadge.textContent = "Somente leitura";
  }
}

async function loadDashboard() {
  const params = new URLSearchParams();
  if (elements.startDateFilter.value) {
    params.set("data", elements.startDateFilter.value);
    params.set("inicio", elements.startDateFilter.value);
  }
  if (elements.endDateFilter.value) {
    params.set("fim", elements.endDateFilter.value);
  }
  if (elements.statusFilter.value) {
    params.set("status", elements.statusFilter.value);
  }
  const selectedRoutes = getSelectedRoutes();
  if (selectedRoutes.length) {
    params.set("pops", selectedRoutes.join(","));
  }
  if (elements.searchFilter.value.trim()) {
    params.set("busca", elements.searchFilter.value.trim());
  }

  const response = await apiFetch(`/api/dashboard-data?${params.toString()}`);
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.message || "Nao foi possivel atualizar o dashboard.");
  }
  state.data = data;
  state.isAdmin = data.isAdmin || false;
  state.autoRefreshMs = Math.max(30000, Number(data.autoRefreshSeconds || 300) * 1000);
  updateAdminUiVisibility();
  renderRouteFilter(data.availableRoutes || [], data.filters?.pops || selectedRoutes);
  renderBlockPopSelect(data.availableRoutes || []);
  state.schedulesById = new Map(data.schedules.map((item) => [item.id, item]));
  state.selectedScheduleIds = new Set(
    [...state.selectedScheduleIds].filter((id) => state.schedulesById.has(id))
  );

  renderSummary(data.summary);
  renderNotices(data.notices);
  renderCalendar(data.grid);
  renderTable(data.schedules);
  updateMeta(data);
  updateSelectionControls();
  if (state.isAdmin && state.compactView) {
    updateCompactView();
  }
  updateSlotConflictFromForm();

  if (data.period?.weekStart && elements.startDateFilter.value !== data.period.weekStart) {
    elements.startDateFilter.value = data.period.weekStart;
  }
  if (data.period?.weekEnd && elements.endDateFilter.value !== data.period.weekEnd) {
    elements.endDateFilter.value = data.period.weekEnd;
  }
}

function scheduleNextAutoRefresh() {
  if (state.autoRefreshTimer) {
    window.clearTimeout(state.autoRefreshTimer);
  }
  state.autoRefreshTimer = window.setTimeout(() => {
    void autoRefreshDashboard();
  }, state.autoRefreshMs);
}

async function autoRefreshDashboard() {
  if (document.hidden || state.pendingMutations > 0 || state.sendingConfirmation || state.refreshing) {
    scheduleNextAutoRefresh();
    return;
  }

  await refreshDashboard({ silent: true });
}

async function refreshDashboard(options = {}) {
  const silent = Boolean(options.silent);
  if (state.refreshing) {
    return;
  }
  state.refreshing = true;

  if (elements.refreshButton && !silent) {
    elements.refreshButton.disabled = true;
    elements.refreshButton.textContent = "Atualizando...";
  }

  try {
    await loadDashboard();
  } catch (error) {
    console.error(error);
    elements.noticeArea.innerHTML = `<div class="notice">Falha ao atualizar o dashboard: ${escapeHtml(error.message)}</div>`;
  } finally {
    state.refreshing = false;
    scheduleNextAutoRefresh();
    if (elements.refreshButton && !silent) {
      elements.refreshButton.disabled = false;
      elements.refreshButton.textContent = "Atualizar";
    }
  }
}

async function handleCalendarGridClick(event) {
  const expandButton = event.target.closest(".cell-expand-button");
  if (expandButton) {
    const cell = expandButton.closest(".calendar-cell");
    const overflow = cell?.querySelector(".calendar-cell-overflow");
    if (!cell || !overflow) {
      return;
    }
    const cellKey = expandButton.dataset.cellKey || cell.dataset.cellKey || "";
    const isExpanded = !overflow.hasAttribute("hidden");
    if (isExpanded) {
      overflow.setAttribute("hidden", "");
      cell.classList.remove("is-expanded");
      expandButton.setAttribute("aria-expanded", "false");
      if (cellKey) {
        state.expandedCalendarCells.delete(cellKey);
      }
      expandButton.textContent = expandButton.dataset.collapsedLabel || expandButton.textContent;
      const firstChip = cell.querySelector(".chip");
      if (firstChip && typeof firstChip.focus === "function") {
        firstChip.focus();
      }
    } else {
      if (!expandButton.dataset.collapsedLabel) {
        expandButton.dataset.collapsedLabel = expandButton.textContent;
      }
      overflow.removeAttribute("hidden");
      cell.classList.add("is-expanded");
      expandButton.setAttribute("aria-expanded", "true");
      expandButton.textContent = "Recolher";
      if (cellKey) {
        state.expandedCalendarCells.add(cellKey);
      }
    }
    return;
  }

  const unblockButton = event.target.closest(".chip-unblock-button");
  if (unblockButton) {
    const id = unblockButton.dataset.blockId || "";
    if (!id) {
      return;
    }
    if (!confirm("Remover bloqueio deste horario?")) {
      return;
    }
    unblockButton.disabled = true;
    try {
      const response = await apiFetch("/api/bloqueios/delete", {
        method: "POST",
        body: JSON.stringify({ id })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message || "Falha ao remover bloqueio.");
      showToast(data.message || "Bloqueio removido.");
      await loadDashboard();
    } catch (error) {
      alert(error.message);
    } finally {
      unblockButton.disabled = false;
    }
    return;
  }

  const selectButton = event.target.closest(".chip-select-button");
  if (selectButton) {
    const scheduleId = selectButton.dataset.selectScheduleId || "";
    const item = state.schedulesById.get(scheduleId);
    if (!item) {
      return;
    }
    if (!canRequestConfirmation(item)) {
      showToast("Confirmacao so pode ser enviada quando data de agendamento e tecnico estiverem preenchidos.");
      return;
    }

    if (state.selectedScheduleIds.has(scheduleId)) {
      state.selectedScheduleIds.delete(scheduleId);
    } else {
      state.selectedScheduleIds.add(scheduleId);
    }

    renderCalendar(state.data.grid);
    updateSelectionControls();
    return;
  }

  const button = event.target.closest(".chip-delete-button");
  if (!button) {
    return;
  }

  const scheduleId = button.dataset.scheduleId || "";
  const item = state.schedulesById.get(scheduleId);
  if (!item) {
    alert("Nao foi possivel localizar o agendamento.");
    return;
  }

  fillScheduleFormFromSchedule(item);
}

async function submitEditSchedule(event) {
  event.preventDefault();
  if (!String(elements.editScheduleForm.elements.horario?.value || "").trim()) {
    alert("Selecione Manhã ou Tarde para definir o horário.");
    return;
  }
  const formData = new FormData(elements.editScheduleForm);
  const payload = Object.fromEntries(formData.entries());
  if (payload.id) {
    const current = state.schedulesById.get(String(payload.id));
    if (current?.createdBy) {
      payload.createdBy = current.createdBy;
    }
  }
  const btn = elements.editScheduleForm.querySelector("button[type=submit]");
  await persistSchedulePayload({
    payload,
    endpoint: "/api/agendamentos/edit",
    editing: true,
    button: btn,
    onSuccess: async (data) => {
      alert(buildScheduleSuccessMessage(data, payload, true));
      elements.scheduleModal.close();
      await loadDashboard();
    },
    onError: async (error) => {
      const detail = error?.details?.detail ? `\n${error.details.detail}` : "";
      alert(`${error.message}${detail}`);
      await loadDashboard().catch(() => {});
    }
  });
}

async function submitCancelSchedule(event) {
  event.preventDefault();
  const formData = new FormData(elements.cancelScheduleForm);
  const motivo = formData.get("motivo");
  const observacao = formData.get("observacao");
  const id = elements.editScheduleForm.elements.id.value;
  const osId = elements.editScheduleForm.elements.osId.value;
  const origem = elements.editScheduleForm.elements.origem.value;

  const btn = elements.cancelScheduleForm.querySelector("button[type=submit]");
  btn.disabled = true;
  state.pendingMutations += 1;

  try {
    const response = await apiFetch("/api/agendamentos/delete", {
      method: "POST",
      body: JSON.stringify({ id, osId, origem, motivo, observacao })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.message || "Falha ao excluir agendamento.");
    alert(data.message || "Agendamento encerrado/cancelado com sucesso.");
    elements.scheduleModal.close();
    await loadDashboard();
  } catch (error) {
    alert(error.message);
  } finally {
    state.pendingMutations = Math.max(0, state.pendingMutations - 1);
    btn.disabled = false;
  }
}

async function submitSchedule(event) {
  event.preventDefault();
  if (!String(elements.scheduleForm.elements.horario?.value || "").trim()) {
    alert("Selecione Manhã ou Tarde para definir o horário.");
    return;
  }
  updateSlotConflictFromForm();
  if (state.slotConflictActive) {
    alert("Horario ocupado ou nao validado. Ajuste POP/Data/Horario para continuar.");
    return;
  }
  const periodDecision = await maybeWarnPeriodConflictsForScheduleForm();
  if (!periodDecision.shouldProceed) {
    return;
  }
  const formData = new FormData(elements.scheduleForm);
  const payload = Object.fromEntries(formData.entries());
  if (periodDecision.duplicatePeriod) {
    payload.duplicatePeriod = true;
  }
  const editing = isEditingSchedule();
  if (editing && payload.id) {
    const current = state.schedulesById.get(String(payload.id));
    if (current?.createdBy) {
      payload.createdBy = current.createdBy;
    }
  }
  const endpoint = editing ? "/api/agendamentos/edit" : "/api/agendamentos";
  const button = elements.scheduleSubmitButton || elements.scheduleForm.querySelector("button[type=submit]");
  await persistSchedulePayload({
    payload,
    endpoint,
    editing,
    button,
    onSuccess: async (data) => {
      alert(buildScheduleSuccessMessage(data, payload, editing));
      resetScheduleForm();
      await loadDashboard();
    },
    onError: async (error) => {
      if (String(error?.code || "") === "SLOT_OCCUPIED") {
        const context = getScheduleFormConflictContext();
        const conflicts = Array.isArray(error?.details?.conflicts) ? error.details.conflicts : [];
        applySlotConflictUi(conflicts, context);
        const detail = error?.details?.detail ? `\n${error.details.detail}` : "";
        alert(`${error.message}${detail}`);
        return;
      }
      applySlotConflictUi([], getScheduleFormConflictContext());
      alert(error.message);
      if (editing) {
        await loadDashboard().catch(() => {});
      }
    }
  });
}

async function submitBlockSlot(event) {
  event.preventDefault();
  if (!elements.blockSlotForm) {
    return;
  }
  const formData = new FormData(elements.blockSlotForm);
  const payload = Object.fromEntries(formData.entries());
  if (payload.horario_inicio && !payload.horario_fim) {
    payload.horario_fim = payload.horario_inicio;
  }
  const button = elements.blockSlotSubmitButton || elements.blockSlotForm.querySelector("button[type=submit]");
  if (button) {
    button.disabled = true;
  }
  setBlockSlotStatus("Bloqueando...", "");

  try {
    const response = await apiFetch("/api/bloqueios", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      const message = data?.message || "Falha ao bloquear horario.";
      const error = new Error(message);
      error.code = String(data?.code || "");
      throw error;
    }
    setBlockSlotStatus(data.message || "Horario bloqueado.", "success");
    showToast(data.message || "Horario bloqueado.");
    await loadDashboard();
  } catch (error) {
    const message = error.message || "Falha ao bloquear horario.";
    setBlockSlotStatus(message, "error");
    alert(message);
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

async function sendSelectedConfirmations(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  const items = [...state.selectedScheduleIds]
    .map((id) => state.schedulesById.get(id))
    .filter((item) => item && canRequestConfirmation(item));

  if (!items.length) {
    updateSelectionControls();
    return;
  }

  state.sendingConfirmation = true;
  state.pendingMutations += 1;
  updateSelectionControls();

  try {
    const response = await apiFetch("/api/agendamentos/send-confirmation", {
      method: "POST",
      body: JSON.stringify({ items })
    });
    const responseText = await response.text();
    let data = null;
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch (error) {
      throw new Error(`Resposta inesperada do servidor ao enviar confirmacao (${response.status}).`);
    }
    if (!response.ok || !data.ok) {
      throw new Error(data.message || "Falha ao solicitar envio de confirmacao.");
    }

    const queuedIds = new Set((data.queued || []).map((item) => String(item.id || "").trim()).filter(Boolean));
    for (const id of queuedIds) {
      const current = state.schedulesById.get(id);
      if (!current) {
        continue;
      }
      current.confirmationStatus = "na_fila_envio";
      current.confirmationSent = false;
    }
    state.selectedScheduleIds.clear();
    renderCalendar(state.data.grid);
    updateSelectionControls();

    const skippedCount = Array.isArray(data.skipped) ? data.skipped.length : 0;
    alert(skippedCount ? `${data.message}\n${skippedCount} item(ns) foi(ram) ignorado(s).` : data.message);
    await loadDashboard();
  } catch (error) {
    alert(error.message);
  } finally {
    state.sendingConfirmation = false;
    state.pendingMutations = Math.max(0, state.pendingMutations - 1);
    updateSelectionControls();
  }
}

async function persistSchedulePayload({ payload, endpoint, editing, button, onSuccess, onError }) {
  if (button) {
    button.disabled = true;
  }
  state.pendingMutations += 1;
  updateScheduleSubmitButtonState();

  try {
    const response = await apiFetch(endpoint, {
      method: "POST",
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      const message = data?.message || (editing ? "Falha ao editar agendamento." : "Falha ao salvar agendamento.");
      const error = new Error(message);
      error.code = String(data?.code || "");
      error.details = data;
      error.status = response.status;
      throw error;
    }

    await onSuccess(data);
  } catch (error) {
    await onError(error);
  } finally {
    state.pendingMutations = Math.max(0, state.pendingMutations - 1);
    updateScheduleSubmitButtonState();
  }
}

function showToast(message) {
  const container = document.querySelector(".toast-container") || document.createElement("div");
  if (!container.className) {
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = "toast success";
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function fillScheduleFormFromContract(contract, openOses = []) {
  if (contract.cliente) {
    elements.scheduleForm.elements.cliente.value = contract.cliente;
  }
  if (contract.telefone) {
    elements.scheduleForm.elements.telefone.value = contract.telefone;
  }
  if (contract.rota) {
    elements.scheduleForm.elements.rota.value = contract.rota;
  }
  if (contract.endereco) {
    elements.scheduleForm.elements.endereco.value = contract.endereco;
  }

  // Clear previous list
  if (elements.osLookupList) {
    elements.osLookupList.innerHTML = "";
  }

  if (openOses && openOses.length > 0) {
    const top3 = openOses.slice(0, 3);
    for (const os of top3) {
      const item = document.createElement("div");
      item.className = "os-suggestion-item";

      // ── Linha 1: ID clicável + ícone de link externo ──
      const header = document.createElement("div");
      header.className = "os-suggestion-header";

      const badge = document.createElement("span");
      badge.className = "os-badge-click";
      badge.textContent = `OS #${os.osId}`;
      badge.title = "Clique para preencher o formulário com esta OS";

      const link = document.createElement("a");
      link.href = os.osUrl || "#";
      link.target = "_blank";
      link.className = "os-link-icon";
      link.innerHTML = "🔗";
      link.title = "Abrir OS no SGP";
      link.onclick = (e) => e.stopPropagation();

      header.appendChild(badge);
      if (os.osUrl) header.appendChild(link);
      item.appendChild(header);

      // ── Linha 2: Motivo (assunto principal em destaque) ──
      if (os.assunto) {
        const assuntoEl = document.createElement("span");
        assuntoEl.className = "os-detail assunto";
        assuntoEl.textContent = os.assunto;
        item.appendChild(assuntoEl);
      }

      // ── Linha 3: Tipo + Data de abertura + Hora ──
      const meta = [];
      if (os.tipo) meta.push(os.tipo);
      if (os.data_abertura) {
        const d = os.data_abertura.substring(0, 10).split("-").reverse().join("/");
        meta.push(`Aberta: ${d}`);
      }
      if (os.status) meta.push(`Status: ${os.status}`);
      if (meta.length > 0) {
        const detail = document.createElement("span");
        detail.className = "os-detail";
        detail.textContent = meta.join(" · ");
        item.appendChild(detail);
      }

      // ── Linha 4: Responsável, POP e Data agendada ──
      const extra = [];
      if (os.responsavel) extra.push(`👤 ${os.responsavel}`);
      if (os.pop) extra.push(`📍 ${os.pop}`);
      if (os.data_agendamento && os.data_agendamento !== "0000-00-00") {
        const da = os.data_agendamento.substring(0, 10).split("-").reverse().join("/");
        const ha = os.hora_agendamento && os.hora_agendamento !== "00:00:00"
          ? ` às ${os.hora_agendamento.substring(0, 5)}`
          : "";
        extra.push(`📅 Agendamento: ${da}${ha}`);
      }
      if (extra.length > 0) {
        const extraEl = document.createElement("span");
        extraEl.className = "os-detail";
        extraEl.textContent = extra.join("  ");
        item.appendChild(extraEl);
      }

      // ── Clique no card: preenche cada campo separadamente ──
      item.onclick = (e) => {
        if (e.target.tagName === "A") return; // não intercepta o link externo

        const f = elements.scheduleForm.elements;

        // Entra em modo de edicao de OS no SGP
        markScheduleFormForSgpEdit(os.osId);

        // Protocolo / Ordem de Serviço
        if (f.protocolo) f.protocolo.value = os.osId;

        // POP → campo "rota"
        if (os.pop && f.rota) f.rota.value = os.pop;

        // Técnico responsável
        if (os.responsavel && f.tecnico) f.tecnico.value = os.responsavel;

        // Data do agendamento (se existir na OS e for válida)
        if (os.data_agendamento && os.data_agendamento !== "0000-00-00" && f.data) {
          f.data.value = os.data_agendamento.substring(0, 10);
        }

        // Horário do agendamento; se não existir, usa a hora de abertura como fallback visual
        if (f.horario) {
          const referenceTime =
            os.hora_agendamento && os.hora_agendamento !== "00:00:00"
              ? os.hora_agendamento
              : os.hora_abertura || "";
          setFormTurno(elements.scheduleForm, inferTurnoFromTime(referenceTime));
        }

        // Observação → apenas o descritivo da OS (limpo)
        if (f.observacao) {
          f.observacao.value = os.descritivo
            ? os.descritivo.replace(/\r\n/g, "\n").trim()
            : "";
        }

        // Destaca o card selecionado
        document.querySelectorAll(".os-suggestion-item").forEach(el => {
          el.style.background = "";
          el.style.borderColor = "";
        });
        item.style.background = "#dbeafe";
        item.style.borderColor = "#3b82f6";

        setContractLookupStatus(`OS #${os.osId} carregada para edicao no SGP.`, "success");
        elements.scheduleForm.scrollIntoView({ behavior: "smooth", block: "start" });
        showToast(`OS #${os.osId} selecionada — campos preenchidos.`);
      };


      if (elements.osLookupList) {
        elements.osLookupList.appendChild(item);
      }
    }
  } else {
    if (elements.scheduleForm.elements.osId) {
      elements.scheduleForm.elements.osId.value = "";
    }
  }
}

async function lookupContractAndFill() {
  const contractId = elements.scheduleForm.elements.contrato.value.trim();
  if (!contractId) {
    resetContractLookupState();
    return;
  }

  if (elements.scheduleForm.dataset.loadedContract === contractId) {
    return;
  }

  elements.lookupContractButton.disabled = true;
  setContractLookupStatus("Buscando contrato no SGP...");

  try {
    const response = await apiFetch(`/api/contrato?contrato=${encodeURIComponent(contractId)}`);
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.message || "Nao foi possivel consultar o contrato.");
    }

    fillScheduleFormFromContract(data.contract, data.openOses);
    elements.scheduleForm.dataset.loadedContract = contractId;
    setContractLookupStatus("Dados do contrato carregados do SGP.", "success");
  } catch (error) {
    elements.scheduleForm.dataset.loadedContract = "";
    setContractLookupStatus(error.message, "error");
  } finally {
    elements.lookupContractButton.disabled = false;
  }
}

function wireEvents() {
  elements.refreshButton.addEventListener("click", refreshDashboard);
  elements.prevWeekButton.addEventListener("click", () => navigateWeek(-7));
  elements.nextWeekButton.addEventListener("click", () => navigateWeek(7));
  elements.statusFilter.addEventListener("change", refreshDashboard);
  if (elements.routeFilter) {
    elements.routeFilter.addEventListener("change", () => {
      const selectedRoutes = getSelectedRoutes();
      if (isTechnicianRouteModeEnabled() && selectedRoutes.length === 1) {
        const selectedPop = selectedRoutes[0];
        const technician = findTechnicianForPop(selectedPop);
        const pops = technician ? findPopsForTechnician(technician) : [];
        if (pops.length) {
          applySelectedRoutes(pops);
        }
      }
      refreshDashboard();
    });
  }
  if (elements.routeModeTechnician) {
    elements.routeModeTechnician.addEventListener("change", () => {
      if (isTechnicianRouteModeEnabled()) {
        const selectedRoutes = getSelectedRoutes();
        if (selectedRoutes.length === 1) {
          const technician = findTechnicianForPop(selectedRoutes[0]);
          const pops = technician ? findPopsForTechnician(technician) : [];
          if (pops.length) {
            applySelectedRoutes(pops);
          }
        }
      }
      refreshDashboard();
    });
  }
  if (elements.routeModePop) {
    elements.routeModePop.addEventListener("change", refreshDashboard);
  }
  elements.startDateFilter.addEventListener("change", () => {
    applySevenDayWindowFromStartDate(elements.startDateFilter.value);
    refreshDashboard();
  });
  elements.searchFilter.addEventListener("input", debounce(refreshDashboard, 250));
  elements.scheduleForm.addEventListener("submit", submitSchedule);
  const debouncedConflictUpdate = debounce(updateSlotConflictFromForm, 120);
  if (elements.scheduleForm?.elements?.rota) {
    elements.scheduleForm.elements.rota.addEventListener("input", debouncedConflictUpdate);
  }
  if (elements.scheduleForm?.elements?.data) {
    elements.scheduleForm.elements.data.addEventListener("change", debouncedConflictUpdate);
  }
  wireTurnoGroup(elements.scheduleForm, () => debouncedConflictUpdate());
  elements.calendarGrid.addEventListener("click", handleCalendarGridClick);
  if (elements.sendConfirmationButton) {
    elements.sendConfirmationButton.addEventListener("click", sendSelectedConfirmations);
  }
  elements.lookupContractButton.addEventListener("click", lookupContractAndFill);
  if (elements.cancelEditButton) {
    elements.cancelEditButton.addEventListener("click", resetScheduleForm);
  }
  if (elements.blockSlotForm) {
    elements.blockSlotForm.addEventListener("submit", submitBlockSlot);
  }
  elements.scheduleForm.elements.contrato.addEventListener("blur", lookupContractAndFill);
  elements.scheduleForm.elements.contrato.addEventListener("input", () => {
    elements.scheduleForm.dataset.loadedContract = "";
    setContractLookupStatus("");
  });

  if (elements.closeModalBtn) {
    elements.closeModalBtn.addEventListener("click", () => elements.scheduleModal.close());
  }

  if (elements.periodConflictCancelButton) {
    elements.periodConflictCancelButton.addEventListener("click", () => closePeriodConflictModal(false));
  }
  if (elements.periodConflictProceedButton) {
    elements.periodConflictProceedButton.addEventListener("click", () => closePeriodConflictModal(true));
  }
  if (elements.periodConflictModal) {
    elements.periodConflictModal.addEventListener("click", (event) => {
      if (event.target === elements.periodConflictModal) {
        closePeriodConflictModal(false);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (elements.periodConflictModal.classList.contains("active")) {
        closePeriodConflictModal(false);
      }
    });
  }

  if (elements.tabButtons) {
    elements.tabButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        elements.tabButtons.forEach(b => b.classList.remove("active"));
        elements.tabContents.forEach(c => c.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(btn.dataset.tab).classList.add("active");
      });
    });
  }

  if (elements.editScheduleForm) {
    elements.editScheduleForm.addEventListener("submit", submitEditSchedule);
    wireTurnoGroup(elements.editScheduleForm);
  }
  if (elements.cancelScheduleForm) {
    elements.cancelScheduleForm.addEventListener("submit", submitCancelSchedule);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleNextAutoRefresh();
      void autoRefreshDashboard();
    }
  });
}

function navigateWeek(offsetDays) {
  if (!elements.startDateFilter.value || !elements.endDateFilter.value) {
    return;
  }
  const nextReference = shiftDate(elements.startDateFilter.value, offsetDays);
  applySevenDayWindowFromStartDate(nextReference);
  refreshDashboard();
}

function debounce(fn, wait) {
  let timeoutId = null;
  return (...args) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => fn(...args), wait);
  };
}

async function init() {
  const user = await checkAuth();
  
  if (elements.loginForm) {
    elements.loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      
      const username = elements.loginUsername?.value || "";
      const password = elements.loginPassword?.value || "";
      
      if (!username || !password) {
        if (elements.loginError) {
          elements.loginError.textContent = "Preencha usuario e senha.";
          elements.loginError.style.display = "block";
        }
        return;
      }
      
      if (elements.loginButton) {
        elements.loginButton.disabled = true;
        elements.loginButton.textContent = "Entrando...";
      }
      if (elements.loginError) {
        elements.loginError.style.display = "none";
      }
      
      try {
        const loggedUser = await login(username, password);
        showMainApp();
        initMainApp();
      } catch (error) {
        if (elements.loginError) {
          elements.loginError.textContent = error.message || "Falha na autenticacao.";
          elements.loginError.style.display = "block";
        }
      } finally {
        if (elements.loginButton) {
          elements.loginButton.disabled = false;
          elements.loginButton.textContent = "Entrar";
        }
      }
    });
  }
  
  if (user) {
    showMainApp();
    initMainApp();
  } else {
    showLoginScreen();
  }
}

function updateAdminUiVisibility() {
  if (state.isAdmin) {
    document.body.classList.add("is-admin");
    if (elements.userBadge) {
      elements.userBadge.textContent = "Admin";
      elements.userBadge.className = "badge success";
      elements.userBadge.style.display = "inline-block";
    }
    if (elements.toggleCompactView) {
      elements.toggleCompactView.style.display = "inline-block";
    }
    state.compactView = true;
    updateCompactView();
  } else {
    document.body.classList.remove("is-admin");
    if (elements.userBadge) {
      elements.userBadge.textContent = "Operador";
      elements.userBadge.className = "badge neutral";
      elements.userBadge.style.display = "inline-block";
    }
    if (elements.toggleCompactView) {
      elements.toggleCompactView.style.display = "none";
    }
  }
}

function updateCompactView() {
  const summaryCards = document.querySelector("#summaryCards");
  const toggle = elements.toggleCompactView;

  if (state.compactView) {
    if (summaryCards) {
      summaryCards.style.display = "grid";
      const cards = summaryCards.querySelectorAll(".summary-card");
      cards.forEach((card) => {
        const text = card.querySelector("span")?.textContent || "";
        const key = Object.entries({ agendado: "Agendamentos", itinerario: "Itinerario", pre_agendado: "Pre-agendadas" }).find(([, v]) => text.includes(v))?.[0];
        card.style.display = (key === "agendado" || key === "itinerario" || key === "pre_agendado") ? "" : "none";
      });
    }
    if (toggle) toggle.classList.add("is-active");
  } else {
    if (summaryCards) {
      summaryCards.style.display = "";
      const cards = summaryCards.querySelectorAll(".summary-card");
      cards.forEach((card) => {
        card.style.display = "";
      });
    }
    if (toggle) toggle.classList.remove("is-active");
  }
}

function initMainApp() {
  updateAdminUiVisibility();
  const today = toLocalIsoDate(new Date());
  applySevenDayWindowFromStartDate(today);
  if (elements.blockSlotForm?.elements?.data) {
    elements.blockSlotForm.elements.data.value = today;
  }
  if (elements.blockRotaSelect) {
    elements.blockRotaSelect.innerHTML = `<option value="">Carregando...</option>`;
  }
  setBlockSlotStatus("");
  resetScheduleForm();
  wireEvents();

  if (elements.toggleCompactView) {
    elements.toggleCompactView.addEventListener("click", () => {
      state.compactView = !state.compactView;
      updateCompactView();
    });
  }

  state.darkMode = localStorage.getItem("darkMode") === "true";
  if (state.darkMode) {
    document.body.classList.add("dark");
    if (elements.toggleDarkMode) elements.toggleDarkMode.classList.add("is-active");
  }
  if (elements.toggleDarkMode) {
    elements.toggleDarkMode.addEventListener("click", () => {
      state.darkMode = !state.darkMode;
      document.body.classList.toggle("dark", state.darkMode);
      elements.toggleDarkMode.classList.toggle("is-active", state.darkMode);
      localStorage.setItem("darkMode", state.darkMode);
    });
  }

  if (elements.logoutButton) {
    elements.logoutButton.addEventListener("click", async () => {
      await logout();
      showLoginScreen();
    });
  }
  
  refreshDashboard().catch((error) => {
    console.error(error);
    if (elements.noticeArea) {
      elements.noticeArea.innerHTML = `<div class="notice">Falha ao carregar o dashboard: ${error.message}</div>`;
    }
  });
}

init();
