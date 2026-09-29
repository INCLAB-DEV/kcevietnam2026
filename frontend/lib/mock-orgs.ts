import type { Organization } from "./types"

// 데모용 5개 참가사 (완성도 100% — 카드 + 상세까지). K-콘텐츠 택소노미(kct001tax01) —
// backend demo_seed.py의 DEMO_EXHIBITORS 5곳(픽셀아츠 스튜디오·한강게임즈·툰브릿지·사운드웨이브·
// 케이브로드캐스트)과 회사명·업종을 동치 유지한다(mock↔실연동 전환 시 이질감 방지).
export const MOCK_EXHIBITORS: Organization[] = [
  {
    id: "ex-001",
    name: "픽셀아츠 스튜디오",
    role: "exhibitor",
    keywords: ["콘텐츠 제작", "캐릭터 라이센서", "신기술융합콘텐츠"],
    booth: { hallNo: "7", hallName: "7홀", code: "A-12" },
    strength: "오리지널 애니메이션과 캐릭터 IP를 기획·제작하는 애니메이션 스튜디오",
    exhibits: [
      "오리지널 애니메이션 시리즈 '스타빔레인저'",
      "캐릭터 라이선싱 패키지 '문라이트 프렌즈'",
      "AR 캐릭터 체험 부스 '스타빔 AR'",
    ],
    description: "오리지널 애니메이션과 캐릭터 IP를 기획·제작하는 애니메이션 스튜디오. 신기술 융합 콘텐츠까지 사업 영역을 넓히고 있다.",
    achievements: [
      "오리지널 애니메이션 '스타빔레인저' 26부작 글로벌 OTT 동시 방영",
      "캐릭터 IP '문라이트 프렌즈' 완구·의류 라이선스 계약",
      "AR 캐릭터 체험 콘텐츠 다수 전시회 시연",
    ],
    founded: "2014년",
    employees: "약 40명",
    contentCategory: "animation_character",
  },
  {
    id: "ex-002",
    name: "한강게임즈",
    role: "exhibitor",
    keywords: ["게임 제작", "신기술융합콘텐츠"],
    booth: { hallNo: "7", hallName: "7홀", code: "B-05" },
    strength: "모바일·콘솔 게임과 실감형 신기술 콘텐츠 개발",
    exhibits: ["모바일 RPG '한강 크로니클'", "실감형 콘텐츠 데모 '메타플레이'"],
    description: "모바일·콘솔 게임과 실감형 신기술 콘텐츠를 개발하는 게임 개발사.",
    achievements: [
      "모바일 RPG '한강 크로니클' 국내 앱스토어 인기 게임 1위",
      "실감형 콘텐츠 '메타플레이' 국제 게임쇼 출품",
      "누적 다운로드 500만 돌파",
    ],
    founded: "2016년",
    employees: "약 85명",
    contentCategory: "comics_game_music",
  },
  {
    id: "ex-003",
    name: "툰브릿지",
    role: "exhibitor",
    keywords: ["만화웹툰 제작", "애니메이션 유통 및 배급"],
    booth: { hallNo: "8", hallName: "8홀", code: "C-21" },
    strength: "웹툰 제작과 해외 플랫폼 유통·배급",
    exhibits: ["웹툰 시리즈 '나이트 브릿지'", "해외 배급 패키지 '글로벌 웹툰 라인업'"],
    description: "웹툰을 제작하고 해외 플랫폼에 유통·배급하는 콘텐츠 기업.",
    achievements: [
      "웹툰 '나이트 브릿지' 동남아 3개국 플랫폼 연재",
      "글로벌 웹툰 라인업 배급 계약 10건 이상",
      "누적 조회수 2억뷰 돌파",
    ],
    founded: "2018년",
    employees: "약 30명",
    contentCategory: "comics_game_music",
  },
  {
    id: "ex-004",
    name: "사운드웨이브",
    role: "exhibitor",
    keywords: ["음악 제작", "음악 플랫폼"],
    booth: { hallNo: "8", hallName: "8홀", code: "D-07" },
    strength: "음원 제작과 자체 스트리밍 플랫폼 운영",
    exhibits: ["오리지널 음원 앨범 '웨이브 시그널'", "스트리밍 플랫폼 '사운드웨이브 라이브'"],
    description: "음원을 제작하고 자체 스트리밍 플랫폼을 운영하는 음악 콘텐츠 기업.",
    achievements: [
      "오리지널 앨범 '웨이브 시그널' 스트리밍 1천만 재생 돌파",
      "자체 플랫폼 '사운드웨이브 라이브' 해외 진출",
      "K-POP 프로듀서 협업 다수",
    ],
    founded: "2015년",
    employees: "약 25명",
    contentCategory: "comics_game_music",
  },
  {
    id: "ex-005",
    name: "케이브로드캐스트",
    role: "exhibitor",
    keywords: ["콘텐츠 제작", "신기술융합콘텐츠"],
    booth: { hallNo: "9", hallName: "9홀", code: "E-15" },
    strength: "예능·드라마 포맷 기획과 방송 송출 기술",
    exhibits: ["예능 포맷 '서울 나이트쇼'", "실시간 방송 송출 솔루션 'K-Broadcast Live'"],
    description: "예능·드라마 포맷을 기획하고 방송 송출 기술을 제공하는 방송 콘텐츠 기업.",
    achievements: [
      "예능 포맷 '서울 나이트쇼' 해외 포맷 수출 계약",
      "실시간 송출 솔루션 다수 방송사 도입",
      "국제 방송 콘텐츠 마켓 3년 연속 참가",
    ],
    founded: "2012년",
    employees: "약 90명",
    contentCategory: "broadcasting",
  },
]

