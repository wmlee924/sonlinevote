/* =====================================================================
   학생용 투표 사이트 로직 (index.html)
   ---------------------------------------------------------------------
   흐름
     1. 페이지 열림 → 설정·작품 목록·하트/댓글 수 불러오기 (로그인 전에도 가능)
     2. [참여하기] → Supabase 익명 로그인 → claim_student 함수로 프로필 연결
     3. 카드/상세 모달에서 하트 → toggle_like 함수 (낙관적 업데이트)
     4. 상세 모달에서 댓글 → add_comment / delete_my_comment 함수
   모든 "쓰기"는 DB 함수(rpc)로만 하며, 브라우저는 표에 직접 insert 하지 않습니다.
   ===================================================================== */

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // 0. Supabase 클라이언트 만들기
  // ------------------------------------------------------------------
  const CFG = window.APP_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

  // ------------------------------------------------------------------
  // 1. 화면 전체에서 공유하는 상태
  // ------------------------------------------------------------------
  const state = {
    settings: null,          // { site_title, notice, voting_open }
    artworks: [],            // 보이는 작품 목록
    stats: new Map(),        // artwork_id → { like_count, comment_count }
    myLikes: new Set(),      // 내가 하트 누른 artwork_id 집합
    profile: null,           // 로그인한 학생 { id, school, student_no, name, masked_name }
    sort: 'random',          // 'random' | 'popular' | 'latest'
    seed: getSessionSeed(),  // 랜덤 정렬 시드 (브라우저 탭을 닫기 전까지 고정)
    currentId: null,         // 상세 모달에 열린 작품 id
    comments: [],            // 상세 모달의 댓글 목록
    pending: new Set(),      // 하트 요청 진행 중인 artwork_id (연타 방지)
  };

  // ------------------------------------------------------------------
  // 2. 자주 쓰는 DOM 요소
  // ------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const el = {
    siteTitle: $('#siteTitle'),
    headerUser: $('#headerUser'),
    voteBadge: $('#voteBadge'),
    noticeText: $('#noticeText'),
    grid: $('#grid'),
    emptyState: $('#emptyState'),
    errorState: $('#errorState'),
    errorText: $('#errorText'),
    btnRetry: $('#btnRetry'),
    sortbar: document.querySelector('.sortbar'),
    // 상세 모달
    detailModal: $('#detailModal'),
    detailImg: $('#detailImg'),
    detailTitle: $('#detailTitle'),
    detailAuthor: $('#detailAuthor'),
    detailActions: $('#detailActions'),
    detailDesc: $('#detailDesc'),
    commentCount: $('#commentCount'),
    commentList: $('#commentList'),
    commentFormWrap: $('#commentFormWrap'),
    // 로그인 모달
    loginModal: $('#loginModal'),
    loginForm: $('#loginForm'),
    loginError: $('#loginError'),
    btnLoginSubmit: $('#btnLoginSubmit'),
    toast: $('#toast'),
  };

  // ------------------------------------------------------------------
  // 3. 작은 도우미 함수들
  // ------------------------------------------------------------------

  /** HTML 특수문자를 안전하게 바꿔 XSS 를 막는다 (사용자 입력을 화면에 넣을 때 항상 사용) */
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 랜덤 정렬용 시드: 같은 탭에서는 새로고침해도 순서가 유지되도록 sessionStorage 에 저장 */
  function getSessionSeed() {
    try {
      let s = sessionStorage.getItem('vote_seed');
      if (!s) {
        s = String(Math.floor(Math.random() * 1e9));
        sessionStorage.setItem('vote_seed', s);
      }
      return Number(s);
    } catch (_) {
      return Math.floor(Math.random() * 1e9);
    }
  }

  /** 시드로 항상 같은 난수열을 만드는 간단한 생성기 (mulberry32) */
  function seededRandom(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 시드 기반으로 섞기 (같은 시드면 항상 같은 순서) */
  function shuffleWithSeed(arr, seed) {
    const rnd = seededRandom(seed);
    const out = arr.slice().sort((a, b) => (a.id < b.id ? -1 : 1)); // 시작 순서를 고정
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** Storage 경로 → 공개 이미지 URL */
  function imageUrl(path) {
    return sb.storage.from(CFG.STORAGE_BUCKET).getPublicUrl(path).data.publicUrl;
  }

  /** 날짜를 "10.08 14:32" 처럼 짧게 */
  function fmtTime(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 아래쪽에 잠깐 뜨는 알림 */
  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2600);
  }

  /** Supabase 오류 객체에서 사람이 읽을 메시지 꺼내기 */
  function errMsg(error, fallback) {
    const m = error && error.message ? String(error.message) : '';
    if (/anonymous sign-ins are disabled/i.test(m)) {
      return '익명 로그인이 꺼져 있어요. 관리자에게 알려 주세요. (Supabase → Authentication → Anonymous sign-ins)';
    }
    if (/rate limit/i.test(m)) {
      return '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.';
    }
    if (/Failed to fetch|NetworkError/i.test(m)) {
      return '인터넷 연결을 확인해 주세요.';
    }
    return m || fallback || '문제가 생겼어요. 다시 시도해 주세요.';
  }

  const HEART_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3.2 5 6.8 5c2 0 3.4 1.1 4.2 2.3C11.8 6.1 13.2 5 15.2 5c3.6 0 5.6 3.6 4.3 6.8C19.5 16.4 12 21 12 21z"/></svg>';

  const votingOpen = () => !!(state.settings && state.settings.voting_open);

  // ------------------------------------------------------------------
  // 4. 데이터 불러오기
  // ------------------------------------------------------------------

  /** 사이트 설정(제목·안내문·투표 상태) */
  async function loadSettings() {
    const { data, error } = await sb.from('settings').select('site_title, notice, voting_open').eq('id', 1).single();
    if (error) throw error;
    state.settings = data;
    renderSettings();
  }

  /** 작품 목록 (숨긴 작품은 RLS 가 걸러 줌) */
  async function loadArtworks() {
    const { data, error } = await sb
      .from('artworks')
      .select('id, title, author, description, image_path, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    state.artworks = data || [];
  }

  /** 작품별 하트·댓글 수 (함수로만 제공됨) */
  async function loadStats() {
    const { data, error } = await sb.rpc('artwork_stats');
    if (error) throw error;
    state.stats = new Map((data || []).map((r) => [r.artwork_id, {
      like_count: Number(r.like_count) || 0,
      comment_count: Number(r.comment_count) || 0,
    }]));
  }

  /** 내가 누른 하트 목록 (RLS 덕분에 내 것만 돌아옴) */
  async function loadMyLikes() {
    if (!state.profile) { state.myLikes = new Set(); return; }
    const { data, error } = await sb.from('likes').select('artwork_id');
    if (error) { console.warn('내 하트 불러오기 실패', error); return; }
    state.myLikes = new Set((data || []).map((r) => r.artwork_id));
  }

  /** 새로고침 후 로그인 상태 복원: 익명 세션이 있고 프로필이 연결돼 있으면 로그인 상태 */
  async function restoreSession() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session || !session.user || !session.user.is_anonymous) {
      state.profile = null;
      return;
    }
    const { data, error } = await sb.rpc('my_profile');
    if (error) { console.warn('프로필 복원 실패', error); state.profile = null; return; }
    // 다른 기기에서 로그인했으면 my_profile 이 null → 이 기기는 로그아웃 상태로 취급
    state.profile = data || null;
  }

  /** 첫 로딩: 모든 데이터를 한 번에 */
  async function loadAll() {
    showLoading();
    try {
      await Promise.all([loadSettings(), loadArtworks(), loadStats(), restoreSession()]);
      await loadMyLikes();
      renderHeaderUser();
      renderGallery();
    } catch (e) {
      console.error(e);
      showError(errMsg(e, '작품을 불러오지 못했어요.'));
    }
  }

  /** 하트/댓글 수와 투표 상태만 가볍게 갱신 (주기적으로 호출) */
  async function refreshLight() {
    try {
      const wasOpen = votingOpen();
      await Promise.all([loadSettings(), loadStats()]);
      if (wasOpen !== votingOpen()) {
        // 관리자가 투표를 시작/마감했으면 하트 버튼 ↔ 안내 문구가 바뀌어야 하므로 전체를 다시 그림
        renderGallery();
        if (state.currentId) { renderDetailActions(); renderCommentForm(); }
        toast(votingOpen() ? '투표가 시작되었어요!' : '투표가 마감되었어요.');
        return;
      }
      // 전체 그리드를 다시 그리지 않고 숫자만 갱신 (하트 애니메이션 끊김 방지)
      state.artworks.forEach((a) => updateLikeUI(a.id));
      if (state.currentId) renderDetailActions();
    } catch (_) { /* 조용히 무시 */ }
  }

  // ------------------------------------------------------------------
  // 5. 화면 그리기
  // ------------------------------------------------------------------

  function renderSettings() {
    const s = state.settings;
    if (!s) return;
    el.siteTitle.textContent = s.site_title || '캐릭터 공모전 투표';
    document.title = s.site_title || '캐릭터 공모전 투표';
    el.noticeText.textContent = s.notice || '';
    el.voteBadge.textContent = s.voting_open ? '투표 진행 중' : '투표 마감';
    el.voteBadge.className = 'badge ' + (s.voting_open ? 'badge--open' : 'badge--closed');
  }

  /** 헤더 오른쪽: 로그인 전/후 */
  function renderHeaderUser() {
    if (state.profile) {
      el.headerUser.innerHTML =
        `<span class="header__name">${esc(state.profile.masked_name)}님</span>` +
        `<button class="btn btn--outline btn--sm" id="btnLogout" type="button">로그아웃</button>`;
      $('#btnLogout').addEventListener('click', logout);
    } else {
      el.headerUser.innerHTML =
        `<button class="btn btn--primary btn--sm" id="btnOpenLogin" type="button">참여하기</button>`;
      $('#btnOpenLogin').addEventListener('click', openLogin);
    }
  }

  function showLoading() {
    el.emptyState.classList.add('hidden');
    el.errorState.classList.add('hidden');
    el.grid.classList.remove('hidden');
    el.grid.innerHTML = '<div class="card card--skeleton"></div>'.repeat(6);
  }

  function showError(msg) {
    el.grid.classList.add('hidden');
    el.emptyState.classList.add('hidden');
    el.errorText.textContent = msg;
    el.errorState.classList.remove('hidden');
  }

  /** 현재 정렬 기준에 맞게 작품 배열을 돌려준다 */
  function sortedArtworks() {
    const base = shuffleWithSeed(state.artworks, state.seed); // 랜덤 순서 (동점 처리에도 사용)
    if (state.sort === 'popular') {
      return base.slice().sort((a, b) => {
        const sa = state.stats.get(a.id) || { like_count: 0, comment_count: 0 };
        const sb_ = state.stats.get(b.id) || { like_count: 0, comment_count: 0 };
        return (sb_.like_count - sa.like_count) || (sb_.comment_count - sa.comment_count);
      });
    }
    if (state.sort === 'latest') {
      return base.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    return base;
  }

  /** 하트 버튼 HTML (카드와 상세 모달에서 공용) */
  function heartHtml(id, big) {
    const liked = state.myLikes.has(id);
    const n = (state.stats.get(id) || {}).like_count || 0;
    return `<button class="heart ${big ? 'heart--big' : ''} ${liked ? 'is-liked' : ''}" type="button"
              data-like-id="${esc(id)}" aria-pressed="${liked}" aria-label="하트">
              ${HEART_SVG}<span class="heart__count">${n}</span>
            </button>`;
  }

  /** 갤러리 전체 그리기 */
  function renderGallery() {
    el.errorState.classList.add('hidden');
    if (!state.artworks.length) {
      el.grid.classList.add('hidden');
      el.emptyState.classList.remove('hidden');
      return;
    }
    el.emptyState.classList.add('hidden');
    el.grid.classList.remove('hidden');

    const open = votingOpen();
    el.grid.innerHTML = sortedArtworks().map((a) => {
      const st = state.stats.get(a.id) || { like_count: 0, comment_count: 0 };
      const foot = open
        ? heartHtml(a.id, false)
        : `<span class="card__comments">♥ ${st.like_count}</span>`;
      return `
        <article class="card" data-card-id="${esc(a.id)}">
          <button class="card__imgbtn" type="button" data-open-id="${esc(a.id)}" aria-label="${esc(a.title)} 크게 보기">
            <img class="card__img" src="${esc(imageUrl(a.image_path))}" alt="${esc(a.title)}" loading="lazy" />
          </button>
          <div class="card__body">
            <h2 class="card__title">${esc(a.title)}</h2>
            <p class="card__author">${esc(a.author)}</p>
            <div class="card__foot">
              ${foot}
              <span class="card__comments" data-cc-id="${esc(a.id)}">💬 ${st.comment_count}</span>
            </div>
          </div>
        </article>`;
    }).join('');
  }

  /** 특정 작품의 하트 버튼/숫자만 갱신 (카드 + 모달 양쪽) */
  function updateLikeUI(id, pop) {
    const liked = state.myLikes.has(id);
    const st = state.stats.get(id) || { like_count: 0, comment_count: 0 };
    document.querySelectorAll(`[data-like-id="${CSS.escape(id)}"]`).forEach((btn) => {
      btn.classList.toggle('is-liked', liked);
      btn.setAttribute('aria-pressed', String(liked));
      const c = btn.querySelector('.heart__count');
      if (c) c.textContent = st.like_count;
      if (pop) {
        btn.classList.remove('is-pop');
        void btn.offsetWidth; // 애니메이션 재시작용 리플로우
        btn.classList.add('is-pop');
      }
    });
    document.querySelectorAll(`[data-cc-id="${CSS.escape(id)}"]`).forEach((s) => {
      s.textContent = `💬 ${st.comment_count}`;
    });
  }

  // ------------------------------------------------------------------
  // 6. 하트 (낙관적 업데이트)
  // ------------------------------------------------------------------
  async function toggleLike(id) {
    if (!votingOpen()) { toast('지금은 투표 기간이 아니에요.'); return; }
    if (!state.profile) { openLogin(); return; }
    if (state.pending.has(id)) return; // 연타 방지
    state.pending.add(id);

    // ① 먼저 화면부터 바꾼다 (즉시 반응)
    const wasLiked = state.myLikes.has(id);
    const st = state.stats.get(id) || { like_count: 0, comment_count: 0 };
    const prevCount = st.like_count;
    if (wasLiked) { state.myLikes.delete(id); st.like_count = Math.max(0, prevCount - 1); }
    else          { state.myLikes.add(id);    st.like_count = prevCount + 1; }
    state.stats.set(id, st);
    updateLikeUI(id, !wasLiked);

    // ② 서버에 요청
    const { data, error } = await sb.rpc('toggle_like', { p_artwork_id: id });
    state.pending.delete(id);

    if (error) {
      // ③ 실패하면 되돌린다
      if (wasLiked) state.myLikes.add(id); else state.myLikes.delete(id);
      st.like_count = prevCount;
      state.stats.set(id, st);
      updateLikeUI(id, false);
      handleAuthError(error);
      return;
    }
    // ④ 서버가 알려준 정확한 값으로 맞춘다
    if (data.liked) state.myLikes.add(id); else state.myLikes.delete(id);
    st.like_count = Number(data.like_count) || 0;
    state.stats.set(id, st);
    updateLikeUI(id, false);
  }

  /** 함수 오류 중 "로그인이 필요" 계열이면 로그아웃 상태로 바꾸고 로그인 창을 연다 */
  function handleAuthError(error) {
    const m = errMsg(error);
    toast(m);
    if (/로그인이 필요/.test(m)) {
      state.profile = null;
      state.myLikes = new Set();
      renderHeaderUser();
      if (state.currentId) { renderDetailActions(); renderCommentForm(); }
      openLogin();
    }
    if (/투표 기간이 아닙니다/.test(m)) {
      // 관리자가 방금 마감했을 수 있으니 설정을 다시 읽어 화면에 반영
      refreshLight().then(renderGallery);
    }
  }

  // ------------------------------------------------------------------
  // 7. 상세 모달
  // ------------------------------------------------------------------
  function openDetail(id) {
    const a = state.artworks.find((x) => x.id === id);
    if (!a) return;
    state.currentId = id;
    el.detailImg.src = imageUrl(a.image_path);
    el.detailImg.alt = a.title;
    el.detailTitle.textContent = a.title;
    el.detailAuthor.textContent = a.author;
    el.detailDesc.textContent = a.description;
    renderDetailActions();
    renderCommentForm();
    el.commentList.innerHTML = '<li class="comments__empty">댓글 불러오는 중…</li>';
    showModal(el.detailModal);
    loadComments(id);
  }

  function closeDetail() {
    state.currentId = null;
    hideModal(el.detailModal);
  }

  /** 모달 안의 큰 하트(또는 안내 문구) */
  function renderDetailActions() {
    const id = state.currentId;
    if (!id) return;
    if (!votingOpen()) {
      const n = (state.stats.get(id) || {}).like_count || 0;
      el.detailActions.innerHTML = `<p class="actions-note">투표가 마감되었어요. ♥ ${n}</p>`;
      return;
    }
    el.detailActions.innerHTML = heartHtml(id, true) +
      (state.profile ? '' : ' <span class="card__comments">참여하려면 하트를 눌러 로그인하세요</span>');
  }

  /** 댓글 입력 폼 (투표 마감/비로그인이면 안내 문구) */
  function renderCommentForm() {
    if (!votingOpen()) {
      el.commentFormWrap.innerHTML = '<p class="actions-note">투표가 마감되어 댓글을 쓸 수 없어요.</p>';
      return;
    }
    if (!state.profile) {
      el.commentFormWrap.innerHTML =
        '<p class="actions-note">댓글을 쓰려면 <button class="btn btn--primary btn--sm" type="button" id="btnLoginFromComment">참여하기</button></p>';
      $('#btnLoginFromComment').addEventListener('click', openLogin);
      return;
    }
    el.commentFormWrap.innerHTML = `
      <form class="cform" id="commentForm">
        <textarea class="cform__input" name="body" maxlength="200" placeholder="응원 댓글을 남겨 주세요 (200자까지)" required></textarea>
        <div class="cform__foot">
          <span class="cform__count"><span id="cLen">0</span>/200</span>
          <button class="btn btn--primary btn--sm" type="submit">등록</button>
        </div>
      </form>`;
    const form = $('#commentForm');
    const ta = form.querySelector('textarea');
    ta.addEventListener('input', () => {
      $('#cLen').textContent = ta.value.length;
      $('#cLen').parentElement.classList.toggle('is-over', ta.value.length >= 200);
    });
    form.addEventListener('submit', submitComment);
  }

  async function loadComments(id) {
    const { data, error } = await sb
      .from('comments')
      .select('id, artwork_id, student_id, body, masked_name, created_at')
      .eq('artwork_id', id)
      .order('created_at', { ascending: true });
    if (state.currentId !== id) return; // 그 사이 다른 작품을 열었으면 무시
    if (error) {
      el.commentList.innerHTML = `<li class="comments__empty">댓글을 불러오지 못했어요.</li>`;
      return;
    }
    state.comments = data || [];
    renderComments();
  }

  function renderComments() {
    el.commentCount.textContent = state.comments.length;
    const st = state.stats.get(state.currentId);
    if (st) { st.comment_count = state.comments.length; updateLikeUI(state.currentId, false); }

    if (!state.comments.length) {
      el.commentList.innerHTML = '<li class="comments__empty">첫 댓글을 남겨 보세요!</li>';
      return;
    }
    const myId = state.profile ? state.profile.id : null;
    el.commentList.innerHTML = state.comments.map((c) => `
      <li class="comment" data-comment-id="${esc(c.id)}">
        <div class="comment__head">
          <span class="comment__name">${esc(c.masked_name)}</span>
          <span>${fmtTime(c.created_at)}</span>
          ${c.student_id === myId ? `<button class="comment__del" type="button" data-del-id="${esc(c.id)}">삭제</button>` : ''}
        </div>
        <p class="comment__body">${esc(c.body)}</p>
      </li>`).join('');
  }

  async function submitComment(ev) {
    ev.preventDefault();
    const form = ev.currentTarget;
    const ta = form.querySelector('textarea');
    const btn = form.querySelector('button[type=submit]');
    const body = ta.value.trim();
    if (!body) { toast('댓글 내용을 입력해 주세요.'); return; }
    if (body.length > 200) { toast('댓글은 200자까지만 쓸 수 있어요.'); return; }

    btn.disabled = true;
    const { data, error } = await sb.rpc('add_comment', { p_artwork_id: state.currentId, p_body: body });
    btn.disabled = false;
    if (error) { handleAuthError(error); return; }

    ta.value = '';
    $('#cLen').textContent = '0';
    state.comments.push(data);
    renderComments();
    // 스크롤을 새 댓글로
    const last = el.commentList.lastElementChild;
    if (last) last.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function deleteComment(commentId) {
    if (!confirm('이 댓글을 삭제할까요?')) return;
    const { data, error } = await sb.rpc('delete_my_comment', { p_comment_id: Number(commentId) });
    if (error) { handleAuthError(error); return; }
    if (!data) { toast('삭제할 수 없는 댓글이에요.'); return; }
    state.comments = state.comments.filter((c) => String(c.id) !== String(commentId));
    renderComments();
    toast('댓글을 삭제했어요.');
  }

  // ------------------------------------------------------------------
  // 8. 로그인 / 로그아웃
  // ------------------------------------------------------------------
  function openLogin() {
    el.loginError.classList.add('hidden');
    showModal(el.loginModal);
    const first = el.loginForm.querySelector('input[name=school]');
    setTimeout(() => first && first.focus(), 50);
  }

  async function submitLogin(ev) {
    ev.preventDefault();
    const fd = new FormData(el.loginForm);
    const school = String(fd.get('school') || '').trim();
    const student_no = String(fd.get('student_no') || '').trim();
    const name = String(fd.get('name') || '').trim();
    const consent = fd.get('consent') === 'on';

    el.loginError.classList.add('hidden');
    if (!school || !student_no || !name) { return showLoginError('학교, 학번, 이름을 모두 입력해 주세요.'); }
    if (!consent) { return showLoginError('개인정보 수집·이용에 동의해야 참여할 수 있어요.'); }

    el.btnLoginSubmit.disabled = true;
    el.btnLoginSubmit.textContent = '확인 중…';
    try {
      // ① 익명 세션 확보 (관리자 세션이 남아 있으면 먼저 로그아웃)
      let { data: { session } } = await sb.auth.getSession();
      if (session && session.user && !session.user.is_anonymous) {
        await sb.auth.signOut();
        session = null;
      }
      if (!session) {
        const { error } = await sb.auth.signInAnonymously();
        if (error) throw error;
      }
      // ② 프로필 만들기/연결하기 (중복·이름 불일치 검사는 DB 함수가 수행)
      const { data, error } = await sb.rpc('claim_student', {
        p_school: school, p_student_no: student_no, p_name: name, p_consent: consent,
      });
      if (error) throw error;

      state.profile = data;
      await loadMyLikes();
      renderHeaderUser();
      renderGallery();
      if (state.currentId) { renderDetailActions(); renderCommentForm(); renderComments(); }
      hideModal(el.loginModal);
      el.loginForm.reset();
      toast(`${data.masked_name}님, 환영해요! 마음에 드는 작품에 하트를 눌러 주세요.`);
    } catch (e) {
      showLoginError(errMsg(e, '참여 처리에 실패했어요. 다시 시도해 주세요.'));
    } finally {
      el.btnLoginSubmit.disabled = false;
      el.btnLoginSubmit.textContent = '참여하기';
    }
  }

  function showLoginError(msg) {
    el.loginError.textContent = msg;
    el.loginError.classList.remove('hidden');
  }

  async function logout() {
    await sb.auth.signOut();
    state.profile = null;
    state.myLikes = new Set();
    renderHeaderUser();
    renderGallery();
    if (state.currentId) { renderDetailActions(); renderCommentForm(); renderComments(); }
    toast('로그아웃했어요.');
  }

  // ------------------------------------------------------------------
  // 9. 모달 공통
  // ------------------------------------------------------------------
  function showModal(m) {
    m.classList.remove('hidden');
    document.body.classList.add('no-scroll');
  }
  function hideModal(m) {
    m.classList.add('hidden');
    // 다른 모달이 열려 있지 않으면 스크롤 잠금 해제
    if (document.querySelectorAll('.modal:not(.hidden)').length === 0) {
      document.body.classList.remove('no-scroll');
    }
  }

  // ------------------------------------------------------------------
  // 10. 이벤트 연결
  // ------------------------------------------------------------------

  // 정렬 버튼
  el.sortbar.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-sort]');
    if (!btn) return;
    state.sort = btn.dataset.sort;
    el.sortbar.querySelectorAll('.sortbar__btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    renderGallery();
  });

  // 갤러리: 이미지 클릭 → 상세, 하트 클릭 → 토글 (이벤트 위임)
  el.grid.addEventListener('click', (ev) => {
    const like = ev.target.closest('[data-like-id]');
    if (like) { toggleLike(like.dataset.likeId); return; }
    const open = ev.target.closest('[data-open-id]');
    if (open) openDetail(open.dataset.openId);
  });

  // 상세 모달 안: 큰 하트, 댓글 삭제, 닫기
  el.detailModal.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-close]')) { closeDetail(); return; }
    const like = ev.target.closest('[data-like-id]');
    if (like) { toggleLike(like.dataset.likeId); return; }
    const del = ev.target.closest('[data-del-id]');
    if (del) deleteComment(del.dataset.delId);
  });

  // 로그인 모달
  el.loginModal.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-close]')) hideModal(el.loginModal);
  });
  el.loginForm.addEventListener('submit', submitLogin);

  // ESC 로 모달 닫기
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!el.loginModal.classList.contains('hidden')) hideModal(el.loginModal);
    else if (!el.detailModal.classList.contains('hidden')) closeDetail();
  });

  el.btnRetry.addEventListener('click', loadAll);

  // 탭이 보이는 동안 30초마다 하트 수·투표 상태 갱신
  setInterval(() => { if (!document.hidden) refreshLight(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshLight(); });

  // ------------------------------------------------------------------
  // 11. 시작
  // ------------------------------------------------------------------
  loadAll();
})();
