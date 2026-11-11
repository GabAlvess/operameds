const navLinks = [...document.querySelectorAll('.nav-link')];
const pages = [...document.querySelectorAll('.page')];
const breadcrumb = document.getElementById('crumbCurrent');
const sidebar = document.getElementById('sidebar');
const menuToggle = document.getElementById('menuToggle');
const scrim = document.getElementById('sidebarScrim');
const optionTypes = ['doctors', 'statuses', 'cities', 'companies'];
const optionLabels = { doctors: 'Médica / Cirurgião', statuses: 'Status da cirurgia', cities: 'Cidade', companies: 'Empresa' };
const optionNouns = { doctors: 'médicas ou cirurgiões', statuses: 'status', cities: 'cidades', companies: 'empresas' };
const optionsByType = Object.fromEntries(optionTypes.map((type) => [type, []]));
let accessUsers = [];
let budgeters = [];
let surgeries = [];
let archivedSurgeries = [];
let settingsLoaded = false;
let settingsLoadedAt = 0;
let settingsLoadPromise = null;
let surgeriesLoadedAt = 0;
let archivedSurgeriesLoadedAt = 0;
let activeSurgeriesLoadPromise = null;
let archivedSurgeriesLoadPromise = null;
const SETTINGS_CACHE_MS = 20_000;
const SURGERIES_CACHE_MS = 5_000;
let currentEmployee = null;
let editingOption = null;
let editingEmployee = null;
let editingBudgeter = null;
let editingSurgery = null;
let convertingReservation = false;
let pendingArchive = null;
let pendingAgendaBlockDelete = null;
let surgeryFormBaseline = null;
let toastTimer;
const apiBaseUrl = String(window.OPERAMEDS_API_BASE_URL || '').replace(/\/+$/, '');

async function api(path, options = {}) {
  const target = apiBaseUrl ? new URL(path, apiBaseUrl).toString() : path;
  const response = await fetch(target, { ...options, credentials: apiBaseUrl ? 'include' : 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && document.getElementById('authGate').hidden) {
      document.getElementById('authGate').hidden = false;
      setFormMessage(document.getElementById('authMessage'), 'Sua sessão terminou. Entre novamente.');
    }
    throw new Error(result.error || 'Não foi possível concluir a operação.');
  }
  return result;
}

function navigate(pageName, updateHistory = true) {
  const page = pages.find((item) => item.dataset.title && item.id === 'page-' + pageName);
  if (!page) return;
  pages.forEach((item) => item.classList.toggle('active', item === page));
  navLinks.forEach((link) => {
    const selected = link.dataset.page === pageName;
    link.classList.toggle('active', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  breadcrumb.textContent = page.dataset.title;
  if (updateHistory && location.hash !== '#' + pageName) history.pushState({ page: pageName }, '', '#' + pageName);
  closeMenu();
  if (pageName === 'configuracoes') Promise.all([loadSettings(), loadSurgeries(true)]).catch((error) => showToast(error.message, 'error'));
  if (pageName === 'gestao' || pageName === 'agenda') Promise.all([loadSettings(), loadSurgeries()]).catch((error) => showToast(error.message, 'error'));
  if (pageName === 'painel') loadSurgeries().catch((error) => showToast(error.message, 'error'));
}

function closeMenu() {
  sidebar.classList.remove('open');
  scrim.classList.remove('visible');
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-label', 'Abrir menu');
}

function showToast(message, kind = 'success') {
  const toast = document.getElementById('appToast');
  toast.textContent = message;
  toast.className = 'app-toast ' + kind + ' visible';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3600);
}

function setFormMessage(element, message, kind = 'error') {
  element.textContent = message;
  element.className = 'form-message ' + (message ? kind : '');
}

function makeButton(label, className, onClick, ariaLabel = label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', onClick);
  return button;
}

function isAdmin() {
  return currentEmployee?.isPrimaryAdmin === true || currentEmployee?.role === 'admin';
}

function isPrimaryAdmin() {
  return currentEmployee?.isPrimaryAdmin === true;
}

async function loadSettings(force = false) {
  if (!force && settingsLoaded && Date.now() - settingsLoadedAt < SETTINGS_CACHE_MS) return;
  if (!settingsLoadPromise) {
    settingsLoadPromise = (async () => {
      const result = await Promise.all([api('/api/settings'), api('/api/budgeters')]);
      optionTypes.forEach((type) => { optionsByType[type] = result[0].filter((item) => item.type === type); });
      budgeters = result[1];
      settingsLoaded = true;
      settingsLoadedAt = Date.now();
      optionTypes.forEach(renderOptionList);
      renderBudgeterList();
      document.querySelectorAll('[data-settings-tab="employees"]').forEach((tab) => { tab.hidden = !isAdmin(); });
      document.querySelectorAll('#page-configuracoes .add-option, #addBudgeterButton, #addEmployeeButton').forEach((button) => { button.hidden = !isAdmin(); });
      if (isAdmin() && accessUsers.length) renderEmployeeList();
      populateAgendaFilters();
      populateManagementFilters();
      populateCommissionFilters();
      renderCommissions();
    })().finally(() => { settingsLoadPromise = null; });
  }
  await settingsLoadPromise;
}

async function loadUsers() {
  if (!isAdmin()) {
    showToast('Acesso somente para administradores.', 'error');
    return;
  }
  accessUsers = await api('/api/users');
  renderEmployeeList();
}

async function loadSurgeries(includeArchived = false, force = false) {
  const requests = [];
  let shouldRender = false;
  if (force || Date.now() - surgeriesLoadedAt >= SURGERIES_CACHE_MS) {
    if (!activeSurgeriesLoadPromise) {
      activeSurgeriesLoadPromise = api('/api/surgeries').then((result) => {
        surgeries = result;
        surgeriesLoadedAt = Date.now();
        shouldRender = true;
      }).finally(() => { activeSurgeriesLoadPromise = null; });
    }
    requests.push(activeSurgeriesLoadPromise);
  }
  if (includeArchived && (force || Date.now() - archivedSurgeriesLoadedAt >= SURGERIES_CACHE_MS)) {
    if (!archivedSurgeriesLoadPromise) {
      archivedSurgeriesLoadPromise = api('/api/surgeries/archived').then((result) => {
        archivedSurgeries = result;
        archivedSurgeriesLoadedAt = Date.now();
        shouldRender = true;
      }).finally(() => { archivedSurgeriesLoadPromise = null; });
    }
    requests.push(archivedSurgeriesLoadPromise);
  }
  if (requests.length) await Promise.all(requests);
  if (shouldRender) renderSurgeryViews();
}

function renderSurgeryViews() {
  populateAgendaFilters();
  populateManagementFilters();
  populateCommissionFilters();
  renderArchivedSurgeryList();
  renderDashboard();
  renderSurgeries();
  renderAgenda();
  renderCommissions();
}

function normalizedStatusName(surgery) {
  return (surgery.status?.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
}

function isAgendaBlockRecord(surgery) {
  if (!surgery) return false;
  if (surgery.isAgendaBlock || surgery.recordType === 'agenda_block') return true;
  return surgery.recordType === 'reservation' && surgery.isReserved === true
    && !String(surgery.patient || '').trim() && Boolean(String(surgery.reservationName || '').trim());
}

function commissionEligible(surgery) {
  if (!surgery || surgery.isReserved || surgery.isAgendaBlock || surgery.recordType === 'reservation' || surgery.recordType === 'agenda_block') return false;
  return surgery.status?.commissionEligible === true || ['realizado', 'realizada'].includes(normalizedStatusName(surgery));
}

const COMMISSION_RATE = 0.02;

function dashboardDateValue() {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
}

function renderDashboard() {
  const surgeriesOnly = surgeries.filter((surgery) => !surgery.isReserved && !surgery.isAgendaBlock && surgery.recordType !== 'agenda_block');
  const reservationCount = surgeries.filter((surgery) => surgery.isReserved).length;
  const confirmed = surgeriesOnly.filter((surgery) => normalizedStatusName(surgery).includes('confirm')).length;
  const completed = surgeriesOnly.filter((surgery) => normalizedStatusName(surgery).includes('realiz')).length;
  const pending = surgeriesOnly.filter((surgery) => normalizedStatusName(surgery).startsWith('confirmad')).length;
  document.getElementById('dashboardScheduled').textContent = String(surgeriesOnly.length);
  document.getElementById('dashboardConfirmed').textContent = String(confirmed);
  document.getElementById('dashboardCompleted').textContent = String(completed);
  document.getElementById('dashboardPending').textContent = String(pending);
  document.getElementById('dashboardScheduledNote').textContent = surgeriesOnly.length === 1 ? '1 cirurgia cadastrada' : surgeriesOnly.length + ' cirurgias cadastradas';
  const reservationNote = document.getElementById('dashboardReservations');
  if (reservationNote) reservationNote.textContent = reservationCount ? reservationCount + (reservationCount === 1 ? ' horário reservado' : ' horários reservados') : 'Nenhum horário reservado';

  const upcomingContainer = document.getElementById('dashboardUpcoming');
  if (!upcomingContainer) return;
  const upcoming = surgeriesOnly
    .filter((surgery) => surgery.date >= dashboardDateValue() && !normalizedStatusName(surgery).includes('cancel'))
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || ''))
    .slice(0, 5);
  upcomingContainer.replaceChildren();
  upcoming.forEach((surgery) => {
    const card = document.createElement('article');
    card.className = 'dashboard-surgery-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', (surgery.patient || 'Paciente') + ', ' + dateLabel(surgery.date) + ', ' + (surgery.time || 'sem horário') + '. Abrir para editar.');
    const date = document.createElement('div');
    date.className = 'dashboard-surgery-date';
    date.innerHTML = '<span>' + (surgery.date ? new Date(surgery.date + 'T12:00:00').getDate() : '—') + '</span><small>' + (surgery.date ? new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(new Date(surgery.date + 'T12:00:00')).replace('.', '') : '—') + '</small>';
    const details = document.createElement('div');
    details.className = 'dashboard-surgery-details';
    const patient = document.createElement('strong');
    patient.textContent = surgery.patient || '—';
    const subtitle = document.createElement('span');
    subtitle.textContent = [surgery.procedure, surgery.doctor?.name, surgery.hospital?.name].filter(Boolean).join(' · ') || 'Detalhes não informados';
    details.append(patient, subtitle);
    const timing = document.createElement('div');
    timing.className = 'dashboard-surgery-time';
    timing.innerHTML = '<span>' + (surgery.time || '—') + '</span><small>' + dateLabel(surgery.date) + '</small>';
    const status = document.createElement('div');
    status.className = 'dashboard-surgery-status';
    status.append(makeStatusChip(surgery.status));
    card.append(date, details, timing, status);
    card.addEventListener('click', () => openSurgeryFromRow(surgery));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openSurgeryFromRow(surgery); }
    });
    upcomingContainer.append(card);
  });
  document.getElementById('dashboardEmpty').hidden = surgeriesOnly.length > 0;
  document.getElementById('dashboardNoUpcoming').hidden = upcoming.length > 0 || surgeriesOnly.length === 0;
}

