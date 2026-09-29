/* ============================================================================
   NABI 글로벌 네비게이션 — 단일 소스 컴포넌트
   ----------------------------------------------------------------------------
   페이지에서 사용:
     <script>
       window.NABI_NAV_ACTIVE = 'profile';            // home|discover|meetings|profile
       window.NABI_NAV_USER   = { name:'김도현', avatar:'김' };
     </script>
     <script src="nabi-nav.js"></script>
   동작:
     · .phone-frame 안에 모바일 앱바(+드로어)를 주입 → 좁아서 항상 햄버거
     · <body> 최상단에 데스크톱 앱바(.dk-only) + 고정 드로어 주입 → 넓으면 인라인,
       좁히면 햄버거(컨테이너 쿼리). 데스크톱 햄버거도 드로어 동작.
     · 로고 = '홈' = 동일 목적지. 홈은 향후 개발(현재 placeholder).
   메뉴 항목/순서는 아래 ITEMS 한 곳에서만 관리.
   ============================================================================ */
(function () {
  var ITEMS = [
    { key: 'home',     label: '홈',        ico: '🏠', home: true },
    { key: 'discover', label: '기업 탐색', ico: '🔍', href: 'prototype-discover.html' },
    { key: 'meetings', label: '내 미팅',   ico: '📅', href: 'prototype-my-meetings.html' },
    { key: 'profile',  label: '내 정보',   ico: '👤', href: 'prototype-profile.html' },
  ];

  var active = window.NABI_NAV_ACTIVE || '';
  var user = window.NABI_NAV_USER || { name: '', avatar: '·' };

  function homeGo() { alert('→ / (홈 · 향후 개발 예정)'); }
  function go(item) {
    if (item.home) { homeGo(); return; }
    var href = item.href;
    // 모바일 프리뷰 중이면 이동 대상에도 view=mobile 부착 (데스크톱으로 튀지 않게)
    try { if (document.body.classList.contains('preview-mobile')) href += (href.indexOf('?') < 0 ? '?' : '&') + 'view=mobile'; } catch (e) {}
    location.href = href;
  }

  // ── 개발용 모바일 프리뷰 상태를 세션 동안 유지 ──
  // 데스크톱에서 'Mobile' 프리뷰로 보다가 nav/버튼으로 페이지를 이동해도 데스크톱으로 튀지 않게 한다.
  // (실제 모바일 기기는 좁은 뷰포트라 컨테이너 쿼리로 자동 모바일 → 이 로직과 무관)
  function previewWanted() {
    var v = new URLSearchParams(location.search).get('view');
    if (v === 'mobile') return true;
    if (v === 'desktop') return false;
    try { return sessionStorage.getItem('nabiView') === 'mobile'; } catch (e) { return false; }
  }
  function syncPreview() {
    var mobile = previewWanted();
    document.body.classList.toggle('preview-mobile', mobile);
    try { sessionStorage.setItem('nabiView', mobile ? 'mobile' : 'desktop'); } catch (e) {}
    document.querySelectorAll('.view-toggle-btn').forEach(function (b) {
      b.classList.toggle('active', /mobile/i.test(b.textContent) === mobile);
    });
    // 페이지 내 토글(setPreview)로 바뀌는 것도 세션에 반영 → 다음 이동까지 유지
    try {
      new MutationObserver(function () {
        try { sessionStorage.setItem('nabiView', document.body.classList.contains('preview-mobile') ? 'mobile' : 'desktop'); } catch (e) {}
      }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    } catch (e) {}
  }
  function byKey(k) { return ITEMS.filter(function (i) { return i.key === k; })[0]; }

  function linksHTML() {
    return ITEMS.map(function (it) {
      return '<button class="app-bar-link' + (it.key === active ? ' active' : '') + '" data-k="' + it.key + '">' + it.label + '</button>';
    }).join('');
  }
  function drawerInnerHTML() {
    return '<div class="nav-drawer-head"><div class="app-bar-logo-icon">N</div> NABI</div>' +
      ITEMS.map(function (it) {
        return '<a class="nav-drawer-item' + (it.key === active ? ' active' : '') + '" data-k="' + it.key + '"><span class="nav-drawer-ico">' + it.ico + '</span> ' + it.label + '</a>';
      }).join('');
  }
  function userHTML(withName) {
    var av = '<div class="app-bar-avatar nb-av">' + (user.avatar || '·') + '</div>';
    if (!withName) return av;
    return '<div class="app-bar-user">' + av + ' <span class="nb-uname">' + (user.name || '') + '</span></div>';
  }
  function barInnerHTML(withName) {
    return '<button class="hamburger" data-ham aria-label="메뉴"><span></span><span></span><span></span></button>' +
      '<div class="app-bar-logo" data-home><div class="app-bar-logo-icon">N</div> NABI</div>' +
      '<nav class="app-bar-menu">' + linksHTML() + '</nav>' +
      '<div class="app-bar-right">' + userHTML(withName) + '</div>';
  }

  function wire(bar, drawer, scrim) {
    bar.querySelector('[data-home]').onclick = homeGo;
    bar.querySelectorAll('.app-bar-link').forEach(function (b) {
      b.onclick = function () { go(byKey(b.getAttribute('data-k'))); };
    });
    bar.querySelector('[data-ham]').onclick = function () { scrim.classList.add('open'); drawer.classList.add('open'); };
    drawer.querySelectorAll('.nav-drawer-item').forEach(function (a) {
      a.onclick = function () { go(byKey(a.getAttribute('data-k'))); };
    });
    scrim.onclick = function () { scrim.classList.remove('open'); drawer.classList.remove('open'); };
  }

  function makeDrawer(fixed) {
    var scrim = document.createElement('div');
    scrim.className = 'nav-drawer-scrim' + (fixed ? ' fixed' : '');
    var drawer = document.createElement('nav');
    drawer.className = 'nav-drawer' + (fixed ? ' fixed' : '');
    drawer.innerHTML = drawerInnerHTML();
    return { scrim: scrim, drawer: drawer };
  }

  // ── NEW: 단일 셸(.app-shell)에 app-bar 1개 + 드로어 1개 주입 ──
  // .app-shell 은 container-type 으로 절대위치 자식의 containing block 이 되므로
  // 드로어/스크림(absolute inset:0)이 셸에 자동 앵커된다.
  function buildShell(shell) {
    var bar = document.createElement('header');
    bar.className = 'app-bar';
    bar.innerHTML = barInnerHTML(true);
    var d = makeDrawer(false);
    shell.insertBefore(bar, shell.firstChild);
    shell.appendChild(d.scrim);
    shell.appendChild(d.drawer);
    wire(bar, d.drawer, d.scrim);
  }

  function build() {
    syncPreview();   // 모바일 프리뷰 상태 복원/유지 (페이지 이동 시 데스크톱 점프 방지)
    // 신규 표준: .app-shell 이 있으면 단일 마운트만 하고 종료
    var shell = document.querySelector('.app-shell');
    if (shell) { buildShell(shell); return; }

    // ── LEGACY: .phone-frame + body .dk-only 이중 주입 (미전환 페이지) ──
    // ── MOBILE: .phone-frame 안에 주입 ──
    var phone = document.querySelector('.phone-frame');
    if (phone) {
      phone.classList.add('has-app-bar');
      var mBar = document.createElement('header');
      mBar.className = 'app-bar';
      mBar.innerHTML = barInnerHTML(false);
      var md = makeDrawer(false);
      phone.insertBefore(md.drawer, phone.firstChild);
      phone.insertBefore(md.scrim, phone.firstChild);
      phone.insertBefore(mBar, phone.firstChild);
      wire(mBar, md.drawer, md.scrim);
    }
    // ── DESKTOP: <body> 최상단 앱바(.dk-only) + 고정 드로어 ──
    var dBar = document.createElement('header');
    dBar.className = 'app-bar dk-only';
    dBar.innerHTML = barInnerHTML(true);
    var dd = makeDrawer(true);
    document.body.insertBefore(dBar, document.body.firstChild);
    document.body.appendChild(dd.scrim);
    document.body.appendChild(dd.drawer);
    wire(dBar, dd.drawer, dd.scrim);
  }

  // 역할/유저 변경 시 주입된 아바타·이름 갱신
  window.__nabiSetUser = function (name, avatar) {
    document.querySelectorAll('.nb-av').forEach(function (a) { a.textContent = avatar || '·'; });
    document.querySelectorAll('.nb-uname').forEach(function (s) { s.textContent = name || ''; });
  };
  window.__nabiHome = homeGo;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