// 데모용 5개 바이어 (완성도 100%). 앞 3곳(Seoul Content Partners·Asia Webtoon Distribution·
// Global Music Ventures)은 backend demo_seed.py의 DEMO_BUYER_PROFILES와 동치 — 관심분야가
// 참가사 5곳과 고루 겹치도록 잡는다(매칭 데모가 0%로 안 보이게).
export const MOCK_BUYERS: Organization[] = [
  {
    id: "by-001",
    name: "Seoul Content Partners",
    role: "buyer",
    buyerType: "hosted",
    description: "게임·애니메이션·캐릭터 IP의 해외 공동제작을 검토하는 콘텐츠 투자사",
    keywords: ["게임 제작", "콘텐츠 제작", "캐릭터 라이센서"],
    budgetRange: "50억~100억",
    adoptionTimeline: "1년 내",
  },
  {
    id: "by-002",
    name: "Asia Webtoon Distribution",
    role: "buyer",
    buyerType: "pre_registered",
    description: "한국 웹툰·애니메이션을 동남아 스트리밍 플랫폼으로 확장하는 유통사",
    keywords: ["만화웹툰 제작", "애니메이션 유통 및 배급", "음악 플랫폼"],
    budgetRange: "100억~500억",
    adoptionTimeline: "2년 내",
  },
  {
    id: "by-003",
    name: "Global Music Ventures",
    role: "buyer",
    buyerType: "hosted",
    description: "스트리밍·실감형 콘텐츠 파트너십을 발굴하는 음악·기술 투자사",
    keywords: ["음악 제작", "신기술융합콘텐츠"],
    budgetRange: "500억 이상",
    adoptionTimeline: "6개월 내",
  },
  {
    id: "by-004",
    name: "K-Wave Media Group",
    role: "buyer",
    buyerType: "pre_registered",
    description: "방송 포맷과 실감형 콘텐츠 수입을 담당하는 아시아 미디어 그룹",
    keywords: ["콘텐츠 제작", "신기술융합콘텐츠"],
    budgetRange: "50억~100억",
    adoptionTimeline: "1년 내",
  },
  {
    id: "by-005",
    name: "Tokyo Anime Ventures",
    role: "buyer",
    buyerType: "on_site",
    description: "애니메이션·캐릭터 IP 라이선싱을 검토하는 일본 투자사",
    keywords: ["캐릭터 라이센서", "애니메이션 유통 및 배급"],
    budgetRange: "10억~50억",
    adoptionTimeline: "2년 내",
  },
]

export const ALL_MOCK_ORGS: Organization[] = [...MOCK_EXHIBITORS, ...MOCK_BUYERS]