function renderOptionList(type) {
  const list = document.querySelector('[data-option-list="' + type + '"]');
  list.replaceChildren();
  if (!optionsByType[type].length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = 'Nenhum item cadastrado em ' + optionNouns[type] + '. Use “+ Adicionar” para começar.';
    list.append(empty);
    return;
  }
  optionsByType[type].forEach((option) => {
    const row = document.createElement('article');
    row.className = 'option-row' + (option.active ? '' : ' inactive');
    const main = document.createElement('div');
    main.className = 'option-main';
    if (type === 'statuses' || type === 'doctors') {
      const swatch = document.createElement('span');
      swatch.className = 'color-swatch';
      const color = type === 'statuses' ? option.color || '#8a989f' : option.agendaBlockColor || defaultDoctorBlockColor(option.name, option.id);
      swatch.style.backgroundColor = color;
      swatch.setAttribute('aria-label', (type === 'doctors' ? 'Cor do bloqueio ' : 'Cor ') + (color || 'não definida'));
      if (type === 'doctors') swatch.title = 'Cor do Bloqueio de Agenda: ' + color;
      main.append(swatch);
    }
    const name = document.createElement('strong');
    name.textContent = option.name;
    const badge = document.createElement('span');
    badge.className = 'state-badge ' + (option.active ? 'is-active' : 'is-inactive');
    badge.textContent = option.active ? 'Ativo' : 'Inativo';
    main.append(name, badge);
    if (type === 'statuses' && (option.commissionEligible || ['realizado', 'realizada'].includes(option.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR')))) {
      const commissionBadge = document.createElement('span');
      commissionBadge.className = 'state-badge is-active';
      commissionBadge.textContent = 'Elegível para comissão';
      main.append(commissionBadge);
    }
    if (isAdmin()) {
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.append(
        makeButton('Editar', 'text-button', () => openOptionDialog(type, option)),
        makeButton(option.active ? 'Desativar' : 'Ativar', 'text-button ' + (option.active ? 'danger-text' : ''), () => toggleOption(option), (option.active ? 'Desativar ' : 'Ativar ') + option.name),
      );
      row.append(main, actions);
    } else row.append(main);
    list.append(row);
  });
}

function renderBudgeterList() {
  const list = document.getElementById('budgeterList');
  list.replaceChildren();
  if (!budgeters.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = 'Nenhum orçamentista cadastrado. Use “+ Adicionar” para cadastrar.';
    list.append(empty);
    return;
  }
  budgeters.forEach((budgeter) => {
    const row = document.createElement('article');
    row.className = 'option-row' + (budgeter.active ? '' : ' inactive');
    const main = document.createElement('div');
    main.className = 'option-main employee-main';
    const name = document.createElement('strong');
    name.textContent = budgeter.name;
    const badge = document.createElement('span');
    badge.className = 'state-badge ' + (budgeter.active ? 'is-active' : 'is-inactive');
    badge.textContent = budgeter.active ? 'Ativo' : 'Inativo';
    main.append(name, badge);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (isAdmin()) actions.append(
      makeButton('Editar', 'text-button', () => openBudgeterDialog(budgeter)),
      makeButton(budgeter.active ? 'Desativar' : 'Ativar', 'text-button ' + (budgeter.active ? 'danger-text' : ''), () => toggleBudgeter(budgeter), (budgeter.active ? 'Desativar ' : 'Ativar ') + budgeter.name),
    );
    row.append(main);
    if (isAdmin()) row.append(actions);
    list.append(row);
  });
}

function renderEmployeeList() {
  const list = document.getElementById('employeeList');
  if (!list) return;
  list.replaceChildren();
  if (!accessUsers.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = 'Nenhum funcionário cadastrado. Use “+ Novo Funcionário” para cadastrar.';
    list.append(empty);
    return;
  }
  accessUsers.forEach((employee) => {
    const row = document.createElement('article');
    row.className = 'option-row' + (employee.active ? '' : ' inactive');
    const main = document.createElement('div');
    main.className = 'option-main employee-main';
    const name = document.createElement('strong');
    name.textContent = employee.name || employee.username;
    const username = document.createElement('span');
    username.className = 'employee-username';
    username.textContent = '@' + employee.username;
    const badge = document.createElement('span');
    badge.className = 'state-badge ' + (employee.role === 'admin' || employee.isPrimaryAdmin ? 'is-active' : 'is-inactive');
    badge.textContent = employee.isPrimaryAdmin ? 'Administradora Principal' : employee.role === 'admin' ? 'Administrador' : 'Usuário';
    const activeBadge = document.createElement('span');
    activeBadge.className = 'state-badge ' + (employee.active ? 'is-active' : 'is-inactive');
    activeBadge.textContent = employee.active ? 'Ativo' : 'Inativo';
    main.append(name, username, badge, activeBadge);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (isAdmin() && !employee.isPrimaryAdmin) actions.append(
      makeButton('Editar', 'text-button', () => openEmployeeDialog(employee)),
      makeButton(employee.active ? 'Desativar' : 'Ativar', 'text-button ' + (employee.active ? 'danger-text' : ''), () => toggleEmployee(employee), (employee.active ? 'Desativar ' : 'Ativar ') + (employee.name || employee.username)),
      makeButton('Excluir', 'text-button danger-text', () => deleteEmployee(employee), 'Excluir ' + (employee.name || employee.username)),
    );
    row.append(main);
    if (actions.childElementCount) row.append(actions);
    list.append(row);
  });
}

function populateCommissionFilters() {
  const select = document.getElementById('commissionEmployeeFilter');
  if (!select) return;
  const selected = select.value;
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'Todos os orçamentistas';
  select.append(all);
  budgeters.forEach((budgeter) => {
    const option = document.createElement('option');
    option.value = budgeter.id;
    option.textContent = budgeter.name + (budgeter.active ? '' : ' (inativo)');
    select.append(option);
  });
  const legacyNames = [...new Set(surgeries.map((surgery) => surgery.employeeName).filter(Boolean))]
    .filter((name) => !budgeters.some((budgeter) => normalizeEmployeeName(budgeter.name) === normalizeEmployeeName(name)));
  legacyNames.forEach((name) => {
    const option = document.createElement('option');
    option.value = 'legacy:' + normalizeEmployeeName(name);
    option.textContent = name + ' (histórico)';
    select.append(option);
  });
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

function renderCommissions() {
  const container = document.getElementById('commissionPeopleList');
  if (!container) return;
  const month = document.getElementById('commissionsMonth').value;
  const personFilter = document.getElementById('commissionEmployeeFilter').value;
  const situation = document.getElementById('commissionPaymentFilter').value;
  const periodSurgeries = surgeries.filter((surgery) => commissionEligible(surgery) && (!month || (surgery.date || '').startsWith(month)));
  const groups = new Map();
  budgeters.forEach((budgeter) => groups.set(budgeter.id, { id: budgeter.id, name: budgeter.name, active: budgeter.active, employeeId: budgeter.id, surgeries: [] }));
  periodSurgeries.forEach((surgery) => {
    const budgeter = budgeters.find((item) => item.id === surgery.employeeId || (!surgery.employeeId && normalizeEmployeeName(item.name) === normalizeEmployeeName(surgery.employeeName)));
    if (budgeter) groups.get(budgeter.id).surgeries.push(surgery);
    else if (surgery.employeeName) {
      const id = 'legacy:' + normalizeEmployeeName(surgery.employeeName);
      if (!groups.has(id)) groups.set(id, { id, name: surgery.employeeName, active: false, employeeId: null, surgeries: [] });
      groups.get(id).surgeries.push(surgery);
    }
  });
  let people = [...groups.values()];
  if (personFilter.startsWith('legacy:')) people = people.filter((group) => group.id === personFilter);
  else if (personFilter) people = people.filter((group) => group.employeeId === personFilter);
  if (situation === 'pending-rule') people = people.filter((group) => group.surgeries.length);
  people.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  container.replaceChildren();
  const eligibleAmounts = people.flatMap((group) => group.surgeries.map((surgery) => managementMoney(surgery.totalAmount)).filter((amount) => amount !== null));
  const totalCommission = eligibleAmounts.reduce((sum, amount) => sum + Math.round((amount * COMMISSION_RATE + Number.EPSILON) * 100) / 100, 0);
  document.getElementById('commissionTotal').textContent = managementMoneyLabel(totalCommission);
  document.getElementById('commissionPaid').textContent = managementMoneyLabel(0);
  document.getElementById('commissionPending').textContent = managementMoneyLabel(totalCommission);
  if (!people.length || (personFilter && !people.some((group) => group.surgeries.length))) {
    const empty = document.createElement('div');
    empty.className = 'commission-empty';
    empty.textContent = 'Nenhuma cirurgia vinculada a este orçamentista no período selecionado.';
    container.append(empty);
    return;
  }
  people.forEach((group) => {
    const details = document.createElement('details');
    details.className = 'commission-person-card';
    const summary = document.createElement('summary');
    const heading = document.createElement('span');
    heading.className = 'commission-person-heading';
    const name = document.createElement('strong');
    name.textContent = group.name;
    const note = document.createElement('small');
    note.textContent = group.active ? 'Orçamentista ativo' : 'Cadastro histórico';
    heading.append(name, note);
    const stats = document.createElement('span');
    stats.className = 'commission-person-stats';
    const count = document.createElement('strong');
    count.textContent = String(group.surgeries.length) + (group.surgeries.length === 1 ? ' cirurgia' : ' cirurgias');
    const amounts = group.surgeries.map((surgery) => managementMoney(surgery.totalAmount));
    const sum = amounts.reduce((total, amount) => total + (amount || 0), 0);
    const value = document.createElement('span');
    value.textContent = 'Valor vinculado: ' + (amounts.length && amounts.every((amount) => amount !== null) ? managementMoneyLabel(sum) : '—');
    const pending = document.createElement('small');
    const commissionAmounts = amounts.filter((amount) => amount !== null).map((amount) => Math.round((amount * COMMISSION_RATE + Number.EPSILON) * 100) / 100);
    pending.textContent = 'Comissão a pagar: ' + (commissionAmounts.length ? managementMoneyLabel(commissionAmounts.reduce((total, amount) => total + amount, 0)) : '—');
    stats.append(count, value, pending);
    summary.append(heading, stats);
    details.append(summary);
    const surgeryList = document.createElement('div');
    surgeryList.className = 'commission-surgery-list';
    group.surgeries.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || '')).forEach((surgery) => {
      const row = document.createElement('div');
      row.className = 'commission-surgery-row';
      const text = document.createElement('span');
      text.textContent = [dateLabel(surgery.date), surgery.time, surgery.patient || 'Paciente não informado', surgery.procedure].filter(Boolean).join(' · ');
      const amount = document.createElement('strong');
      const surgeryAmount = managementMoney(surgery.totalAmount);
      amount.textContent = surgeryAmount === null ? 'Comissão: —' : 'Comissão: ' + managementMoneyLabel(Math.round((surgeryAmount * COMMISSION_RATE + Number.EPSILON) * 100) / 100);
      if (surgeryAmount !== null) amount.title = '2% de ' + managementMoneyLabel(surgeryAmount);
      row.append(text, amount);
      surgeryList.append(row);
    });
    if (!group.surgeries.length) {
      const empty = document.createElement('p');
      empty.className = 'commission-empty-person';
      empty.textContent = 'Nenhuma cirurgia vinculada neste mês.';
      surgeryList.append(empty);
    }
    details.append(surgeryList);
    container.append(details);
  });
}

function renderArchivedSurgeryList() {
  const list = document.getElementById('archivedSurgeriesList');
  if (!list) return;
  list.replaceChildren();
  if (!archivedSurgeries.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = 'Nenhum procedimento arquivado.';
    list.append(empty);
    return;
  }
  archivedSurgeries.forEach((surgery) => {
    const row = document.createElement('article');
    row.className = 'archived-surgery-row';
    const details = document.createElement('div');
    details.className = 'archived-surgery-details';
    const patient = document.createElement('strong');
    patient.textContent = surgery.isReserved ? (surgery.reservationName || 'Horário reservado') : (surgery.patient || '—');
    const summary = document.createElement('span');
    summary.textContent = [dateLabel(surgery.date), surgery.time, surgery.procedure, surgery.doctor?.name, surgery.hospital?.name].filter(Boolean).join(' · ');
    const status = makeStatusChip(surgery.status);
    details.append(patient, summary, status);
    const actions = document.createElement('div');
    actions.className = 'archived-surgery-actions';
    const edit = makeButton('', 'archived-icon-button', () => openSurgeryFromRow(surgery), 'Editar procedimento arquivado');
    const editIcon = document.createElement('span');
    editIcon.className = 'material-symbols';
    editIcon.textContent = 'edit';
    edit.setAttribute('aria-label', 'Editar procedimento arquivado');
    edit.append(editIcon);
    const restore = makeButton('', 'archived-icon-button', () => restoreSurgery(surgery), 'Restaurar procedimento');
    const restoreIcon = document.createElement('span');
    restoreIcon.className = 'material-symbols';
    restoreIcon.textContent = 'unarchive';
    restore.setAttribute('aria-label', 'Restaurar procedimento');
    restore.append(restoreIcon);
    actions.append(edit, restore);
    row.append(details, actions);
    list.append(row);
  });
}

async function archiveSurgery(surgery) {
  pendingArchive = surgery;
  document.getElementById('archiveConfirmName').textContent = surgery.patient || surgery.reservationName || 'este procedimento';
  document.getElementById('archiveConfirmDialog').showModal();
}

async function confirmArchiveSurgery() {
  if (!pendingArchive) return;
  try {
    await api('/api/surgeries/' + pendingArchive.id + '/archive', { method: 'POST', body: '{}' });
    document.getElementById('archiveConfirmDialog').close();
    surgeriesLoadedAt = 0;
    archivedSurgeriesLoadedAt = 0;
    await loadSurgeries(true);
    showToast('Procedimento arquivado.');
    pendingArchive = null;
  } catch (error) { showToast(error.message, 'error'); }
}

function requestDeleteAgendaBlock() {
  if (!isAgendaBlockRecord(editingSurgery)) return;
  pendingAgendaBlockDelete = editingSurgery;
  document.getElementById('deleteAgendaBlockDialog').showModal();
}

async function confirmDeleteAgendaBlock() {
  if (!pendingAgendaBlockDelete) return;
  const button = document.getElementById('confirmDeleteAgendaBlockButton');
  button.disabled = true;
  try {
    await api('/api/surgeries/' + pendingAgendaBlockDelete.id + '/delete', { method: 'POST', body: '{}' });
    document.getElementById('deleteAgendaBlockDialog').close();
    closeSurgeryDialogNow();
    pendingAgendaBlockDelete = null;
    editingSurgery = null;
    surgeriesLoadedAt = 0;
    await loadSurgeries();
    showToast('Bloqueio excluído da agenda.');
  } catch (error) { showToast(error.message, 'error'); }
  finally { button.disabled = false; }
}

async function restoreSurgery(surgery) {
  try {
    await api('/api/surgeries/' + surgery.id + '/restore', { method: 'POST', body: '{}' });
    surgeriesLoadedAt = 0;
    archivedSurgeriesLoadedAt = 0;
    await loadSurgeries(true);
    showToast('Procedimento restaurado para a Agenda e a Gestão.');
  } catch (error) { showToast(error.message, 'error'); }
}

function openOptionDialog(type, option = null) {
  if (!isAdmin()) { showToast('Acesso somente para administradores.', 'error'); return; }
  editingOption = option ? { ...option } : { type };
  const form = document.getElementById('optionForm');
  form.reset();
  form.elements.name.value = option?.name || '';
  form.elements.active.checked = option ? option.active : true;
  form.elements.color.value = option?.color || '#18aaa7';
  form.elements.agendaBlockColor.value = option?.agendaBlockColor || defaultDoctorBlockColor(option?.name, option?.id);
  form.elements.agendaBlockColor.required = type === 'doctors';
  form.elements.commissionEligible.checked = option?.commissionEligible === true;
  document.getElementById('optionDialogTitle').textContent = (option ? 'Editar ' : 'Adicionar ') + optionLabels[type];
  document.getElementById('statusColorField').hidden = type !== 'statuses';
  document.getElementById('doctorBlockColorField').hidden = type !== 'doctors';
  document.getElementById('statusCommissionField').hidden = type !== 'statuses';
  setFormMessage(document.getElementById('optionFormMessage'), '');
  document.getElementById('optionDialog').showModal();
  form.elements.name.focus();
}

async function toggleOption(option) {
  if (!isAdmin()) { showToast('Acesso somente para administradores.', 'error'); return; }
  try {
    await api('/api/settings/' + option.id, { method: 'PUT', body: JSON.stringify({ name: option.name, color: option.color, agendaBlockColor: option.agendaBlockColor || (option.type === 'doctors' ? defaultDoctorBlockColor(option.name, option.id) : null), active: !option.active, commissionEligible: option.commissionEligible === true }) });
    await Promise.all([loadSettings(true), loadSurgeries(false, true)]);
    showToast(option.name + (option.active ? ' desativado' : ' ativado') + ' com sucesso.');
  } catch (error) { showToast(error.message, 'error'); }
}

async function saveOption(event) {
  event.preventDefault();
  if (!isAdmin()) { showToast('Acesso somente para administradores.', 'error'); return; }
  const form = event.currentTarget;
  const type = editingOption.type;
  const body = { type, name: form.elements.name.value, active: form.elements.active.checked, color: type === 'statuses' ? form.elements.color.value : null, agendaBlockColor: type === 'doctors' ? form.elements.agendaBlockColor.value : null, commissionEligible: type === 'statuses' && form.elements.commissionEligible.checked };
  const submit = form.querySelector('[type="submit"]');
  const message = document.getElementById('optionFormMessage');
  submit.disabled = true;
  setFormMessage(message, 'Salvando…', 'info');
  try {
    await api(editingOption.id ? '/api/settings/' + editingOption.id : '/api/settings', {
      method: editingOption.id ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    });
    document.getElementById('optionDialog').close();
    await Promise.all([loadSettings(true), loadSurgeries(false, true)]);
    showToast(optionLabels[type] + ' salvo com sucesso.');
  } catch (error) { setFormMessage(message, error.message); }
  finally { submit.disabled = false; }
}

function openBudgeterDialog(budgeter = null) {
  if (!isAdmin()) { showToast('Acesso somente para administradores.', 'error'); return; }
  editingBudgeter = budgeter ? { ...budgeter } : null;
  const form = document.getElementById('budgeterForm');
  form.reset();
  form.elements.name.value = budgeter?.name || '';
  form.elements.active.checked = budgeter ? budgeter.active : true;
  document.getElementById('budgeterDialogTitle').textContent = budgeter ? 'Editar orçamentista' : 'Adicionar orçamentista';
  setFormMessage(document.getElementById('budgeterFormMessage'), '');
  document.getElementById('budgeterDialog').showModal();
  form.elements.name.focus();
}

async function saveBudgeter(event) {
  event.preventDefault();
  if (!isAdmin()) { showToast('Acesso somente para administradores.', 'error'); return; }
  const form = event.currentTarget;
  const body = { name: form.elements.name.value, active: form.elements.active.checked };
  const submit = form.querySelector('[type="submit"]');
  const message = document.getElementById('budgeterFormMessage');
  submit.disabled = true;
  setFormMessage(message, 'Salvando…', 'info');
  try {
    await api(editingBudgeter ? '/api/budgeters/' + editingBudgeter.id : '/api/budgeters', { method: editingBudgeter ? 'PUT' : 'POST', body: JSON.stringify(body) });
    document.getElementById('budgeterDialog').close();
    await Promise.all([loadSettings(true), loadSurgeries(false, true)]);
    showToast('Orçamentista salvo com sucesso.');
  } catch (error) { setFormMessage(message, error.message); }
  finally { submit.disabled = false; }
}

async function toggleBudgeter(budgeter) {
  if (!isAdmin()) { showToast('Acesso somente para administradores.', 'error'); return; }
  try {
    await api('/api/budgeters/' + budgeter.id, { method: 'PUT', body: JSON.stringify({ name: budgeter.name, active: !budgeter.active }) });
    await Promise.all([loadSettings(true), loadSurgeries(false, true)]);
    showToast('Orçamentista ' + budgeter.name + (budgeter.active ? ' desativado.' : ' ativado.'));
  } catch (error) { showToast(error.message, 'error'); }
}

function openEmployeeDialog(employee = null) {
  if (!isAdmin()) { showToast('Acesso somente para administradores.', 'error'); return; }
  if (employee?.isPrimaryAdmin) { showToast('A conta da Administradora Principal está protegida.', 'error'); return; }
  editingEmployee = employee ? { ...employee } : null;
  const form = document.getElementById('employeeForm');
  form.reset();
  form.elements.name.value = employee?.name || '';
  form.elements.username.value = employee?.username || '';
  form.elements.pin.value = '';
  form.elements.pin.required = !employee;
  form.elements.role.value = employee?.role === 'admin' ? 'admin' : 'user';
  form.elements.active.checked = employee ? employee.active : true;
  document.getElementById('employeePinHint').textContent = employee ? 'Deixe em branco para manter o PIN atual.' : 'Exatamente 4 dígitos numéricos.';
  document.getElementById('employeeRoleField').hidden = !isPrimaryAdmin();
  document.getElementById('employeeDialogTitle').textContent = employee ? 'Editar funcionário' : 'Novo funcionário';
  setFormMessage(document.getElementById('employeeFormMessage'), '');
  document.getElementById('employeeDialog').showModal();
  form.elements.name.focus();
}

async function saveEmployee(event) {
  event.preventDefault();
  if (!isAdmin()) { showToast('Acesso somente para administradores.', 'error'); return; }
  const form = event.currentTarget;
  const body = { name: form.elements.name.value, username: form.elements.username.value, pin: form.elements.pin.value };
  if (isPrimaryAdmin()) body.role = form.elements.role.value;
  if (editingEmployee) body.active = form.elements.active.checked;
  const submit = form.querySelector('[type="submit"]');
  const message = document.getElementById('employeeFormMessage');
  submit.disabled = true;
  setFormMessage(message, 'Salvando…', 'info');
  try {
    const updated = await api(editingEmployee ? '/api/users/' + editingEmployee.id : '/api/users', { method: editingEmployee ? 'PUT' : 'POST', body: JSON.stringify(body) });
    document.getElementById('employeeDialog').close();
    await loadUsers();
    if (currentEmployee?.id === updated.id) enterApplication(updated);
    showToast('Funcionário salvo com sucesso.');
  } catch (error) { setFormMessage(message, error.message); }
  finally { submit.disabled = false; }
}

async function toggleEmployee(employee) {
  if (!isAdmin()) { showToast('Acesso somente para administradores.', 'error'); return; }
  if (employee.isPrimaryAdmin) { showToast('A conta da Administradora Principal está protegida.', 'error'); return; }
  try {
    await api('/api/users/' + employee.id, { method: 'PUT', body: JSON.stringify({ active: !employee.active }) });
    await loadUsers();
    showToast('Funcionário ' + (employee.name || employee.username) + (employee.active ? ' desativado.' : ' ativado.'));
  } catch (error) { showToast(error.message, 'error'); }
}

async function deleteEmployee(employee) {
  if (!isAdmin()) { showToast('Acesso somente para administradores.', 'error'); return; }
  if (employee.isPrimaryAdmin) { showToast('A conta da Administradora Principal está protegida.', 'error'); return; }
  if (!window.confirm('Excluir ' + (employee.name || employee.username) + '? Os registros de cirurgias serão mantidos.')) return;
  try {
    await api('/api/users/' + employee.id, { method: 'DELETE', body: '{}' });
    await loadUsers();
    showToast('Funcionário excluído. Os registros de cirurgias foram preservados.');
  } catch (error) { showToast(error.message, 'error'); }
}

function fillSelect(select, items, label, current = null, allowEmpty = false) {
  select.replaceChildren();
  const activeItems = items.filter((item) => item.active);
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = allowEmpty ? 'Não selecionada' : (activeItems.length ? 'Selecione ' + label.toLocaleLowerCase('pt-BR') : 'Nenhuma opção ativa cadastrada para ' + label.toLocaleLowerCase('pt-BR'));
  placeholder.disabled = !allowEmpty;
  placeholder.selected = true;
  select.append(placeholder);
  const selectable = [...activeItems];
  if (current && !selectable.some((item) => item.id === current.id)) selectable.push(current);
  selectable.forEach((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name + (item.active ? '' : ' (inativo; mantido neste registro)');
    if (item.id === current?.id) option.selected = true;
    select.append(option);
  });
  select.disabled = !activeItems.length && !current && !allowEmpty;
}

function syncReservationFields() {
  const form = document.getElementById('surgeryForm');
  const blockMode = form.elements.isAgendaBlock.checked;
  const legacyReservation = Boolean(editingSurgery?.isReserved && !editingSurgery?.isAgendaBlock && !convertingReservation);
  const specialTime = blockMode || legacyReservation;
  const doctorField = document.getElementById('doctorFormField');
  const newBlockMode = blockMode && !legacyReservation;
  document.getElementById(specialTime ? 'blockDoctorSlot' : 'normalDoctorSlot').append(doctorField);
  document.getElementById(specialTime ? 'blockCompanySlot' : 'normalCompanySlot').append(document.getElementById('companyFormField'));
  document.getElementById(newBlockMode ? 'blockCitySlot' : 'normalCitySlot').append(document.getElementById('cityFormField'));
  form.classList.toggle('is-agenda-block', newBlockMode);
  document.getElementById('surgeryDialog').classList.toggle('agenda-block-dialog', newBlockMode);
  document.getElementById('surgeryDetailFields').hidden = specialTime;
  document.querySelectorAll('#surgeryPatientFields .patient-only').forEach((field) => { field.hidden = specialTime; });
  document.getElementById('agendaBlockFields').hidden = !specialTime;
  document.getElementById('surgeryProcedureSection').hidden = newBlockMode || legacyReservation;
  document.getElementById('surgeryPatientSection').querySelector('.surgery-form-section-heading h3').textContent = newBlockMode ? 'Bloqueio de Agenda' : legacyReservation ? 'Horário reservado antigo' : 'Agendamento e Paciente';
  document.getElementById('surgeryHospitalField').hidden = specialTime;
  document.querySelector('#surgeryForm [name="hospitalName"]').required = false;
  if (!specialTime) form.elements.reservationName.value = '';
  ['patient', 'procedure'].forEach((name) => { form.elements[name].required = !specialTime; });
  form.elements.statusId.required = !specialTime;
  form.elements.date.required = specialTime;
  form.elements.time.required = specialTime;
  form.elements.doctorId.required = specialTime;
  form.elements.reservationName.required = blockMode && !legacyReservation;
  const convertNotice = document.getElementById('convertReservationNotice');
  const reserveToggle = document.getElementById('reserveToggleField');
  const isExistingReservation = legacyReservation;
  if (convertNotice) convertNotice.hidden = !isExistingReservation || convertingReservation;
  if (reserveToggle) reserveToggle.hidden = Boolean(editingSurgery);
  document.getElementById('surgeryDialogTitle').textContent = newBlockMode ? (editingSurgery ? 'Editar Bloqueio' : 'Bloqueio de Agenda') : legacyReservation ? 'Editar Horário Reservado' : editingSurgery ? 'Editar Cirurgia' : 'Nova Cirurgia';
  document.querySelector('#surgeryForm [type="submit"]').textContent = legacyReservation ? 'Salvar Horário Reservado' : newBlockMode ? 'Salvar Bloqueio' : editingSurgery ? 'Salvar Alterações' : 'Salvar Cirurgia';
  document.getElementById('deleteAgendaBlockButton').hidden = !isAgendaBlockRecord(editingSurgery);
}

function currentSurgeryFormState() {
  return JSON.stringify([...new FormData(document.getElementById('surgeryForm')).entries()]);
}

function surgeryFormHasUnsavedChanges() {
  return surgeryFormBaseline !== null && currentSurgeryFormState() !== surgeryFormBaseline;
}

function closeSurgeryDialogNow() {
  delete document.getElementById('surgeryForm').dataset.saving;
  surgeryFormBaseline = null;
  document.getElementById('surgeryDialog').close();
}

function requestCloseSurgeryDialog() {
  if (document.getElementById('surgeryForm').dataset.saving === 'true') return;
  if (surgeryFormHasUnsavedChanges()) {
    document.getElementById('unsavedSurgeryDialog').showModal();
    return;
  }
  closeSurgeryDialogNow();
}

function discardSurgeryFormChanges() {
  document.getElementById('unsavedSurgeryDialog').close();
  closeSurgeryDialogNow();
  editingSurgery = null;
  convertingReservation = false;
}

function calculateSurgeryAmounts() {
  const form = document.getElementById('surgeryForm');
  const totalText = form.elements.totalAmount.value;
  const total = totalText === '' ? null : Number(totalText);
  const deposit = form.elements.depositPaid.value === '' ? 0 : Number(form.elements.depositPaid.value);
  const format = (amount) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(amount);
  form.elements.pendingAmount.value = total !== null && Number.isFinite(total) ? format(Math.max(total - (Number.isFinite(deposit) ? deposit : 0), 0)) : '';
  form.elements.commissionAmount.value = total !== null && Number.isFinite(total) ? format(Math.round((total * 0.02 + Number.EPSILON) * 100) / 100) : '';
}

function openSurgeryDialog(surgery = null) {
  editingSurgery = surgery;
  convertingReservation = false;
  const form = document.getElementById('surgeryForm');
  form.reset();
  form.elements.date.value = surgery?.date || '';
  form.elements.time.value = surgery?.time || '';
  form.elements.patient.value = surgery?.patient || '';
  form.elements.procedure.value = surgery?.procedure || '';
  form.elements.anesthetist.value = surgery?.anesthetist || '';
  form.elements.employeeName.value = surgery?.employeeName || surgery?.employee?.name || '';
  form.elements.hospitalName.value = surgery?.hospital?.name || '';
  form.elements.convenio.value = surgery?.convenio || '';
  form.elements.reservationName.value = surgery?.reservationName || '';
  form.elements.phone.value = surgery?.phone || '';
  form.elements.consultationDate.value = surgery?.consultationDate || '';
  form.elements.totalAmount.value = surgery?.totalAmount ?? '';
  form.elements.depositPaid.value = surgery?.depositPaid ?? '';
  form.elements.returnDate.value = surgery?.returnDate || '';
  form.elements.returnType.value = surgery?.returnType || '';
  form.elements.observations.value = surgery?.observations || '';
  form.elements.isAgendaBlock.checked = surgery?.isAgendaBlock === true || surgery?.isReserved === true;
  fillSelect(form.elements.doctorId, optionsByType.doctors, 'Médica / Cirurgião', surgery?.doctor, true);
  fillSelect(form.elements.companyId, optionsByType.companies, 'Empresa', surgery?.company, true);
  const oldEmployeeName = normalizeEmployeeName(surgery?.employeeName || surgery?.employee?.name || '');
  const currentEmployeeOption = surgery?.employee || budgeters.find((item) => normalizeEmployeeName(item.name) === oldEmployeeName) || null;
  fillSelect(form.elements.employeeId, budgeters, 'Orçamentista', currentEmployeeOption, true);
  form.elements.employeeName.value = currentEmployeeOption?.name || surgery?.employeeName || '';
  fillSelect(form.elements.cityId, optionsByType.cities, 'Cidade', surgery?.city, true);
  const configuredStatus = surgery?.status?.virtual ? optionsByType.statuses.find((item) => item.id === surgery.statusId) : surgery?.status;
  fillSelect(form.elements.statusId, optionsByType.statuses, 'Status', configuredStatus);
  calculateSurgeryAmounts();
  document.getElementById('surgeryDialogTitle').textContent = surgery ? 'Editar Cirurgia' : 'Nova Cirurgia';
  document.querySelector('#surgeryForm [type="submit"]').textContent = surgery ? 'Salvar Alterações' : 'Salvar Cirurgia';
  document.getElementById('convertReservationButton').textContent = 'Converter em cirurgia';
  setFormMessage(document.getElementById('surgeryFormMessage'), '');
  syncReservationFields();
  document.getElementById('surgeryDialog').showModal();
  surgeryFormBaseline = currentSurgeryFormState();
}

async function openNewSurgeryDialog() {
  try {
    await loadSettings();
    openSurgeryDialog();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function convertReservationToSurgery() {
  if (!editingSurgery?.isReserved) return;
  convertingReservation = true;
  const form = document.getElementById('surgeryForm');
  form.elements.isAgendaBlock.checked = false;
  syncReservationFields();
  document.getElementById('surgeryFormMessage').scrollIntoView({ block: 'nearest' });
  form.elements.patient.focus();
}

async function saveSurgery(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  const legacyReservation = Boolean(editingSurgery?.isReserved && !editingSurgery?.isAgendaBlock && !convertingReservation);
  body.isAgendaBlock = form.elements.isAgendaBlock.checked && !legacyReservation;
  body.isReserved = legacyReservation;
  body.convertReservation = convertingReservation;
  delete body.pendingAmount;
  delete body.commissionAmount;
  const message = document.getElementById('surgeryFormMessage');
  const submit = form.querySelector('[type="submit"]');
  const specialTime = body.isReserved || body.isAgendaBlock;
  const missingReservationFields = specialTime && (!body.date || !body.time || !body.doctorId || (body.isAgendaBlock && !body.reservationName.trim()));
  const missingSurgeryFields = !specialTime && (!body.patient || !body.procedure || !body.statusId);
  if (missingReservationFields || missingSurgeryFields) {
    setFormMessage(message, body.isAgendaBlock ? 'Informe data, horário, médico e nome ou motivo do bloqueio.' : body.isReserved ? 'Informe data, horário e médica para a reserva.' : 'Preencha paciente, cirurgia e status. Data, horário, médica e hospital podem ficar em branco.');
    return;
  }
  submit.disabled = true;
  form.dataset.saving = 'true';
  setFormMessage(message, 'Salvando…', 'info');
  try {
    const savedSurgery = await api(editingSurgery ? '/api/surgeries/' + editingSurgery.id : '/api/surgeries', {
      method: editingSurgery ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    });
    const existingIndex = surgeries.findIndex((item) => item.id === savedSurgery.id);
    if (existingIndex < 0) surgeries.push(savedSurgery);
    else surgeries[existingIndex] = savedSurgery;
    surgeriesLoadedAt = Date.now();
    closeSurgeryDialogNow();
    renderSurgeryViews();
    showToast(convertingReservation ? 'Horário convertido em cirurgia.' : editingSurgery ? (body.isAgendaBlock ? 'Bloqueio atualizado.' : 'Cirurgia atualizada com sucesso.') : body.isAgendaBlock ? 'Bloqueio de agenda salvo.' : body.isReserved ? 'Horário reservado com sucesso.' : 'Cirurgia cadastrada com sucesso.');
  } catch (error) { setFormMessage(message, error.message); }
  finally { submit.disabled = false; delete form.dataset.saving; }
}

function monthValue(date = new Date()) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}

function setMonthOffset(offset) {
  const current = document.getElementById('agendaMonth').value || monthValue();
  const [year, month] = current.split('-').map(Number);
  const next = monthValue(new Date(year, month - 1 + offset, 1));
  document.getElementById('agendaMonth').value = next < '2022-01' ? '2022-01' : next;
  renderMonthPicker('agendaMonth');
  renderAgenda();
}

function enforceMonthMinimum(input) {
  if (input.value && input.value < '2022-01') input.value = '2022-01';
}

const monthPickerLabels = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function selectedAgendaMonths() {
  return document.getElementById('agendaMonth').value.split(',').filter((value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value)).sort();
}

function agendaMonthLabel(value, long = false) {
  const [year, month] = value.split('-').map(Number);
  const name = long
    ? new Intl.DateTimeFormat('pt-BR', { month: 'long' }).format(new Date(year, month - 1, 1))
    : monthPickerLabels[month - 1];
  return name + '/' + year;
}

function renderMonthPicker(inputId, draftYear = null) {
  const input = document.getElementById(inputId);
  const prefix = inputId.slice(0, -'Month'.length);
  if (inputId === 'agendaMonth') {
    const months = selectedAgendaMonths();
    const yearInput = document.getElementById('agendaMonthYear');
    const draft = Number(draftYear) || Number(yearInput.value);
    const selectedYear = Math.max(2022, Math.min(9999, draft || Number(months[0]?.slice(0, 4)) || new Date().getFullYear()));
    yearInput.value = String(selectedYear);
    document.getElementById('agendaMonthDisplay').textContent = !months.length
      ? 'Todos os meses'
      : months.length === 1 ? agendaMonthLabel(months[0]) : months.length + ' meses selecionados';
    const selection = document.getElementById('agendaMonthSelection');
    selection.textContent = months.length ? months.length + (months.length === 1 ? ' mês selecionado.' : ' meses selecionados.') : 'Nenhum mês selecionado: exibindo todos os meses.';
    const chips = document.getElementById('agendaMonthChips');
    chips.replaceChildren();
    chips.hidden = months.length === 0;
    months.forEach((value) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'agenda-month-chip';
      const label = agendaMonthLabel(value, true);
      chip.setAttribute('aria-label', 'Remover ' + label + ' da seleção');
      const text = document.createElement('span');
      text.textContent = label.charAt(0).toLocaleUpperCase('pt-BR') + label.slice(1);
      const removeIcon = document.createElement('span');
      removeIcon.className = 'material-symbols';
      removeIcon.setAttribute('aria-hidden', 'true');
      removeIcon.textContent = 'close';
      chip.append(text, removeIcon);
      chip.addEventListener('click', () => {
        input.value = selectedAgendaMonths().filter((month) => month !== value).join(',');
        renderMonthPicker('agendaMonth');
        renderAgenda();
      });
      chips.append(chip);
    });
    const grid = document.getElementById('agendaMonthGrid');
    grid.replaceChildren();
    monthPickerLabels.forEach((monthLabel, index) => {
      const value = selectedYear + '-' + String(index + 1).padStart(2, '0');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'month-picker-option';
      button.textContent = monthLabel;
      const isSelected = months.includes(value);
      button.classList.toggle('selected', isSelected);
      button.setAttribute('aria-pressed', String(isSelected));
      button.addEventListener('click', () => {
        const next = new Set(selectedAgendaMonths());
        if (next.has(value)) next.delete(value);
        else next.add(value);
        input.value = [...next].sort().join(',');
        renderMonthPicker('agendaMonth', selectedYear);
        renderAgenda();
      });
      grid.append(button);
    });
    return;
  }
  const [year, month] = (input.value || monthValue()).split('-').map(Number);
  document.getElementById(prefix + 'MonthDisplay').textContent = input.value ? monthPickerLabels[month - 1] + '/' + year : 'Todos';
  const allMonthsButton = document.getElementById(prefix + 'MonthAll');
  if (allMonthsButton) {
    allMonthsButton.classList.toggle('selected', !input.value);
    allMonthsButton.setAttribute('aria-pressed', String(!input.value));
  }
  const yearSelect = document.getElementById(prefix + 'MonthYear');
  const selectedYear = Number(draftYear) || year;
  if (!yearSelect.options.length) {
    const lastYear = Math.max(new Date().getFullYear() + 5, year);
    for (let optionYear = 2022; optionYear <= lastYear; optionYear += 1) {
      const option = document.createElement('option');
      option.value = String(optionYear);
      option.textContent = String(optionYear);
      yearSelect.append(option);
    }
  }
  yearSelect.value = String(selectedYear);
  const grid = document.getElementById(prefix + 'MonthGrid');
  grid.replaceChildren();
  monthPickerLabels.forEach((monthLabel, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'month-picker-option';
    button.textContent = monthLabel;
    const isSelected = Boolean(input.value) && selectedYear === year && index + 1 === month;
    button.setAttribute('aria-pressed', String(isSelected));
    if (isSelected) button.classList.add('selected');
    button.addEventListener('click', () => {
      input.value = selectedYear + '-' + String(index + 1).padStart(2, '0');
      input.dispatchEvent(new Event('change', { bubbles: true }));
      closeMonthPicker(prefix);
    });
    grid.append(button);
  });
}

function closeMonthPicker(prefix) {
  document.getElementById(prefix + 'MonthPopover').hidden = true;
  document.getElementById(prefix + 'MonthToggle').setAttribute('aria-expanded', 'false');
}

function toggleMonthPicker(prefix) {
  const popover = document.getElementById(prefix + 'MonthPopover');
  const opening = popover.hidden;
  if (opening) {
    renderMonthPicker(prefix + 'Month');
    popover.hidden = false;
  } else popover.hidden = true;
  document.getElementById(prefix + 'MonthToggle').setAttribute('aria-expanded', String(opening));
}

function populateFilter(select, entries, allLabel, selectedValue) {
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = allLabel;
  select.append(all);
  entries.forEach((entry) => {
    const option = document.createElement('option');
    option.value = entry.value;
    option.textContent = entry.label;
    select.append(option);
  });
  if ([...select.options].some((option) => option.value === selectedValue)) select.value = selectedValue;
}

function availableCityFilterOptions() {
  const cityOptions = [...optionsByType.cities.filter((item) => item.active)];
  surgeries.forEach((surgery) => {
    if (!surgery.cityId || !surgery.city?.name || cityOptions.some((option) => option.id === surgery.cityId)) return;
    cityOptions.push({ id: surgery.cityId, name: surgery.city.name, active: true });
  });
  return cityOptions.map((item) => ({ value: item.id, label: item.name }));
}

function availableCompanyFilterOptions() {
  const companyOptions = [...optionsByType.companies.filter((item) => item.active)];
  surgeries.forEach((surgery) => {
    if (!surgery.companyId || !surgery.company?.name || companyOptions.some((option) => option.id === surgery.companyId)) return;
    companyOptions.push({ id: surgery.companyId, name: surgery.company.name, active: true });
  });
  return companyOptions.map((item) => ({ value: item.id, label: item.name }));
}

function populateAgendaFilters() {
  const doctor = document.getElementById('agendaDoctorFilter');
  const city = document.getElementById('agendaCityFilter');
  const company = document.getElementById('agendaCompanyFilter');
  const status = document.getElementById('agendaStatusFilter');
  const selectedDoctor = doctor.value;
  const selectedCity = city.value;
  const selectedCompany = company.value;
  const selectedStatus = status.value;
  populateFilter(doctor, optionsByType.doctors.filter((item) => item.active).map((item) => ({ value: item.id, label: item.name })), 'Todos os cirurgiões', selectedDoctor);
  populateFilter(city, availableCityFilterOptions(), 'Todas', selectedCity);
  populateFilter(company, availableCompanyFilterOptions(), 'Todas as empresas', selectedCompany);
  status.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'Todos';
  status.append(all);
  const reserved = document.createElement('option');
  reserved.value = 'reserved';
  reserved.textContent = 'Horário reservado';
  status.append(reserved);
  optionsByType.statuses.filter((item) => item.active).forEach((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    status.append(option);
  });
  if ([...status.options].some((option) => option.value === selectedStatus)) status.value = selectedStatus;
}

function normalizedStatus(value) {
  return (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
}

function statusStyle(status) {
  const configured = status?.color;
  if (/^#[\da-f]{6}$/i.test(configured || '')) return { color: configured, background: configured + '24', border: configured + '55' };
  const defaults = {
    'horario reservado': ['#075fbb', '#d9eaff', '#b9d7ff'],
    agendada: ['#a56500', '#fff1c6', '#f7dda0'],
    confirmada: ['#187844', '#d9f5e5', '#b5e6c8'],
    realizada: ['#6628b8', '#eadfff', '#d9c5fa'],
    remarcar: ['#b75500', '#ffead9', '#ffd2ae'],
    cancelada: ['#b42318', '#ffdddd', '#ffc6c4'],
  };
  const result = defaults[normalizedStatus(status?.name)] || ['#137f86', '#e8f7f6', '#bee8e5'];
  return { color: result[0], background: result[1], border: result[2] };
}

function makeStatusChip(status) {
  const chip = document.createElement('span');
  chip.className = 'status-chip';
  const name = status?.name || 'Sem status';
  const normalized = normalizedStatus(name);
  const iconName = normalized.includes('reservado') ? 'schedule'
    : normalized.includes('confirm') ? 'check_circle'
      : normalized.includes('realiz') ? 'task_alt'
        : normalized.includes('remarcar') ? 'update'
          : normalized.includes('cancel') ? 'cancel'
            : normalized.includes('agend') ? 'calendar_month' : 'medical_information';
  const icon = document.createElement('span');
  icon.className = 'material-symbols status-chip-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = iconName;
  chip.append(icon, document.createTextNode(name));
  const style = statusStyle(status);
  chip.style.setProperty('--chip-color', style.color);
  chip.style.setProperty('--chip-bg', style.background);
  chip.style.setProperty('--chip-border', style.border);
  return chip;
}

function dateLabel(date, withWeekday = false) {
  if (!date) return 'Data não informada';
  return new Intl.DateTimeFormat('pt-BR', withWeekday
    ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(date + 'T12:00:00'));
}

function filteredAgenda() {
  const months = selectedAgendaMonths();
  const doctor = document.getElementById('agendaDoctorFilter').value;
  const city = document.getElementById('agendaCityFilter').value;
  const company = document.getElementById('agendaCompanyFilter').value;
  const status = document.getElementById('agendaStatusFilter').value;
  const patient = document.getElementById('agendaPatientSearch').value.trim().toLocaleLowerCase('pt-BR');
  return surgeries.filter((surgery) => {
    if (months.length && (!surgery.date || !months.includes(surgery.date.slice(0, 7)))) return false;
    if (doctor && surgery.doctorId !== doctor) return false;
    // Bloqueios antigos sem cidade permanecem visíveis, pois sua cidade não
    // pode ser inferida. Os novos respeitam o filtro quando têm cidade salva.
    if (isAgendaBlockRecord(surgery)) {
      if (city && surgery.cityId && surgery.cityId !== city) return false;
      if (company && surgery.companyId !== company) return false;
      if (patient && !(surgery.reservationName || '').toLocaleLowerCase('pt-BR').includes(patient)) return false;
      return true;
    }
    if (city && surgery.cityId !== city) return false;
    if (company && surgery.companyId !== company) return false;
    if (patient && !(surgery.patient || surgery.reservationName || '').toLocaleLowerCase('pt-BR').includes(patient)) return false;
    if (status === 'reserved' && !surgery.isReserved) return false;
    if (status && status !== 'reserved' && (surgery.isReserved || surgery.statusId !== status)) return false;
    return true;
  }).sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || ''));
}

function agendaPeriodLabel() {
  const months = selectedAgendaMonths();
  return months.length ? months.map((value) => agendaMonthLabel(value, true)).join(', ') : 'Todos os meses';
}

function selectedAgendaCompanyLabel() {
  const id = document.getElementById('agendaCompanyFilter').value;
  return id ? optionsByType.companies.find((company) => company.id === id)?.name || surgeries.find((surgery) => surgery.companyId === id)?.company?.name || 'Empresa selecionada' : 'Todas as empresas';
}

function agendaMonthHeading(date) {
  if (!date) return 'Data não informada';
  const [year, month] = date.slice(0, 7).split('-').map(Number);
  return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1)).toLocaleUpperCase('pt-BR');
}

