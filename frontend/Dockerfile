# NABI 프론트엔드 — ECS Fargate 배포용 이미지 (docker/build-push-action, context: frontend)
# Node 22-alpine — frontend-ci.yml의 setup-node(node-version: 22)와 정합.
# 멀티스테이지: deps(의존성만) → builder(next build, output:"standalone") → runner(standalone 산출물만 실행).

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci는 lock 생성 npm 버전(로컬 npm 11)과 컨테이너 npm(node22=npm10) 불일치로 @swc/helpers 등에서 거부됨.
# standalone 데모 이미지라 재현성 엄격도보다 빌드 성공이 우선 — install로 관대하게 해석(lock 존재 시 최대한 준수).
RUN npm install --no-audit --no-fund


FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_*은 빌드 시점에 JS 번들에 인라인된다(deploy 워크플로우의 build-args와 동일 인자).
# 기본값은 프로덕션 오배선을 막기 위해 mock이 아닌 http로 둔다(fail-closed 원칙, deploy 워크플로우 주석 참고).
ARG NEXT_PUBLIC_AUTH_CLIENT=http
ENV NEXT_PUBLIC_AUTH_CLIENT=$NEXT_PUBLIC_AUTH_CLIENT
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build


FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# standalone 산출물은 node_modules 없이 실행 가능한 최소 서버(server.js) — public/static은 별도 복사 필요.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
