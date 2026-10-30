const SESSION_TTL_SECONDS = 60 * 60 * 12;
const FILE_LINK_TTL_SECONDS = 60 * 60;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FILE_MIME_TYPES = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const COLLECTIONS = new Set(['students', 'archives', 'classifications', 'tasks', 'submissions', 'practice', 'quiz', 'journal', 'feedback']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method === 'GET' && url.pathname.startsWith('/files/')) return serveFile(request, env, url);
    if (request.method !== 'POST') return json({ success: false, message: 'Gunakan metode POST.' }, 405);

    let action = 'tidak diketahui';
    try {
      const input = await request.json();
      action = input?.action || action;
      if (!input || typeof input.action !== 'string') throw httpError('Aksi API tidak valid.');
      const data = await handleAction(input, env);
      await addSignedFileLinks(data, env, url.origin);
      return json({ success: true, data });
    } catch (error) {
      console.error(`[SIMARSIP Worker] Aksi ${action} gagal:`, error);
      return json({ success: false, message: error.message || 'Permintaan gagal.' }, error.status || 500);
    }
  }
};

async function handleAction(input, env) {
  const action = input.action;
  if (action === 'loginTeacher') return loginTeacher(input, env);
  if (action === 'loginStudent') return loginStudent(input, env);
  if (action === 'loginDeveloper') return loginDeveloper(input, env);

  const session = await authenticate(input.token, env);
  if (action === 'validateSession') return { role: session.role, username: session.username };
  if (action === 'logout') return { success: true };

  const teacherOnly = new Set(['getUsers', 'getStudentArchives', 'createStudent', 'bulkCreateStudents', 'updateStudent', 'deleteStudent', 'deleteStudents', 'getDashboardTeacher', 'createArchive', 'updateArchive', 'deleteArchive', 'createTask', 'deleteTask']);
  const studentOnly = new Set(['getDashboardStudent', 'createPracticeArchive', 'createSubmission', 'updateSubmission', 'saveQuizResult', 'saveJournal', 'getFeedback', 'createFeedback']);
  const developerOnly = new Set(['getAllFeedback', 'replyFeedback']);
  if (teacherOnly.has(action) && session.role !== 'guru') throw httpError('Aksi ini khusus guru.', 403);
  if (studentOnly.has(action) && session.role !== 'siswa') throw httpError('Aksi ini khusus siswa.', 403);
  if (developerOnly.has(action) && session.role !== 'developer') throw httpError('Aksi ini khusus developer.', 403);
  if (session.role === 'developer' && !developerOnly.has(action)) throw httpError('Aksi ini tidak tersedia untuk developer.', 403);

  switch (action) {
    case 'getUsers': return listStudents(env);
    case 'getStudentArchives': return getStudentArchives(input.username, env);
    case 'createStudent': return createStudent(input, env);
    case 'bulkCreateStudents': return bulkCreateStudents(input, env);
    case 'updateStudent': return updateStudent(input, env);
    case 'deleteStudent': return deleteStudent(input.username, env);
    case 'deleteStudents': return deleteStudents(input.usernames, env);
    case 'getArchives': return getArchives(session, env);
    case 'createArchive': return createArchive(input, session, env);
    case 'updateArchive': return updateArchive(input, session, env);
    case 'deleteArchive': return deleteArchive(input.id, session, env);
    case 'createPracticeArchive': return createPracticeArchive(input, session, env);
    case 'getClassifications': return getClassifications(session, env);
    case 'createClassification': return createClassification(input, session, env);
    case 'deleteClassification': return deleteClassification(input.kode, session, env);
    case 'getTasks': return getTasks(session, env);
    case 'createTask': return createTask(input, env);
    case 'deleteTask': return deleteTask(input.id, env);
    case 'getSubmissions': return listCollection(env, 'submissions', item => session.role === 'guru' || item.username === session.username, session.role === 'guru' ? {} : { username: session.username });
    case 'createSubmission': return saveSubmission(input, session, env, false);
    case 'updateSubmission': return saveSubmission(input, session, env, true);
    case 'getPractice': return listCollection(env, 'practice', item => session.role === 'guru' || item.username === session.username, session.role === 'guru' ? {} : { username: session.username });
    case 'getQuizResults': return listCollection(env, 'quiz', item => session.role === 'guru' || item.username === session.username, session.role === 'guru' ? {} : { username: session.username });
    case 'getJournals': return listCollection(env, 'journal', item => session.role === 'guru' || item.username === session.username, session.role === 'guru' ? {} : { username: session.username });
    case 'getFeedback': return listCollection(env, 'feedback', item => item.username === session.username, { username: session.username });
    case 'createFeedback': return createFeedback(input, session, env);
    case 'getAllFeedback': return (await listCollection(env, 'feedback')).sort((a, b) => String(b.waktu || '').localeCompare(String(a.waktu || '')));
    case 'replyFeedback': return replyFeedback(input, env);
    case 'getDashboardTeacher': return dashboardTeacher(env);
    case 'getDashboardStudent': return dashboardStudent(session, env);
    case 'saveQuizResult': return saveStudentActivity('quiz', input, session, env);
    case 'saveJournal': return saveStudentActivity('journal', input, session, env);
    default: throw httpError(`Aksi '${action}' belum tersedia pada backend.`, 404);
  }
}

