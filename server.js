const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { MongoClient, ObjectId } = require('mongodb');

const root = __dirname;
const port = Number(process.env.PORT) || 3000;
const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB || 'operamed';
const optionTypes = new Set(['doctors', 'statuses', 'cities']);
const collectionNames = { options: 'settings_options', surgeries: 'surgeries', employees: 'employees', budgeters: 'budgeters', users: 'users', sessions: 'sessions', metadata: 'system_metadata' };
const scrypt = promisify(crypto.scrypt);
const loginAttempts = new Map();

let mongoClient;
let connectionPromise;
let indexesPromise;

function getDatabase() {
  if (!mongoUri) {
    throw Object.assign(new Error('MONGODB_URI não foi definida. Configure a variável no ambiente.'), { status: 500 });
  }
  if (!mongoClient) {
    mongoClient = new MongoClient(mongoUri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 10000,
      maxPoolSize: 10,
    });
  }
  if (!connectionPromise) {
    connectionPromise = mongoClient.connect().then(() => mongoClient.db(databaseName)).catch((error) => {
      connectionPromise = undefined;
      throw error;
    });
  }
  return connectionPromise;
}

async function getCollections() {
  const db = await getDatabase();
  if (!indexesPromise) {
    indexesPromise = (async () => {
      const employeesExist = await db.listCollections({ name: collectionNames.employees }, { nameOnly: true }).hasNext();
      if (employeesExist) {
        const employeeIndexes = await db.collection(collectionNames.employees).indexes();
        if (employeeIndexes.some((index) => index.name === 'unique_employee_username')) {
          await db.collection(collectionNames.employees).dropIndex('unique_employee_username');
        }
      }
      await Promise.all([
        db.collection(collectionNames.options).createIndex({ type: 1, nameKey: 1 }, { unique: true, name: 'unique_setting_name_per_type', partialFilterExpression: { type: { $exists: true }, nameKey: { $exists: true } } }),
        db.collection(collectionNames.budgeters).createIndex({ nameKey: 1 }, { unique: true, name: 'unique_budgeter_name' }),
        db.collection(collectionNames.surgeries).createIndex({ updatedAt: -1 }, { name: 'surgeries_updated_at' }),
        db.collection(collectionNames.users).createIndex({ usernameKey: 1 }, { unique: true, name: 'unique_access_username' }),
        db.collection(collectionNames.sessions).createIndex({ tokenHash: 1 }, { unique: true, name: 'unique_session_token' }),
        db.collection(collectionNames.sessions).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expire_sessions' }),
      ]);
      const legacyBudgeters = await db.collection(collectionNames.employees).find({}).toArray();
      if (legacyBudgeters.length) await db.collection(collectionNames.budgeters).bulkWrite(legacyBudgeters.map((item) => ({
        updateOne: {
          filter: { _id: item._id },
          update: { $setOnInsert: { _id: item._id, name: item.name, nameKey: item.nameKey || item.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR'), active: item.active !== false && !item.deletedAt, createdAt: item.createdAt || new Date(), updatedAt: item.updatedAt || new Date() } },
          upsert: true,
        },
      })));
    })().catch((error) => {
      indexesPromise = undefined;
      throw error;
    });
  }
  await indexesPromise;
  return {
    db,
    options: db.collection(collectionNames.options),
    surgeries: db.collection(collectionNames.surgeries),
    employees: db.collection(collectionNames.employees),
    budgeters: db.collection(collectionNames.budgeters),
    users: db.collection(collectionNames.users),
    sessions: db.collection(collectionNames.sessions),
    metadata: db.collection(collectionNames.metadata),
  };
}

const publicFiles = new Map([
  ['/',['index.html','text/html; charset=utf-8']],
  ['/index.html',['index.html','text/html; charset=utf-8']],
  ['/styles.css',['styles.css','text/css; charset=utf-8']],
  ['/app.js',['app.js','text/javascript; charset=utf-8']],
  ['/assets/operameds-logo.png',['assets/operameds-logo.png','image/png']],
  ['/assets/operameds-icon.png',['assets/operameds-icon.png','image/png']],
]);

function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) throw Object.assign(new Error('O formulário excede o tamanho permitido.'), { status: 413 });
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw Object.assign(new Error('O conteúdo enviado não é JSON válido.'), { status: 400 });
  }
}

function normalizedName(value) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}