function agendaCompanyLabel(surgery) {
  return surgery.company?.name || 'Empresa não definida';
}

function appendCell(row, value, className = '') {
  const cell = document.createElement('td');
  const text = value || '—';
  cell.textContent = text;
  if (value) cell.title = String(value);
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

async function openSurgeryFromRow(surgery) {
  try {
    if (!settingsLoaded) await loadSettings();
    const current = surgeries.find((item) => item.id === surgery.id) || archivedSurgeries.find((item) => item.id === surgery.id);
    if (current) openSurgeryDialog(current);
  } catch (error) { showToast(error.message, 'error'); }
}

function normalizeEmployeeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
}

const agendaBlockColorOptions = [
  { color: '#EDE4FF', text: '#59359A', border: '#D7C7F2' },
  { color: '#DCEEFF', text: '#205D99', border: '#BEDBFA' },
  { color: '#DCF5E5', text: '#216B45', border: '#BFE7CC' },
  { color: '#FCE5D6', text: '#80512C', border: '#F2D0B9' },
  { color: '#FFF2C6', text: '#725C16', border: '#F0E2AC' },
  { color: '#FCE1EB', text: '#8B3E60', border: '#F0C6D5' },
  { color: '#DDF5F2', text: '#176B67', border: '#BDE4DF' },
  { color: '#E5EAFB', text: '#445487', border: '#CBD5F2' },
  { color: '#E8F1D5', text: '#486125', border: '#D3E1B7' },
];

