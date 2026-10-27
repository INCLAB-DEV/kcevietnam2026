// 대리작성(proxy write) 규칙 — 슈퍼어드민 콘솔의 핵심 요구.
//
// 상황: 주관사 명단에는 올라와 있지만 아직 회원가입도, 비즈매칭 신청도 하지 않은 기업이 있다
// (application_status = "registered", 임포트만 된 상태). 운영자가 전화·메일로 받은 정보를 대신
// 신청서에 채워 넣어야 매칭 모수에 들어간다.
//
// 규칙: 대리작성은 신청서 저장과 상태 전이를 함께 한다. master는 승인 권한까지 있으므로 즉시
// approved로 전환해 매칭 풀에 넣고, sub는 submitted로 전환해 master 승인 대기열에 넣는다.
//
// 일반 정정(PATCH /profile — 신청서 편집 패널, components/operator/application-panel)과의 차이:
// 일반 정정은 상태를 바꾸지 않고 어느 상태에서나 되지만, 대리작성은 상태를 전이시키고 작성자를
// 기록하며 registered 한정으로 제한된다.

import type { ApplicationStatus } from "@/lib/application-status"
import type { AdminOrganization } from "./types"

// 대리작성 가능 대상 — 미신청(registered)만.
// 이미 제출한 회사(submitted 이상)의 신청서를 운영자가 갈아끼우면 회사가 낸 선언과 승인 심사 대상이
// 어긋난다. 그런 건은 일반 정정(PATCH /profile)으로 다루고, 상태 전이는 심사 화면 소관이다.
export function canProxyWrite(status: ApplicationStatus): boolean {
  return status === "registered"
}

// 대리작성 후 상태 — 항상 registered(미신청 유지). 입력이 무엇이든 이 규칙이 이긴다.
export function statusAfterProxyWrite(approveImmediately: boolean): ApplicationStatus {
  return approveImmediately ? "approved" : "submitted"
}

export type ProxyWriteOutcome =
  | { ok: true; organization: AdminOrganization }
  | { ok: false; reason: "not-unsubmitted"; message: string }

// 대리작성 저장을 기업 행에 반영한다. 상태 배지는 미신청 유지, 작성자·시각만 새로 남는다.
// (프로필 본문 자체는 별도 스토어가 들고 있고, 여기선 리스트 행의 파생 필드만 다룬다.)
export function applyProxyWrite(
  org: AdminOrganization,
  writtenBy: string,
  at: string,
  approveImmediately: boolean,
): ProxyWriteOutcome {
  if (!canProxyWrite(org.application_status)) {
    return {
      ok: false,
      reason: "not-unsubmitted",
      message:
        "이미 신청서를 제출한 기업입니다. 대리작성 대신 신청서 정정으로 내용을 수정해 주세요.",
    }
  }
  return {
    ok: true,
    organization: {
      ...org,
      application_status: statusAfterProxyWrite(approveImmediately),
      proxy_written: true,
      proxy_written_by: writtenBy,
      proxy_written_at: at,
      updated_at: at,
    },
  }
}

// 상태 배지 라벨 — 운영자 컨텍스트(ORGANIZER_STATUS_LABELS와 동일 어휘).
// 대리작성 여부는 신청 상태와 별도 감사 정보로 표시한다.
export const ADMIN_STATUS_LABELS: Record<ApplicationStatus, string> = {
  registered: "미신청",
  submitted: "제출됨",
  changes_requested: "보완요청",
  approved: "승인",
  rejected: "반려",
}
