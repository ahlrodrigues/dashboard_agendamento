const state = {
  data: null,
  schedulesById: new Map(),
  selectedScheduleIds: new Set(),
  sendingConfirmation: false,
  pendingMutations: 0,
  autoRefreshTimer: null,
  autoRefreshMs: 300000,
  refreshing: false
};

const summaryConfig = [
  { key: "agendado", label: "Agendadas", className: "blue" },
  { key: "pre_agendado", label: "Pre-agendadas", className: "amber" },
  { key: "confirmacao_solicitada", label: "Solicitadas confirmacao", className: "pink" },
  { key: "confirmacao_confirmada", label: "Confirmadas", className: "green" }
];

const elements = {
  startDateFilter: document.querySelector("#startDateFilter"),
  endDateFilter: document.querySelector("#endDateFilter"),
  statusFilter: document.querySelector("#statusFilter"),
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
  scheduleModal: document.querySelector("#scheduleModal"),
  closeModalBtn: document.querySelector("#closeModalBtn"),
  tabButtons: document.querySelectorAll(".tab-button"),
  tabContents: document.querySelectorAll(".tab-content"),
  editScheduleForm: document.querySelector("#editScheduleForm"),
  cancelScheduleForm: document.querySelector("#cancelScheduleForm"),
  osLookupList: document.querySelector("#osLookupList")
};

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

