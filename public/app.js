const state = {
  data: null
};

const summaryConfig = [
  { key: "disponivel", label: "Horarios Disponiveis", className: "green" },
  { key: "agendado", label: "Agendamentos", className: "blue" },
  { key: "confirmado", label: "Confirmados", className: "cyan" },
  { key: "indisponivel", label: "Indisponiveis", className: "red" },
  { key: "pre_agendado", label: "Pre-agendados Locais", className: "amber" }
];

const elements = {
  dateFilter: document.querySelector("#dateFilter"),
  statusFilter: document.querySelector("#statusFilter"),
  searchFilter: document.querySelector("#searchFilter"),
  refreshButton: document.querySelector("#refreshButton"),
  summaryCards: document.querySelector("#summaryCards"),
  calendarGrid: document.querySelector("#calendarGrid"),
  scheduleTableBody: document.querySelector("#scheduleTableBody"),
  tableCount: document.querySelector("#tableCount"),
  weekRange: document.querySelector("#weekRange"),
  sourceBadge: document.querySelector("#sourceBadge"),
  snapshotLabel: document.querySelector("#snapshotLabel"),
  writeModeBadge: document.querySelector("#writeModeBadge"),
  noticeArea: document.querySelector("#noticeArea"),
  scheduleForm: document.querySelector("#scheduleForm")
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
          ${items.length ? items.map(renderChip).join("") : '<span class="muted">Livre</span>'}
        </div>
      `);
    }
  }

  elements.calendarGrid.innerHTML = fragments.join("");
}

function renderChip(item) {
  return `
    <div class="chip ${item.status}">
      <strong>${item.cliente}</strong>
      <small>${item.rota} ${item.tecnico ? `· ${item.tecnico}` : ""}</small>
      <small>${statusLabel(item.status)}</small>
    </div>
  `;
}

function statusLabel(status) {
  const map = {
    disponivel: "Disponivel",
    agendado: "Agendado",
    confirmado: "Confirmado",
    indisponivel: "Indisponivel",
    pre_agendado: "Pre-agendamento local",
    cancelado: "Cancelado"
  };
  return map[status] || status;
}

function renderTable(rows) {
  elements.tableCount.textContent = `${rows.length} registros`;
  if (!rows.length) {
    elements.scheduleTableBody.innerHTML = `<tr><td class="empty-state" colspan="7">Nenhum agendamento encontrado para os filtros atuais.</td></tr>`;
    return;
  }

  elements.scheduleTableBody.innerHTML = rows
    .map(
      (item) => `
        <tr>
          <td>${formatDate(item.data)}</td>
          <td>${item.horario || "-"}</td>
          <td>
            <strong>${item.cliente}</strong><br />
            <span class="muted">${item.protocolo || item.contrato || "-"}</span>
          </td>
          <td>${item.rota || "-"}</td>
          <td>${item.tecnico || "-"}</td>
          <td><span class="badge neutral">${statusLabel(item.status)}</span></td>
          <td>${item.origem || "-"}</td>
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
  if (elements.dateFilter.value) {
    params.set("data", elements.dateFilter.value);
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

  renderSummary(data.summary);
  renderNotices(data.notices);
  renderCalendar(data.grid);
  renderTable(data.schedules);
  updateMeta(data);
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
  alert(data.message || "Operacao concluida.");
  if (data.ok) {
    elements.scheduleForm.reset();
    if (elements.dateFilter.value) {
      elements.scheduleForm.elements.data.value = elements.dateFilter.value;
    }
    await loadDashboard();
  }
}

function wireEvents() {
  elements.refreshButton.addEventListener("click", loadDashboard);
  elements.statusFilter.addEventListener("change", loadDashboard);
  elements.dateFilter.addEventListener("change", loadDashboard);
  elements.searchFilter.addEventListener("input", debounce(loadDashboard, 250));
  elements.scheduleForm.addEventListener("submit", submitSchedule);
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
  elements.dateFilter.value = today;
  elements.scheduleForm.elements.data.value = today;
  wireEvents();
  loadDashboard().catch((error) => {
    console.error(error);
    elements.noticeArea.innerHTML = `<div class="notice">Falha ao carregar o dashboard: ${error.message}</div>`;
  });
}

init();