function database(env) {
  if (!env.DB) throw httpError('Binding D1 DB belum dikonfigurasi pada Worker.', 503);
  return env.DB;
}
function bucket(env) {
  if (!env.FILES) throw httpError('Binding R2 FILES belum dikonfigurasi pada Worker.', 503);
  return env.FILES;
}

async function loginTeacher(input, env) {
  requireEnv(env, ['TEACHER_USERNAME', 'TEACHER_PASSWORD', 'SESSION_SECRET']);
  const username = String(input.username || '').trim();
  const validUser = constantTimeEqual(username.toLowerCase(), String(env.TEACHER_USERNAME).trim().toLowerCase());
  const validPassword = constantTimeEqual(String(input.password || ''), String(env.TEACHER_PASSWORD));
  if (!validUser || !validPassword) throw httpError('Username atau password guru salah.', 401);
  const user = { username, nama: env.TEACHER_NAME || 'Guru' };
  return { token: await createSession({ role: 'guru', username, name: user.nama }, env), user };
}

async function loginStudent(input, env) {
  const username = normalizeUsername(input.username);
  const account = await getDocument(env, 'students', username);
  if (!account || !await verifyPassword(String(input.password || ''), account.passwordHash, account.passwordSalt)) {
    throw httpError('Username atau password salah. Hubungi guru pengampu.', 401);
  }
  const user = { username, nama: account.nama, kelas: account.kelas };
  return { token: await createSession({ role: 'siswa', username, name: account.nama, kelas: account.kelas }, env), user };
}

async function loginDeveloper(input, env) {
  requireEnv(env, ['DEVELOPER_USERNAME', 'DEVELOPER_PASSWORD', 'SESSION_SECRET']);
  const username = String(input.username || '').trim();
  const validUser = constantTimeEqual(username.toLowerCase(), String(env.DEVELOPER_USERNAME).trim().toLowerCase());
  const validPassword = constantTimeEqual(String(input.password || ''), String(env.DEVELOPER_PASSWORD));
  if (!validUser || !validPassword) throw httpError('Username atau password developer salah.', 401);
  const user = { username, nama: env.DEVELOPER_NAME || 'Developer SIMARSIP' };
  return { token: await createSession({ role: 'developer', username, name: user.nama }, env), user };
}

async function createStudent(input, env) {
  const username = normalizeUsername(input.username);
  const nama = requiredText(input.nama, 'Nama siswa wajib diisi.');
  const kelas = requiredText(input.kelas, 'Kelas wajib diisi.');
  const password = requiredText(input.password, 'Password wajib diisi.');
  if (password.length < 6) throw httpError('Password siswa harus terdiri dari minimal 6 karakter.');
  if (await getDocument(env, 'students', username)) throw httpError('Username sudah digunakan.', 409);
  const account = { id: username, nama, kelas, username, ...await hashPassword(password), createdAt: new Date().toISOString() };
  try { await insertDocument(env, 'students', username, account); }
  catch (error) { if (await getDocument(env, 'students', username)) throw httpError('Username sudah digunakan.', 409); throw error; }
  return { id: username, nama, kelas, username, password: '' };
}

async function bulkCreateStudents(input, env) {
  if (!Array.isArray(input.students) || !input.students.length) throw httpError('Daftar siswa CSV kosong atau tidak valid.');
  if (input.students.length > 200) throw httpError('Maksimal 200 akun dapat diproses dalam satu impor.');
  const created = [], errors = [], seen = new Set(), valid = [];
  for (const [index, student] of input.students.entries()) {
    const row = Number(student?.row) || index + 2;
    try {
      const username = normalizeUsername(student?.username);
      if (seen.has(username)) throw httpError('Username duplikat dalam file CSV.');
      seen.add(username);
      valid.push({ student, row });
    } catch (error) { errors.push({ row, message: error.message || 'Data akun tidak valid.' }); }
  }
  for (let start = 0; start < valid.length; start += 10) {
    const results = await Promise.all(valid.slice(start, start + 10).map(async ({ student, row }) => {
      try { return { account: await createStudent(student, env) }; }
      catch (error) { return { row, message: error.message || 'Akun gagal dibuat.' }; }
    }));
    for (const result of results) result.account ? created.push(result.account) : errors.push({ row: result.row, message: result.message });
  }
  return { created, errors };
}