function defaultDoctorBlockColor(name, id = '') {
  const normalized = normalizeEmployeeName(name).replace(/^(?:dra?|dr)\.?\s*/, '');
  if (normalized.startsWith('victoria')) return '#EDE4FF';
  if (normalized.startsWith('talissa')) return '#DCEEFF';
  if (normalized.startsWith('rafael')) return '#DCF5E5';
  const key = String(id || normalized);
  if (!key) return '';
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  const otherColors = agendaBlockColorOptions.slice(3);
  return otherColors[(hash >>> 0) % otherColors.length].color;
}

function setAgendaBlockColors(row, surgery) {
  const doctor = optionsByType.doctors.find((item) => item.id === surgery.doctorId) || surgery.doctor || {};
  const color = doctor.agendaBlockColor || defaultDoctorBlockColor(doctor.name, surgery.doctorId || doctor.id);
  const palette = agendaBlockColorOptions.find((item) => item.color.toLocaleLowerCase() === String(color).toLocaleLowerCase());
  row.style.setProperty('--agenda-block-background', color || '#EDE4FF');
  row.style.setProperty('--agenda-block-foreground', palette?.text || '#33485A');
  row.style.setProperty('--agenda-block-border', palette?.border || color || '#D7C7F2');
}

function renderAgenda() {
  const tbody = document.getElementById('agendaRows');
  if (!tbody) return;
  const table = document.getElementById('agendaTable');
  const empty = document.getElementById('agendaEmpty');
  const rows = filteredAgenda();
  tbody.replaceChildren();
  table.hidden = rows.length === 0;
  empty.hidden = rows.length > 0;
  document.getElementById('agendaResultCount').textContent = rows.length + (rows.length === 1 ? ' horário' : ' horários');
  document.getElementById('agendaPrintMeta').textContent = 'Empresa: ' + selectedAgendaCompanyLabel() + ' · Período: ' + agendaPeriodLabel();
  let currentDate = null;
  let currentMonth = null;
  rows.forEach((surgery) => {
    const monthKey = surgery.date ? surgery.date.slice(0, 7) : 'undated';
    if (monthKey !== currentMonth) {
      currentMonth = monthKey;
      const monthGroup = document.createElement('tr');
      monthGroup.className = 'agenda-month-group';
      const monthCell = document.createElement('td');
      monthCell.colSpan = 9;
      monthCell.textContent = agendaMonthHeading(surgery.date);
      monthGroup.append(monthCell);
      tbody.append(monthGroup);
    }
    if (surgery.date !== currentDate) {
      currentDate = surgery.date;
      const group = document.createElement('tr');
      group.className = 'agenda-day-group';
      const cell = document.createElement('td');
      cell.colSpan = 9;
      cell.textContent = dateLabel(surgery.date, true);
      group.append(cell);
      tbody.append(group);
    }
    const row = document.createElement('tr');
    const agendaBlock = isAgendaBlockRecord(surgery);
    row.className = 'agenda-data-row' + (agendaBlock ? ' agenda-block-row' : surgery.isReserved ? ' reserved-row' : '');
    if (agendaBlock) setAgendaBlockColors(row, surgery);
    row.tabIndex = 0;
    row.setAttribute('aria-label', (agendaBlock ? 'Bloqueio de Agenda: ' + surgery.reservationName : surgery.isReserved ? 'Horário reservado' : surgery.patient) + ', ' + dateLabel(surgery.date) + ', ' + (surgery.time || 'sem horário') + '. Clique para editar.');
    row.addEventListener('click', () => openSurgeryFromRow(surgery));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openSurgeryFromRow(surgery); }
    });
    appendCell(row, surgery.time);
    appendCell(row, agendaBlock ? surgery.reservationName : surgery.isReserved ? (surgery.reservationName || '— Horário reservado —') : surgery.patient, surgery.isReserved && !agendaBlock ? 'reserved-copy' : '');
    appendCell(row, surgery.doctor?.name);
    appendCell(row, agendaCompanyLabel(surgery), 'agenda-company-cell');
    const hospitalCell = document.createElement('td');
    row.append(hospitalCell);
    if (!agendaBlock) {
      const hospitalName = document.createElement('strong');
      hospitalName.textContent = surgery.hospital?.name || '—';
      hospitalCell.append(hospitalName);
      if (surgery.hospital?.name) hospitalCell.title = surgery.hospital.name;
    }
    if (surgery.city?.name) {
      const city = document.createElement('small');
      city.textContent = surgery.city.name;
      hospitalCell.append(city);
      hospitalCell.title = [surgery.hospital?.name, surgery.city.name].filter(Boolean).join(' · ');
    }
    if (agendaBlock) { row.append(document.createElement('td'), document.createElement('td'), document.createElement('td')); }
    else {
      appendCell(row, surgery.convenio);
      appendCell(row, surgery.isReserved ? '—' : surgery.procedure);
      appendCell(row, surgery.isReserved ? '—' : surgery.anesthetist);
    }
    const statusCell = document.createElement('td');
    if (!agendaBlock && surgery.status?.name) statusCell.title = surgery.status.name;
    if (agendaBlock) {
      statusCell.title = 'Bloqueio de Agenda';
      const blockType = document.createElement('span');
      blockType.className = 'agenda-block-type';
      const icon = document.createElement('span');
      icon.className = 'material-symbols';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = 'event_busy';
      blockType.append(icon, document.createTextNode('Bloqueio de Agenda'));
      statusCell.append(blockType);
    } else statusCell.append(makeStatusChip(surgery.status));
    row.append(statusCell);
    tbody.append(row);
  });
}

