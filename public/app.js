const state = {
  data: null,
  schedulesById: new Map()
};

const summaryConfig = [
  { key: "agendado", label: "Agendadas", className: "blue" },
  { key: "pre_agendado", label: "Pre-agendadas", className: "amber" }
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
  scheduleTableBody: document.querySelector("#scheduleTableBody"),
  tableCount: document.querySelector("#tableCount"),
  weekRange: document.querySelector("#weekRange"),
  sourceBadge: document.querySelector("#sourceBadge"),
  snapshotLabel: document.querySelector("#snapshotLabel"),
  writeModeBadge: document.querySelector("#writeModeBadge"),
  noticeArea: document.querySelector("#noticeArea"),
  scheduleForm: document.querySelector("#scheduleForm"),
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
      const items = grid.cells[day.date]?.[slot] || [];
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
  const deleteButton = canDeleteSchedule(item)
    ? `<button class="chip-delete-button" type="button" data-schedule-id="${escapeHtml(item.id)}" aria-label="Acoes do agendamento">&#9998;</button>`
    : "";
  return `
    <div class="chip ${item.status}">
      <div class="chip-actions">${deleteButton}</div>
      <strong>${clientName}</strong>
      <small>${routeLabel}<br />${technicianLabel}</small>
    </div>
  `;
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
    const input = document.createElement("input");
    input.name = "protocolo";
    input.type = "text";
    elements.scheduleForm.elements.osId.replaceWith(input);
  }
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
  state.data = data;
  state.schedulesById = new Map(data.schedules.map((item) => [item.id, item]));

  renderSummary(data.summary);
  renderNotices(data.notices);
  renderCalendar(data.grid);
  renderTable(data.schedules);
  updateMeta(data);

  if (!elements.startDateFilter.value || elements.startDateFilter.value !== data.period.startDate) {
    elements.startDateFilter.value = data.period.startDate;
  }
  if (!elements.endDateFilter.value || elements.endDateFilter.value !== data.period.endDate) {
    elements.endDateFilter.value = data.period.endDate;
  }
}

async function handleCalendarGridClick(event) {
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

  elements.editScheduleForm.elements.id.value = item.id;
  elements.editScheduleForm.elements.osId.value = item.osId || "";
  elements.editScheduleForm.elements.origem.value = item.origem || "";
  elements.editScheduleForm.elements.setor.value = item.setor || "";
  elements.editScheduleForm.elements.tipo.value = item.tipo || "";
  elements.editScheduleForm.elements.motivo.value = item.motivo || "";
  elements.editScheduleForm.elements.prioridade.value = item.prioridade || "";
  elements.editScheduleForm.elements.data.value = item.data;
  elements.editScheduleForm.elements.horario.value = item.horario === "A definir" ? "" : item.horario;
  elements.editScheduleForm.elements.observacao.value = item.observacao || "";

  elements.cancelScheduleForm.reset();

  elements.scheduleModal.showModal();
}

async function submitEditSchedule(event) {
  event.preventDefault();
  const formData = new FormData(elements.editScheduleForm);
  const payload = Object.fromEntries(formData.entries());

  const btn = elements.editScheduleForm.querySelector("button[type=submit]");
  btn.disabled = true;

  try {
    const response = await fetch("/api/agendamentos/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.message || "Falha ao editar agendamento.");
    alert(data.message || "Agendamento atualizado.");
    elements.scheduleModal.close();
    await loadDashboard();
  } catch (error) {
    alert(error.message);
  } finally {
    btn.disabled = false;
  }
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
    btn.disabled = false;
  }
}

async function submitSchedule(event) {
  event.preventDefault();
  const formData = new FormData(elements.scheduleForm);
  const payload = Object.fromEntries(formData.entries());

  const response = await fetch("/api/agendamentos", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  const reference = data.response?.os_id || data.response?.protocolo || data.response?.contratoId || "";
  const message = reference ? `${data.message || "Operacao concluida."}\nReferencia: ${reference}` : (data.message || "Operacao concluida.");
  alert(message);
  if (data.ok) {
    elements.scheduleForm.reset();
    elements.scheduleForm.elements.data.value = elements.startDateFilter.value || new Date().toISOString().slice(0, 10);
    resetContractLookupState();
    await loadDashboard();
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
        const h = os.hora_abertura ? ` ${os.hora_abertura.substring(0, 5)}` : "";
        meta.push(`Aberta: ${d}${h}`);
      }
      if (os.status) meta.push(os.status);
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
        extra.push(`📅 ${da}`);
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

        // Horário (da hora_abertura da OS, se não houver hora_agendamento)
        if (os.hora_abertura && f.horario) {
          f.horario.value = os.hora_abertura.substring(0, 5);
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

        showToast(`OS #${os.osId} selecionada — campos preenchidos.`);
      };


      if (elements.osLookupList) {
        elements.osLookupList.appendChild(item);
      }
    }
  } else {
    if (elements.scheduleForm.elements.osId) {
      const input = document.createElement("input");
      input.name = "protocolo";
      input.type = "text";
      elements.scheduleForm.elements.osId.replaceWith(input);
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
  elements.refreshButton.addEventListener("click", loadDashboard);
  elements.prevWeekButton.addEventListener("click", () => navigateWeek(-7));
  elements.nextWeekButton.addEventListener("click", () => navigateWeek(7));
  elements.statusFilter.addEventListener("change", loadDashboard);
  elements.startDateFilter.addEventListener("change", loadDashboard);
  elements.endDateFilter.addEventListener("change", loadDashboard);
  elements.searchFilter.addEventListener("input", debounce(loadDashboard, 250));
  elements.scheduleForm.addEventListener("submit", submitSchedule);
  elements.calendarGrid.addEventListener("click", handleCalendarGridClick);
  elements.lookupContractButton.addEventListener("click", lookupContractAndFill);
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
}

function navigateWeek(offsetDays) {
  if (!elements.startDateFilter.value || !elements.endDateFilter.value) {
    return;
  }
  elements.startDateFilter.value = shiftDate(elements.startDateFilter.value, offsetDays);
  elements.endDateFilter.value = shiftDate(elements.endDateFilter.value, offsetDays);
  loadDashboard();
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
  elements.scheduleForm.elements.data.value = today;
  resetContractLookupState();
  wireEvents();
  loadDashboard().catch((error) => {
    console.error(error);
    elements.noticeArea.innerHTML = `<div class="notice">Falha ao carregar o dashboard: ${error.message}</div>`;
  });
}

init();