async function updateStudent(input, env) {
  const username = normalizeUsername(input.username);
  const existing = await getDocument(env, 'students', username);
  if (!existing) throw httpError('Akun siswa tidak ditemukan.', 404);
  const account = { ...existing, nama: requiredText(input.nama, 'Nama siswa wajib diisi.'), kelas: requiredText(input.kelas, 'Kelas wajib diisi.') };
  if (input.password) {
    if (String(input.password).length < 6) throw httpError('Password siswa harus terdiri dari minimal 6 karakter.');
    Object.assign(account, await hashPassword(String(input.password)));
  }
  await putDocument(env, 'students', username, account);
  return { id: username, nama: account.nama, kelas: account.kelas, username, password: '' };
}

async function listStudents(env) {
  return (await listCollection(env, 'students')).map(({ passwordHash, passwordSalt, ...account }) => ({ ...account, id: account.id || account.username, password: '' }));
}

async function deleteStudent(username, env) {
  const id = normalizeUsername(username);
  const removed = await deleteStudentData([id], env);
  return { username: id, deletedRecords: removed.records, deletedFiles: removed.files };
}

async function deleteStudents(usernames, env) {
  if (!Array.isArray(usernames)) throw httpError('Daftar username tidak valid.');
  const ids = [...new Set(usernames.map(normalizeUsername))];
  const removed = await deleteStudentData(ids, env);
  return { deleted: ids.length, deletedRecords: removed.records, deletedFiles: removed.files };
}

async function deleteStudentData(usernames, env) {
  const collections = ['archives', 'classifications', 'submissions', 'practice', 'quiz', 'journal'];
  const usernameSet = new Set(usernames.map(name => name.toLowerCase()));
  const lists = await Promise.all(collections.map(collection => listCollection(env, collection, () => true, { username: usernames })));
  const targets = lists.flatMap((items, index) => items.filter(item => {
    if (!usernameSet.has(String(item.username || '').toLowerCase())) return false;
    return collections[index] !== 'archives' && collections[index] !== 'classifications' || item.ownerRole === 'siswa' || !item.ownerRole;
  }).map(item => ({ collection: collections[index], item })));
  const students = await Promise.all(usernames.map(async username => ({ collection: 'students', item: await getDocument(env, 'students', username) })));
  const entries = [...targets, ...students.filter(entry => entry.item)];
  const deletedFiles = await deleteR2Files(entries.map(entry => entry.item), env);
  await deleteEntries(entries, env);
  return { records: entries.length, files: deletedFiles };
}

async function createTask(input, env) {
  const rawClasses = Array.isArray(input.kelas) ? input.kelas : [input.kelas || ''];
  const classes = [...new Set(rawClasses.map(value => String(value || '').trim()).filter(Boolean))];
  if (!classes.length) throw httpError('Pilih setidaknya satu kelas tujuan.');
  if (!classes.includes('Semua')) {
    const available = new Set((await listStudents(env)).map(student => String(student.kelas || '').trim().toLowerCase()).filter(Boolean));
    const unknown = classes.filter(value => !available.has(value.toLowerCase()));
    if (unknown.length) throw httpError(`Kelas tidak ditemukan di Akun Siswa: ${unknown.join(', ')}.`);
  }
  const id = crypto.randomUUID(), judul = requiredText(input.judul, 'Judul tugas wajib diisi.');
  const task = { id, judul, instruksi: String(input.instruksi || ''), kelas: classes.includes('Semua') ? 'Semua' : classes, deadline: String(input.deadline || ''), createdAt: new Date().toISOString() };
  task.file = await saveR2Object(input.file, env, { kind: 'task', ...task });
  try { await putDocument(env, 'tasks', task.id, task); }
  catch (error) { if (task.file?.key) await bucket(env).delete(task.file.key).catch(() => {}); throw error; }
  return task;
}

async function getTasks(session, env) {
  const tasks = await listCollection(env, 'tasks');
  return session.role === 'guru' ? tasks : tasks.filter(task => taskMatchesClass(task, session.kelas));
}
function taskMatchesClass(task, studentClass) {
  const classes = Array.isArray(task.kelas) ? task.kelas : [task.kelas || 'Semua'];
  return classes.includes('Semua') || classes.some(value => String(value).toLowerCase() === String(studentClass || '').toLowerCase());
}

async function deleteTask(id, env) {
  const key = requiredText(id, 'ID tugas tidak ditemukan.'), task = await getDocument(env, 'tasks', key);
  if (!task) throw httpError('Tugas tidak ditemukan.', 404);
  const submissions = await listCollection(env, 'submissions', item => item.tugasId === key, { taskId: key });
  const files = await deleteR2Files([task], env);
  const entries = [{ collection: 'tasks', item: task }, ...submissions.map(item => ({ collection: 'submissions', item }))];
  await deleteEntries(entries, env);
  return { id: key, deletedSubmissions: submissions.length, deletedFiles: files };
}

