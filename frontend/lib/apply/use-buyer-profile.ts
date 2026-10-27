"use client"

// useBuyerProfile — buyer-profile-store의 반응형 구독 훅. store 본체에서 분리한 이유:
// store는 route handler(서버, app/api/buyer-profile 등)도 import하는데, React 클라 전용 API
// (useSyncExternalStore)가 store에 있으면 RSC 번들 경계에서 컴파일이 깨진다. React 의존은
// 이 파일에만 둔다(호출처는 이 경로로 import).

import { useSyncExternalStore } from "react"
import {
  freshProfileSnapshot,
  getProfileSnapshot,
  subscribeProfiles,
  type ProfileSeed,
  type StoredProfile,
} from "./buyer-profile-store"

export function useBuyerProfile(key: string, seed?: ProfileSeed): StoredProfile {
  return useSyncExternalStore(
    subscribeProfiles,
    () => getProfileSnapshot(key, seed),
    () => freshProfileSnapshot(seed),
  )
}