function validateOption(body) {
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw Object.assign(new Error('Informe o nome.'), { status: 400 });
  if (name.length > 120) throw Object.assign(new Error('O nome deve ter até 120 caracteres.'), { status: 400 });
  const color = body.type === 'statuses' ? body.color : null;
  if (body.type === 'statuses' && !/^#[\da-f]{6}$/i.test(color || '')) {
    throw Object.assign(new Error('Escolha uma cor válida para o status.'), { status: 400 });
  }
  return {
    name,
    nameKey: normalizedName(name),
    color,
    active: body.active !== false,
    commissionEligible: body.type === 'statuses' && body.commissionEligible === true,
  };
}

function serializeOption(option) {
  return { id: option._id.toString(), type: option.type, name: option.name, color: option.color || null, active: option.active !== false, commissionEligible: option.type === 'statuses' && option.commissionEligible === true };
}

function isDuplicateError(error) {
  return error && error.code === 11000;
}

async function parseOptionType(url) {
  const type = url.searchParams.get('type');
  if (type && !optionTypes.has(type)) throw Object.assign(new Error('Categoria inválida.'), { status: 400 });
  return type;
}

function publicEmployee(employee) {
  return { id: employee._id.toString(), name: employee.name, active: employee.active !== false, role: employee.role === 'admin' ? 'admin' : 'employee' };
}

function publicUser(user, primaryAdminId = '') {
  const id = user._id.toString();
  const isPrimaryAdmin = id === primaryAdminId || user.isPrimaryAdmin === true;
  return { id, name: user.name || user.username, username: user.username, role: isPrimaryAdmin || user.role === 'admin' ? 'admin' : 'user', active: user.active !== false, isPrimaryAdmin };
}

function validateAccessUser(body, { allowOptionalPin = false } = {}) {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const pin = typeof body.pin === 'string' ? body.pin : '';
  if (!/^[\p{L}\d._-]{3,40}$/u.test(username)) throw Object.assign(new Error('Informe um nome de usuário válido.'), { status: 400 });
  if ((!allowOptionalPin || pin) && !/^\d{4}$/.test(pin)) throw Object.assign(new Error('A senha deve conter exatamente 4 dígitos.'), { status: 400 });
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length > 120) throw Object.assign(new Error('O nome deve ter até 120 caracteres.'), { status: 400 });
  const role = body.role === 'admin' ? 'admin' : body.role === undefined || body.role === 'user' ? 'user' : null;
  if (!role) throw Object.assign(new Error('Selecione um tipo de acesso válido.'), { status: 400 });
  return { name: name || username, username, usernameKey: username.toLocaleLowerCase('pt-BR'), pin, role, active: body.active !== false };
}

function validateBudgeter(body) {
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 120) throw Object.assign(new Error('Informe um nome de até 120 caracteres.'), { status: 400 });
  return { name, nameKey: name.toLocaleLowerCase('pt-BR'), active: body.active !== false };
}

function requireAdmin(user) {
  if (user?.isPrimaryAdmin || user?.role === 'admin') return;
  throw Object.assign(new Error('Acesso somente para administradores.'), { status: 403 });
}

function protectPrimaryTarget(targetId, primaryAdminId, user, allowPrimarySelf = false) {
  if (targetId === primaryAdminId && !(allowPrimarySelf && user?.isPrimaryAdmin)) {
    throw Object.assign(new Error('A conta da Administradora Principal está protegida.'), { status: 403 });
  }
}

async function makePinRecord(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = await scrypt(pin, salt, 64);
  return { pinSalt: salt, pinHash: hash.toString('hex') };
}

function sessionToken(request) {
  const cookie = request.headers.cookie || '';
  const item = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('operamed_session='));
  if (!item) return '';
  try { return decodeURIComponent(item.slice('operamed_session='.length)); } catch { return ''; }
}