function ownsClassification(item, session) {
  if (session.role === 'guru') return item.ownerRole === 'guru' || (!item.ownerRole && !item.username);
  return item.ownerRole === 'siswa' && item.username === session.username;
}
async function getClassifications(session, env) {
  const filters = session.role === 'siswa' ? { ownerRole: 'siswa', username: session.username } : { ownerRole: 'guru' };
  return listCollection(env, 'classifications', item => item.status !== 'deleted' && ownsClassification(item, session), filters);
}
async function createClassification(input, session, env) {
  const kode = requiredText(input.kode, 'Kode klasifikasi wajib diisi.'), nama = requiredText(input.nama, 'Nama klasifikasi wajib diisi.');
  const items = await getClassifications(session, env);
  if (items.some(item => String(item.kode).toLowerCase() === kode.toLowerCase())) throw httpError('Kode klasifikasi sudah digunakan.', 409);
  const item = { id: crypto.randomUUID(), kode, nama, desk: String(input.desk || input.deskripsi || ''), status: 'active', ownerRole: session.role, username: session.username };
  await putDocument(env, 'classifications', item.id, item);
  return item;
}
async function deleteClassification(code, session, env) {
  const kode = requiredText(code, 'Kode klasifikasi tidak ditemukan.');
  const items = await listCollection(env, 'classifications', item => ownsClassification(item, session));
  const item = items.find(value => String(value.kode) === kode);
  if (!item) throw httpError('Klasifikasi tidak ditemukan.', 404);
  await deleteDocument(env, 'classifications', item.id);
  return { kode };
}

async function saveSubmission(input, session, env, update) {
  const tugasId = requiredText(input.tugasId || input.tugas_id, 'ID tugas tidak ditemukan.'), task = await getDocument(env, 'tasks', tugasId);
  if (!task) throw httpError('Tugas tidak ditemukan.', 404);
  if (session.role === 'siswa' && !taskMatchesClass(task, session.kelas)) throw httpError('Tugas ini bukan untuk kelas Anda.', 403);
  const existing = (await listCollection(env, 'submissions', item => item.tugasId === tugasId && item.username === session.username, { taskId: tugasId, username: session.username }))[0];
  if (update && !existing) throw httpError('Pengumpulan tugas tidak ditemukan.', 404);
  const item = {
    ...(existing || {}), id: existing?.id || crypto.randomUUID(), tugasId, username: session.username,
    siswa: session.name || '', kelas: session.kelas || '', uraian: requiredText(input.uraian, 'Uraian arsip wajib diisi.'),
    kode: requiredText(input.kode, 'Kode klasifikasi wajib diisi.'), tanggal: requiredText(input.tanggal, 'Tanggal dokumen wajib diisi.'),
    tingkat: String(input.tingkat || ''), media: String(input.media || ''), akses: String(input.akses || ''),
    tautan: String(input.tautan || ''), catatan: String(input.catatan || ''), archiveId: String(input.archiveId || existing?.archiveId || ''),
    sesuai: task.ref ? String(input.kode) === String(task.ref) : null, waktu: new Date().toISOString()
  };
  await putDocument(env, 'submissions', item.id, item);
  return item;
}

async function getArchives(session, env) {
  const filters = session.role === 'siswa' ? { ownerRole: 'siswa', username: session.username } : { ownerRole: 'guru' };
  return listCollection(env, 'archives', item => session.role === 'guru'
    ? item.ownerRole === 'guru' || (!item.ownerRole && !item.username)
    : item.ownerRole === 'siswa' && item.username === session.username, filters);
}
async function getStudentArchives(username, env) {
  const id = normalizeUsername(username);
  if (!await getDocument(env, 'students', id)) throw httpError('Akun siswa tidak ditemukan.', 404);
  return listCollection(env, 'archives', item => item.ownerRole === 'siswa' && item.username === id, { ownerRole: 'siswa', username: id });
}
async function createArchive(input, session, env) {
  const record = normalizeArchive(input, session);
  record.file = await saveR2Object(input.file, env, { kind: 'archive', ...record });
  try { await putDocument(env, 'archives', record.id, record); }
  catch (error) { if (record.file?.key) await bucket(env).delete(record.file.key).catch(() => {}); throw error; }
  return record;
}
async function updateArchive(input, session, env) {
  const id = requiredText(input.id, 'ID arsip tidak ditemukan.'), previous = await getDocument(env, 'archives', id);
  if (!previous || previous.ownerRole !== session.role || (session.role === 'siswa' && previous.username !== session.username)) throw httpError('Arsip tidak ditemukan.', 404);
  const record = { ...previous, ...normalizeArchive(input, session), id };
  const oldFile = previous.file;
  if (input.file?.data) record.file = await saveR2Object(input.file, env, { kind: 'archive', ...record });
  try { await putDocument(env, 'archives', id, record); }
  catch (error) { if (record.file?.key && record.file.key !== oldFile?.key) await bucket(env).delete(record.file.key).catch(() => {}); throw error; }
  if (record.file?.key && oldFile?.key && record.file.key !== oldFile.key) {
    try { await bucket(env).delete(oldFile.key); }
    catch (error) { console.error('[SIMARSIP] Arsip diperbarui, tetapi objek R2 lama gagal dihapus:', error); }
  }
  return record;
}
async function deleteArchive(id, session, env) {
  const key = requiredText(id, 'ID arsip tidak ditemukan.'), record = await getDocument(env, 'archives', key);
  if (!record || record.ownerRole !== session.role || (session.role === 'siswa' && record.username !== session.username)) throw httpError('Arsip tidak ditemukan.', 404);
  let related = [];
  if (session.role === 'siswa') {
    const username = session.username;
    const [practice, submissions] = await Promise.all([
      listCollection(env, 'practice', item => item.username === username && archiveRecordMatches(item, record, key), { username }),
      listCollection(env, 'submissions', item => item.username === username && archiveRecordMatches(item, record, key), { username })
    ]);
    related = [...practice.map(item => ({ collection: 'practice', item })), ...submissions.map(item => ({ collection: 'submissions', item }))];
  }
  const entries = [{ collection: 'archives', item: record }, ...related];
  const files = await deleteR2Files(entries.map(entry => entry.item), env);
  await deleteEntries(entries, env);
  return { id: key, fileDeleted: files > 0, deletedPractice: related.filter(entry => entry.collection === 'practice').length, deletedSubmissions: related.filter(entry => entry.collection === 'submissions').length };
}
function archiveRecordMatches(item, record, archiveId) {
  if (item.archiveId) return item.archiveId === archiveId;
  return ['jenis', 'nomor', 'tanggal', 'kode', 'uraian'].every(key => String(item[key] || '') === String(record[key] || ''));
}

