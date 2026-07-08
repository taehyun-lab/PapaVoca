/* ===== PapaVoca : app.js ===== */
(function(){
"use strict";

/* ---------- 저장소 헬퍼 ---------- */
const LS = {
  get(key, fallback){
    try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch(e){ return fallback; }
  },
  set(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){} }
};
const KEYS = {
  settings:'hgw_settings', learned:'hgw_learned', fav:'hgw_fav', wrong:'hgw_wrong',
  quiz:'hgw_quiz', days:'hgw_days', session:'hgw_today_session', dailyStats:'hgw_daily_stats',
  reviewMeta:'hgw_review_meta'
};
const REVIEW_INTERVALS = [1,3,7,14,30]; // 망각곡선 기반 복습 주기(일)

function todayStr(){
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function monthStr(){ return todayStr().slice(0,7); }

/* ---------- 상태 ---------- */
let DATA = null;          // words.json 원본
let ALL_WORDS = {};       // id -> word
let CATS = [];            // 카테고리 목록
let ORDERED = {basic:[], intermediate:[], advanced:[]}; // 레벨별 라운드로빈 id 순서

let settings = LS.get(KEYS.settings, {level:'basic', fontScale:'normal', rate:0.85, voiceURI:null});
let learned = new Set(LS.get(KEYS.learned, []));
let favs = new Set(LS.get(KEYS.fav, []));
let wrongs = LS.get(KEYS.wrong, []); // 배열(순서 유지)
let quizStats = LS.get(KEYS.quiz, {correct:0, total:0});
let daysProgress = LS.get(KEYS.days, {basic:{completed:[]}, intermediate:{completed:[]}, advanced:{completed:[]}});
let dailyStats = LS.get(KEYS.dailyStats, {}); // {date: count}
let reviewMeta = LS.get(KEYS.reviewMeta, {}); // {wordId: {stage, nextReviewAt, learnedAt}}

function saveAll(){
  LS.set(KEYS.settings, settings);
  LS.set(KEYS.learned, [...learned]);
  LS.set(KEYS.fav, [...favs]);
  LS.set(KEYS.wrong, wrongs);
  LS.set(KEYS.quiz, quizStats);
  LS.set(KEYS.days, daysProgress);
  LS.set(KEYS.dailyStats, dailyStats);
  LS.set(KEYS.reviewMeta, reviewMeta);
}

function ensureMeta(id, dueNow){
  if(!reviewMeta[id]){
    reviewMeta[id] = {
      stage:0,
      learnedAt: Date.now(),
      nextReviewAt: dueNow ? Date.now() : Date.now() + REVIEW_INTERVALS[0]*86400000
    };
  }
}
function migrateReviewMeta(){
  // 이전 버전 데이터(메타 없이 학습만 기록된 단어)는 즉시 복습 대상으로 편입
  let changed = false;
  learned.forEach(id=>{ if(!reviewMeta[id]){ ensureMeta(id, true); changed = true; } });
  if(changed) LS.set(KEYS.reviewMeta, reviewMeta);
}
function dueWords(){
  const now = Date.now();
  return [...learned].filter(id => reviewMeta[id] && reviewMeta[id].nextReviewAt <= now);
}
function updateReviewSchedule(id, correct){
  ensureMeta(id, false);
  const meta = reviewMeta[id];
  meta.stage = correct ? Math.min(meta.stage+1, REVIEW_INTERVALS.length-1) : 0;
  meta.nextReviewAt = Date.now() + REVIEW_INTERVALS[meta.stage]*86400000;
  LS.set(KEYS.reviewMeta, reviewMeta);
}

let session = LS.get(KEYS.session, null); // {level, day, wordIds, index, date, completed}

const STATE = {
  screen:'home',
  browseCat:null,
  detail:null,        // {wordId, back:'browse'|'today'|'fav'|'wrong'|'flash'}
  reviewTab:'quiz',
  quiz:null,           // active quiz session
  flash:null,          // {pool:[ids], index, flipped, source}
  dayPicker:false,
};

/* ---------- 데이터 로드 ---------- */
async function loadData(){
  const res = await fetch('data/words.json');
  DATA = await res.json();
  CATS = DATA.categories;
  CATS.forEach(cat=>{
    ['basic','intermediate','advanced'].forEach(lv=>{
      cat.levels[lv].forEach(w=>{ ALL_WORDS[w.id] = w; });
    });
  });
  ['basic','intermediate','advanced'].forEach(lv=>{
    const maxLen = Math.max(...CATS.map(c=>c.levels[lv].length));
    const arr = [];
    for(let i=0;i<maxLen;i++){
      CATS.forEach(cat=>{ if(cat.levels[lv][i]) arr.push(cat.levels[lv][i].id); });
    }
    ORDERED[lv] = arr;
  });
}

/* ---------- TTS ---------- */
let voicesReady = false, enVoices = [], enVoice = null, koVoice = null;

function pickVoices(){
  const voices = speechSynthesis.getVoices();
  if(!voices.length) return;

  enVoices = voices.filter(v=> v.lang && v.lang.startsWith('en'));

  const preferByName = (list, re) => list.find(v=>re.test(v.name));
  // 저장된 사용자 선택이 있으면 최우선
  if(settings.voiceURI){
    enVoice = voices.find(v=>v.voiceURI===settings.voiceURI) || null;
  }
  if(!enVoice){
    enVoice = preferByName(enVoices, /Premium|Enhanced|Neural/i)
          || preferByName(enVoices, /Samantha|Ava|Evan|Nathan|Siri|Google US/i)
          || enVoices.find(v=>v.lang==='en-US')
          || enVoices[0] || null;
  }
  const koVoices = voices.filter(v=> v.lang && v.lang.startsWith('ko'));
  koVoice = preferByName(koVoices, /Premium|Enhanced|Neural/i)
        || preferByName(koVoices, /Yuna|Sora|Google/i)
        || koVoices[0] || null;

  voicesReady = true;
}
if('speechSynthesis' in window){
  pickVoices();
  speechSynthesis.onvoiceschanged = ()=>{ pickVoices(); if(STATE.screen==='settings') render(); };
}

function speak(text, lang, onend){
  if(!('speechSynthesis' in window)){ onend && onend(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const isKo = lang.startsWith('ko');
  u.lang = lang;
  u.rate = isKo ? 0.95 : (settings.rate || 0.85);
  const v = isKo ? koVoice : enVoice;
  if(v) u.voice = v;
  if(onend) u.onend = onend;
  speechSynthesis.speak(u);
}
function chain(steps){
  // steps: [[text,lang], ...] 순서대로 이어서 발음, 각 사이 살짝 쉬는 시간
  let i = 0;
  function next(){
    if(i >= steps.length) return;
    const [text, lang] = steps[i++];
    speak(text, lang, ()=> setTimeout(next, 300));
  }
  next();
}
function speakWord(w){ speak(w.en, 'en-US'); }
function speakExample(w){ speak(w.example_en, 'en-US'); }
function speakAll(w){
  chain([[w.en,'en-US'], [w.ko,'ko-KR'], [w.example_en,'en-US'], [w.example_ko,'ko-KR']]);
}

/* ---------- 유틸 ---------- */
function el(id){ return document.getElementById(id); }
function shuffle(arr){ const a=[...arr]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function toast(msg){
  const t = el('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._h); toast._h = setTimeout(()=>t.classList.remove('show'), 1600);
}
function levelLabel(lv){ return {basic:'기본', intermediate:'중급', advanced:'심화'}[lv]; }
function maxDays(lv){ return Math.ceil(ORDERED[lv].length/20); }
function getDayWords(lv, day){ return ORDERED[lv].slice((day-1)*20, day*20); }
function nextDay(lv){
  const done = daysProgress[lv].completed;
  for(let d=1; d<=maxDays(lv); d++){ if(!done.includes(d)) return d; }
  return maxDays(lv); // 모두 완료 시 마지막 회차 재표시
}
function allDone(lv){ return daysProgress[lv].completed.length >= maxDays(lv); }
function alreadyDoneToday(lv){ return daysProgress[lv].lastDate === todayStr(); }

/* ---------- 렌더 라우터 ---------- */
function render(){
  el('topbar-title').textContent = STATE.screen==='home' ? 'PapaVoca' : ({
    browse:'단어장', review:'복습', stats:'학습 통계', settings:'설정', studying:'오늘의 학습'
  }[STATE.screen] || 'PapaVoca');
  el('topbar-sub').textContent = STATE.screen==='home' ? '한가한 갈매기를 위한 단어 학습장' : '';
  el('topbar-sub').style.display = STATE.screen==='home' ? 'block':'none';

  document.querySelectorAll('.nav-item').forEach(b=>{
    b.classList.toggle('active', b.dataset.nav===STATE.screen);
  });

  if(STATE.detail){ el('content').innerHTML = renderDetail(STATE.detail); return; }
  if(STATE.quiz){ el('content').innerHTML = renderQuiz(); return; }
  if(STATE.flash){ el('content').innerHTML = renderFlash(); return; }
  if(session && !session.completed && STATE.screen==='studying'){ el('content').innerHTML = renderStudy(); return; }

  let html = '';
  if(STATE.screen==='home') html = renderHome();
  else if(STATE.screen==='browse') html = renderBrowse();
  else if(STATE.screen==='review') html = renderReview();
  else if(STATE.screen==='stats') html = renderStats();
  else if(STATE.screen==='settings') html = renderSettings();
  el('content').innerHTML = html;
}

/* ---------- 홈 ---------- */
function renderHome(){
  const lv = settings.level;
  let banner = '';
  if(session && !session.completed){
    banner = `<div class="banner">
      <div class="msg">🌊 지난 학습을 이어서 하시겠습니까?<br><span style="color:#7a8794;font-size:13px;">${levelLabel(session.level)} · ${session.index}/${session.wordIds.length} 단어 진행됨</span></div>
    </div>
    <div class="btn-row" style="margin-bottom:16px;">
      <button class="big-btn small" data-action="resume-session">이어서 하기</button>
      <button class="big-btn small ghost" data-action="discard-session">새로 시작</button>
    </div>`;
  }

  const dueCount = dueWords().length;
  const dueBanner = dueCount > 0 ? `
    <div class="banner" style="background:var(--success-bg);">
      <div class="msg">🔔 오늘 복습할 단어가 <b>${dueCount}개</b> 있어요</div>
    </div>
    <button class="big-btn" style="margin-bottom:16px;" data-action="start-quiz" data-mode="en2ko" data-source="due">지금 복습하기</button>
  ` : '';

  const day = nextDay(lv);
  const done = allDone(lv);
  const doneToday = alreadyDoneToday(lv);
  const todayCount = dailyStats[todayStr()] || 0;

  const dayPickerBlock = STATE.dayPicker ? renderDayPicker(lv) : '';

  return `
    ${banner}
    ${dueBanner}
    <div class="card">
      <div class="level-pills">
        ${['basic','intermediate','advanced'].map(l=>`
          <div class="level-pill ${l===lv?'active':''}" data-action="set-level" data-level="${l}">${levelLabel(l)}</div>
        `).join('')}
      </div>
      <div style="text-align:center;">
        <div style="font-size:16px;color:#5c6b78;">${done ? '모든 회차를 학습했어요 🎉' : doneToday ? '오늘치 학습 완료 ✅' : `오늘의 학습 · ${day}회차`}</div>
        <div style="font-size:32px;font-weight:700;margin:6px 0 2px;">${todayCount} <span style="font-size:16px;color:#7a8794;">/ 20 단어</span></div>
      </div>
      <button class="big-btn" style="margin-top:14px;" data-action="start-today">오늘 학습 시작</button>
      <button class="big-btn ghost small" style="margin-top:10px;" data-action="toggle-day-picker">${STATE.dayPicker ? '회차 목록 닫기' : '다른 회차 선택'}</button>
      ${dayPickerBlock}
    </div>

    <div class="section-title">바로가기</div>
    <div class="btn-row">
      <button class="big-btn secondary" data-action="go-review">복습하기</button>
      <button class="big-btn secondary" data-action="go-fav">즐겨찾기</button>
    </div>
  `;
}

function renderDayPicker(lv){
  const n = maxDays(lv);
  let items = '';
  for(let d=1; d<=n; d++){
    const isDone = daysProgress[lv].completed.includes(d);
    const cnt = getDayWords(lv,d).length;
    items += `<div class="word-row" data-action="pick-day" data-day="${d}">
      <div class="en" style="font-size:17px;">${d}회차 <span style="color:#7a8794;font-size:13px;">(${cnt}단어)</span></div>
      <div>${isDone?'✅':'▶️'}</div>
    </div>`;
  }
  return `<div style="margin-top:14px;max-height:280px;overflow-y:auto;">${items}</div>`;
}

/* ---------- 오늘의 학습 진행 화면 ---------- */
function renderStudy(){
  const w = ALL_WORDS[session.wordIds[session.index]];
  const total = session.wordIds.length;
  const pct = Math.round(((session.index)/total)*100);
  const isLast = session.index === total-1;
  return `
    <div class="progress-wrap">
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%;"></div><div class="gull-marker" style="left:calc(${pct}% - 10px);">🕊️</div></div>
      <div class="progress-label">${session.index+1} / ${total} 단어 · ${levelLabel(session.level)}</div>
    </div>
    ${renderWordCard(w, true)}
    <div class="btn-row">
      <button class="big-btn ghost small" data-action="finish-today">오늘 학습 완료</button>
      <button class="big-btn small" data-action="next-word">${isLast ? '학습 완료하기' : '다음 단어'}</button>
    </div>
  `;
}

function renderWordCard(w, showSound){
  const isFav = favs.has(w.id);
  return `
    <div class="wordcard">
      <button class="star-btn ${isFav?'active':''}" style="float:right;" data-action="toggle-fav" data-id="${w.id}">${isFav?'★':'☆'}</button>
      <div class="en">${w.en}</div>
      <div class="pron">[${w.pron}]</div>
      <div class="ko">${w.ko}</div>
      <div class="example">
        <div>${w.example_en}</div>
        <div class="ex-ko">${w.example_ko}</div>
      </div>
      <div class="related">💡 함께 외우면 좋은 단어: <b>${w.related.en}</b> (${w.related.ko})</div>
      ${showSound !== false ? `
      <div class="sound-row">
        <button class="icon-btn" data-action="speak-word" data-id="${w.id}">🔊 단어 듣기</button>
        <button class="icon-btn" data-action="speak-example" data-id="${w.id}">🔊 예문 듣기</button>
      </div>
      <button class="big-btn secondary small" style="margin-top:10px;" data-action="speak-all" data-id="${w.id}">🔊 전체 듣기</button>
      ` : ''}
    </div>
  `;
}

/* ---------- 단어장(카테고리) ---------- */
function renderBrowse(){
  const lv = settings.level;
  if(!STATE.browseCat){
    return `
      <div class="level-pills">
        ${['basic','intermediate','advanced'].map(l=>`
          <div class="level-pill ${l===lv?'active':''}" data-action="set-level" data-level="${l}">${levelLabel(l)}</div>
        `).join('')}
      </div>
      <div class="cat-grid">
        ${CATS.map(cat=>`
          <div class="cat-tile" data-action="open-cat" data-cat="${cat.id}">
            <span class="icon">${cat.icon}</span>
            <div class="name">${cat.name}</div>
            <div class="count">${cat.levels[lv].length}개 단어</div>
          </div>
        `).join('')}
      </div>
    `;
  }
  const cat = CATS.find(c=>c.id===STATE.browseCat);
  const words = cat.levels[lv];
  return `
    <button class="icon-btn" data-action="back-to-cats" style="margin-bottom:14px;">← 카테고리 목록</button>
    <div class="section-title">${cat.icon} ${cat.name} · ${levelLabel(lv)}</div>
    ${words.map(w=>`
      <div class="word-row" data-action="open-detail" data-id="${w.id}" data-back="browse">
        <div style="flex:1;">
          <div class="en">${w.en}</div>
          <div class="ko">${w.ko}</div>
        </div>
        <button class="star-btn ${favs.has(w.id)?'active':''}" data-action="toggle-fav" data-id="${w.id}" data-stop="1">${favs.has(w.id)?'★':'☆'}</button>
      </div>
    `).join('')}
  `;
}

/* ---------- 단어 상세 ---------- */
function renderDetail(detail){
  const w = ALL_WORDS[detail.wordId];
  return `
    <button class="icon-btn" data-action="close-detail" style="margin-bottom:14px;">← 뒤로</button>
    ${renderWordCard(w, true)}
  `;
}

/* ---------- 복습 ---------- */
function renderReview(){
  const tabs = [['quiz','복습하기'],['fav','즐겨찾기'],['wrong','틀린 단어']];
  const tabRow = `<div class="tab-row">${tabs.map(([id,label])=>`
    <button class="tab-btn ${STATE.reviewTab===id?'active':''}" data-action="set-review-tab" data-tab="${id}">${label}</button>
  `).join('')}</div>`;

  if(STATE.reviewTab==='fav'){
    const list = [...favs];
    if(!list.length) return tabRow + emptyState('⭐','즐겨찾기한 단어가 없어요','단어 상세 화면에서 별 아이콘을 눌러보세요.');
    return tabRow + `
      <button class="big-btn" style="margin-bottom:14px;" data-action="start-flash" data-source="fav">즐겨찾기 전체 학습</button>
      ${list.map(id=>{const w=ALL_WORDS[id]; return `
        <div class="word-row" data-action="open-detail" data-id="${w.id}" data-back="fav">
          <div style="flex:1;"><div class="en">${w.en}</div><div class="ko">${w.ko}</div></div>
          <button class="star-btn active" data-action="toggle-fav" data-id="${w.id}" data-stop="1">★</button>
        </div>`;}).join('')}
    `;
  }
  if(STATE.reviewTab==='wrong'){
    if(!wrongs.length) return tabRow + emptyState('🙆','틀린 단어가 없어요','복습 퀴즈를 풀면 틀린 단어가 여기에 모여요.');
    return tabRow + `
      <button class="big-btn ghost small" style="margin-bottom:14px;" data-action="clear-wrong">틀린 단어 전체 삭제</button>
      ${wrongs.map(id=>{const w=ALL_WORDS[id]; if(!w) return ''; return `
        <div class="word-row" data-action="open-detail" data-id="${w.id}" data-back="wrong">
          <div style="flex:1;"><div class="en">${w.en}</div><div class="ko">${w.ko}</div></div>
          <button class="icon-btn" style="min-height:auto;padding:8px 12px;" data-action="remove-wrong" data-id="${w.id}" data-stop="1">삭제</button>
        </div>`;}).join('')}
    `;
  }
  // quiz tab
  const learnedCount = learned.size;
  if(!learnedCount) return tabRow + emptyState('📚','아직 학습한 단어가 없어요','오늘의 학습을 먼저 완료해보세요.');
  const acc = quizStats.total ? Math.round(quizStats.correct/quizStats.total*100) : 0;
  const dueCount = dueWords().length;
  return tabRow + `
    <div class="card">
      <div style="text-align:center;color:#5c6b78;">학습한 단어 <b style="color:var(--navy);">${learnedCount}</b>개 · 퀴즈 정답률 <b style="color:var(--navy);">${acc}%</b></div>
    </div>
    ${dueCount>0 ? `
    <div class="card" style="background:var(--success-bg);">
      <div style="text-align:center;font-weight:800;">🔔 오늘 복습할 단어 ${dueCount}개</div>
    </div>
    <button class="big-btn" style="margin-bottom:12px;" data-action="start-quiz" data-mode="en2ko" data-source="due">망각곡선 복습하기</button>
    ` : `<div class="card" style="text-align:center;color:#5c6b78;">오늘은 복습할 단어가 없어요 🌤️</div>`}
    <button class="big-btn secondary" style="margin-bottom:12px;" data-action="start-flash" data-source="learned">단어 보기 (플래시카드)</button>
    <button class="big-btn secondary" style="margin-bottom:12px;" data-action="start-quiz" data-mode="en2ko" data-source="all">뜻 맞추기 퀴즈 (전체)</button>
    <button class="big-btn secondary" data-action="start-quiz" data-mode="ko2en" data-source="all">객관식 퀴즈 (단어 맞추기, 전체)</button>
  `;
}

function emptyState(emoji, title, desc){
  return `<div class="empty-state"><span class="emoji">${emoji}</span><div style="font-size:18px;font-weight:700;color:var(--navy);">${title}</div><div style="margin-top:6px;">${desc}</div></div>`;
}

/* ---------- 플래시카드 ---------- */
function renderFlash(){
  const f = STATE.flash;
  const w = ALL_WORDS[f.pool[f.index]];
  const total = f.pool.length;
  return `
    <button class="icon-btn" data-action="close-flash" style="margin-bottom:14px;">← 목록으로</button>
    <div class="progress-label" style="margin-bottom:10px;">${f.index+1} / ${total}</div>
    ${renderWordCard(w, true)}
    <div class="btn-row">
      <button class="big-btn ghost small" data-action="flash-prev" ${f.index===0?'disabled':''}>이전</button>
      <button class="big-btn small" data-action="flash-next">${f.index===total-1?'마치기':'다음'}</button>
    </div>
  `;
}

/* ---------- 퀴즈 ---------- */
function buildQuizRound(mode, source){
  let pool;
  if(source==='wrong') pool = [...new Set(wrongs)];
  else if(source==='due') pool = dueWords();
  else pool = [...learned];
  pool = shuffle(pool).slice(0, Math.min(10, pool.length));
  const questions = pool.map(id=>{
    const w = ALL_WORDS[id];
    const others = shuffle([...learned].filter(x=>x!==id)).slice(0,3).map(x=>ALL_WORDS[x]);
    // 학습한 단어가 적을 때는 전체 단어에서 오답 채우기
    while(others.length < 3){
      const rand = ALL_WORDS[shuffle(Object.keys(ALL_WORDS)).find(x=>x!==id && !others.some(o=>o.id===x))];
      if(rand) others.push(rand); else break;
    }
    const correct = mode==='en2ko' ? w.ko : w.en;
    const optionPool = shuffle([correct, ...others.map(o=> mode==='en2ko'?o.ko:o.en)]);
    return {wordId:id, correct, options:optionPool};
  });
  return {mode, questions, index:0, correctCount:0, answered:false};
}
function renderQuiz(){
  const q = STATE.quiz;
  const cur = q.questions[q.index];
  const w = ALL_WORDS[cur.wordId];
  const prompt = q.mode==='en2ko' ? `<div class="en">${w.en}</div><div class="pron">[${w.pron}]</div>` : `<div class="ko" style="font-size:26px;">${w.ko}</div>`;
  return `
    <button class="icon-btn" data-action="close-quiz" style="margin-bottom:14px;">← 그만하기</button>
    <div class="progress-label">${q.index+1} / ${q.questions.length} 문제</div>
    <div class="wordcard" style="margin-top:10px;">${prompt}</div>
    <div class="quiz-options">
      ${cur.options.map(opt=>`
        <button class="quiz-opt" data-action="answer-quiz" data-opt="${encodeURIComponent(opt)}" ${q.answered?'disabled':''}>${opt}</button>
      `).join('')}
    </div>
  `;
}

/* ---------- 통계 ---------- */
function renderStats(){
  const total = learned.size;
  const todayCount = dailyStats[todayStr()] || 0;
  const mKey = monthStr();
  const monthCount = Object.entries(dailyStats).filter(([d])=>d.startsWith(mKey)).reduce((s,[,c])=>s+c,0);
  const acc = quizStats.total ? Math.round(quizStats.correct/quizStats.total*100) : 0;

  const catCounts = CATS.map(cat=>{
    const allIds = [...cat.levels.basic, ...cat.levels.intermediate, ...cat.levels.advanced].map(w=>w.id);
    const learnedInCat = allIds.filter(id=>learned.has(id)).length;
    return {name:cat.name, icon:cat.icon, learned:learnedInCat, total:allIds.length};
  });
  const top = catCounts.slice().sort((a,b)=>b.learned-a.learned)[0];

  return `
    <div class="stat-grid" style="margin-bottom:16px;">
      <div class="stat-box"><div class="num">${total}</div><div class="label">총 학습 단어</div></div>
      <div class="stat-box"><div class="num">${todayCount}</div><div class="label">오늘 학습</div></div>
      <div class="stat-box"><div class="num">${monthCount}</div><div class="label">이번 달 학습</div></div>
      <div class="stat-box"><div class="num">${acc}%</div><div class="label">퀴즈 정답률</div></div>
      <div class="stat-box"><div class="num">${favs.size}</div><div class="label">즐겨찾기</div></div>
      <div class="stat-box"><div class="num">${wrongs.length}</div><div class="label">틀린 단어</div></div>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:4px;">🏆 가장 많이 학습한 카테고리</div>
      <div style="color:#5c6b78;">${top && top.learned>0 ? `${top.icon} ${top.name} (${top.learned}개)` : '아직 없어요'}</div>
    </div>
    <div class="section-title">카테고리별 진행률</div>
    <div class="card">
      ${catCounts.map(c=>`
        <div class="bar-row">
          <div class="bar-label">${c.icon} ${c.name}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${c.total? (c.learned/c.total*100):0}%;"></div></div>
          <div class="bar-num">${c.learned}/${c.total}</div>
        </div>
      `).join('')}
    </div>
  `;
}

/* ---------- 설정 ---------- */
function renderSettings(){
  return `
    <div class="setting-row">
      <div><div class="label">난이도</div><div class="desc">오늘의 학습·단어장 기본 난이도</div></div>
      <div class="toggle-group">
        ${['basic','intermediate','advanced'].map(l=>`
          <button class="toggle-btn ${settings.level===l?'active':''}" data-action="set-level" data-level="${l}">${levelLabel(l)}</button>
        `).join('')}
      </div>
    </div>
    <div class="setting-row">
      <div><div class="label">글자 크기</div><div class="desc">화면 전체 글자 크기</div></div>
      <div class="toggle-group">
        ${[['normal','보통'],['large','크게'],['xlarge','아주 크게']].map(([id,label])=>`
          <button class="toggle-btn ${settings.fontScale===id?'active':''}" data-action="set-font" data-font="${id}">${label}</button>
        `).join('')}
      </div>
    </div>
    <div class="setting-row">
      <div><div class="label">음성 속도</div><div class="desc">단어·예문 읽어주는 속도</div></div>
      <div class="toggle-group">
        ${[[0.7,'천천히'],[0.85,'보통'],[1.0,'빠르게']].map(([r,label])=>`
          <button class="toggle-btn ${settings.rate===r?'active':''}" data-action="set-rate" data-rate="${r}">${label}</button>
        `).join('')}
      </div>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">🔊 영어 음성 선택</div>
      ${enVoices.length ? `
      <select id="voice-select" style="width:100%;padding:14px;border-radius:12px;border:1.5px solid var(--line);font-size:16px;background:var(--white);color:var(--text);">
        <option value="">자동 (기본 추천 음성)</option>
        ${enVoices.map(v=>`<option value="${v.voiceURI}" ${settings.voiceURI===v.voiceURI?'selected':''}>${v.name} (${v.lang})</option>`).join('')}
      </select>
      <button class="icon-btn" style="margin-top:10px;width:100%;" data-action="test-voice">🔊 선택한 음성으로 들어보기</button>
      ` : `<div style="color:#5c6b78;font-size:14px;">사용 가능한 음성 목록을 불러오는 중이에요. 잠시 후 다시 열어보세요.</div>`}
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:6px;">더 자연스러운 목소리를 원하신다면</div>
      <div style="color:#5c6b78;font-size:14px;line-height:1.6;">
        아이폰의 <b>설정 → 손쉬운 사용 → 음성 콘텐츠 → 음성</b>에서 영어(미국) 음성을
        "고급/향상된 품질"로 다운로드한 뒤, 위 목록에서 다시 선택해보세요. 무료 기능이고
        훨씬 자연스럽게 들려요.
      </div>
    </div>
    <button class="big-btn ghost" data-action="reset-data">학습 데이터 초기화</button>
  `;
}

/* ---------- 이벤트 처리 ---------- */
function markLearned(ids){
  let newCount = 0;
  ids.forEach(id=>{ if(!learned.has(id)){ learned.add(id); newCount++; ensureMeta(id, false); } });
  const t = todayStr();
  dailyStats[t] = (dailyStats[t]||0) + newCount;
  saveAll();
}

function completeSession(){
  markLearned(session.wordIds);
  if(!daysProgress[session.level].completed.includes(session.day)){
    daysProgress[session.level].completed.push(session.day);
  }
  daysProgress[session.level].lastDate = todayStr();
  session.completed = true;
  LS.set(KEYS.session, session);
  saveAll();
  STATE.screen = 'home';
  session = null;
  LS.set(KEYS.session, null);
  toast('오늘의 학습을 완료했어요! 🎉');
  render();
}

document.addEventListener('change', function(e){
  if(e.target.id === 'voice-select'){
    settings.voiceURI = e.target.value || null;
    saveAll();
    pickVoices();
  }
});

document.addEventListener('click', function(e){
  const t = e.target.closest('[data-action]');
  if(!t) return;
  if(t.dataset.stop) e.stopPropagation();
  const a = t.dataset.action;

  switch(a){
    case 'set-level':
      settings.level = t.dataset.level; saveAll(); render(); break;
    case 'set-font':
      settings.fontScale = t.dataset.font; saveAll(); applyFontScale(); render(); break;
    case 'set-rate':
      settings.rate = parseFloat(t.dataset.rate); saveAll(); render(); break;
    case 'toggle-day-picker':
      STATE.dayPicker = !STATE.dayPicker; render(); break;
    case 'pick-day': {
      if(alreadyDoneToday(settings.level)){ toast('아빠! 오늘치 단어공부는 다했어유 🦭'); break; }
      const d = parseInt(t.dataset.day,10);
      session = {level:settings.level, day:d, wordIds:getDayWords(settings.level,d), index:0, date:todayStr(), completed:false};
      LS.set(KEYS.session, session);
      STATE.dayPicker=false; STATE.screen='studying'; render(); break;
    }
    case 'start-today': {
      if(alreadyDoneToday(settings.level)){ toast('아빠! 오늘치 단어공부는 다했어유 🦭'); break; }
      const d = nextDay(settings.level);
      session = {level:settings.level, day:d, wordIds:getDayWords(settings.level,d), index:0, date:todayStr(), completed:false};
      LS.set(KEYS.session, session);
      STATE.screen='studying'; render(); break;
    }
    case 'resume-session': STATE.screen='studying'; render(); break;
    case 'discard-session': session=null; LS.set(KEYS.session,null); render(); break;
    case 'next-word':
      if(session.index >= session.wordIds.length-1){ completeSession(); }
      else { session.index++; LS.set(KEYS.session, session); render(); }
      break;
    case 'finish-today': completeSession(); break;
    case 'toggle-fav': {
      const id = t.dataset.id;
      if(favs.has(id)) favs.delete(id); else favs.add(id);
      saveAll(); render(); break;
    }
    case 'speak-word': speakWord(ALL_WORDS[t.dataset.id]); break;
    case 'speak-example': speakExample(ALL_WORDS[t.dataset.id]); break;
    case 'speak-all': speakAll(ALL_WORDS[t.dataset.id]); break;
    case 'open-cat': STATE.browseCat = t.dataset.cat; render(); break;
    case 'back-to-cats': STATE.browseCat = null; render(); break;
    case 'open-detail': STATE.detail = {wordId:t.dataset.id, back:t.dataset.back}; render(); break;
    case 'close-detail': STATE.detail = null; render(); break;
    case 'go-review': STATE.screen='review'; STATE.reviewTab='quiz'; render(); break;
    case 'go-fav': STATE.screen='review'; STATE.reviewTab='fav'; render(); break;
    case 'set-review-tab': STATE.reviewTab = t.dataset.tab; render(); break;
    case 'clear-wrong': wrongs = []; saveAll(); render(); break;
    case 'remove-wrong': wrongs = wrongs.filter(id=>id!==t.dataset.id); saveAll(); render(); break;
    case 'start-flash': {
      const src = t.dataset.source;
      const pool = src==='fav' ? [...favs] : [...learned];
      if(!pool.length){ toast('학습한 단어가 없어요'); break; }
      STATE.flash = {pool: shuffle(pool), index:0, source:src};
      render(); break;
    }
    case 'flash-next':
      if(STATE.flash.index >= STATE.flash.pool.length-1){ STATE.flash=null; toast('학습을 마쳤어요 🌤️'); }
      else STATE.flash.index++;
      render(); break;
    case 'flash-prev': if(STATE.flash.index>0) STATE.flash.index--; render(); break;
    case 'close-flash': STATE.flash = null; render(); break;
    case 'start-quiz': {
      const mode = t.dataset.mode;
      const source = t.dataset.source || 'all';
      const pool = source==='due' ? dueWords() : source==='wrong' ? wrongs : [...learned];
      if(pool.length < 2){ toast(source==='due' ? '지금은 복습할 단어가 없어요' : '학습한 단어가 더 필요해요'); break; }
      STATE.quiz = buildQuizRound(mode, source);
      render(); break;
    }
    case 'answer-quiz': {
      const q = STATE.quiz;
      const cur = q.questions[q.index];
      const chosen = decodeURIComponent(t.dataset.opt);
      const isCorrect = chosen === cur.correct;
      q.answered = true;
      quizStats.total++;
      if(isCorrect) { quizStats.correct++; q.correctCount++; }
      else { if(!wrongs.includes(cur.wordId)) wrongs.push(cur.wordId); }
      updateReviewSchedule(cur.wordId, isCorrect);
      saveAll();
      // 시각적 피드백
      document.querySelectorAll('.quiz-opt').forEach(btn=>{
        const val = decodeURIComponent(btn.dataset.opt);
        if(val === cur.correct) btn.classList.add('correct');
        else if(val === chosen) btn.classList.add('wrong');
      });
      setTimeout(()=>{
        if(q.index >= q.questions.length-1){
          toast(`퀴즈 완료! ${q.correctCount}/${q.questions.length} 정답`);
          STATE.quiz = null;
        } else { q.index++; q.answered=false; }
        render();
      }, 900);
      break;
    }
    case 'close-quiz': STATE.quiz = null; render(); break;
    case 'test-voice': speak('Hello, this is a sample sentence for you.', 'en-US'); break;
    case 'reset-data': {
      if(confirm('학습 기록, 즐겨찾기, 통계가 모두 초기화됩니다. 계속할까요?')){
        learned = new Set(); favs = new Set(); wrongs = [];
        quizStats = {correct:0,total:0};
        daysProgress = {basic:{completed:[]}, intermediate:{completed:[]}, advanced:{completed:[]}};
        dailyStats = {};
        reviewMeta = {};
        session = null; LS.set(KEYS.session, null);
        saveAll(); toast('초기화되었습니다'); render();
      }
      break;
    }
  }
});

document.querySelectorAll('.nav-item').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    STATE.screen = btn.dataset.nav;
    STATE.detail=null; STATE.quiz=null; STATE.flash=null; STATE.dayPicker=false;
    if(STATE.screen!=='browse') STATE.browseCat=null;
    render();
  });
});

function applyFontScale(){
  const map = {normal:'17px', large:'19px', xlarge:'21px'};
  document.documentElement.style.fontSize = map[settings.fontScale] || '17px';
}

/* ---------- 시작 ---------- */
async function init(){
  applyFontScale();
  await loadData();
  migrateReviewMeta();
  if(session && session.date !== todayStr() && !session.completed){
    // 날짜가 지났어도 이어하기 제안은 유지 (진행 중이면)
  }
  render();
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  }
}
init();
})();
