const loginSection = document.getElementById('developerLogin');
const inboxSection = document.getElementById('developerInbox');
const loginForm = document.getElementById('developerLoginForm');
const loginMessage = document.getElementById('developerLoginMessage');
const feedbackList = document.getElementById('developerFeedbackList');
let developerMessages = [];

function developerSetBusy(form, busy, label = 'Menyimpan…') {
  if (busy) {
    form.dataset.busy = '1';
    form.querySelectorAll('button[type="submit"]').forEach(button => {
      button.dataset.originalText = button.textContent;
      button.disabled = true;
      button.textContent = label;
    });
  } else {
    delete form.dataset.busy;
    form.querySelectorAll('button[type="submit"]').forEach(button => {
      button.disabled = false;
      if (button.dataset.originalText) button.textContent = button.dataset.originalText;
    });
  }
}

function developerToast(message) {
  document.getElementById('developerToast')?.remove();
  const toast = document.createElement('div');
  toast.id = 'developerToast';
  toast.className = 'developer-toast';
  toast.textContent = message;
  document.body.append(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => toast.remove(), 3000);
}

function showInbox() {
  loginSection.hidden = true;
  inboxSection.hidden = false;
  loadFeedback();
}

function renderFeedback() {
  const count = developerMessages.length;
  document.getElementById('developerMessageCount').innerHTML = `<span>${count}</span> pesan dari siswa · ${developerMessages.filter(item => !String(item.balasan || '').trim()).length} belum dibalas`;
  if (!count) {
    feedbackList.innerHTML = '<div class="developer-empty"><span>✉</span><h2>Inbox masih tenang</h2><p>Pesan yang dikirim siswa akan muncul di sini.</p></div>';
    return;
  }
  feedbackList.innerHTML = developerMessages.map((item, index) => {
    const replied = Boolean(String(item.balasan || '').trim());
    return `<article class="developer-feedback-card ${replied ? 'is-replied' : 'is-pending'}" style="--card-order:${Math.min(index, 8)}">
      <header class="developer-student-meta"><span class="developer-student-avatar" aria-hidden="true">${escapeHTML(String(item.siswa || item.username || 'S').trim().slice(0, 1).toUpperCase())}</span><div><h2>${escapeHTML(item.siswa || 'Nama siswa tidak tersedia')}</h2><p>@${escapeHTML(item.username || 'username tidak tersedia')}${item.kelas ? ` <span>·</span> ${escapeHTML(item.kelas)}` : ''}</p></div><span class="developer-reply-status">${replied ? 'Sudah dibalas' : 'Menunggu balasan'}</span></header>
      <div class="developer-student-message"><span>PESAN SISWA</span><p>${escapeHTML(item.pesan || '')}</p><small>${item.waktu ? fmtWhen(item.waktu) : 'Waktu tidak tersedia'}</small></div>
      ${replied ? `<div class="developer-existing-reply"><span>✦ BALASAN TERKIRIM</span><p>${escapeHTML(item.balasan)}</p>${item.balasanWaktu ? `<small>${fmtWhen(item.balasanWaktu)}</small>` : ''}</div>` : ''}
      <form class="developer-reply-form" data-feedback-id="${escapeHTML(item.id || '')}"><label for="reply-${escapeHTML(item.id || index)}">${replied ? 'Perbarui balasan' : 'Tulis balasan'}</label><textarea id="reply-${escapeHTML(item.id || index)}" name="balasan" maxlength="2000" placeholder="Tulis balasan yang ramah dan jelas…" required>${replied ? escapeHTML(item.balasan) : ''}</textarea><div class="developer-reply-footer"><small>Maksimal 2.000 karakter</small><button class="btn developer-primary" type="submit">${replied ? 'Simpan Perubahan' : 'Kirim Balasan'} <span>↗</span></button></div></form>
    </article>`;
  }).join('');
}

async function loadFeedback() {
  feedbackList.innerHTML = '<div class="developer-empty"><span class="developer-loader" aria-hidden="true"></span><p>Memuat pesan siswa…</p></div>';
  try {
    const result = await apiRequest('getAllFeedback');
    developerMessages = Array.isArray(result) ? result : [];
    renderFeedback();
  } catch (error) {
    console.error('[Developer] Gagal memuat pesan:', error);
    feedbackList.innerHTML = `<div class="developer-empty"><h2>Pesan belum dapat dimuat</h2><p>${escapeHTML(error.message || 'Periksa koneksi backend lalu coba lagi.')}</p><button class="btn secondary" type="button" onclick="loadFeedback()">Coba lagi</button></div>`;
  }
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (loginForm.dataset.busy === '1') return;
  const username = loginForm.elements.username.value.trim();
  const password = loginForm.elements.password.value;
  loginMessage.textContent = 'Memeriksa akun developer…';
  loginMessage.classList.remove('error');
  developerSetBusy(loginForm, true, 'Memeriksa…');
  try {
    const result = await apiRequest('loginDeveloper', { username, password });
    session('developer', { token: result.token, ...result.user, name: result.user.nama });
    showInbox();
  } catch (error) {
    loginMessage.textContent = error.message || 'Login developer gagal.';
    loginMessage.classList.add('error');
  } finally {
    developerSetBusy(loginForm, false);
  }
});

document.addEventListener('submit', async event => {
  const form = event.target.closest('.developer-reply-form');
  if (!form) return;
  event.preventDefault();
  if (form.dataset.busy === '1') return;
  const id = form.dataset.feedbackId;
  const balasan = String(form.elements.balasan.value || '').trim();
  if (!balasan) return developerToast('Tulis balasan terlebih dahulu.');
  developerSetBusy(form, true, 'Mengirim…');
  try {
    const updated = await apiRequest('replyFeedback', { id, balasan });
    developerMessages = developerMessages.map(item => item.id === id ? updated : item);
    renderFeedback();
    developerToast('Balasan berhasil dikirim ke siswa.');
  } catch (error) {
    console.error('[Developer] Gagal mengirim balasan:', error);
    developerToast(error.message || 'Balasan belum berhasil dikirim.');
    developerSetBusy(form, false);
  }
});

document.getElementById('refreshFeedback').addEventListener('click', loadFeedback);
document.getElementById('developerLogout').addEventListener('click', () => {
  sessionStorage.removeItem('simarsip:session');
  developerMessages = [];
  inboxSection.hidden = true;
  loginSection.hidden = false;
  loginForm.reset();
  loginMessage.textContent = 'Anda sudah keluar dari ruang developer.';
});

async function bootDeveloper() {
  const current = getSession();
  if (current?.role !== 'developer' || !current.token || !apiEnabled()) return;
  try {
    await apiRequest('validateSession');
    showInbox();
  } catch {
    sessionStorage.removeItem('simarsip:session');
  }
}

bootDeveloper();