async function createPracticeArchive(input, session, env) {
  const taskId = String(input.tugasId || '').trim();
  if (taskId) {
    const task = await getDocument(env, 'tasks', taskId);
    if (!task) throw httpError('Tugas yang dipilih tidak ditemukan.', 404);
    if (!taskMatchesClass(task, session.kelas)) throw httpError('Tugas ini bukan untuk kelas Anda.', 403);
  }
  const record = normalizeArchive(input, session);
  record.ownerRole = 'siswa'; record.username = session.username; record.siswa = session.name; record.kelas = session.kelas || ''; record.taskId = taskId;
  record.file = await saveR2Object(input.file, env, { kind: 'archive', ...record });
  const practice = { id: crypto.randomUUID(), archiveId: record.id, username: session.username, siswa: session.name, kelas: session.kelas || '', ...archiveFields(input), benar: Boolean(input.kode), waktu: new Date().toISOString() };
  try {
    await putDocument(env, 'archives', record.id, record);
    await putDocument(env, 'practice', practice.id, practice);
    const submission = taskId ? await saveSubmission({ ...archiveFields(input), tugasId: taskId, archiveId: record.id, tautan: '', catatan: input.ket || input.keterangan || '' }, session, env, false) : null;
    return { archive: record, submission };
  } catch (error) {
    await Promise.allSettled([deleteDocument(env, 'archives', record.id), deleteDocument(env, 'practice', practice.id)]);
    if (record.file?.key) await bucket(env).delete(record.file.key).catch(() => {});
    throw error;
  }
}
function normalizeArchive(input, session) {
  return {
    id: String(input.id || crypto.randomUUID()), ownerRole: session.role, username: session.username,
    siswa: session.name || '', kelas: session.kelas || '', jenis: requiredText(input.jenis || 'Surat Masuk', 'Jenis arsip wajib diisi.'),
    nomor: requiredText(input.nomor, 'Nomor dokumen wajib diisi.'), tanggal: requiredText(input.tanggal, 'Tanggal dokumen wajib diisi.'),
    kode: requiredText(input.kode, 'Kode klasifikasi wajib diisi.'), nama_klasifikasi: String(input.nama_klasifikasi || input.namaKlasifikasi || ''),
    uraian: requiredText(input.uraian, 'Uraian wajib diisi.'), pihak: String(input.pihak || input.unit || ''), unit: String(input.unit || input.pihak || ''),
    lampiran: String(input.lampiran || input.volume || ''), volume: String(input.volume || input.lampiran || ''), tingkat: String(input.tingkat || ''),
    media: String(input.media || ''), akses: String(input.akses || ''), ket: String(input.ket || input.keterangan || ''), waktu: input.waktu || new Date().toISOString()
  };
}
function archiveFields(input) {
  return { jenis: input.jenis || 'Surat Masuk', nomor: input.nomor || '', tanggal: input.tanggal || '', kode: input.kode || input.kode_klasifikasi || '', uraian: input.uraian || '', pihak: input.pihak || input.unit || '', lampiran: input.lampiran || input.volume || '', tingkat: input.tingkat || '', media: input.media || '', akses: input.akses || '', ket: input.ket || input.keterangan || '' };
}

