/* =====================================================================
   관리자(교사) 페이지 로직 (admin.html)
   ---------------------------------------------------------------------
   - 로그인: Supabase 이메일+비밀번호. 로그인 후 is_admin() 함수로 관리자인지 확인
   - 계정 만들기: signup_admin(email, pw, 가입코드) 함수 → 생성·활성화·등록 한 번에
   - 탭: 대시보드 / 작품 / 학생 / 댓글 / 결과 / 교사 계정
   - 관리자의 읽기·쓰기는 RLS 정책(is_admin()) 으로 허용되므로 표에 직접 접근합니다.
   ===================================================================== */

(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  const BUCKET = CFG.STORAGE_BUCKET;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ------------------------------------------------------------------
  // 공통 도우미
  // ------------------------------------------------------------------
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  function errMsg(error, fallback) {
    const m = error && error.message ? String(error.message) : '';
    if (/Invalid login credentials/i.test(m)) return '이메일 또는 비밀번호가 올바르지 않습니다.';
    if (/Email not confirmed/i.test(m)) return '이메일 인증이 완료되지 않은 계정입니다. (Supabase → Authentication → Email → Confirm email 을 끄거나, 가입 코드로 다시 만드세요)';
    if (/rate limit/i.test(m)) return '요청이 너무 많습니다. 잠시 후 다시 시도하세요.';
    if (/Failed to fetch|NetworkError/i.test(m)) return '인터넷 연결을 확인하세요.';
    return m || fallback || '오류가 발생했습니다.';
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function imageUrl(path) {
    return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }

  /** CSV 파일 다운로드 (엑셀용 UTF-8 BOM 포함, 모든 칸을 따옴표로 감쌈) */
  function downloadCsv(filename, header, rows) {
    const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const lines = [header.map(q).join(',')].concat(rows.map((r) => r.map(q).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /** 파일 이름에 넣을 오늘 날짜 (YYYYMMDD) */
  function todayTag() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }

  /** 간단한 CSV 파서: 따옴표·줄바꿈·BOM 처리 → 2차원 배열 */
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    const s = text.replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQ) {
        if (ch === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; } else { inQ = false; }
        } else field += ch;
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\r') {
        // 무시 (\r\n 처리)
      } else if (ch === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }

  // ------------------------------------------------------------------
  // 상태
  // ------------------------------------------------------------------
  const state = {
    email: null,          // 로그인한 관리자 이메일
    settings: null,
    artworks: [],         // 전체 작품(숨김 포함)
    stats: new Map(),     // artwork_id → { like_count, comment_count }
    pending: [],          // 업로드 대기 파일 [{ file, url, title, author, description, status }]
    csvRows: [],          // 불러온 작품정보 CSV [{ title, author, description, keyword }]
    students: [],
    comments: [],
    admins: [],
  };

  // ------------------------------------------------------------------
  // 1. 인증
  // ------------------------------------------------------------------
  const authView = $('#authView');
  const appView = $('#appView');
  const loginForm = $('#loginForm');
  const signupForm = $('#signupForm');

  $('#btnShowSignup').addEventListener('click', () => { loginForm.classList.add('hidden'); signupForm.classList.remove('hidden'); });
  $('#btnShowLogin').addEventListener('click', () => { signupForm.classList.add('hidden'); loginForm.classList.remove('hidden'); });

  function showFormError(id, msg) {
    const p = $(id);
    if (!msg) { p.classList.add('hidden'); return; }
    p.textContent = msg;
    p.classList.remove('hidden');
  }

  loginForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(loginForm);
    const btn = $('#btnLogin');
    showFormError('#loginError', '');
    btn.disabled = true;
    try {
      const { error } = await sb.auth.signInWithPassword({
        email: String(fd.get('email') || '').trim(),
        password: String(fd.get('password') || ''),
      });
      if (error) throw error;
      await enterApp();
    } catch (e) {
      showFormError('#loginError', errMsg(e));
    } finally {
      btn.disabled = false;
    }
  });

  signupForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(signupForm);
    const email = String(fd.get('email') || '').trim();
    const password = String(fd.get('password') || '');
    const code = String(fd.get('code') || '');
    const btn = $('#btnSignup');
    showFormError('#signupError', '');
    if (password.length < 6) { showFormError('#signupError', '비밀번호는 6자 이상이어야 합니다.'); return; }
    btn.disabled = true;
    try {
      // 계정 생성 + 활성화 + 관리자 등록 (DB 함수, 가입 코드로 보호)
      const { error } = await sb.rpc('signup_admin', { p_email: email, p_password: password, p_code: code });
      if (error) throw error;
      // 바로 로그인
      const { error: e2 } = await sb.auth.signInWithPassword({ email, password });
      if (e2) throw e2;
      await enterApp();
    } catch (e) {
      showFormError('#signupError', errMsg(e));
    } finally {
      btn.disabled = false;
    }
  });

  $('#btnLogout').addEventListener('click', async () => {
    await sb.auth.signOut();
    state.email = null;
    appView.classList.add('hidden');
    authView.classList.remove('hidden');
  });

  /** 로그인 성공 후: 정말 관리자인지 확인하고 화면 전환 */
  async function enterApp() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session || !session.user || session.user.is_anonymous) {
      // 학생용 익명 세션이 남아 있으면 정리
      if (session) await sb.auth.signOut();
      return false;
    }
    const { data: isAdmin, error } = await sb.rpc('is_admin');
    if (error || !isAdmin) {
      await sb.auth.signOut();
      throw new Error('관리자로 등록되지 않은 계정입니다. 관리자 가입 코드로 계정을 만들거나 다른 관리자에게 등록을 요청하세요.');
    }
    state.email = session.user.email;
    $('#adminEmail').textContent = state.email;
    authView.classList.add('hidden');
    appView.classList.remove('hidden');
    showTab('dashboard');
    return true;
  }

  // ------------------------------------------------------------------
  // 2. 탭 전환
  // ------------------------------------------------------------------
  const loaders = {
    dashboard: loadDashboard,
    artworks: loadArtworks,
    students: loadStudents,
    comments: loadComments,
    results: loadResults,
    admins: loadAdmins,
  };

  function showTab(name) {
    $$('.tabs__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
    $$('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${name}`));
    loaders[name]().catch((e) => toast(errMsg(e)));
  }
  $('#tabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-tab]');
    if (b) showTab(b.dataset.tab);
  });

  // ------------------------------------------------------------------
  // 3. 대시보드
  // ------------------------------------------------------------------
  async function loadDashboard() {
    const { data, error } = await sb.from('settings').select('*').eq('id', 1).single();
    if (error) throw error;
    state.settings = data;
    $('#votingSwitch').checked = !!data.voting_open;
    $('#votingLabel').textContent = data.voting_open ? '투표 진행 중' : '투표 마감';
    const f = $('#settingsForm');
    f.elements.site_title.value = data.site_title || '';
    f.elements.notice.value = data.notice || '';

    // 현황 숫자: head:true 로 행 개수만 가져옴
    const count = async (table) => {
      const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true });
      if (error) throw error;
      return count ?? 0;
    };
    const [a, s, l, c] = await Promise.all([count('artworks'), count('students'), count('likes'), count('comments')]);
    $('#statArtworks').textContent = a;
    $('#statStudents').textContent = s;
    $('#statLikes').textContent = l;
    $('#statComments').textContent = c;
  }

  $('#votingSwitch').addEventListener('change', async (ev) => {
    const open = ev.target.checked;
    const { error } = await sb.from('settings').update({ voting_open: open, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) { ev.target.checked = !open; toast(errMsg(error)); return; }
    $('#votingLabel').textContent = open ? '투표 진행 중' : '투표 마감';
    toast(open ? '투표를 시작했습니다.' : '투표를 마감했습니다.');
  });

  $('#settingsForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.currentTarget;
    const { error } = await sb.from('settings').update({
      site_title: f.elements.site_title.value.trim() || '캐릭터 공모전 투표',
      notice: f.elements.notice.value.trim(),
      updated_at: new Date().toISOString(),
    }).eq('id', 1);
    if (error) { toast(errMsg(error)); return; }
    toast('저장했습니다.');
  });

  // ------------------------------------------------------------------
  // 4. 작품 - 업로드
  // ------------------------------------------------------------------
  const dropzone = $('#dropzone');
  const pendingList = $('#pendingList');

  ['dragenter', 'dragover'].forEach((t) => dropzone.addEventListener(t, (ev) => {
    ev.preventDefault(); dropzone.classList.add('is-over');
  }));
  ['dragleave', 'drop'].forEach((t) => dropzone.addEventListener(t, (ev) => {
    ev.preventDefault(); dropzone.classList.remove('is-over');
  }));
  dropzone.addEventListener('drop', (ev) => addFiles(ev.dataTransfer.files));
  $('#fileInput').addEventListener('change', (ev) => { addFiles(ev.target.files); ev.target.value = ''; });

  /** 선택/드롭한 파일을 대기 목록에 추가 (이미지만) */
  function addFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type));
    if (!files.length) { toast('PNG/JPG/WEBP/GIF 이미지만 올릴 수 있습니다.'); return; }
    files.forEach((file) => {
      state.pending.push({
        file,
        url: URL.createObjectURL(file),
        title: stripExt(file.name),
        author: '',
        description: '',
        status: 'ready',   // ready | uploading | done | error
        matched: null,     // 매칭된 CSV 행 index
      });
    });
    autoMatchAll();
    renderPending();
  }

  function stripExt(name) { return name.replace(/\.[^.]+$/, ''); }

  /** CSV 행과 파일명 키워드로 자동 매칭 (아직 매칭되지 않은 항목만) */
  function autoMatchAll() {
    if (!state.csvRows.length) return;
    state.pending.forEach((p) => {
      if (p.matched !== null || p.status !== 'ready') return;
      const fname = p.file.name.toLowerCase();
      const idx = state.csvRows.findIndex((r) => r.keyword && fname.includes(r.keyword.toLowerCase()));
      if (idx >= 0) applyCsvRow(p, idx);
    });
  }

  function applyCsvRow(p, idx) {
    const r = state.csvRows[idx];
    if (!r) { p.matched = null; return; }
    p.matched = idx;
    p.title = r.title;
    p.author = r.author;
    p.description = r.description;
  }

  /** 작품정보 CSV 불러오기 */
  $('#csvInput').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (!rows.length) throw new Error('CSV 가 비어 있습니다.');
      // 첫 줄이 머리글이면 열 이름으로 위치를 찾고, 아니면 순서대로(제목, 출품자, 설명, 키워드)
      const head = rows[0].map((h) => String(h).trim());
      const col = (names, def) => {
        const i = head.findIndex((h) => names.some((n) => h.includes(n)));
        return i >= 0 ? i : def;
      };
      const isHeader = head.some((h) => /제목|출품자|설명|키워드|title|author/i.test(h));
      const ci = {
        title: col(['제목', 'title'], 0),
        author: col(['출품자', '작가', 'author', 'name'], 1),
        description: col(['설명', 'description'], 2),
        keyword: col(['키워드', '파일', 'keyword', 'file'], 3),
      };
      const body = isHeader ? rows.slice(1) : rows;
      state.csvRows = body.map((r) => ({
        title: String(r[ci.title] ?? '').trim(),
        author: String(r[ci.author] ?? '').trim(),
        description: String(r[ci.description] ?? '').trim(),
        keyword: String(r[ci.keyword] ?? '').trim(),
      })).filter((r) => r.title);
      $('#csvStatus').textContent = `${file.name} · ${state.csvRows.length}건`;
      autoMatchAll();
      renderPending();
      toast(`작품정보 ${state.csvRows.length}건을 불러왔습니다.`);
    } catch (e) {
      toast(errMsg(e, 'CSV 를 읽지 못했습니다.'));
    }
  });

  /** 업로드 대기 목록 그리기 */
  function renderPending() {
    const list = state.pending;
    $('#uploadBar').classList.toggle('hidden', !list.length);
    if (!list.length) { pendingList.innerHTML = ''; return; }

    const options = (p) => {
      const opts = state.csvRows.map((r, i) =>
        `<option value="${i}" ${p.matched === i ? 'selected' : ''}>${esc(r.title)}${r.author ? ' / ' + esc(r.author) : ''}</option>`);
      return `<option value="">(CSV 에서 선택)</option>${opts.join('')}`;
    };

    pendingList.innerHTML = list.map((p, i) => `
      <div class="pitem ${p.status === 'done' ? 'is-done' : ''} ${p.status === 'error' ? 'is-error' : ''}" data-idx="${i}">
        <img class="pitem__thumb" src="${p.url}" alt="" />
        <div class="pitem__fields">
          <span class="pitem__file">${esc(p.file.name)} · ${(p.file.size / 1024 / 1024).toFixed(2)}MB
            ${p.status === 'done' ? '<span class="tag tag--ok">업로드 완료</span>' : ''}
            ${p.status === 'uploading' ? '<span class="tag">업로드 중…</span>' : ''}
            ${p.status === 'error' ? `<span class="tag tag--hidden">실패: ${esc(p.error || '')}</span>` : ''}
          </span>
          <div class="pitem__grid">
            <input class="field__input" data-f="title" placeholder="제목" value="${esc(p.title)}" ${p.status !== 'ready' ? 'disabled' : ''} />
            <input class="field__input" data-f="author" placeholder="출품자" value="${esc(p.author)}" ${p.status !== 'ready' ? 'disabled' : ''} />
          </div>
          <textarea class="field__input" data-f="description" rows="2" placeholder="작품 설명" ${p.status !== 'ready' ? 'disabled' : ''}>${esc(p.description)}</textarea>
          <div class="pitem__foot">
            ${state.csvRows.length ? `<select class="field__input field__input--sm" data-csv>${options(p)}</select>` : ''}
            <button class="btn btn--sm" type="button" data-remove ${p.status === 'uploading' ? 'disabled' : ''}>빼기</button>
          </div>
        </div>
      </div>`).join('');
  }

  // 대기 목록 안의 입력값 변경 → state 에 반영 (이벤트 위임)
  pendingList.addEventListener('input', (ev) => {
    const item = ev.target.closest('[data-idx]');
    if (!item) return;
    const p = state.pending[Number(item.dataset.idx)];
    const f = ev.target.dataset.f;
    if (p && f) p[f] = ev.target.value;
  });
  pendingList.addEventListener('change', (ev) => {
    const item = ev.target.closest('[data-idx]');
    if (!item) return;
    const p = state.pending[Number(item.dataset.idx)];
    if (ev.target.hasAttribute('data-csv')) {
      const v = ev.target.value;
      if (v === '') { p.matched = null; } else { applyCsvRow(p, Number(v)); }
      renderPending();
    }
  });
  pendingList.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-remove]');
    if (!btn) return;
    const item = btn.closest('[data-idx]');
    const i = Number(item.dataset.idx);
    URL.revokeObjectURL(state.pending[i].url);
    state.pending.splice(i, 1);
    renderPending();
  });

  $('#btnClearPending').addEventListener('click', () => {
    state.pending.forEach((p) => URL.revokeObjectURL(p.url));
    state.pending = [];
    renderPending();
  });

  /** 전체 업로드: Storage 에 파일 올리기 → artworks 행 추가 (하나씩 순서대로) */
  $('#btnUploadAll').addEventListener('click', async () => {
    const targets = state.pending.filter((p) => p.status === 'ready' || p.status === 'error');
    if (!targets.length) { toast('업로드할 항목이 없습니다.'); return; }
    const missing = targets.filter((p) => !p.title.trim());
    if (missing.length) { toast('제목이 비어 있는 항목이 있습니다.'); return; }

    const btn = $('#btnUploadAll');
    btn.disabled = true;
    let ok = 0, fail = 0;
    for (const p of targets) {
      p.status = 'uploading'; renderPending();
      $('#uploadStatus').textContent = `${ok + fail + 1} / ${targets.length} 업로드 중…`;
      try {
        const ext = (p.file.name.split('.').pop() || 'png').toLowerCase();
        // 파일 이름은 한글·공백 문제를 피하려고 날짜+난수로 새로 만든다
        const path = `${todayTag()}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error: upErr } = await sb.storage.from(BUCKET).upload(path, p.file, {
          contentType: p.file.type, upsert: false,
        });
        if (upErr) throw upErr;

        const { error: insErr } = await sb.from('artworks').insert({
          title: p.title.trim(),
          author: p.author.trim(),
          description: p.description.trim(),
          image_path: path,
          sort_order: state.artworks.length + ok,
        });
        if (insErr) {
          // 행 추가에 실패하면 방금 올린 파일은 지워서 찌꺼기를 남기지 않는다
          await sb.storage.from(BUCKET).remove([path]);
          throw insErr;
        }
        p.status = 'done'; ok++;
      } catch (e) {
        p.status = 'error'; p.error = errMsg(e); fail++;
      }
      renderPending();
    }
    btn.disabled = false;
    $('#uploadStatus').textContent = `완료 ${ok}건${fail ? `, 실패 ${fail}건` : ''}`;
    toast(`업로드 완료 ${ok}건${fail ? `, 실패 ${fail}건` : ''}`);
    // 완료된 항목은 목록에서 정리
    state.pending = state.pending.filter((p) => p.status !== 'done');
    renderPending();
    await loadArtworks();
  });

  // ------------------------------------------------------------------
  // 5. 작품 - 목록 / 인라인 수정 / 숨김 / 삭제
  // ------------------------------------------------------------------
  const artworkList = $('#artworkList');

  async function loadArtworkStats() {
    const { data, error } = await sb.rpc('artwork_stats');
    if (error) throw error;
    state.stats = new Map((data || []).map((r) => [r.artwork_id, {
      like_count: Number(r.like_count) || 0, comment_count: Number(r.comment_count) || 0,
    }]));
  }

  async function loadArtworks() {
    const [{ data, error }] = await Promise.all([
      sb.from('artworks').select('*').order('created_at', { ascending: false }),
      loadArtworkStats(),
    ]);
    if (error) throw error;
    state.artworks = data || [];
    $('#artworkCount').textContent = `${state.artworks.length}개`;
    renderArtworkList();
  }

  function renderArtworkList() {
    if (!state.artworks.length) {
      artworkList.innerHTML = '<p class="muted">아직 작품이 없습니다. 위에서 업로드하세요.</p>';
      return;
    }
    artworkList.innerHTML = state.artworks.map((a) => {
      const st = state.stats.get(a.id) || { like_count: 0, comment_count: 0 };
      return `
      <div class="aitem ${a.hidden ? 'is-hidden' : ''}" data-id="${esc(a.id)}">
        <a href="${esc(imageUrl(a.image_path))}" target="_blank" rel="noopener">
          <img class="aitem__thumb" src="${esc(imageUrl(a.image_path))}" alt="" loading="lazy" />
        </a>
        <div class="aitem__fields">
          <div class="aitem__grid">
            <input class="field__input" data-f="title" value="${esc(a.title)}" placeholder="제목" />
            <input class="field__input" data-f="author" value="${esc(a.author)}" placeholder="출품자" />
          </div>
          <textarea class="field__input" data-f="description" rows="2" placeholder="작품 설명">${esc(a.description)}</textarea>
          <div class="aitem__foot">
            <button class="btn btn--sm btn--primary" type="button" data-act="save">저장</button>
            <button class="btn btn--sm btn--outline" type="button" data-act="toggle">${a.hidden ? '보이기' : '숨김'}</button>
            <button class="btn btn--sm btn--danger" type="button" data-act="delete">삭제</button>
            <span class="aitem__meta">
              ${a.hidden ? '<span class="tag tag--hidden">숨김</span>' : '<span class="tag tag--ok">공개</span>'}
              ♥ ${st.like_count} · 💬 ${st.comment_count} · ${fmtDateTime(a.created_at)}
            </span>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  artworkList.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const item = btn.closest('[data-id]');
    const id = item.dataset.id;
    const a = state.artworks.find((x) => x.id === id);
    if (!a) return;
    const act = btn.dataset.act;
    btn.disabled = true;
    try {
      if (act === 'save') {
        const patch = {
          title: item.querySelector('[data-f=title]').value.trim(),
          author: item.querySelector('[data-f=author]').value.trim(),
          description: item.querySelector('[data-f=description]').value.trim(),
        };
        if (!patch.title) throw new Error('제목을 입력하세요.');
        const { error } = await sb.from('artworks').update(patch).eq('id', id);
        if (error) throw error;
        Object.assign(a, patch);
        toast('저장했습니다.');
      } else if (act === 'toggle') {
        const { error } = await sb.from('artworks').update({ hidden: !a.hidden }).eq('id', id);
        if (error) throw error;
        a.hidden = !a.hidden;
        renderArtworkList();
      } else if (act === 'delete') {
        const st = state.stats.get(id) || { like_count: 0, comment_count: 0 };
        if (!confirm(`"${a.title}" 작품을 삭제할까요?\n이미지 파일과 하트 ${st.like_count}개, 댓글 ${st.comment_count}개가 함께 삭제됩니다.`)) return;
        // 이미지 파일 먼저 삭제 → 그 다음 행 삭제 (하트·댓글은 FK cascade 로 자동 삭제)
        const { error: sErr } = await sb.storage.from(BUCKET).remove([a.image_path]);
        if (sErr) console.warn('이미지 삭제 실패(계속 진행)', sErr);
        const { error } = await sb.from('artworks').delete().eq('id', id);
        if (error) throw error;
        state.artworks = state.artworks.filter((x) => x.id !== id);
        $('#artworkCount').textContent = `${state.artworks.length}개`;
        renderArtworkList();
        toast('삭제했습니다.');
      }
    } catch (e) {
      toast(errMsg(e));
    } finally {
      btn.disabled = false;
    }
  });

  // ------------------------------------------------------------------
  // 6. 학생
  // ------------------------------------------------------------------
  async function loadStudents() {
    const { data, error } = await sb.from('students').select('*').order('last_login_at', { ascending: false });
    if (error) throw error;
    state.students = data || [];
    renderStudents();
  }

  function filteredStudents() {
    const q = $('#studentSearch').value.trim().toLowerCase();
    if (!q) return state.students;
    return state.students.filter((s) =>
      [s.school, s.student_no, s.name].some((v) => String(v).toLowerCase().includes(q)));
  }

  function renderStudents() {
    const rows = filteredStudents();
    $('#studentCount').textContent = `${rows.length} / ${state.students.length}명`;
    const tb = $('#studentTable tbody');
    if (!rows.length) { tb.innerHTML = '<tr><td class="empty" colspan="6">학생이 없습니다.</td></tr>'; return; }
    tb.innerHTML = rows.map((s) => `
      <tr data-id="${esc(s.id)}">
        <td>${esc(s.school)}</td>
        <td>${esc(s.student_no)}</td>
        <td>${esc(s.name)}</td>
        <td>${fmtDateTime(s.last_login_at)}</td>
        <td>${s.auth_uid ? '<span class="tag tag--ok">연결됨</span>' : '<span class="tag">해제됨</span>'}</td>
        <td class="actions">
          <button class="btn btn--sm btn--outline" type="button" data-act="unlink" ${s.auth_uid ? '' : 'disabled'}>기기 해제</button>
          <button class="btn btn--sm btn--danger" type="button" data-act="delete">삭제</button>
        </td>
      </tr>`).join('');
  }

  $('#studentSearch').addEventListener('input', renderStudents);

  $('#studentTable').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const s = state.students.find((x) => x.id === id);
    if (!s) return;
    btn.disabled = true;
    try {
      if (btn.dataset.act === 'unlink') {
        const { error } = await sb.from('students').update({ auth_uid: null }).eq('id', id);
        if (error) throw error;
        s.auth_uid = null;
        renderStudents();
        toast('기기 연결을 해제했습니다. 학생이 다시 로그인하면 다시 연결됩니다.');
      } else if (btn.dataset.act === 'delete') {
        if (!confirm(`${s.school} ${s.student_no} ${s.name} 학생의 프로필을 삭제할까요?\n이 학생의 하트·댓글도 모두 삭제됩니다.`)) return;
        const { error } = await sb.from('students').delete().eq('id', id);
        if (error) throw error;
        state.students = state.students.filter((x) => x.id !== id);
        renderStudents();
        toast('삭제했습니다.');
      }
    } catch (e) {
      toast(errMsg(e));
    } finally {
      btn.disabled = false;
    }
  });

  $('#btnStudentsCsv').addEventListener('click', () => {
    downloadCsv(`학생목록_${todayTag()}.csv`,
      ['학교', '학번', '이름', '동의 시각', '최초 로그인', '마지막 로그인', '기기 연결'],
      state.students.map((s) => [s.school, s.student_no, s.name, fmtDateTime(s.consent_at),
        fmtDateTime(s.created_at), fmtDateTime(s.last_login_at), s.auth_uid ? '연결됨' : '해제됨']));
  });

  // ------------------------------------------------------------------
  // 7. 댓글
  // ------------------------------------------------------------------
  async function loadComments() {
    // 작품 제목과 학생 실명·학번을 함께 가져온다 (FK 를 따라가는 embedded select)
    const { data, error } = await sb
      .from('comments')
      .select('id, body, hidden, created_at, artwork_id, student_id, artworks(title), students(school, student_no, name)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    state.comments = data || [];
    renderComments();
  }

  function renderComments() {
    const hiddenOnly = $('#hiddenOnly').checked;
    const rows = hiddenOnly ? state.comments.filter((c) => c.hidden) : state.comments;
    $('#commentCount').textContent = `${rows.length}개`;
    const tb = $('#commentTable tbody');
    if (!rows.length) { tb.innerHTML = '<tr><td class="empty" colspan="6">댓글이 없습니다.</td></tr>'; return; }
    tb.innerHTML = rows.map((c) => {
      const st = c.students || {};
      return `
      <tr data-id="${esc(c.id)}" class="${c.hidden ? 'is-hidden' : ''}">
        <td>${fmtDateTime(c.created_at)}</td>
        <td>${esc(c.artworks ? c.artworks.title : '(삭제된 작품)')}</td>
        <td>${esc(st.school || '')} ${esc(st.student_no || '')}<br />${esc(st.name || '(삭제된 학생)')}</td>
        <td class="wrap">${esc(c.body)}</td>
        <td>${c.hidden ? '<span class="tag tag--hidden">숨김</span>' : '<span class="tag tag--ok">공개</span>'}</td>
        <td class="actions">
          <button class="btn btn--sm btn--outline" type="button" data-act="toggle">${c.hidden ? '보이기' : '숨김'}</button>
          <button class="btn btn--sm btn--danger" type="button" data-act="delete">삭제</button>
        </td>
      </tr>`;
    }).join('');
  }

  $('#hiddenOnly').addEventListener('change', renderComments);

  $('#commentTable').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const c = state.comments.find((x) => String(x.id) === String(id));
    if (!c) return;
    btn.disabled = true;
    try {
      if (btn.dataset.act === 'toggle') {
        const { error } = await sb.from('comments').update({ hidden: !c.hidden }).eq('id', c.id);
        if (error) throw error;
        c.hidden = !c.hidden;
        renderComments();
      } else if (btn.dataset.act === 'delete') {
        if (!confirm('이 댓글을 완전히 삭제할까요?')) return;
        const { error } = await sb.from('comments').delete().eq('id', c.id);
        if (error) throw error;
        state.comments = state.comments.filter((x) => x.id !== c.id);
        renderComments();
        toast('삭제했습니다.');
      }
    } catch (e) {
      toast(errMsg(e));
    } finally {
      btn.disabled = false;
    }
  });

  // ------------------------------------------------------------------
  // 8. 결과 + CSV 3종
  // ------------------------------------------------------------------
  function ranking() {
    return state.artworks
      .map((a) => ({ ...a, ...(state.stats.get(a.id) || { like_count: 0, comment_count: 0 }) }))
      .sort((a, b) => (b.like_count - a.like_count) || (b.comment_count - a.comment_count) || a.title.localeCompare(b.title, 'ko'))
      .map((a, i) => ({ ...a, rank: i + 1 }));
  }

  async function loadResults() {
    const [{ data, error }] = await Promise.all([
      sb.from('artworks').select('*'),
      loadArtworkStats(),
    ]);
    if (error) throw error;
    state.artworks = data || [];
    const tb = $('#resultTable tbody');
    const rows = ranking();
    if (!rows.length) { tb.innerHTML = '<tr><td class="empty" colspan="6">작품이 없습니다.</td></tr>'; return; }
    tb.innerHTML = rows.map((a) => `
      <tr class="${a.hidden ? 'is-hidden' : ''}">
        <td><strong>${a.rank}</strong></td>
        <td>${esc(a.title)}</td>
        <td>${esc(a.author)}</td>
        <td><strong>${a.like_count}</strong></td>
        <td>${a.comment_count}</td>
        <td>${a.hidden ? '<span class="tag tag--hidden">숨김</span>' : ''}</td>
      </tr>`).join('');
  }

  // CSV ① 작품별 집계
  $('#btnCsvSummary').addEventListener('click', () => {
    downloadCsv(`결과_작품별집계_${todayTag()}.csv`,
      ['순위', '제목', '출품자', '하트', '댓글', '상태'],
      ranking().map((a) => [a.rank, a.title, a.author, a.like_count, a.comment_count, a.hidden ? '숨김' : '공개']));
  });

  // CSV ② 하트 상세 (누가 어떤 작품에 언제)
  $('#btnCsvLikes').addEventListener('click', async () => {
    try {
      const { data, error } = await sb
        .from('likes')
        .select('created_at, artworks(title, author), students(school, student_no, name)')
        .order('created_at', { ascending: true });
      if (error) throw error;
      downloadCsv(`결과_하트상세_${todayTag()}.csv`,
        ['작품 제목', '출품자', '학교', '학번', '이름', '시각'],
        (data || []).map((l) => [
          l.artworks ? l.artworks.title : '', l.artworks ? l.artworks.author : '',
          l.students ? l.students.school : '', l.students ? l.students.student_no : '', l.students ? l.students.name : '',
          fmtDateTime(l.created_at)]));
    } catch (e) { toast(errMsg(e)); }
  });

  // CSV ③ 댓글 상세
  $('#btnCsvComments').addEventListener('click', async () => {
    try {
      const { data, error } = await sb
        .from('comments')
        .select('body, hidden, created_at, artworks(title, author), students(school, student_no, name)')
        .order('created_at', { ascending: true });
      if (error) throw error;
      downloadCsv(`결과_댓글상세_${todayTag()}.csv`,
        ['작품 제목', '출품자', '학교', '학번', '이름', '댓글', '상태', '시각'],
        (data || []).map((c) => [
          c.artworks ? c.artworks.title : '', c.artworks ? c.artworks.author : '',
          c.students ? c.students.school : '', c.students ? c.students.student_no : '', c.students ? c.students.name : '',
          c.body, c.hidden ? '숨김' : '공개', fmtDateTime(c.created_at)]));
    } catch (e) { toast(errMsg(e)); }
  });

  // ------------------------------------------------------------------
  // 9. 교사 계정
  // ------------------------------------------------------------------
  async function loadAdmins() {
    const { data, error } = await sb.from('admins').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    state.admins = data || [];
    const tb = $('#adminTable tbody');
    tb.innerHTML = state.admins.map((a) => {
      const me = a.email.toLowerCase() === String(state.email).toLowerCase();
      return `
      <tr data-email="${esc(a.email)}">
        <td>${esc(a.email)} ${me ? '<span class="tag tag--ok">나</span>' : ''}</td>
        <td>${fmtDateTime(a.created_at)}</td>
        <td><button class="btn btn--sm btn--danger" type="button" data-act="remove" ${me ? 'disabled title="본인은 해제할 수 없습니다"' : ''}>권한 해제</button></td>
      </tr>`;
    }).join('');
  }

  $('#adminTable').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act=remove]');
    if (!btn) return;
    const email = btn.closest('tr').dataset.email;
    if (!confirm(`${email} 의 관리자 권한을 해제할까요?\n(로그인 계정은 남지만 관리자 페이지를 쓸 수 없게 됩니다)`)) return;
    btn.disabled = true;
    try {
      const { error } = await sb.rpc('remove_admin', { p_email: email });
      if (error) throw error;
      toast('권한을 해제했습니다.');
      await loadAdmins();
    } catch (e) {
      toast(errMsg(e));
      btn.disabled = false;
    }
  });

  $('#addAdminForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.currentTarget;
    const fd = new FormData(f);
    showFormError('#addAdminError', '');
    const password = String(fd.get('password') || '');
    if (password.length < 6) { showFormError('#addAdminError', '비밀번호는 6자 이상이어야 합니다.'); return; }
    try {
      const { data, error } = await sb.rpc('signup_admin', {
        p_email: String(fd.get('email') || '').trim(),
        p_password: password,
        p_code: String(fd.get('code') || ''),
      });
      if (error) throw error;
      toast(data.created ? '계정을 만들고 관리자로 등록했습니다.' : '이미 있는 계정을 관리자로 등록했습니다. (비밀번호는 바뀌지 않음)');
      f.reset();
      await loadAdmins();
    } catch (e) {
      showFormError('#addAdminError', errMsg(e));
    }
  });

  // ------------------------------------------------------------------
  // 10. 시작: 이미 로그인돼 있으면 바로 관리자 화면
  // ------------------------------------------------------------------
  (async function init() {
    try {
      const ok = await enterApp();
      if (!ok) authView.classList.remove('hidden');
    } catch (e) {
      authView.classList.remove('hidden');
      showFormError('#loginError', errMsg(e));
    }
  })();
})();