const managementIcons = {
  patient: 'person',
  phone: 'call',
  calendar: 'calendar_month',
  time: 'schedule',
  staff: 'badge',
  business: 'business',
  hospital: 'local_hospital',
  location: 'location_on',
  doctor: 'medical_services',
  surgery: 'healing',
  notes: 'notes',
  total: 'payments',
  paid: 'account_balance_wallet',
  pending: 'schedule',
  commission: 'percent',
};

function createManagementIcon(name, className = '') {
  const icon = document.createElement('span');
  icon.className = 'material-symbols management-icon ' + className;
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = managementIcons[name] || managementIcons.notes;
  return icon;
}

function managementMoney(value) {
  if (value && typeof value === 'object' && '$numberDecimal' in value) value = value.$numberDecimal;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  let normalized = value.trim().replace(/\s|R\$/gi, '');
  if (normalized.includes(',')) normalized = normalized.replace(/\./g, '').replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function managementMoneyLabel(value) {
  const amount = managementMoney(value);
  return amount === null ? '—' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(amount);
}

function managementDate(value) {
  if (!value) return '—';
  const source = String(value);
  const date = /^\d{4}-\d{2}-\d{2}/.test(source) ? source.slice(0, 10) : '';
  return date ? dateLabel(date) : '—';
}

function populateManagementFilters() {
  const month = document.getElementById('managementMonth');
  const doctor = document.getElementById('managementDoctorFilter');
  const company = document.getElementById('managementCompanyFilter');
  const city = document.getElementById('managementCityFilter');
  const status = document.getElementById('managementStatusFilter');
  if (!month || !doctor || !company || !city || !status) return;
  const selectedDoctor = doctor.value;
  const selectedCompany = company.value;
  const selectedCity = city.value;
  const selectedStatus = status.value;
  populateFilter(doctor, optionsByType.doctors.filter((item) => item.active).map((item) => ({ value: item.id, label: item.name })), 'Todos os cirurgiões', selectedDoctor);
  populateFilter(company, availableCompanyFilterOptions(), 'Todas as empresas', selectedCompany);
  populateFilter(city, availableCityFilterOptions(), 'Todas as cidades', selectedCity);
  status.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'Todos os status';
  status.append(all);
  optionsByType.statuses.filter((item) => item.active).forEach((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    status.append(option);
  });
  if ([...status.options].some((option) => option.value === selectedStatus)) status.value = selectedStatus;
}

function filteredManagementSurgeries() {
  const month = document.getElementById('managementMonth').value;
  const doctor = document.getElementById('managementDoctorFilter').value;
  const company = document.getElementById('managementCompanyFilter').value;
  const city = document.getElementById('managementCityFilter').value;
  const status = document.getElementById('managementStatusFilter').value;
  const patient = document.getElementById('managementPatientSearch').value.trim().toLocaleLowerCase('pt-BR');
  return surgeries.filter((surgery) => {
    if (surgery.isReserved || surgery.isAgendaBlock || surgery.recordType === 'agenda_block') return false;
    if (month && (!surgery.date || !surgery.date.startsWith(month))) return false;
    if (doctor && surgery.doctorId !== doctor) return false;
    if (company && surgery.companyId !== company) return false;
    if (city && surgery.cityId !== city) return false;
    if (status && surgery.statusId !== status) return false;
    if (patient && !(surgery.patient || '').toLocaleLowerCase('pt-BR').includes(patient)) return false;
    return true;
  }).sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || ''));
}