async function createFeedback(input, session, env) {
  const pesan = requiredText(input.pesan, 'Pesan wajib diisi.');
  if (pesan.length > 2000) throw httpError('Pesan maksimal 2.000 karakter.');
  const item = { id: crypto.randomUUID(), username: session.username, siswa: session.name || '', kelas: session.kelas || '', pesan, balasan: '', waktu: new Date().toISOString() };
  await putDocument(env, 'feedback', item.id, item);
  return item;
}
async function replyFeedback(input, env) {
  const id = requiredText(input.id, 'ID pesan tidak ditemukan.'), balasan = requiredText(input.balasan, 'Balasan wajib diisi.');
  if (balasan.length > 2000) throw httpError('Balasan maksimal 2.000 karakter.');
  const item = await getDocument(env, 'feedback', id);
  if (!item) throw httpError('Pesan siswa tidak ditemukan.', 404);
  const updated = { ...item, balasan, balasanWaktu: new Date().toISOString() };
  await putDocument(env, 'feedback', id, updated);
  return updated;
}
async function dashboardTeacher(env) {
  const [archives, tasks, submissions, practice] = await Promise.all([getArchives({ role: 'guru' }, env), listCollection(env, 'tasks'), listCollection(env, 'submissions'), listCollection(env, 'practice')]);
  return { totalArsip: archives.length, tugasAktif: tasks.length, pengumpulan: submissions.length, latihanSiswa: practice.length };
}
async function dashboardStudent(session, env) {
  const [tasks, submissions, practice, quiz] = await Promise.all([listCollection(env, 'tasks'), listCollection(env, 'submissions', item => item.username === session.username, { username: session.username }), listCollection(env, 'practice', item => item.username === session.username, { username: session.username }), listCollection(env, 'quiz', item => item.username === session.username, { username: session.username })]);
  const relevantTasks = tasks.filter(task => taskMatchesClass(task, session.kelas));
  return { tugas: relevantTasks.length, dikumpulkan: submissions.length, latihan: practice.length, kuisBenar: quiz.filter(item => item.correct).length, jumlahKuis: quiz.length };
}
async function saveStudentActivity(collection, input, session, env) {
  const id = crypto.randomUUID(), isQuiz = collection === 'quiz';
  const item = isQuiz
    ? { id, username: session.username, siswa: session.name, kelas: session.kelas || '', qi: Number(input.question_index), correct: Boolean(input.correct), waktu: new Date().toISOString() }
    : { id, username: session.username, siswa: session.name, kelas: session.kelas || '', r1: String(input.refleksi_1 || ''), r2: String(input.refleksi_2 || ''), r3: String(input.refleksi_3 || ''), waktu: new Date().toISOString() };
  await putDocument(env, collection, id, item);
  return item;
}

