const state = {
  data: null
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
  return `
    <div class="chip ${item.status}">
      <strong>${clientName}</strong>
      <small>${item.rota} ${item.tecnico ? `· ${item.tecnico}` : ""}</small>
    </div>
  `;
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

function statusLabel(status) {
  const map = {
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
    elements.scheduleForm.elements.data.value = elements.startDateFilter.value || new Date().toISOString().slice(0, 10);
    await loadDashboard();
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
  wireEvents();
  loadDashboard().catch((error) => {
    console.error(error);
    elements.noticeArea.innerHTML = `<div class="notice">Falha ao carregar o dashboard: ${error.message}</div>`;
  });
}

init();