function createManagementInfo(iconName, label, value, className = '') {
  const item = document.createElement('div');
  item.className = 'management-info' + (className ? ' ' + className : '');
  item.append(createManagementIcon(iconName));
  const copy = document.createElement('div');
  copy.className = 'management-info-copy';
  const heading = document.createElement('span');
  heading.className = 'management-info-label';
  heading.textContent = label;
  const detail = document.createElement('span');
  detail.className = 'management-info-value';
  detail.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
  if (value !== null && value !== undefined && value !== '') detail.title = String(value);
  copy.append(heading, detail);
  item.append(copy);
  return item;
}

function createManagementObservation(value) {
  const observation = String(value || '').trim();
  if (!observation) return null;
  const wrapper = document.createElement('div');
  wrapper.className = 'management-observation';
  if (observation.length <= 150) {
    const label = document.createElement('strong');
    label.textContent = 'Observações';
    const text = document.createElement('span');
    text.textContent = observation;
    wrapper.append(label, text);
    return wrapper;
  }
  const disclosure = document.createElement('details');
  disclosure.className = 'management-observation-details';
  const summary = document.createElement('summary');
  const label = document.createElement('strong');
  label.textContent = 'Observações';
  const preview = document.createElement('span');
  preview.textContent = observation.slice(0, 150).trimEnd() + '…';
  preview.title = observation;
  const toggle = document.createElement('span');
  toggle.className = 'material-symbols management-observation-toggle';
  toggle.setAttribute('aria-hidden', 'true');
  toggle.textContent = 'expand_more';
  summary.append(label, preview, toggle);
  const fullText = document.createElement('p');
  fullText.textContent = observation;
  disclosure.append(summary, fullText);
  wrapper.append(disclosure);
  return wrapper;
}