async function listCollection(env, collection, predicate = () => true, filters = {}) {
  if (!COLLECTIONS.has(collection)) throw httpError('Koleksi data tidak dikenal.');
  const db = database(env), records = [], clauses = [], values = [];
  for (const [key, column] of [['username', 'username'], ['ownerRole', 'owner_role'], ['className', 'class_name'], ['taskId', 'task_id'], ['status', 'status']]) {
    const value = filters[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (!value.length) return [];
      clauses.push(`${column} IN (${value.map(() => '?').join(',')})`);
      values.push(...value.map(String));
    } else { clauses.push(`${column} = ?`); values.push(String(value)); }
  }
  const where = clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
  let cursor = '';
  while (true) {
    const result = await db.prepare(`SELECT data, id FROM records WHERE collection = ? AND id > ?${where} ORDER BY id LIMIT 500`).bind(collection, cursor, ...values).all();
    const rows = result.results || [];
    records.push(...rows.map(row => decodeRecord(row.data, row.id)));
    if (rows.length < 500) break;
    cursor = rows[rows.length - 1].id;
  }
  return records.filter(predicate);
}
async function getDocument(env, collection, id) {
  if (!COLLECTIONS.has(collection)) throw httpError('Koleksi data tidak dikenal.');
  const row = await database(env).prepare('SELECT data FROM records WHERE collection = ? AND id = ?').bind(collection, String(id)).first();
  return row ? decodeRecord(row.data, id) : null;
}
async function putDocument(env, collection, id, value) {
  if (!COLLECTIONS.has(collection)) throw httpError('Koleksi data tidak dikenal.');
  const record = { ...value, id: String(id) };
  await database(env).prepare(`INSERT INTO records (collection, id, data, username, owner_role, class_name, task_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(collection, id) DO UPDATE SET data=excluded.data, username=excluded.username, owner_role=excluded.owner_role, class_name=excluded.class_name, task_id=excluded.task_id, status=excluded.status`)
    .bind(collection, String(id), JSON.stringify(record), nullable(record.username), nullable(record.ownerRole), normalizeClass(record.kelas), nullable(record.tugasId || record.taskId), nullable(record.status), String(record.createdAt || record.waktu || new Date().toISOString())).run();
}
async function insertDocument(env, collection, id, value) {
  if (!COLLECTIONS.has(collection)) throw httpError('Koleksi data tidak dikenal.');
  const record = { ...value, id: String(id) };
  await database(env).prepare(`INSERT INTO records (collection, id, data, username, owner_role, class_name, task_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(collection, String(id), JSON.stringify(record), nullable(record.username), nullable(record.ownerRole), normalizeClass(record.kelas), nullable(record.tugasId || record.taskId), nullable(record.status), String(record.createdAt || record.waktu || new Date().toISOString())).run();
}
async function deleteDocument(env, collection, id) {
  await database(env).prepare('DELETE FROM records WHERE collection = ? AND id = ?').bind(collection, String(id)).run();
}
function decodeRecord(raw, fallbackId) {
  try { const value = JSON.parse(raw); return { ...value, id: value.id || fallbackId }; }
  catch { throw httpError('Record D1 tidak berisi JSON valid.', 500); }
}
function nullable(value) { return value === undefined || value === null || value === '' ? null : String(value); }
function normalizeClass(value) { return value == null ? null : Array.isArray(value) ? value.join('|') : String(value); }
async function deleteEntries(entries, env) {
  if (!entries.length) return;
  const db = database(env), statements = entries.map(({ collection, item }) => db.prepare('DELETE FROM records WHERE collection = ? AND id = ?').bind(collection, String(item.id)));
  for (let start = 0; start < statements.length; start += 50) await db.batch(statements.slice(start, start + 50));
}
async function deleteR2Files(records, env) {
  const keys = [...new Set(records.map(record => record?.file?.key).filter(Boolean))];
  if (!keys.length) return 0;
  for (let start = 0; start < keys.length; start += 8) {
    const results = await Promise.allSettled(keys.slice(start, start + 8).map(key => bucket(env).delete(key)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw httpError(`Data belum dihapus karena file R2 gagal dihapus: ${failed.reason?.message || 'kesalahan R2'}`, 502);
  }
  return keys.length;
}

async function saveR2Object(file, env, context = {}) {
  if (!file?.data) return file?.key ? { name: String(file.name || 'Berkas'), key: String(file.key), type: String(file.type || ''), size: Number(file.size || 0) } : file?.name && file?.url ? { name: String(file.name), url: String(file.url) } : null;
  const match = String(file.data).match(/^data:([^;,]*);base64,([\s\S]+)$/);
  if (!match) throw httpError('Format berkas tidak valid.');
  let bytes;
  try { bytes = base64Bytes(match[2]); } catch { throw httpError('Isi berkas bukan Base64 yang valid.'); }
  if (bytes.byteLength > MAX_FILE_BYTES) throw httpError('Ukuran file maksimal 5 MB.');
  const name = safeSegment(file.name, 'arsip'), extension = name.match(/\.[^.]+$/)?.[0].toLowerCase() || '';
  if (!FILE_MIME_TYPES[extension]) throw httpError('Jenis file tidak didukung. Gunakan PDF, DOC/DOCX, XLS/XLSX, JPG, atau PNG.');
  const type = FILE_MIME_TYPES[extension];
  const segments = context.kind === 'task'
    ? ['tasks', ...(Array.isArray(context.kelas) ? context.kelas : [context.kelas || 'Semua']).map(value => safeSegment(value, 'Semua')), safeSegment(context.id, 'tugas')]
    : ['archives', context.ownerRole === 'siswa' ? 'siswa' : 'guru', ...(context.ownerRole === 'siswa' ? [safeSegment(context.kelas, 'Tanpa-Kelas'), safeSegment(context.username, 'siswa')] : []), archiveDateParts(context.tanggal).year, safeSegment(context.jenis, 'Dokumen-Lainnya'), `${safeSegment(context.kode, 'kode')}-${safeSegment(context.nama_klasifikasi || context.namaKlasifikasi, 'klasifikasi')}`];
  const key = `${segments.join('/')}/${crypto.randomUUID()}_${name}`;
  await bucket(env).put(key, bytes, { httpMetadata: { contentType: type }, customMetadata: { originalName: String(file.name || name), ownerRole: String(context.ownerRole || 'guru') } });
  return { name: String(file.name || name), key, type, size: bytes.byteLength };
}
function archiveDateParts(value) {
  const date = String(value || ''), iso = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { year: iso[1] };
  const local = date.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  return { year: local ? local[3] : String(new Date().getFullYear()) };
}
function safeSegment(value, fallback) {
  const safe = String(value || '').replace(/[\/\\\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/\.\./g, '.');
  return (safe || fallback).slice(0, 100);
}
function base64Bytes(value) { const binary = atob(value); return Uint8Array.from(binary, char => char.charCodeAt(0)); }

async function addSignedFileLinks(value, env, origin) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) await addSignedFileLinks(item, env, origin); return; }
  if (value.file?.key) value.file.url = await createFileUrl(value.file.key, env, origin);
  for (const child of Object.values(value)) if (child && typeof child === 'object') await addSignedFileLinks(child, env, origin);
}
async function createFileUrl(key, env, origin) {
  requireEnv(env, ['SESSION_SECRET']);
  const configuredTtl = Number(env.FILE_LINK_TTL_SECONDS);
  const ttl = Math.min(Math.max(Number.isFinite(configuredTtl) && configuredTtl ? configuredTtl : FILE_LINK_TTL_SECONDS, 60), FILE_LINK_TTL_SECONDS);
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const signature = await hmac(`${key}\n${expires}`, env.SESSION_SECRET);
  return `${origin}/files/${encodeURIComponent(key)}?expires=${expires}&sig=${signature}`;
}
async function serveFile(request, env, url) {
  try {
    requireEnv(env, ['SESSION_SECRET']);
    const key = decodeURIComponent(url.pathname.slice('/files/'.length)), expires = Number(url.searchParams.get('expires')), signature = url.searchParams.get('sig') || '';
    if (!key || !Number.isSafeInteger(expires) || expires < Date.now() / 1000 || expires > Date.now() / 1000 + FILE_LINK_TTL_SECONDS + 60) throw httpError('Tautan berkas tidak valid atau sudah kedaluwarsa.', 403);
    const expected = await hmac(`${key}\n${expires}`, env.SESSION_SECRET || '');
    if (!constantTimeEqual(signature, expected)) throw httpError('Tautan berkas tidak valid.', 403);
    const object = await bucket(env).get(key);
    if (!object) throw httpError('Berkas tidak ditemukan.', 404);
    const headers = new Headers(corsHeaders());
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'private, max-age=300');
    headers.set('X-Content-Type-Options', 'nosniff');
    const contentType = headers.get('Content-Type') || 'application/octet-stream';
    const disposition = ['application/pdf', 'image/jpeg', 'image/png'].includes(contentType) ? 'inline' : 'attachment';
    headers.set('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(object.customMetadata?.originalName || key.split('/').pop())}`);
    if (object.httpEtag) headers.set('ETag', object.httpEtag);
    return new Response(object.body, { headers });
  } catch (error) {
    return json({ success: false, message: error.message || 'Berkas gagal dibuka.' }, error.status || 500);
  }
}

