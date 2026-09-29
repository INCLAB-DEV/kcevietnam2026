"""K-콘텐츠 택소노미(kct001tax01) 라벨 드리프트 가드.

``migrations/versions/kct001tax01_kcontent_taxonomy_pivot.py``는 keywords 테이블에 business_field
8종 마스터(code/label/label_en)를 하드코딩해 심는다. 이 하드코딩이 ``app.demo_seed.DEMO_BUSINESS_FIELDS``와
어긋나면, 데모 재시드(``app.demo_seed.seed``)가 마이그레이션이 심어둔 마스터 라벨을 조용히 덮어써
버린다 — bm002api0001/i18n0001과 같은 선례(마이그레이션 파일 주석 참고).

마이그레이션 파일 자체는 import하지 않는다(alembic 리비전은 실행 스크립트지 안정적인 import 대상이
아니다). 대신 ``_MIGRATION_BUSINESS_FIELD_LABELS``에 마이그레이션의 ``_BUSINESS_FIELD_LABELS``를
문자열 상수로 그대로 옮겨 적어 두고, demo_seed 쪽과 비교한다 — 둘 중 하나만 고치고 반대쪽을 잊으면
이 테스트가 바로 잡는다.
"""

from __future__ import annotations

from app import models
from app.demo_seed import DEMO_BUSINESS_FIELDS, DEMO_EXHIBITORS

# migrations/versions/kct001tax01_kcontent_taxonomy_pivot.py의 _BUSINESS_FIELD_LABELS와 동일한
# 값이어야 한다(마이그레이션 파일 그대로 옮겨 적은 스냅샷 — 마이그레이션 수정 시 여기도 같이 고칠 것).
_MIGRATION_BUSINESS_FIELD_LABELS: tuple[tuple[str, str, str], ...] = (
    ("game_production", "게임 제작", "Game Production"),
    ("animation_distribution", "애니메이션 유통 및 배급", "Animation Distribution"),
    ("content_production", "콘텐츠 제작", "Content Production"),
    ("music_platform", "음악 플랫폼", "Music Platform"),
    ("newtech_content", "신기술융합콘텐츠", "New-Tech Convergence Content"),
    ("character_licensor", "캐릭터 라이센서", "Character Licensor"),
    ("webtoon_production", "만화웹툰 제작", "Comics & Webtoon Production"),
    ("music_production", "음악 제작", "Music Production"),
)


def test_migration_snapshot_covers_all_business_fields():
    """이 테스트 파일의 스냅샷 자체가 models.BUSINESS_FIELDS(8종)를 빠짐없이 담고 있는지."""
    assert {code for code, _, _ in _MIGRATION_BUSINESS_FIELD_LABELS} == set(models.BUSINESS_FIELDS)


def test_demo_business_fields_code_set_matches_models():
    """demo_seed가 아는 사업분야 코드 집합 == models.BUSINESS_FIELDS(CHECK 제약과 동일 소스)."""
    assert set(DEMO_BUSINESS_FIELDS) == set(models.BUSINESS_FIELDS)


def test_demo_business_fields_labels_match_migration_seed():
    """demo_seed 라벨(ko, en)이 마이그레이션이 keywords에 심는 라벨과 문자 그대로 일치하는지.

    어긋나면 재시드가 마이그레이션 마스터 라벨을 demo_seed 라벨로 조용히 덮어쓴다.
    """
    migration_labels = {
        code: (label_ko, label_en) for code, label_ko, label_en in _MIGRATION_BUSINESS_FIELD_LABELS
    }
    assert DEMO_BUSINESS_FIELDS == migration_labels


def test_demo_business_fields_have_both_locales():
    """demo_seed 라벨은 ko/en 둘 다 채워져 있어야 한다(en 화면이 한글로 새지 않게)."""
    for code, (label_ko, label_en) in DEMO_BUSINESS_FIELDS.items():
        assert label_ko, f"{code}: ko 라벨 누락"
        assert label_en, f"{code}: en 라벨 누락"


def test_content_category_codes_used_in_demo_seed_match_models():
    """demo_seed가 실제로 쓰는 content_category 코드 집합 == models.CONTENT_CATEGORIES(CHECK 제약).

    content_category는 keyword 조인이 아닌 스칼라라 별도 라벨 마스터가 없다 — 코드 집합만 대조.
    """
    used = {spec.content_category for spec in DEMO_EXHIBITORS}
    assert used == set(models.CONTENT_CATEGORIES)
