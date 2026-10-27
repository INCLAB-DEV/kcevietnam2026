/* ============================================================================
   NABI 미팅 신청 모달 — 공유 컴포넌트 (단일 소스)
   ----------------------------------------------------------------------------
   여러 페이지(discover·company-detail 등)에서 호출하는 풍부한 미팅 신청 플로.
   플로: ① 시간 선택(선점 슬롯 표시) → ② 장소 선택(테이블/룸 서브 선택) → ③ 확인+AI 메시지

   사용:
     <script src="nabi-meeting.js?v=…"></script>
     NABI_MEETING.open({ name:'한화에어로스페이스', booth:'A-101', matchScore:94, logo:'한' });

   동작:
     · .app-shell 이 있으면 그 안에 주입(모바일=바텀시트 / 데스크톱=중앙 다이얼로그, 컨테이너 쿼리).
       없으면 body 에 주입(@media 폴백).
     · 자체 스코프 CSS(.nbm-*) 1회 주입 → 페이지 기존 스타일과 충돌 없음.
     · 데모용 mock 데이터(날짜별 선점 슬롯). onSubmit 콜백으로 결과 전달 가능.
   ============================================================================ */
(function () {
  // ───────── 데모 데이터 ─────────
  var DATES = [
    { day: '화', num: '9/16' },
    { day: '수', num: '9/17' },
    { day: '목', num: '9/18' },
    { day: '금', num: '9/19' },
  ];
  var AM = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30'];
  var PM = ['12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30'];
  var ALL = AM.concat(PM);            // 30분 그리드(연속 인덱스)
  var MAX_BLOCKS = 4;                 // 최대 2시간 = 30분 × 4

  function addMin(t, m) {             // "HH:MM" + 분
    var p = t.split(':'), tot = (+p[0]) * 60 + (+p[1]) + m;
    var h = Math.floor(tot / 60), mm = tot % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
  }
  function durLabel(blocks) {         // 블록 수 → "1시간 30분"
    var mins = blocks * 30, h = Math.floor(mins / 60), m = mins % 60;
    return (h ? h + '시간' : '') + (h && m ? ' ' : '') + (m ? m + '분' : '');
  }
  // 날짜별 "선점(일정 겹침)" 시간 — 양쪽 중 누구든 잡혀있는 시간
  var TAKEN = {
    0: ['09:30', '10:30', '12:00', '12:30', '14:00', '15:30', '17:00'],
    1: ['09:00', '10:00', '11:30', '13:30', '14:30', '15:00', '16:30', '17:00', '17:30'],
    2: ['09:30', '11:00', '12:30', '13:00', '15:30', '16:00'],
    3: ['09:00', '09:30', '10:00', '10:30', '11:00', '12:00', '12:30', '13:30', '14:00', '15:00', '16:00', '16:30', '17:00'],
  };
  function freeCount(di) {
    var taken = TAKEN[di] || [];
    return ALL.filter(function (t) { return taken.indexOf(t) < 0; }).length;
  }

  // 장소 — 일부는 서브(테이블/룸) 선택 필요
  function venues(c) {
    return [
      { key: 'booth', icon: '🏢', cls: 'booth', name: '상대방 부스', desc: c.booth + ' · ' + c.name + ' 부스에서 직접 미팅', avail: '가능', availCls: 'open' },
      { key: 'matching', icon: '🤝', cls: 'matching', name: '비즈매칭존 테이블', desc: '2층 비즈매칭존 · 주최측 지정 테이블', avail: '가능', availCls: 'open',
        subLabel: '테이블 선택', sub: [{ n: 'T-01' }, { n: 'T-02' }, { n: 'T-03', un: true }, { n: 'T-04' }, { n: 'T-05' }, { n: 'T-06', un: true }] },
      { key: 'business', icon: '🚪', cls: 'business', name: '비즈니스 룸', desc: '3층 프라이빗 회의실 · 사전 예약 필요', avail: '잔여 2석', availCls: 'limited',
        subLabel: '룸 선택', sub: [{ n: 'Room A', un: true }, { n: 'Room B' }, { n: 'Room C' }, { n: 'Room D', un: true }] },
    ];
  }

  // ───────── 상태 ─────────
  // 시간은 구간 선택: selStart~selEnd (ALL 인덱스), awaitingEnd=다음 탭이 종료시간
  var company = null, dateIdx = 0, selStart = null, selEnd = null, awaitingEnd = false,
      venue = null, subVenue = null, step = 1, onSubmit = null;
  var root = null; // 주입된 모달 루트

  function selText() {                // 현재 시간 구간 텍스트
    if (selStart == null) return null;
    var blocks = selEnd - selStart + 1;
    return { range: ALL[selStart] + '–' + addMin(ALL[selEnd], 30), dur: durLabel(blocks), blocks: blocks };
  }
  // 시작/종료 탭 — 연속·가용·최대 2시간 검증
  function pickSlot(idx) {
    if (selStart == null || !awaitingEnd) { selStart = selEnd = idx; awaitingEnd = true; render(true); return; }
    var lo = Math.min(selStart, idx), hi = Math.max(selStart, idx), taken = TAKEN[dateIdx] || [], ok = (hi - lo + 1) <= MAX_BLOCKS;
    for (var i = lo; i <= hi && ok; i++) { if (taken.indexOf(ALL[i]) >= 0) ok = false; }
    if (ok) { selStart = lo; selEnd = hi; awaitingEnd = false; } // 구간 확정
    else { selStart = selEnd = idx; awaitingEnd = true; }         // 무효 → 새 시작
    render(true);
  }

  // ───────── CSS (1회 주입, .nbm- 스코프) ─────────
  var CSS = [
    '.nbm-overlay{position:absolute;inset:0;background:rgba(8,9,10,.45);z-index:200;display:none;}',
    '.nbm-overlay.nbm-show{display:block;}',
    /* 시트: 모바일=하단, 데스크톱=중앙(컨테이너 쿼리는 아래) */
    '.nbm-sheet{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;background:var(--bg-elevated);border-radius:20px 20px 0 0;max-height:88%;z-index:201;box-shadow:0 -4px 24px rgba(0,0,0,.14);transform:translateY(100%);transition:transform .32s cubic-bezier(.32,.72,0,1);font-family:var(--font-sans,var(--font-stack));}',
    '.nbm-overlay.nbm-show .nbm-sheet{transform:translateY(0);}',
    '.nbm-handle{width:36px;height:4px;background:#d4d1cd;border-radius:2px;margin:10px auto 6px;flex-shrink:0;}',
    '.nbm-head{padding:6px 20px 12px;border-bottom:1px solid var(--border-default);flex-shrink:0;}',
    '.nbm-head-row{display:flex;align-items:center;justify-content:space-between;}',
    '.nbm-title{font-size:17px;font-weight:800;}',
    '.nbm-close{width:30px;height:30px;border:none;background:var(--bg-secondary);border-radius:50%;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;}',
    '.nbm-steps{display:flex;gap:6px;margin-top:12px;}',
    '.nbm-step{flex:1;height:3px;border-radius:2px;background:var(--border-default);}',
    '.nbm-step.cur{background:var(--accent-primary);}',
    '.nbm-target{display:flex;align-items:center;gap:12px;padding:14px 20px 0;flex-shrink:0;}',
    '.nbm-avatar{width:44px;height:44px;border-radius:var(--radius-md);background:var(--accent-subtle);color:var(--accent-primary);display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:800;flex-shrink:0;}',
    '.nbm-tname{font-size:15px;font-weight:700;}',
    '.nbm-tmeta{font-size:12px;color:var(--text-tertiary);margin-top:2px;}',
    '.nbm-body{flex:1;overflow-y:auto;padding:16px 20px;min-height:0;}',
    /* 날짜 */
    '.nbm-dates{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;margin-bottom:16px;}',
    '.nbm-date{min-width:70px;padding:10px 14px;border:1.5px solid var(--border-default);border-radius:var(--radius-md);background:var(--bg-elevated);cursor:pointer;text-align:center;flex-shrink:0;font-family:inherit;transition:all .15s;}',
    '.nbm-date:hover{border-color:var(--accent-primary);}',
    '.nbm-date.sel{border-color:var(--accent-primary);background:var(--accent-subtle);}',
    '.nbm-date .d{font-size:11px;color:var(--text-tertiary);font-weight:600;}',
    '.nbm-date .n{font-size:16px;font-weight:800;margin-top:1px;}',
    '.nbm-date .s{font-size:10px;color:var(--accent-green);font-weight:600;margin-top:2px;}',
    /* 슬롯 */
    '.nbm-slot-label{font-size:12px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.5px;margin:4px 0 10px;}',
    '.nbm-slot-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px;}',
    '.nbm-slot{padding:10px 4px;border:1.5px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-elevated);text-align:center;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s;}',
    '.nbm-slot:hover{border-color:var(--accent-primary);}',
    '.nbm-slot.sel{border-color:var(--accent-primary);background:var(--accent-primary);color:#fff;}',
    '.nbm-slot.taken{opacity:.35;cursor:not-allowed;pointer-events:none;text-decoration:line-through;}',
    '.nbm-legend{display:flex;gap:16px;font-size:11px;color:var(--text-tertiary);margin-top:4px;}',
    '.nbm-legend-item{display:flex;align-items:center;gap:5px;}',
    '.nbm-dot{width:8px;height:8px;border-radius:50%;}',
    '.nbm-dot.free{background:var(--accent-primary);}',
    '.nbm-dot.busy{background:var(--border-default);}',
    '.nbm-dur{margin-top:12px;padding:10px 12px;border-radius:var(--radius-sm);background:var(--accent-subtle);color:var(--accent-primary);font-size:13px;font-weight:600;line-height:1.4;}',
    '.nbm-dur b{font-weight:800;}',
    '.nbm-dur-hint{background:var(--bg-secondary);color:var(--text-tertiary);font-weight:500;}',
    /* 장소 */
    '.nbm-hint{font-size:13px;color:var(--text-tertiary);line-height:1.4;margin-bottom:12px;}',
    '.nbm-venue{display:flex;align-items:center;gap:14px;padding:16px;border:1.5px solid var(--border-default);border-radius:var(--radius-md);background:var(--bg-elevated);cursor:pointer;transition:all .15s;}',
    '.nbm-venue:hover{border-color:var(--accent-primary);background:var(--accent-subtle);}',
    '.nbm-venue.sel{border-color:var(--accent-primary);background:var(--accent-subtle);}',
    '.nbm-venue-icon{width:44px;height:44px;border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;}',
    '.nbm-venue-icon.booth{background:#dbeafe;}.nbm-venue-icon.matching{background:#dcfce7;}.nbm-venue-icon.business{background:#fef3c7;}',
    '.nbm-venue-info{flex:1;}',
    '.nbm-venue-name{font-size:15px;font-weight:700;margin-bottom:2px;}',
    '.nbm-venue-desc{font-size:12px;color:var(--text-tertiary);line-height:1.4;}',
    '.nbm-avail{font-size:11px;font-weight:600;padding:3px 8px;border-radius:var(--radius-full);flex-shrink:0;}',
    '.nbm-avail.open{background:var(--accent-green-subtle);color:var(--accent-green);}',
    '.nbm-avail.limited{background:#fff7ed;color:var(--accent-amber);}',
    '.nbm-check{width:22px;height:22px;border-radius:50%;border:2px solid var(--border-default);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:transparent;transition:all .15s;}',
    '.nbm-venue.sel .nbm-check{border-color:var(--accent-primary);background:var(--accent-primary);color:#fff;}',
    /* 서브(테이블/룸) — 선택된 장소 바로 아래만 노출 */
    '.nbm-sub{display:none;padding:10px 0 4px 58px;}',
    '.nbm-venue.sel + .nbm-sub{display:block;}',
    '.nbm-sub-label{font-size:12px;font-weight:600;color:var(--text-tertiary);margin-bottom:8px;}',
    '.nbm-sub-grid{display:flex;flex-wrap:wrap;gap:6px;}',
    '.nbm-chip{padding:8px 14px;border:1.5px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-elevated);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s;}',
    '.nbm-chip:hover{border-color:var(--accent-primary);}',
    '.nbm-chip.sel{border-color:var(--accent-primary);background:var(--accent-primary);color:#fff;}',
    '.nbm-chip.un{opacity:.3;cursor:not-allowed;pointer-events:none;text-decoration:line-through;}',
    '.nbm-venue-row{display:flex;flex-direction:column;gap:0;}',
    '.nbm-venue-row .nbm-venue{margin-bottom:0;}',
    '.nbm-venue-wrap + .nbm-venue-wrap{margin-top:10px;}',
    /* 확인 */
    '.nbm-summary{background:var(--bg-secondary);border-radius:var(--radius-md);padding:6px 16px;margin-bottom:18px;}',
    '.nbm-srow{display:flex;justify-content:space-between;align-items:center;padding:9px 0;font-size:14px;}',
    '.nbm-srow + .nbm-srow{border-top:1px solid var(--border-default);}',
    '.nbm-slabel{color:var(--text-tertiary);font-weight:600;}',
    '.nbm-sval{font-weight:700;text-align:right;}',
    '.nbm-msg-label{font-size:14px;font-weight:700;margin-bottom:8px;display:flex;align-items:center;gap:6px;}',
    '.nbm-ai-badge{font-size:10px;font-weight:700;padding:2px 8px;background:var(--accent-primary);color:#fff;border-radius:var(--radius-full);}',
    '.nbm-textarea{width:100%;min-height:100px;padding:14px;border:1.5px solid var(--border-default);border-radius:var(--radius-md);font-family:inherit;font-size:14px;line-height:1.6;resize:vertical;color:var(--text-primary);background:var(--bg-elevated);box-sizing:border-box;}',
    '.nbm-textarea:focus{outline:none;border-color:var(--accent-primary);}',
    /* 푸터 */
    '.nbm-foot{padding:14px 20px 22px;border-top:1px solid var(--border-default);flex-shrink:0;display:flex;gap:10px;}',
    '.nbm-btn{flex:1;padding:15px;border:none;border-radius:var(--radius-md);font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;}',
    '.nbm-btn-ghost{flex:0 0 auto;padding:15px 18px;background:var(--bg-secondary);color:var(--text-secondary);}',
    '.nbm-btn-primary{background:var(--accent-primary);color:#fff;}',
    '.nbm-btn-primary:disabled{opacity:.4;cursor:not-allowed;}',
    /* 완료 */
    '.nbm-sent{display:none;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:48px 24px;flex:1;}',
    '.nbm-sent.nbm-show{display:flex;}',
    '.nbm-sent-icon{font-size:52px;margin-bottom:16px;}',
    '.nbm-sent-title{font-size:19px;font-weight:800;margin-bottom:8px;}',
    '.nbm-sent-desc{font-size:14px;color:var(--text-secondary);line-height:1.6;}',
    /* 데스크톱(≥720cqi 또는 ≥720px): 바텀시트 → 중앙 다이얼로그 */
    '@container shell (min-width:720px){',
    '  .nbm-sheet{top:50%;bottom:auto;left:50%;right:auto;width:100%;max-width:480px;max-height:86%;border-radius:var(--radius-lg);transform:translate(-50%,-50%) scale(.96);box-shadow:0 24px 64px rgba(0,0,0,.24);}',
    '  .nbm-overlay.nbm-show .nbm-sheet{transform:translate(-50%,-50%) scale(1);}',
    '}',
  ].join('\n');

  // body 에 붙는 경우(.app-shell 없음) 뷰포트 @media 폴백
  var CSS_FALLBACK = [
    '@media (min-width:720px){',
    '  body > .nbm-overlay .nbm-sheet{top:50%;bottom:auto;left:50%;right:auto;width:100%;max-width:480px;max-height:86%;border-radius:var(--radius-lg);transform:translate(-50%,-50%) scale(.96);box-shadow:0 24px 64px rgba(0,0,0,.24);}',
    '  body > .nbm-overlay.nbm-show .nbm-sheet{transform:translate(-50%,-50%) scale(1);}',
    '}',
  ].join('\n');

  function injectCSS() {
    if (document.getElementById('nbm-style')) return;
    var s = document.createElement('style');
    s.id = 'nbm-style';
    s.textContent = CSS + '\n' + CSS_FALLBACK;
    document.head.appendChild(s);
  }

  // ───────── 렌더 ─────────
  function esc(t) { return String(t == null ? '' : t); }

  function slotGridHTML(times) {
    var taken = TAKEN[dateIdx] || [];
    return times.map(function (t) {
      var idx = ALL.indexOf(t);
      var isTaken = taken.indexOf(t) >= 0;
      var inRange = selStart != null && idx >= selStart && idx <= selEnd;
      var cls = isTaken ? ' taken' : (inRange ? ' sel' : '');
      return '<div class="nbm-slot' + cls + '"' + (isTaken ? '' : ' data-idx="' + idx + '"') + '>' + t + '</div>';
    }).join('');
  }

  function durBarHTML() {
    var s = selText();
    if (!s) return '<div class="nbm-dur nbm-dur-hint">시작 시간을 누르고, 종료 시간을 한 번 더 누르면 구간이 선택됩니다 · 최대 2시간</div>';
    var more = s.blocks < MAX_BLOCKS ? ' · 종료 시간을 눌러 연장 가능' : ' · 최대 2시간';
    return '<div class="nbm-dur"><b>' + s.range + '</b> · ' + s.dur + more + '</div>';
  }

  function timeStepHTML() {
    return '' +
      '<div class="nbm-dates">' + DATES.map(function (d, i) {
        return '<div class="nbm-date' + (i === dateIdx ? ' sel' : '') + '" data-date="' + i + '">' +
          '<div class="d">' + d.day + '</div><div class="n">' + d.num + '</div>' +
          '<div class="s">' + freeCount(i) + ' 슬롯</div></div>';
      }).join('') + '</div>' +
      '<div class="nbm-slot-label">오전</div><div class="nbm-slot-grid">' + slotGridHTML(AM) + '</div>' +
      '<div class="nbm-slot-label">오후</div><div class="nbm-slot-grid">' + slotGridHTML(PM) + '</div>' +
      '<div class="nbm-legend"><div class="nbm-legend-item"><div class="nbm-dot free"></div> 양쪽 모두 가능</div>' +
      '<div class="nbm-legend-item"><div class="nbm-dot busy"></div> 일정 겹침</div></div>' +
      durBarHTML();
  }

  function venueStepHTML() {
    var st = selText();
    return '<div class="nbm-hint">선택한 시간(' + DATES[dateIdx].num + ' ' + (st ? st.range : '') + ')에 이용 가능한 장소입니다.</div>' +
      venues(company).map(function (v) {
        var sel = venue === v.key ? ' sel' : '';
        var card = '<div class="nbm-venue' + sel + '" data-venue="' + v.key + '">' +
          '<div class="nbm-venue-icon ' + v.cls + '">' + v.icon + '</div>' +
          '<div class="nbm-venue-info"><div class="nbm-venue-name">' + v.name + '</div>' +
          '<div class="nbm-venue-desc">' + v.desc + '</div></div>' +
          '<span class="nbm-avail ' + v.availCls + '">' + v.avail + '</span>' +
          '<div class="nbm-check">✓</div></div>';
        var sub = '';
        if (v.sub) {
          sub = '<div class="nbm-sub"><div class="nbm-sub-label">' + v.subLabel + '</div><div class="nbm-sub-grid">' +
            v.sub.map(function (s) {
              if (s.un) return '<div class="nbm-chip un">' + s.n + '</div>';
              return '<div class="nbm-chip' + (subVenue === s.n ? ' sel' : '') + '" data-sub="' + s.n + '">' + s.n + '</div>';
            }).join('') + '</div></div>';
        }
        return '<div class="nbm-venue-wrap">' + card + sub + '</div>';
      }).join('');
  }

  function venueLabel() {
    var v = venues(company).filter(function (x) { return x.key === venue; })[0];
    if (!v) return '-';
    return v.name + (subVenue ? ' · ' + subVenue : '');
  }

  function confirmStepHTML() {
    var st = selText() || { range: '', dur: '' };
    var msg = 'AI가 ' + company.name + ' 담당자에게 보낼 메시지를 준비했습니다.\n\n안녕하세요, ' + company.name +
      '님. 귀사의 전시 품목에 깊은 관심이 있어 미팅을 신청드립니다. ' + DATES[dateIdx].num + ' ' + st.range +
      ' (' + st.dur + ') ' + venueLabel() + '에서 뵙고 협력 가능성을 논의하고 싶습니다.';
    return '<div class="nbm-summary">' +
      '<div class="nbm-srow"><span class="nbm-slabel">상대</span><span class="nbm-sval">' + company.name + '</span></div>' +
      '<div class="nbm-srow"><span class="nbm-slabel">일시</span><span class="nbm-sval">' + DATES[dateIdx].day + ' ' + DATES[dateIdx].num + ' · ' + st.range + '</span></div>' +
      '<div class="nbm-srow"><span class="nbm-slabel">소요</span><span class="nbm-sval">' + st.dur + '</span></div>' +
      '<div class="nbm-srow"><span class="nbm-slabel">장소</span><span class="nbm-sval">' + venueLabel() + '</span></div>' +
      '</div>' +
      '<div class="nbm-msg-label">미팅 메시지 <span class="nbm-ai-badge">AI 초안</span></div>' +
      '<textarea class="nbm-textarea" id="nbm-msg">' + msg + '</textarea>';
  }

  var TITLES = { 1: '시간 선택', 2: '장소 선택', 3: '확인 및 신청' };

  function footHTML() {
    if (step === 1) return '<button class="nbm-btn nbm-btn-primary" id="nbm-next" disabled>다음</button>';
    if (step === 2) return '<button class="nbm-btn nbm-btn-ghost" id="nbm-back">이전</button>' +
      '<button class="nbm-btn nbm-btn-primary" id="nbm-next" disabled>다음</button>';
    return '<button class="nbm-btn nbm-btn-ghost" id="nbm-back">이전</button>' +
      '<button class="nbm-btn nbm-btn-primary" id="nbm-submit">미팅 신청하기</button>';
  }

  function stepComplete() {
    if (step === 1) return selStart != null;
    if (step === 2) {
      if (!venue) return false;
      var v = venues(company).filter(function (x) { return x.key === venue; })[0];
      if (v && v.sub) return !!subVenue;  // 서브 선택 필요한 장소
      return true;
    }
    return true;
  }

  // keepScroll: 같은 단계 내 재렌더(슬롯/장소 선택)는 스크롤 위치 유지 → 자동으로 위로 안 튐.
  // 단계 이동(다음/이전)·오픈은 위에서 시작.
  function render(keepScroll) {
    var bodyEl = root.querySelector('.nbm-body');
    var sc = keepScroll ? bodyEl.scrollTop : 0;
    var body = step === 1 ? timeStepHTML() : step === 2 ? venueStepHTML() : confirmStepHTML();
    root.querySelector('.nbm-title').textContent = TITLES[step];
    for (var i = 1; i <= 3; i++) root.querySelector('#nbm-s' + i).classList.toggle('cur', i <= step);
    bodyEl.innerHTML = body;
    bodyEl.scrollTop = sc;
    root.querySelector('.nbm-foot').innerHTML = footHTML();
    wireStep();
    var next = root.querySelector('#nbm-next');
    if (next) next.disabled = !stepComplete();
  }

  function wireStep() {
    root.querySelectorAll('.nbm-date').forEach(function (el) {
      el.onclick = function () { dateIdx = +el.getAttribute('data-date'); selStart = selEnd = null; awaitingEnd = false; render(true); };
    });
    root.querySelectorAll('.nbm-slot[data-idx]').forEach(function (el) {
      el.onclick = function () { pickSlot(+el.getAttribute('data-idx')); };
    });
    root.querySelectorAll('.nbm-venue').forEach(function (el) {
      el.onclick = function () { venue = el.getAttribute('data-venue'); subVenue = null; render(true); };
    });
    root.querySelectorAll('.nbm-chip[data-sub]').forEach(function (el) {
      el.onclick = function () { subVenue = el.getAttribute('data-sub'); render(true); };
    });
    var back = root.querySelector('#nbm-back');
    if (back) back.onclick = function () { step--; render(); };
    var next = root.querySelector('#nbm-next');
    if (next) next.onclick = function () { if (stepComplete()) { step++; render(); } };
    var submit = root.querySelector('#nbm-submit');
    if (submit) submit.onclick = doSubmit;
  }

  function doSubmit() {
    var st = selText() || { range: '', dur: '' };
    var result = { company: company, date: DATES[dateIdx].num, day: DATES[dateIdx].day,
      time: st.range, duration: st.dur, venue: venueLabel(),
      message: (root.querySelector('#nbm-msg') || {}).value };
    root.querySelector('.nbm-body').style.display = 'none';
    root.querySelector('.nbm-foot').style.display = 'none';
    root.querySelector('.nbm-head').style.display = 'none';
    root.querySelector('.nbm-target').style.display = 'none';
    var sent = root.querySelector('.nbm-sent');
    sent.innerHTML = '<div class="nbm-sent-icon">✓</div><div class="nbm-sent-title">미팅 신청 완료</div>' +
      '<div class="nbm-sent-desc">' + company.name + '에 신청을 보냈습니다.<br>' + DATES[dateIdx].num + ' ' + st.range + ' (' + st.dur + ') · ' + venueLabel() + '<br>상대가 수락하면 알려드릴게요.</div>';
    sent.classList.add('nbm-show');
    if (typeof onSubmit === 'function') { try { onSubmit(result); } catch (e) {} }
    setTimeout(close, 1800);
  }

  // ───────── 빌드/오픈/클로즈 ─────────
  function build() {
    injectCSS();
    var host = document.querySelector('.app-shell') || document.body;
    var ov = document.createElement('div');
    ov.className = 'nbm-overlay';
    ov.innerHTML =
      '<div class="nbm-sheet" role="dialog" aria-modal="true">' +
      '  <div class="nbm-handle"></div>' +
      '  <div class="nbm-head"><div class="nbm-head-row"><div class="nbm-title">시간 선택</div>' +
      '    <button class="nbm-close" aria-label="닫기">✕</button></div>' +
      '    <div class="nbm-steps"><div class="nbm-step cur" id="nbm-s1"></div><div class="nbm-step" id="nbm-s2"></div><div class="nbm-step" id="nbm-s3"></div></div></div>' +
      '  <div class="nbm-target"><div class="nbm-avatar" id="nbm-av">·</div><div><div class="nbm-tname" id="nbm-tn"></div><div class="nbm-tmeta" id="nbm-tm"></div></div></div>' +
      '  <div class="nbm-body"></div>' +
      '  <div class="nbm-sent"></div>' +
      '  <div class="nbm-foot"></div>' +
      '</div>';
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelector('.nbm-close').onclick = close;
    host.appendChild(ov);
    root = ov;
  }

  function open(c, opts) {
    if (!root) build();
    company = c || {};
    opts = opts || {};
    onSubmit = opts.onSubmit || null;
    dateIdx = 0; selStart = selEnd = null; awaitingEnd = false; venue = null; subVenue = null; step = 1;
    root.querySelector('#nbm-tn').textContent = company.name || '';
    root.querySelector('#nbm-tm').textContent = (company.booth ? company.booth + ' · ' : '') + (company.matchScore != null ? '적합도 ' + company.matchScore + '%' : '');
    root.querySelector('#nbm-av').textContent = company.logo || (company.name || '·').charAt(0);
    // 완료 화면 초기화
    var sent = root.querySelector('.nbm-sent'); sent.classList.remove('nbm-show'); sent.innerHTML = '';
    root.querySelector('.nbm-body').style.display = '';
    root.querySelector('.nbm-foot').style.display = '';
    root.querySelector('.nbm-head').style.display = '';
    root.querySelector('.nbm-target').style.display = '';
    render();
    // show (다음 프레임에 transition)
    root.classList.add('nbm-show');
  }

  function close() { if (root) root.classList.remove('nbm-show'); }

  window.NABI_MEETING = { open: open, close: close };
})();