async function authenticate(token, env) {
  requireEnv(env, ['SESSION_SECRET']);
  if (!token || typeof token !== 'string') throw httpError('Sesi tidak valid. Silakan masuk kembali.', 401);
  const parts = token.split('.');
  if (parts.length !== 2 || !await verifyHmac(parts[0], parts[1], env.SESSION_SECRET)) throw httpError('Sesi tidak valid. Silakan masuk kembali.', 401);
  let session;
  try { session = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[0]))); }
  catch { throw httpError('Sesi tidak valid. Silakan masuk kembali.', 401); }
  if (!session.exp || session.exp <= Date.now() / 1000 || !['guru', 'siswa', 'developer'].includes(session.role)) throw httpError('Sesi berakhir. Silakan masuk kembali.', 401);
  return session;
}
async function createSession(user, env) {
  const payload = base64url(JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }));
  return `${payload}.${await hmac(payload, env.SESSION_SECRET)}`;
}
async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, material, 256);
  return { passwordHash: base64urlBytes(new Uint8Array(bits)), passwordSalt: base64urlBytes(salt) };
}
async function verifyPassword(password, expectedHash, encodedSalt) {
  if (!expectedHash || !encodedSalt) return false;
  const candidate = await hashPassword(password, base64urlDecode(encodedSalt));
  return constantTimeEqual(candidate.passwordHash, expectedHash);
}
async function hmac(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64urlBytes(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))));
}
async function verifyHmac(value, signature, secret) {
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, base64urlDecode(signature), new TextEncoder().encode(value));
  } catch { return false; }
}
function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{1,64}$/.test(username)) throw httpError('Username hanya boleh berisi huruf, angka, titik, garis bawah, dan tanda hubung.');
  return username;
}
function requiredText(value, message) {
  const text = String(value || '').trim();
  if (!text) throw httpError(message);
  return text;
}
function constantTimeEqual(a, b) {
  const left = new TextEncoder().encode(String(a)), right = new TextEncoder().encode(String(b));
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) difference |= (left[i] || 0) ^ (right[i] || 0);
  return difference === 0;
}
function base64url(value) { return base64urlBytes(new TextEncoder().encode(value)); }
function base64urlBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function base64urlDecode(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)), char => char.charCodeAt(0));
}
function requireEnv(env, keys) {
  const missing = keys.filter(key => !env[key]);
  if (missing.length) throw httpError(`Konfigurasi Worker belum lengkap: ${missing.join(', ')}.`, 503);
}
function httpError(message, status = 400) { const error = new Error(message); error.status = status; return error; }
function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json; charset=utf-8' };
}
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: corsHeaders() }); }