function sessionCookie(token, request, maxAge = 60 * 60 * 24 * 7) {
  const secure = request.headers['x-forwarded-proto'] === 'https';
  return `operamed_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

async function userForRequest(request, collections) {
  const token = sessionToken(request);
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = await collections.sessions.findOne({ tokenHash, expiresAt: { $gt: new Date() } });
  if (!session || !ObjectId.isValid(session.userId)) return null;
  const user = await collections.users.findOne({ _id: new ObjectId(session.userId), active: { $ne: false } });
  if (!user) return null;
  const primaryAdmin = await collections.metadata.findOne({ _id: 'primary-admin' });
  return publicUser(user, primaryAdmin?.userId || '');
}

function checkLoginRateLimit(request, username) {
  const key = `${request.socket.remoteAddress || 'unknown'}:${username.toLocaleLowerCase('pt-BR')}`;
  const now = Date.now();
  const state = loginAttempts.get(key);
  if (state && state.blockedUntil > now) throw Object.assign(new Error('Acesso temporariamente bloqueado. Tente novamente em 15 minutos.'), { status: 429 });
  if (state && now - state.startedAt > 15 * 60 * 1000) loginAttempts.delete(key);
  return key;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const state = loginAttempts.get(key) || { count: 0, startedAt: now };
  state.count += 1;
  if (state.count >= 10) state.blockedUntil = now + 15 * 60 * 1000;
  loginAttempts.set(key, state);
  return Math.max(10 - state.count, 0);
}

function rejectLogin(key) {
  const remaining = recordLoginFailure(key);
  if (remaining === 0) throw Object.assign(new Error('Acesso temporariamente bloqueado por 15 minutos após 10 tentativas incorretas.'), { status: 429 });
  const attempt = remaining === 1 ? 'tentativa' : 'tentativas';
  throw Object.assign(new Error(`Usuário ou senha incorretos. Você tem ${remaining} ${attempt}.`), { status: 401 });
}

async function validateSurgeryReferences(collections, values, previous = null) {
  const isReserved = values.isReserved === true;
  const result = {};
  const doctorId = typeof values.doctorId === 'string' ? values.doctorId : '';
  if (!ObjectId.isValid(doctorId)) throw Object.assign(new Error('Selecione uma médica ou cirurgião ativo.'), { status: 400 });
  const doctor = await collections.options.findOne({ _id: new ObjectId(doctorId), type: 'doctors' });
  if (!doctor || (!doctor.active && (!previous || previous.doctorId !== doctorId))) throw Object.assign(new Error('Selecione uma médica ou cirurgião ativo.'), { status: 400 });
  result.doctorId = doctorId;

  const cityId = typeof values.cityId === 'string' ? values.cityId : '';
  if (cityId) {
    if (!ObjectId.isValid(cityId)) throw Object.assign(new Error('Selecione uma cidade válida.'), { status: 400 });
    const city = await collections.options.findOne({ _id: new ObjectId(cityId), type: 'cities' });
    if (!city || (!city.active && (!previous || previous.cityId !== cityId))) throw Object.assign(new Error('Selecione uma cidade ativa.'), { status: 400 });
    result.cityId = cityId;
  } else result.cityId = null;

  const employeeId = typeof values.employeeId === 'string' ? values.employeeId : '';
  if (employeeId) {
    if (!ObjectId.isValid(employeeId)) throw Object.assign(new Error('Selecione um orçamentista válido.'), { status: 400 });
    let budgeter = await collections.budgeters.findOne({ _id: new ObjectId(employeeId) });
    if (!budgeter) budgeter = await collections.employees.findOne({ _id: new ObjectId(employeeId) });
    if (!budgeter || ((budgeter.active === false || budgeter.deletedAt) && (!previous || previous.employeeId !== employeeId))) throw Object.assign(new Error('Selecione um orçamentista ativo.'), { status: 400 });
    result.employeeId = employeeId;
    result.employeeName = budgeter.name;
  } else {
    result.employeeId = null;
    result.employeeName = typeof values.employeeName === 'string' ? values.employeeName.trim() : '';
  }
  for (const [field, required, collection, type] of [
    ['statusId', !isReserved, collections.options, 'statuses'],
  ]) {
    const id = typeof values[field] === 'string' ? values[field] : '';
    if (!id && !required) {
      result[field] = previous?.[field] || null;
      continue;
    }
    if (!ObjectId.isValid(id)) throw Object.assign(new Error('Selecione um status ativo.'), { status: 400 });
    const query = { _id: new ObjectId(id), active: { $ne: false } };
    if (type) query.type = type;
    const option = await collection.findOne(query);
    const prior = previous && previous[field] === id;
    let existingInactive = prior && !option && await collection.findOne({ _id: new ObjectId(id), ...(type ? { type } : {}) });
    if (prior && !option && field === 'employeeId' && !existingInactive) existingInactive = await collections.options.findOne({ _id: new ObjectId(id), type: 'employees' });
    if (!option && !existingInactive) throw Object.assign(new Error('Uma das opções selecionadas não existe mais.'), { status: 400 });
    if (!option && !prior) throw Object.assign(new Error('Selecione uma opção ativa; a opção inativa atual pode ser mantida ao editar.'), { status: 400 });
    result[field] = id;
  }

  return result;
}

function validateSurgeryDetails(body) {
  const date = typeof body.date === 'string' ? body.date : '';
  const time = typeof body.time === 'string' ? body.time : '';
  const isReserved = body.isReserved === true;
  const dateParts = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const normalizedDate = dateParts ? new Date(Date.UTC(Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3]))) : null;
  if (!normalizedDate || Number.isNaN(normalizedDate.getTime()) || normalizedDate.toISOString().slice(0, 10) !== date) {
    throw Object.assign(new Error('Informe uma data válida para a cirurgia.'), { status: 400 });
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw Object.assign(new Error('Informe um horário válido.'), { status: 400 });
  }
  const fields = {};
  for (const [key, label, maxLength, required] of [
    ['patient', 'paciente', 160, !isReserved],
    ['procedure', 'cirurgia', 160, !isReserved],
    ['anesthetist', 'anestesista', 160, false],
    ['employeeName', 'orçamentista', 160, false],
    ['hospitalName', 'hospital', 160, !isReserved],
    ['reservationName', 'identificação do horário', 160, false],
    ['phone', 'telefone', 40, false],
    ['returnType', 'tipo do retorno', 120, false],
    ['observations', 'observações', 2000, false],
  ]) {
    const value = typeof body[key] === 'string' ? body[key].trim().replace(/\s+/g, ' ') : '';
    if (required && !value) throw Object.assign(new Error(`Informe ${label}.`), { status: 400 });
    if (value.length > maxLength) throw Object.assign(new Error(`O campo ${label} deve ter até ${maxLength} caracteres.`), { status: 400 });
    fields[key] = value;
  }
  for (const field of ['consultationDate', 'returnDate']) {
    const value = typeof body[field] === 'string' ? body[field] : '';
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Object.assign(new Error(`Informe uma data válida para ${field === 'returnDate' ? 'o retorno' : 'a consulta'}.`), { status: 400 });
    fields[field] = value;
  }
  const readAmount = (field, label) => {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') return null;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0 || amount > 999999999) throw Object.assign(new Error(`Informe um valor válido para ${label}.`), { status: 400 });
    return Math.round((amount + Number.EPSILON) * 100) / 100;
  };
  const totalAmount = readAmount('totalAmount', 'valor total');
  const depositPaid = readAmount('depositPaid', 'sinal pago');
  fields.totalAmount = totalAmount;
  fields.depositPaid = depositPaid;
  fields.pendingAmount = totalAmount === null ? null : Math.round(Math.max(totalAmount - (depositPaid || 0), 0) * 100) / 100;
  return { ...fields, date, time, isReserved, recordType: isReserved ? 'reservation' : 'surgery' };
}

async function serializeSurgery(surgery, collections, lookups = null) {
  const hydrated = {};
  for (const [idField, name, collection, type] of [
    ['doctorId', 'doctor', collections.options, 'doctors'],
    ['employeeId', 'employee', collections.budgeters, null],
    ['statusId', 'status', collections.options, 'statuses'],
    ['cityId', 'city', collections.options, 'cities'],
  ]) {
    const id = surgery[idField] || null;
    const lookup = collection === collections.budgeters ? lookups?.budgeters : lookups?.options;
    let option = id && ObjectId.isValid(id)
      ? (lookup ? lookup.get(id) || null : await collection.findOne({ _id: new ObjectId(id), ...(type ? { type } : {}) }))
      : null;
    if (!option && id && name === 'employee' && ObjectId.isValid(id)) option = lookups?.legacyEmployees?.get(id) || await collections.employees.findOne({ _id: new ObjectId(id) });
    if (option && type && option.type !== type) option = null;
    let legacyEmployee = false;
    if (!option && id && name === 'employee' && ObjectId.isValid(id)) {
      option = lookups?.options ? lookups.options.get(id) || null : await collections.options.findOne({ _id: new ObjectId(id), type: 'employees' });
      if (option?.type !== 'employees') option = null;
      legacyEmployee = Boolean(option);
    }
    hydrated[idField] = id;
    hydrated[name] = id ? (option ? (type || legacyEmployee ? serializeOption(option) : publicEmployee(option)) : { id, name: 'Cadastro não encontrado', active: false }) : null;
  }
  if (surgery.isReserved) {
    hydrated.status = { id: null, type: 'reserved', name: 'Horário reservado', color: '#1670d2', active: true, virtual: true };
  } else if (!surgery.statusId) {
    hydrated.status = null;
  }
  let hospitalName = surgery.hospitalName || '';
  if (!hospitalName && surgery.hospitalId && ObjectId.isValid(surgery.hospitalId)) {
    const legacyHospital = lookups?.options ? lookups.options.get(surgery.hospitalId) : await collections.options.findOne({ _id: new ObjectId(surgery.hospitalId), type: 'hospitals' });
    hospitalName = legacyHospital?.name || '';
  }
  return {
    id: surgery._id.toString(),
    ...hydrated,
    hospital: hospitalName ? { name: hospitalName } : null,
    patient: surgery.patient || '',
    procedure: surgery.procedure || '',
    anesthetist: surgery.anesthetist || '',
    employeeName: surgery.employeeName || hydrated.employee?.name || '',
    reservationName: surgery.reservationName || '',
    date: surgery.date || '',
    time: surgery.time || '',
    isReserved: surgery.recordType === 'reservation' || surgery.isReserved === true,
    recordType: surgery.recordType || (surgery.isReserved === true ? 'reservation' : 'surgery'),
    createdAt: surgery.createdAt,
    updatedAt: surgery.updatedAt,
    ...Object.fromEntries(['phone', 'consultationDate', 'returnDate', 'returnType', 'observations', 'totalAmount', 'depositPaid', 'pendingAmount']
      .filter((field) => Object.hasOwn(surgery, field))
      .map((field) => [field, surgery[field]])),
  };
}

async function serializeSurgeries(data, collections) {
  const ids = new Set();
  data.forEach((surgery) => {
    ['doctorId', 'employeeId', 'statusId', 'cityId', 'hospitalId'].forEach((key) => {
      if (typeof surgery[key] === 'string' && ObjectId.isValid(surgery[key])) ids.add(surgery[key]);
    });
  });
  const objectIds = [...ids].map((id) => new ObjectId(id));
  const [optionDocs, budgeterDocs, legacyEmployeeDocs] = objectIds.length
    ? await Promise.all([
      collections.options.find({ _id: { $in: objectIds } }).toArray(),
      collections.budgeters.find({ _id: { $in: objectIds } }).toArray(),
      collections.employees.find({ _id: { $in: objectIds } }).toArray(),
    ])
    : [[], [], []];
  const lookups = {
    options: new Map(optionDocs.map((item) => [item._id.toString(), item])),
    budgeters: new Map(budgeterDocs.map((item) => [item._id.toString(), item])),
    legacyEmployees: new Map(legacyEmployeeDocs.map((item) => [item._id.toString(), item])),
  };
  const serialized = [];
  for (const surgery of data) serialized.push(await serializeSurgery(surgery, collections, lookups));
  return serialized;
}
async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const vercelPath = url.searchParams.get('__vercel_path');
  const pathname = vercelPath && /^\/api(?:\/|$)/.test(vercelPath) ? vercelPath : url.pathname;
  url.searchParams.delete('__vercel_path');

  if (request.method === 'GET' && pathname === '/api/health') {
    try {
      const database = await getDatabase();
      await database.command({ ping: 1 });
      sendJson(response, 200, { status: 'connected', database: databaseName });
    } catch {
      sendJson(response, 503, { status: 'disconnected' });
    }
    return;
  }

  try {
    if (request.method === 'POST' && pathname === '/api/access/bootstrap') {
      const remoteAddress = request.socket.remoteAddress || '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) throw Object.assign(new Error('A configuração inicial de acesso só pode ser feita neste computador.'), { status: 403 });
      const value = validateAccessUser(await readJson(request));
      const { users, sessions } = await getCollections();
      if (await users.countDocuments({})) throw Object.assign(new Error('O primeiro usuário autorizado já foi configurado.'), { status: 409 });
      const { pin, ...safeValue } = value;
      const now = new Date();
      let result;
      try {
        result = await users.insertOne({ ...safeValue, active: true, ...await makePinRecord(pin), createdAt: now, updatedAt: now });
      } catch (error) {
        if (isDuplicateError(error)) throw Object.assign(new Error('O primeiro usuário autorizado já foi configurado.'), { status: 409 });
        throw error;
      }
      const token = crypto.randomBytes(32).toString('base64url');
      await sessions.insertOne({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId: result.insertedId.toString(), createdAt: now, expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) });
      sendJson(response, 201, { authenticated: true, user: publicUser({ ...safeValue, _id: result.insertedId }) }, { 'Set-Cookie': sessionCookie(token, request) });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/login') {
      const body = await readJson(request);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const pin = typeof body.pin === 'string' ? body.pin : '';
      const rateKey = checkLoginRateLimit(request, username);
      if (!/^\d{4}$/.test(pin)) {
        rejectLogin(rateKey);
      }
      const collections = await getCollections();
      const { users, sessions } = collections;
      const user = await users.findOne({ usernameKey: username.toLocaleLowerCase('pt-BR') });
      const salt = user?.pinSalt || 'operamed-login-check';
      const actual = await scrypt(pin, salt, 64);
      const expected = user?.pinHash ? Buffer.from(user.pinHash, 'hex') : Buffer.alloc(64);
      const valid = user && user.active !== false && expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
      if (!valid) {
        rejectLogin(rateKey);
      }
      loginAttempts.delete(rateKey);
      const token = crypto.randomBytes(32).toString('base64url');
      const now = new Date();
      await sessions.insertOne({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId: user._id.toString(), createdAt: now, expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) });
      const primaryAdmin = await collections.metadata.findOne({ _id: 'primary-admin' });
      sendJson(response, 200, { authenticated: true, user: publicUser(user, primaryAdmin?.userId || '') }, { 'Set-Cookie': sessionCookie(token, request) });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/session') {
      const collections = await getCollections();
      const user = await userForRequest(request, collections);
      sendJson(response, 200, { authenticated: Boolean(user), user });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/logout') {
      const token = sessionToken(request);
      if (token) {
        const { sessions } = await getCollections();
        await sessions.deleteOne({ tokenHash: crypto.createHash('sha256').update(token).digest('hex') });
      }
      sendJson(response, 200, { authenticated: false }, { 'Set-Cookie': sessionCookie('', request, 0) });
      return;
    }

    const protectedRoute = pathname.startsWith('/api/settings') || pathname.startsWith('/api/employees') || pathname.startsWith('/api/budgeters') || pathname.startsWith('/api/users') || pathname.startsWith('/api/surgeries');
    let collections;
    let authenticatedUser = null;
    if (protectedRoute) {
      collections = await getCollections();
      authenticatedUser = await userForRequest(request, collections);
      if (!authenticatedUser) {
        sendJson(response, 401, { error: 'Entre na plataforma para continuar.' });
        return;
      }
    }

    if (pathname === '/api/users' && request.method === 'GET') {
      requireAdmin(authenticatedUser);
      const primaryAdmin = await collections.metadata.findOne({ _id: 'primary-admin' });
      const data = await collections.users.find({}).sort({ usernameKey: 1 }).toArray();
      sendJson(response, 200, data.map((user) => publicUser(user, primaryAdmin?.userId || '')));
      return;
    }

    if (pathname === '/api/users' && request.method === 'POST') {
      requireAdmin(authenticatedUser);
      const value = validateAccessUser(await readJson(request));
      if (!authenticatedUser.isPrimaryAdmin) value.role = 'user';
      const { pin, ...safeValue } = value;
      const now = new Date();
      try {
        const result = await collections.users.insertOne({ ...safeValue, active: true, ...await makePinRecord(pin), createdAt: now, updatedAt: now });
        sendJson(response, 201, publicUser({ ...safeValue, _id: result.insertedId }));
      } catch (error) {
        if (isDuplicateError(error)) throw Object.assign(new Error('Este nome de usuário já está em uso.'), { status: 409 });
        throw error;
      }
      return;
    }

    const userMatch = pathname.match(/^\/api\/users\/([a-f\d]{24})$/i);
    if (userMatch && request.method === 'PUT') {
      requireAdmin(authenticatedUser);
      const id = new ObjectId(userMatch[1]);
      const targetId = id.toString();
      const primaryAdmin = await collections.metadata.findOne({ _id: 'primary-admin' });
      protectPrimaryTarget(targetId, primaryAdmin?.userId || '', authenticatedUser, true);
      const current = await collections.users.findOne({ _id: id });
      if (!current) throw Object.assign(new Error('Funcionário não encontrado.'), { status: 404 });
      if (!authenticatedUser.isPrimaryAdmin && current.role === 'admin') throw Object.assign(new Error('Somente a Administradora Principal pode modificar administradores.'), { status: 403 });
      const body = await readJson(request);
      const merged = { ...current, ...body, username: body.username ?? current.username, name: body.name ?? current.name, role: body.role ?? current.role ?? 'user', pin: typeof body.pin === 'string' ? body.pin : '' };
      const value = validateAccessUser(merged, { allowOptionalPin: true });
      if (!authenticatedUser.isPrimaryAdmin) value.role = 'user';
      const { pin, ...safeValue } = value;
      const update = { ...safeValue, updatedAt: new Date() };
      if (pin) Object.assign(update, await makePinRecord(pin));
      try {
        await collections.users.updateOne({ _id: id }, { $set: update });
      } catch (error) {
        if (isDuplicateError(error)) throw Object.assign(new Error('Este nome de usuário já está em uso.'), { status: 409 });
        throw error;
      }
      const updated = await collections.users.findOne({ _id: id });
      sendJson(response, 200, publicUser(updated, primaryAdmin?.userId || ''));
      return;
    }

    if (userMatch && request.method === 'DELETE') {
      requireAdmin(authenticatedUser);
      const id = new ObjectId(userMatch[1]);
      const targetId = id.toString();
      const primaryAdmin = await collections.metadata.findOne({ _id: 'primary-admin' });
      protectPrimaryTarget(targetId, primaryAdmin?.userId || '', authenticatedUser);
      const target = await collections.users.findOne({ _id: id });
      if (!target) throw Object.assign(new Error('Funcionário não encontrado.'), { status: 404 });
      if (target.role === 'admin' && !authenticatedUser.isPrimaryAdmin) throw Object.assign(new Error('Somente a Administradora Principal pode excluir administradores.'), { status: 403 });
      await collections.sessions.deleteMany({ userId: targetId });
      await collections.users.deleteOne({ _id: id });
      sendJson(response, 200, { deleted: true });
      return;
    }

    if (pathname === '/api/budgeters' && request.method === 'GET') {
      const data = await collections.budgeters.find({}).sort({ nameKey: 1, name: 1 }).toArray();
      sendJson(response, 200, data.map(publicEmployee));
      return;
    }

    if (pathname === '/api/budgeters' && request.method === 'POST') {
      requireAdmin(authenticatedUser);
      const value = validateBudgeter(await readJson(request));
      const now = new Date();
      try {
        const result = await collections.budgeters.insertOne({ ...value, createdAt: now, updatedAt: now });
        sendJson(response, 201, publicEmployee({ ...value, _id: result.insertedId }));
      } catch (error) {
        if (isDuplicateError(error)) throw Object.assign(new Error('Já existe um orçamentista com esse nome.'), { status: 409 });
        throw error;
      }
      return;
    }

    const budgeterMatch = pathname.match(/^\/api\/budgeters\/([a-f\d]{24})$/i);
    if (budgeterMatch && request.method === 'PUT') {
      requireAdmin(authenticatedUser);
      const id = new ObjectId(budgeterMatch[1]);
      const value = validateBudgeter(await readJson(request));
      if (!await collections.budgeters.findOne({ _id: id })) throw Object.assign(new Error('Orçamentista não encontrado.'), { status: 404 });
      try {
        await collections.budgeters.updateOne({ _id: id }, { $set: { ...value, updatedAt: new Date() } });
      } catch (error) {
        if (isDuplicateError(error)) throw Object.assign(new Error('Já existe um orçamentista com esse nome.'), { status: 409 });
        throw error;
      }
      sendJson(response, 200, publicEmployee(await collections.budgeters.findOne({ _id: id })));
      return;
    }

    if (pathname === '/api/settings' && request.method === 'GET') {
      const type = await parseOptionType(url);
      const query = type ? { type } : { type: { $in: [...optionTypes] } };
      const data = await collections.options.find(query).sort({ type: 1, nameKey: 1 }).toArray();
      sendJson(response, 200, data.map(serializeOption));
      return;
    }

    if (pathname === '/api/settings' && request.method === 'POST') {
      requireAdmin(authenticatedUser);
      const body = await readJson(request);
      if (!optionTypes.has(body.type)) throw Object.assign(new Error('Categoria inválida.'), { status: 400 });
      const value = validateOption(body);
      const { options } = collections;
      const now = new Date();
      const document = { ...value, type: body.type, createdAt: now, updatedAt: now };
      try {
        const result = await options.insertOne(document);
        sendJson(response, 201, serializeOption({ ...document, _id: result.insertedId }));
      } catch (error) {
        if (isDuplicateError(error)) throw Object.assign(new Error('Já existe um item com esse nome nesta categoria.'), { status: 409 });
        throw error;
      }
      return;
    }

    const optionMatch = pathname.match(/^\/api\/settings\/([a-f\d]{24})$/i);
    if (optionMatch && request.method === 'PUT') {
      requireAdmin(authenticatedUser);
      const body = await readJson(request);
      const { options } = collections;
      const id = new ObjectId(optionMatch[1]);
      const current = await options.findOne({ _id: id });
      if (!current) throw Object.assign(new Error('Item não encontrado.'), { status: 404 });
      const value = validateOption({ ...body, type: current.type });
      try {
        await options.updateOne({ _id: id }, { $set: { ...value, updatedAt: new Date() } });
        const updated = await options.findOne({ _id: id });
        sendJson(response, 200, serializeOption(updated));
      } catch (error) {
        if (isDuplicateError(error)) throw Object.assign(new Error('Já existe um item com esse nome nesta categoria.'), { status: 409 });
        throw error;
      }
      return;
    }

    if (pathname === '/api/surgeries/archived' && request.method === 'GET') {
      const data = await collections.surgeries.find({ archivedAt: { $exists: true } }).sort({ date: -1, time: 1, updatedAt: -1 }).toArray();
      sendJson(response, 200, await serializeSurgeries(data, collections));
      return;
    }

    if (pathname === '/api/surgeries' && request.method === 'GET') {
      const data = await collections.surgeries.find({ archivedAt: { $exists: false } }).sort({ date: 1, time: 1, updatedAt: -1 }).toArray();
      sendJson(response, 200, await serializeSurgeries(data, collections));
      return;
    }

    if (pathname === '/api/surgeries' && request.method === 'POST') {
      const body = await readJson(request);
      const references = await validateSurgeryReferences(collections, body);
      const details = validateSurgeryDetails(body);
      const now = new Date();
      const document = { ...details, ...references, createdAt: now, updatedAt: now };
      const result = await collections.surgeries.insertOne(document);
      sendJson(response, 201, await serializeSurgery({ ...document, _id: result.insertedId }, collections));
      return;
    }

    const archiveMatch = pathname.match(/^\/api\/surgeries\/([a-f\d]{24})\/(archive|restore)$/i);
    if (archiveMatch && request.method === 'POST') {
      const id = new ObjectId(archiveMatch[1]);
      const current = await collections.surgeries.findOne({ _id: id });
      if (!current) throw Object.assign(new Error('Cirurgia não encontrada.'), { status: 404 });
      if (archiveMatch[2].toLowerCase() === 'archive') {
        await collections.surgeries.updateOne({ _id: id }, { $set: { archivedAt: new Date(), archivedBy: authenticatedUser.id, updatedAt: new Date() } });
      } else {
        await collections.surgeries.updateOne({ _id: id }, { $unset: { archivedAt: '', archivedBy: '' }, $set: { updatedAt: new Date() } });
      }
      const updated = await collections.surgeries.findOne({ _id: id });
      sendJson(response, 200, await serializeSurgery(updated, collections));
      return;
    }

    const surgeryMatch = pathname.match(/^\/api\/surgeries\/([a-f\d]{24})$/i);
    if (surgeryMatch && request.method === 'PUT') {
      const body = await readJson(request);
      const id = new ObjectId(surgeryMatch[1]);
      const current = await collections.surgeries.findOne({ _id: id });
      if (!current) throw Object.assign(new Error('Cirurgia não encontrada.'), { status: 404 });
      const currentIsReservation = current.recordType === 'reservation' || current.isReserved === true;
      if (currentIsReservation && body.isReserved !== true && body.convertReservation !== true) {
        throw Object.assign(new Error('Para transformar este horário reservado em cirurgia, use “Converter em cirurgia” no formulário.'), { status: 400 });
      }
      const references = await validateSurgeryReferences(collections, body, current);
      const details = validateSurgeryDetails(body);
      delete details.convertReservation;
      await collections.surgeries.updateOne({ _id: id }, { $set: { ...details, ...references, updatedAt: new Date() } });
      const updated = await collections.surgeries.findOne({ _id: id });
      sendJson(response, 200, await serializeSurgery(updated, collections));
      return;
    }
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error('Erro na API:', error);
    sendJson(response, status, { error: status >= 500 ? 'Não foi possível concluir a operação. Tente novamente.' : error.message });
    return;
  }

  if (request.method !== 'GET' || !publicFiles.has(pathname)) {
    sendJson(response, 404, { error: 'Não encontrado.' });
    return;
  }

  const [relativePath, contentType] = publicFiles.get(pathname);
  fs.readFile(path.join(root, relativePath), (error, content) => {
    if (error) {
      sendJson(response, 404, { error: 'Não encontrado.' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    response.end(content);
  });
}

module.exports = { handler: handleRequest };

if (require.main === module) {
  if (!mongoUri) {
    console.error('MONGODB_URI não foi definida. Configure a variável no arquivo .env.');
    process.exitCode = 1;
  } else {
    const server = http.createServer(handleRequest);
    server.listen(port, () => {
      console.log(`OperaMeds disponível em http://localhost:${port}`);
    });

    async function shutdown() {
      server.close();
      if (mongoClient) await mongoClient.close();
      process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}