function createFinanceItem(iconName, label, value) {
  const item = document.createElement('div');
  item.className = 'management-finance-item';
  item.append(createManagementIcon(iconName));
  const copy = document.createElement('div');
  const title = document.createElement('span');
  title.textContent = label;
  const amount = document.createElement('strong');
  amount.textContent = value;
  copy.append(title, amount);
  item.append(copy);
  return item;
}

function createSurgeryCard(surgery) {
  const card = document.createElement('article');
  card.className = 'surgery-card' + (surgery.isReserved ? ' is-reservation' : '');
  card.tabIndex = 0;
  const header = document.createElement('div');
  header.className = 'surgery-card-header';
  const patient = document.createElement('div');
  patient.className = 'surgery-card-patient';
  patient.append(createManagementIcon('patient', 'patient-mark'));
  const name = document.createElement('h3');
  name.textContent = surgery.isReserved ? (surgery.reservationName || 'Horário reservado') : (surgery.patient || '—');
  patient.append(name, makeStatusChip(surgery.status));
  const appointment = document.createElement('div');
  appointment.className = 'surgery-card-appointment';
  const date = document.createElement('span');
  date.append(createManagementIcon('calendar'), document.createTextNode(managementDate(surgery.date)));
  const time = document.createElement('span');
  time.append(createManagementIcon('time'), document.createTextNode(surgery.time || '—'));
  const actions = document.createElement('div');
  actions.className = 'surgery-card-actions';
  const edit = makeButton('', 'surgery-card-menu', () => openSurgeryFromRow(surgery), 'Editar cirurgia');
  const editIcon = document.createElement('span');
  editIcon.className = 'material-symbols';
  editIcon.setAttribute('aria-hidden', 'true');
  editIcon.textContent = 'edit';
  edit.append(editIcon);
  const archive = makeButton('', 'surgery-card-menu archive-action', () => archiveSurgery(surgery), 'Arquivar cirurgia');
  const archiveIcon = document.createElement('span');
  archiveIcon.className = 'material-symbols';
  archiveIcon.setAttribute('aria-hidden', 'true');
  archiveIcon.textContent = 'archive';
  archive.append(archiveIcon);
  actions.append(edit, archive);
  appointment.append(date, time, actions);
  header.append(patient, appointment);

  const details = document.createElement('div');
  details.className = 'surgery-card-details';
  const returnInfo = document.createElement('div');
  returnInfo.className = 'management-info management-info-return-group';
  returnInfo.append(
    createManagementInfo('calendar', 'Data do retorno', managementDate(surgery.returnDate), 'management-info-nested'),
    createManagementInfo('surgery', 'Tipo do retorno', surgery.returnType, 'management-info-nested'),
  );
  details.append(
    createManagementInfo('phone', 'Telefone', surgery.phone),
    createManagementInfo('calendar', 'Data da consulta', managementDate(surgery.consultationDate)),
    createManagementInfo('staff', 'Orçamentista', surgery.employeeName || surgery.employee?.name),
    createManagementInfo('business', 'Empresa', surgery.company?.name || 'Empresa não definida'),
    createManagementInfo('hospital', 'Hospital', surgery.hospital?.name),
    createManagementInfo('location', 'Cidade', surgery.city?.name),
    createManagementInfo('doctor', 'Médica / Cirurgião', surgery.doctor?.name),
    createManagementInfo('doctor', 'Anestesista', surgery.anesthetist),
    createManagementInfo('surgery', 'Cirurgia', surgery.isReserved ? '—' : surgery.procedure, 'management-info-procedure'),
    createManagementInfo('business', 'Convênio', surgery.convenio),
    returnInfo,
  );
  const observation = createManagementObservation(surgery.observations);

  const total = managementMoney(surgery.totalAmount);
  const deposit = managementMoney(surgery.depositPaid);
  const pending = total !== null ? Math.max(total - (deposit ?? 0), 0) : null;
  const finance = document.createElement('div');
  finance.className = 'surgery-card-finance';
  finance.append(
    createFinanceItem('total', 'Valor Total', managementMoneyLabel(surgery.totalAmount)),
    createFinanceItem('paid', 'Sinal Pago', managementMoneyLabel(surgery.depositPaid)),
    createFinanceItem('pending', 'Falta Pagar', pending === null ? '—' : managementMoneyLabel(pending)),
  );
  card.append(header, details);
  if (observation) card.append(observation);
  card.append(finance);
  card.addEventListener('click', (event) => {
    if (!event.target.closest('button, details')) openSurgeryFromRow(surgery);
  });
  card.addEventListener('keydown', (event) => {
    if (event.target === card && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      openSurgeryFromRow(surgery);
    }
  });
  return card;
}

function renderSurgeries() {
  const container = document.getElementById('surgeryCards');
  const empty = document.getElementById('surgeryEmpty');
  if (!container || !empty) return;
  const rows = filteredManagementSurgeries();
  container.replaceChildren();
  empty.hidden = rows.length > 0;
  rows.forEach((surgery) => container.append(createSurgeryCard(surgery)));

  const month = document.getElementById('managementMonth').value;
  let period = 'Cirurgias';
  if (month) {
    const [year, number] = month.split('-').map(Number);
    const label = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(new Date(year, number - 1, 1));
    period = 'Cirurgias de ' + label.charAt(0).toLocaleUpperCase('pt-BR') + label.slice(1);
  }
  document.getElementById('managementPeriodTitle').textContent = period;
  document.getElementById('managementResultCount').textContent = rows.length + (rows.length === 1 ? ' cirurgia encontrada' : ' cirurgias encontradas');
  const surgeriesOnly = rows;
  document.getElementById('managementSurgeryCount').textContent = String(surgeriesOnly.length);
  const totals = surgeriesOnly.map((item) => managementMoney(item.totalAmount));
  const deposits = surgeriesOnly.map((item) => managementMoney(item.depositPaid));
  const knownTotalIndexes = totals.flatMap((value, index) => value === null ? [] : [index]);
  const hasKnownTotals = knownTotalIndexes.length > 0;
  const totalValue = knownTotalIndexes.reduce((sum, index) => sum + totals[index], 0);
  const pendingValue = knownTotalIndexes.reduce((sum, index) => sum + Math.max(totals[index] - (deposits[index] ?? 0), 0), 0);
  document.getElementById('managementTotalValue').textContent = hasKnownTotals ? managementMoneyLabel(totalValue) : '—';
  document.getElementById('managementPendingValue').textContent = hasKnownTotals ? managementMoneyLabel(pendingValue) : '—';
}