function shiftDate(dateText, days) {
  const date = new Date(`${dateText}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
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
  elements.summaryCards.innerHTML = summaryConfig
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
      const items = (grid.cells[day.date]?.[slot] || []).map((item) => state.schedulesById.get(item.id) || item);
      fragments.push(`
        <div class="calendar-cell">
          ${items.length ? items.map(renderChip).join("") : ""}
        </div>
      `);
    }
  }

  elements.calendarGrid.innerHTML = fragments.join("");
}

function renderChip(item) {
  const clientName = renderClientLink(item, item.cliente);
  const routeLabel = escapeHtml(item.rota || "");
  const technicianName = getDisplayTechnicianName(item.tecnico);
  const technicianLabel = technicianName ? `Tecnico: ${escapeHtml(technicianName)}` : "Tecnico:";
  const confirmationLabel = confirmationStatusLabel(item.confirmationStatus, item.confirmationSent);
  const confirmationTitle = item.confirmationTitle ? ` title="${escapeHtml(item.confirmationTitle)}"` : "";
  const selected = state.selectedScheduleIds.has(item.id);
  const canSendConfirmation = canRequestConfirmation(item);
  const selectTitle = canSendConfirmation
    ? (selected ? "Desmarcar OS para envio" : "Marcar OS para envio")
    : "OS indisponivel para envio";
  const deleteButton = canDeleteSchedule(item)
    ? `<button class="chip-delete-button" type="button" data-schedule-id="${escapeHtml(item.id)}" aria-label="Acoes do agendamento">&#9998;</button>`
    : "";
  return `
    <div class="chip ${item.status} ${confirmationStatusClass(item.confirmationStatus)}${selected ? " is-selected" : ""}"${confirmationTitle}>
      <div class="chip-actions">
        <button class="chip-select-button${selected ? " is-selected" : ""}${canSendConfirmation ? "" : " is-disabled"}" type="button" data-select-schedule-id="${escapeHtml(item.id)}" aria-pressed="${selected ? "true" : "false"}" aria-label="${escapeHtml(selectTitle)}" title="${escapeHtml(selectTitle)}">${selected ? "✓" : "+"}</button>
        ${deleteButton}
      </div>
      <strong>${clientName}</strong>
      <small>${routeLabel}<br />${technicianLabel}<br />Confirmacao: ${confirmationLabel}</small>
      <span class="chip-flag">${canSendConfirmation ? `OS ${escapeHtml(item.osId || item.protocolo || "")}` : "Envio indisponivel"}</span>
    </div>
  `;
}

function confirmationStatusClass(status) {
  const value = String(status || "").trim();
  if (value === "na_fila_envio") {
    return "confirmation-fila";
  }
  if (value === "processando_envio") {
    return "confirmation-processando";
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
  return sent ? "Solicitado ao SGP" : "Sem solicitacao";
}

function canRequestConfirmation(item) {
  return item.origem === "sgp" && String(item.osId || "").trim();
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
  if (/^\d{2}:\d{2}:\d{2}$/.test(normalized)) {
    return normalized;
  }
  if (/^\d{2}:\d{2}$/.test(normalized)) {
    return `${normalized}:00`;
  }
  return normalized;
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
  form.horario.value = formatTimeForInput(item.horario);
  form.endereco.value = item.endereco || "";
  form.observacao.value = item.observacao || "";
  elements.scheduleForm.dataset.loadedContract = item.contrato || "";
  setContractLookupStatus("Agendamento carregado para edicao.", "success");
  setScheduleFormMode("edit");
  elements.scheduleForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetScheduleForm() {
  const today = new Date().toISOString().slice(0, 10);
  elements.scheduleForm.reset();
  elements.scheduleForm.elements.id.value = "";
  elements.scheduleForm.elements.osId.value = "";
  elements.scheduleForm.elements.origem.value = "";
  elements.scheduleForm.elements.data.value = elements.startDateFilter.value || today;
  resetContractLookupState();
  setScheduleFormMode("create");
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
    agendado: "Agendada",
    pre_agendado: "Pre-agendada",
    indisponivel: "Pre-agendada",
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
        <tr>
          <td>${formatDate(item.data)}</td>
          <td>${item.horario || "-"}</td>
          <td>
            <strong>${renderClientLink(item, item.cliente)}</strong><br />
            <span class="muted">${item.protocolo || item.contrato || "-"}</span>
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
  elements.snapshotLabel.textContent = `Atualizado em ${formatDateTime(data.generatedAt)}`;
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
  if (elements.searchFilter.value.trim()) {
    params.set("busca", elements.searchFilter.value.trim());
  }

  const response = await fetch(`/api/dashboard-data?${params.toString()}`);
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.message || "Nao foi possivel atualizar o dashboard.");
  }
  state.data = data;
  state.autoRefreshMs = Math.max(30000, Number(data.autoRefreshSeconds || 300) * 1000);
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

  if (!elements.startDateFilter.value || elements.startDateFilter.value !== data.period.startDate) {
    elements.startDateFilter.value = data.period.startDate;
  }
  if (!elements.endDateFilter.value || elements.endDateFilter.value !== data.period.endDate) {
    elements.endDateFilter.value = data.period.endDate;
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
  const selectButton = event.target.closest(".chip-select-button");
  if (selectButton) {
    const scheduleId = selectButton.dataset.selectScheduleId || "";
    const item = state.schedulesById.get(scheduleId);
    if (!item) {
      return;
    }
    if (!canRequestConfirmation(item)) {
      showToast("Essa OS nao pode receber solicitacao de confirmacao.");
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
  const formData = new FormData(elements.editScheduleForm);
  const payload = Object.fromEntries(formData.entries());
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
      alert(error.message);
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
    const response = await fetch("/api/agendamentos/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  const formData = new FormData(elements.scheduleForm);
  const payload = Object.fromEntries(formData.entries());
  const editing = isEditingSchedule();
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
      alert(error.message);
      if (editing) {
        await loadDashboard().catch(() => {});
      }
    }
  });
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
    const response = await fetch("/api/agendamentos/send-confirmation", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
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

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.message || (editing ? "Falha ao editar agendamento." : "Falha ao salvar agendamento."));
    }

    await onSuccess(data);
  } catch (error) {
    await onError(error);
  } finally {
    state.pendingMutations = Math.max(0, state.pendingMutations - 1);
    if (button) {
      button.disabled = false;
    }
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
          if (os.hora_agendamento && os.hora_agendamento !== "00:00:00") {
            f.horario.value = formatTimeForInput(os.hora_agendamento);
          } else if (os.hora_abertura) {
            f.horario.value = formatTimeForInput(os.hora_abertura);
          }
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
    const response = await fetch(`/api/contrato?contrato=${encodeURIComponent(contractId)}`);
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
  elements.startDateFilter.addEventListener("change", refreshDashboard);
  elements.endDateFilter.addEventListener("change", refreshDashboard);
  elements.searchFilter.addEventListener("input", debounce(refreshDashboard, 250));
  elements.scheduleForm.addEventListener("submit", submitSchedule);
  elements.calendarGrid.addEventListener("click", handleCalendarGridClick);
  if (elements.sendConfirmationButton) {
    elements.sendConfirmationButton.addEventListener("click", sendSelectedConfirmations);
  }
  elements.lookupContractButton.addEventListener("click", lookupContractAndFill);
  if (elements.cancelEditButton) {
    elements.cancelEditButton.addEventListener("click", resetScheduleForm);
  }
  elements.scheduleForm.elements.contrato.addEventListener("blur", lookupContractAndFill);
  elements.scheduleForm.elements.contrato.addEventListener("input", () => {
    elements.scheduleForm.dataset.loadedContract = "";
    setContractLookupStatus("");
  });

  if (elements.closeModalBtn) {
    elements.closeModalBtn.addEventListener("click", () => elements.scheduleModal.close());
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
  elements.startDateFilter.value = shiftDate(elements.startDateFilter.value, offsetDays);
  elements.endDateFilter.value = shiftDate(elements.endDateFilter.value, offsetDays);
  refreshDashboard();
}

function debounce(fn, wait) {
  let timeoutId = null;
  return (...args) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => fn(...args), wait);
  };
}

function init() {
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date(`${today}T12:00:00`);
  end.setDate(end.getDate() + 14);
  elements.startDateFilter.value = today;
  elements.endDateFilter.value = end.toISOString().slice(0, 10);
  resetScheduleForm();
  wireEvents();
  refreshDashboard().catch((error) => {
    console.error(error);
    elements.noticeArea.innerHTML = `<div class="notice">Falha ao carregar o dashboard: ${error.message}</div>`;
  });
}

init();
