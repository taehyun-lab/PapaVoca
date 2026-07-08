# PapaVoca

아빠를 위해 만든 voca 연습장

## 배포 방법 (GitHub Pages, 무료)

1. GitHub에서 새 저장소 생성 (예: `papavoca`)
2. 이 폴더 안의 파일 전체(`index.html`, `style.css`, `app.js`, `manifest.json`,
   `service-worker.js`, `data/`, `icons/`)를 저장소에 업로드
3. 저장소 **Settings → Pages** 메뉴에서
   - Source: `Deploy from a branch`
   - Branch: `main` / `(root)` 선택 후 저장
4. 몇 분 후 `https://[아이디].github.io/papavoca/` 주소로 접속 가능
5. 아이폰 Safari로 접속 → 공유 버튼 → **홈 화면에 추가** 하면 앱처럼 사용 가능

## 현재 데이터 규모

11개 카테고리 × 3단계 난이도 × 10단어 = **총 330단어**
(하루 20단어 기준 약 16~17일 분량, 1회차 시작)

카테고리: 여행·식사·음식·유아교육·가족·날씨·병원·쇼핑·직업·감정·생활회화

## 데이터 확장하기

`data/words.json` 파일만 채워 넣으면 됩니다. 형식은 기존 단어들과 동일하게
`en / ko / pron / example_en / example_ko / related` 필드를 유지하면 됩니다.
6개월 분량(약 2,500단어 이상)까지 계속 채워나갈 수 있어요.
다음 대화에서 "여행 카테고리 심화 단어 20개 더 추가해줘" 처럼 요청하시면
카테고리별로 배치 추가해드릴 수 있습니다.

## 유지보수 메모

- 모든 사용자 데이터(학습 기록·즐겨찾기·틀린 단어·통계)는 브라우저 LocalStorage에만 저장됩니다.
- 서버·로그인 없음. 순수 정적 파일이라 GitHub Pages 무료 플랜으로 충분합니다.
- 발음은 브라우저 Speech Synthesis API(무료) 사용. 아이폰에서 설정 → 손쉬운 사용 →
  음성 콘텐츠에서 영어 음성을 "고급/향상된 품질"로 다운로드하면 훨씬 자연스러워집니다.