function renderSharePreview() {
  const container = document.getElementById('shareAgendaContent');
  const rows = filteredAgenda();
  container.replaceChildren();
  const brand = document.createElement('p');
  brand.className = 'share-brand';
  brand.textContent = 'OperaMeds · Organização Cirúrgica';
  container.append(brand);
  const title = document.createElement('p');
  title.className = 'share-period';
  title.textContent = 'Empresa: ' + selectedAgendaCompanyLabel() + ' · Período: ' + agendaPeriodLabel();
  container.append(title);
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'share-empty';
    empty.textContent = 'Nenhum horário encontrado para os filtros selecionados.';
    container.append(empty);
    return;
  }
  const table = document.createElement('table');
  table.className = 'share-table';
  const columns = document.createElement('colgroup');
  [7, 16, 11, 9, 10, 10, 20, 8, 9].forEach((width) => {
    const column = document.createElement('col');
    column.style.width = width + '%';
    columns.append(column);
  });
  table.append(columns);
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  ['Horário', 'Paciente / Motivo', 'Cirurgião', 'Empresa', 'Hospital', 'Convênio', 'Cirurgia', 'Anestesista', 'Status / Tipo'].forEach((label) => {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.append(th);
  });
  head.append(headerRow);
  table.append(head);
  const body = document.createElement('tbody');
  let currentDate = null;
  let currentMonth = null;
  rows.forEach((surgery) => {
    const monthKey = surgery.date ? surgery.date.slice(0, 7) : 'undated';
    if (monthKey !== currentMonth) {
      currentMonth = monthKey;
      const monthGroup = document.createElement('tr');
      monthGroup.className = 'agenda-month-group';
      const cell = document.createElement('td');
      cell.colSpan = 9;
      cell.textContent = agendaMonthHeading(surgery.date);
      monthGroup.append(cell);
      body.append(monthGroup);
    }
    if (surgery.date !== currentDate) {
      currentDate = surgery.date;
      const group = document.createElement('tr');
      group.className = 'agenda-day-group';
      const cell = document.createElement('td');
      cell.colSpan = 9;
      cell.textContent = dateLabel(surgery.date, true);
      group.append(cell);
      body.append(group);
    }
    const row = document.createElement('tr');
    if (isAgendaBlockRecord(surgery)) {
      row.className = 'agenda-block-row';
      setAgendaBlockColors(row, surgery);
    }
    appendCell(row, surgery.time);
    appendCell(row, isAgendaBlockRecord(surgery) ? surgery.reservationName : surgery.isReserved ? (surgery.reservationName || '— Horário reservado —') : surgery.patient);
    appendCell(row, surgery.doctor?.name);
    appendCell(row, agendaCompanyLabel(surgery));
    const agendaBlock = isAgendaBlockRecord(surgery);
    if (agendaBlock) row.append(document.createElement('td'));
    else appendCell(row, [surgery.hospital?.name, surgery.city?.name].filter(Boolean).join(' · '));
    if (agendaBlock) row.append(document.createElement('td'));
    else appendCell(row, surgery.convenio);
    if (agendaBlock) row.append(document.createElement('td'));
    else appendCell(row, surgery.isReserved ? '—' : surgery.procedure);
    if (agendaBlock) row.append(document.createElement('td'));
    else appendCell(row, surgery.isReserved ? '—' : surgery.anesthetist);
    const statusCell = document.createElement('td');
    if (!agendaBlock && surgery.status?.name) statusCell.title = surgery.status.name;
    if (agendaBlock) {
      statusCell.title = 'Bloqueio de Agenda';
      const blockType = document.createElement('span');
      blockType.className = 'agenda-block-type';
      const icon = document.createElement('span');
      icon.className = 'material-symbols';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = 'event_busy';
      blockType.append(icon, document.createTextNode('Bloqueio de Agenda'));
      statusCell.append(blockType);
    } else statusCell.append(makeStatusChip(surgery.status));
    row.append(statusCell);
    body.append(row);
  });
  table.append(body);
  container.append(table);
}

function showLoginGate(message = '') {
  const form = document.getElementById('authForm');
  form.reset();
  setFormMessage(document.getElementById('authMessage'), message);
  document.getElementById('authGate').hidden = false;
  form.elements.username.focus();
}

function enterApplication(user) {
  currentEmployee = user;
  surgeriesLoadedAt = 0;
  settingsLoadedAt = 0;
  document.getElementById('currentEmployeeAvatar').textContent = user.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toLocaleUpperCase('pt-BR');
  document.getElementById('currentEmployeeName').textContent = user.name;
  document.getElementById('authGate').hidden = true;
  navigate('painel');
}

async function initialize() {
  try {
    const result = await api('/api/session');
    if (result.authenticated) enterApplication(result.user);
    else showLoginGate();
  } catch (error) {
    showLoginGate('Não foi possível acessar o OperaMeds: ' + error.message);
  }
}

async function submitLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById('authMessage');
  const submit = form.querySelector('[type="submit"]');
  const body = { username: form.elements.username.value.trim(), pin: form.elements.pin.value };
  if (!body.username) {
    setFormMessage(message, 'Informe o nome de usuário.');
    form.elements.username.focus();
    return;
  }
  if (!/^\d{4}$/.test(body.pin)) {
    setFormMessage(message, 'Digite a senha completa com exatamente 4 dígitos.');
    form.elements.pin.focus();
    return;
  }
  submit.disabled = true;
  setFormMessage(message, 'Verificando acesso…', 'info');
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify(body) });
    enterApplication(result.user);
  } catch (error) {
    setFormMessage(message, error.message);
  } finally { submit.disabled = false; }
}

navLinks.forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); navigate(link.dataset.page); }));
menuToggle.addEventListener('click', () => {
  const open = !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
  scrim.classList.toggle('visible', open);
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
});
scrim.addEventListener('click', closeMenu);
window.addEventListener('popstate', () => navigate(location.hash.slice(1) || 'painel', false));

document.querySelectorAll('[data-settings-tab]').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('[data-settings-tab]').forEach((item) => {
    const selected = item === tab;
    item.classList.toggle('active', selected);
    item.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('[data-settings-panel]').forEach((panel) => {
    const selected = panel.dataset.settingsPanel === tab.dataset.settingsTab;
    panel.classList.toggle('active', selected);
    panel.hidden = !selected;
  });
  if (tab.dataset.settingsTab === 'budgeters') loadSettings().catch((error) => showToast(error.message, 'error'));
  if (tab.dataset.settingsTab === 'employees') loadUsers().catch((error) => showToast(error.message, 'error'));
  if (tab.dataset.settingsTab === 'commissions') Promise.all([loadSettings(), loadSurgeries()]).catch((error) => showToast(error.message, 'error'));
}));
document.querySelectorAll('.add-option').forEach((button) => button.addEventListener('click', () => openOptionDialog(button.dataset.optionType)));
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.closeDialog === 'surgeryDialog') requestCloseSurgeryDialog();
  else document.getElementById(button.dataset.closeDialog).close();
}));
document.querySelectorAll('.app-dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (event.target !== dialog || dialog.id === 'surgeryDialog') return;
  dialog.close();
}));
document.getElementById('surgeryDialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  requestCloseSurgeryDialog();
});
document.getElementById('optionForm').addEventListener('submit', saveOption);
document.getElementById('employeeForm').addEventListener('submit', saveEmployee);
document.getElementById('budgeterForm').addEventListener('submit', saveBudgeter);
document.getElementById('surgeryForm').addEventListener('submit', saveSurgery);
document.getElementById('archiveConfirmButton').addEventListener('click', confirmArchiveSurgery);
document.getElementById('deleteAgendaBlockButton').addEventListener('click', requestDeleteAgendaBlock);
document.getElementById('confirmDeleteAgendaBlockButton').addEventListener('click', confirmDeleteAgendaBlock);
document.getElementById('continueSurgeryEditingButton').addEventListener('click', () => document.getElementById('unsavedSurgeryDialog').close());
document.getElementById('discardSurgeryChangesButton').addEventListener('click', discardSurgeryFormChanges);
document.getElementById('convertReservationButton').addEventListener('click', convertReservationToSurgery);
document.getElementById('authForm').addEventListener('submit', submitLogin);
document.querySelector('#authForm [name="pin"]').addEventListener('input', (event) => {
  event.currentTarget.value = event.currentTarget.value.replace(/\D/g, '').slice(0, 4);
});
document.getElementById('addEmployeeButton').addEventListener('click', () => openEmployeeDialog());
document.getElementById('addBudgeterButton').addEventListener('click', () => openBudgeterDialog());
document.getElementById('commissionEmployeeFilter').addEventListener('change', renderCommissions);
document.getElementById('commissionPaymentFilter').addEventListener('change', renderCommissions);
document.getElementById('commissionsMonth').addEventListener('change', (event) => {
  enforceMonthMinimum(event.currentTarget);
  renderMonthPicker('commissionsMonth');
  renderCommissions();
});
document.getElementById('commissionsMonth').value = monthValue();
document.getElementById('addSurgeryButton').addEventListener('click', openNewSurgeryDialog);
document.getElementById('agendaAddSurgeryButton').addEventListener('click', openNewSurgeryDialog);
document.querySelector('#surgeryForm [name="isAgendaBlock"]').addEventListener('change', syncReservationFields);
document.querySelector('#surgeryForm [name="employeeId"]').addEventListener('change', (event) => {
  const selected = budgeters.find((item) => item.id === event.currentTarget.value);
  document.querySelector('#surgeryForm [name="employeeName"]').value = selected?.name || '';
});
document.querySelector('#employeeForm [name="pin"]').addEventListener('input', (event) => {
  event.currentTarget.value = event.currentTarget.value.replace(/\D/g, '').slice(0, 4);
});
['totalAmount', 'depositPaid'].forEach((name) => document.querySelector('#surgeryForm [name="' + name + '"]').addEventListener('input', calculateSurgeryAmounts));
document.getElementById('logoutButton').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
  currentEmployee = null;
  showLoginGate();
});

['agendaMonth', 'agendaDoctorFilter', 'agendaCityFilter', 'agendaCompanyFilter', 'agendaStatusFilter', 'agendaPatientSearch'].forEach((id) => {
  document.getElementById(id).addEventListener('change', (event) => {
    if (id === 'agendaMonth') enforceMonthMinimum(event.currentTarget);
    if (id === 'agendaMonth') renderMonthPicker('agendaMonth');
    renderAgenda();
  });
  if (id === 'agendaPatientSearch') document.getElementById(id).addEventListener('input', renderAgenda);
});
document.getElementById('agendaMonth').value = monthValue();
['managementMonth', 'managementDoctorFilter', 'managementCompanyFilter', 'managementCityFilter', 'managementStatusFilter', 'managementPatientSearch'].forEach((id) => {
  document.getElementById(id).addEventListener(id === 'managementPatientSearch' ? 'input' : 'change', (event) => {
    if (id === 'managementMonth') enforceMonthMinimum(event.currentTarget);
    if (id === 'managementMonth') renderMonthPicker('managementMonth');
    renderSurgeries();
  });
});
document.getElementById('managementMonth').value = monthValue();
['agenda', 'management', 'commissions'].forEach((prefix) => {
  document.getElementById(prefix + 'MonthToggle').addEventListener('click', () => toggleMonthPicker(prefix));
  document.getElementById(prefix + 'MonthYear').addEventListener('change', (event) => {
    renderMonthPicker(prefix + 'Month', Number(event.currentTarget.value));
  });
  renderMonthPicker(prefix + 'Month');
});
document.addEventListener('click', (event) => {
  ['agenda', 'management', 'commissions'].forEach((prefix) => {
    const wrap = document.getElementById(prefix + 'MonthToggle').closest('.month-picker-wrap');
    if (!wrap.contains(event.target)) closeMonthPicker(prefix);
  });
});
document.getElementById('agendaShareButton').addEventListener('click', () => {
  renderSharePreview();
  document.getElementById('shareDialog').showModal();
});
document.getElementById('agendaPrintButton').addEventListener('click', () => {
  document.body.classList.add('printing-agenda');
  window.print();
  setTimeout(() => document.body.classList.remove('printing-agenda'), 800);
});
document.getElementById('sharePrintButton').addEventListener('click', () => {
  document.body.classList.add('printing-share');
  window.print();
  setTimeout(() => document.body.classList.remove('printing-share'), 800);
});

initialize();
