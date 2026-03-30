# Agent-to-Agent (A2A) Coordination

Claude + Gemini + GPT 에이전트가 역할을 가진 팀으로 협업하는 시스템 설계 문서.

> **상태**: 설계 완료 / 구현 예정 (Phase 1 → 2 → 3)

---

## 목차

1. [개요](#1-개요)
2. [빠른 시작 — 에이전트 관점](#2-빠른-시작--에이전트-관점)
3. [파일 구조](#3-파일-구조)
4. [역할 시스템](#4-역할-시스템)
5. [데이터 구조 레퍼런스](#5-데이터-구조-레퍼런스)
6. [메시지 프로토콜](#6-메시지-프로토콜)
7. [Task 시스템](#7-task-시스템)
8. [협업 패턴](#8-협업-패턴)
9. [오피스 UI 시각화](#9-오피스-ui-시각화)
10. [웹뷰 메시지 프로토콜 (개발자용)](#10-웹뷰-메시지-프로토콜-개발자용)
11. [구현 로드맵](#11-구현-로드맵)
12. [설계 결정 및 트레이드오프](#12-설계-결정-및-트레이드오프)

---

## 1. 개요

### 왜 멀티 AI 팀인가

Pixel Agents는 Claude / Gemini / OpenAI 에이전트를 동시에 오피스에 띄울 수 있다. 지금까지 각 에이전트는 완전히 독립적으로 동작했다. A2A Coordination 시스템은 이 에이전트들이:

- 서로의 존재를 **발견(discover)**하고
- **역할(role)**로 전문성을 표현하고
- **메시지를 주고받으며**
- **작업(task)을 위임하고 수행**할 수 있게 한다

### 어떤 시나리오에서 유용한가

| 시나리오 | 예시 |
|---|---|
| 대규모 리팩터링 | Claude(Architect)가 설계, Gemini(Backend Dev)가 구현, GPT(QA)가 테스트 |
| 병렬 코드 리뷰 | 보안 / 성능 / 커버리지를 동시에 각각 다른 에이전트가 검토 |
| 문서화 파이프라인 | 코드 작성 완료 신호 → Tech Writer 에이전트가 자동으로 문서 작성 |
| 버그 가설 경쟁 | 동일 버그를 여러 에이전트가 다른 가설로 동시 분석 → Orchestrator가 종합 |

### Claude Agent Teams 참고

이 설계는 Anthropic Claude Agent Teams (v2.1.32+)의 패턴을 참고했다.

| 패턴 | Claude Agent Teams | Pixel Agents A2A |
|---|---|---|
| 메시지 전달 | Direct + Broadcast mailbox | inbox JSONL per-agent |
| 작업 관리 | Shared task list | tasks/ 디렉터리 |
| 역할 정의 | AgentDefinition.description + prompt | role + roleDescription |
| Race condition 방지 | File locking | rename-based atomic claim |
| Agent ID 노출 | tool result | 환경변수 주입 |

---

## 2. 빠른 시작 — 에이전트 관점

에이전트가 실행되면 다음 환경변수가 자동으로 주입된다:

```bash
PIXEL_AGENTS_SESSION_ID   # 이 에이전트의 고유 세션 UUID
PIXEL_AGENTS_REGISTRY     # ~/.pixel-agents/coordination/registry.json
PIXEL_AGENTS_INBOX        # ~/.pixel-agents/coordination/inbox/<session-id>.jsonl
PIXEL_AGENTS_COORD_DIR    # ~/.pixel-agents/coordination/
```

### 팀 현황 파악

```bash
cat $PIXEL_AGENTS_REGISTRY | jq '[.agents[] | {role, providerId, status, sessionId}]'
# 출력 예시:
# [
#   { "role": "Architect",    "providerId": "claude",  "status": "idle",   "sessionId": "abc-123" },
#   { "role": "QA Engineer",  "providerId": "gemini",  "status": "active", "sessionId": "def-456" },
#   { "role": "Tech Writer",  "providerId": "openai",  "status": "idle",   "sessionId": "ghi-789" }
# ]
```

### 역할로 에이전트 찾기

```bash
cat $PIXEL_AGENTS_REGISTRY | jq '.agents[] | select(.role == "QA Engineer" and .status == "idle")'
```

### 다른 에이전트에게 메시지 보내기

자신의 inbox에 `send_to` 타입 메시지를 작성한다. Extension이 감지해서 대상 에이전트의 inbox로 라우팅한다.

```bash
TARGET_SESSION="def-456"
echo "{
  \"type\": \"send_to\",
  \"toSessionId\": \"$TARGET_SESSION\",
  \"msgType\": \"delegate\",
  \"body\": \"Write tests for src/auth.ts. Focus on edge cases.\",
  \"taskId\": \"task-001\",
  \"sentAt\": $(date +%s)000
}" >> $PIXEL_AGENTS_INBOX
```

### 내 수신 메시지 확인

```bash
# send_to(발신 요청)를 제외한 수신 메시지만 표시
cat $PIXEL_AGENTS_INBOX | jq -c 'select(.type != "send_to")'
```

### 역할 선언

```bash
echo "{
  \"type\": \"set_role\",
  \"body\": \"QA Engineer\",
  \"sentAt\": $(date +%s)000
}" >> $PIXEL_AGENTS_INBOX
```

---

## 3. 파일 구조

```
~/.pixel-agents/
  layout.json                        # 기존 (오피스 레이아웃)
  config.json                        # 기존 (외부 에셋 등)
  coordination/
    registry.json                    # Extension이 단독으로 쓰는 집약 파일
                                     # 에이전트가 읽기 전용으로 사용
    agents/
      <session-id>.json              # per-agent 메타데이터
                                     # multi-window VS Code 충돌 방지용
    inbox/
      <session-id>.jsonl             # per-agent 수신함 (JSONL, append-only)
    tasks/
      pending/<task-id>.json         # claim 가능한 태스크
      blocked/<task-id>.json         # dependsOn 미충족 태스크
      claimed/<task-id>.<session>    # rename으로 원자적 claim된 태스크
      done/<task-id>.json            # 완료된 태스크
      failed/<task-id>.json          # 실패한 태스크
    payloads/
      <msg-id>.txt                   # 4KB 초과 메시지 본문 별도 저장
    history.jsonl                    # 최근 coordination 이벤트 로그
```

### Registry 이중 구조

`agents/<session-id>.json`과 `registry.json`을 함께 유지하는 이유:

- **`agents/` 디렉터리**: 각 에이전트(또는 VS Code 창)가 자신의 파일만 쓴다. 동시 쓰기 충돌 없음
- **`registry.json`**: Extension이 `agents/` 변경을 감지할 때마다 재생성. 에이전트가 한 파일만 읽으면 전체 팀 현황을 알 수 있음

### 메시지 쓰기 권한

**Extension이 단일 진입점**이다. 에이전트는 타 에이전트의 inbox에 직접 쓰지 않는다.

```
에이전트 A의 inbox에 send_to 작성
        ↓
coordinationWatcher 감지
        ↓
coordinationManager가 대상 에이전트 inbox에 라우팅
```

→ 동시 쓰기 경쟁 조건 해소

---

## 4. 역할 시스템

### 역할 정의

역할은 자유 문자열이다. 사전 정의된 프리셋을 UI에서 제안하지만 직접 입력도 가능하다.

**프리셋 목록**:
- `Architect` — 시스템 설계, 코드 구조 결정
- `Frontend Dev` — UI, 컴포넌트, 스타일
- `Backend Dev` — API, 서버, 데이터베이스
- `QA Engineer` — 테스트, 버그 탐지, 품질 검증
- `Tech Writer` — 문서화, README, 주석
- `Code Reviewer` — 코드 리뷰, 보안, 성능
- `DevOps` — CI/CD, 인프라, 배포
- `Data Analyst` — 데이터 분석, 쿼리, 시각화

### 역할 지정 방법

**방법 1: UI (ToolOverlay)**

오피스에서 에이전트 캐릭터를 클릭 → ToolOverlay에서 역할 텍스트 클릭 → RoleSelector 팝업:

```
Role: [Architect              ▼]  ← 프리셋 드롭다운 또는 직접 입력
Desc: [시스템 설계 및 리뷰 담당  ]  ← 선택 사항: 이 에이전트를 언제 써야 하는가
Tags: [design, code-review     ]  ← 쉼표 구분 자유 텍스트
```

**방법 2: 에이전트 자신이 선언**

에이전트가 자신의 inbox에 `set_role` 메시지를 작성하면 Extension이 감지해서 registry를 갱신한다.

```bash
echo "{\"type\":\"set_role\",\"body\":\"QA Engineer\",\"sentAt\":$(date +%s)000}" \
  >> $PIXEL_AGENTS_INBOX
```

### 역할 기반 자동 라우팅

Extension이 역할 + 상태를 기반으로 최적 에이전트를 선택한다.

**스코어링 알고리즘**:

| 상태 | 기본 점수 | 작업 없음 추가 |
|---|---|---|
| `idle` | 100 | +50 |
| `waiting` | 60 | +50 |
| `active` | 20 | — |

동점이면 먼저 등록된 에이전트 우선.

**사용 예**: `requiredRole: "QA Engineer"`로 라우팅 요청 시 idle QA 에이전트(150점)가 active QA 에이전트(20점)보다 우선 선택됨.

---

## 5. 데이터 구조 레퍼런스

### `AgentRegistryEntry`

```typescript
interface AgentRegistryEntry {
  sessionId: string;           // JSONL 파일 basename (UUID)
  agentId: number;             // Pixel Agents 내부 ID
  providerId: string;          // 'claude' | 'openai' | 'gemini'
  providerName: string;        // 'Claude Code' | 'OpenAI Codex' | 'Google Gemini'
  role: string | null;         // "Architect", "QA Engineer", null이면 미지정
  roleDescription: string | null;  // 이 에이전트를 언제 써야 하는가
  capabilities: string[];      // ["code-review", "design"] 쉼표 구분 태그
  status: 'active' | 'waiting' | 'idle';
  currentTask: string | null;  // 마지막 tool status 텍스트
  inboxFile: string;           // 절대 경로
  registeredAt: number;        // ms epoch
  updatedAt: number;           // stale 판별용 (30초 초과 시 오프라인)
}
```

`registry.json` 전체 구조:
```json
{
  "version": 1,
  "agents": {
    "<session-id>": { ...AgentRegistryEntry }
  },
  "updatedAt": 1711234567000
}
```

### `CoordinationMessage`

```typescript
interface CoordinationMessage {
  id: string;                  // UUID (중복 방지)
  fromSessionId: string;
  fromProviderId: string;
  fromRole: string | null;
  toSessionId: string;
  type: CoordinationMessageType;
  body: string;                // 4KB 초과 시 "[PAYLOAD_REF:<msg-id>.txt]"
  taskId?: string;             // delegate ↔ result 연결
  chainDepth?: number;         // 루프 방지, 최대 5
  rootMessageId?: string;      // 루프 경로 감지
  sentAt: number;              // ms epoch
  ttl?: number;                // ms, 기본 86_400_000 (24h)
}

type CoordinationMessageType =
  | 'message'    // 일반 메시지
  | 'delegate'   // 작업 위임
  | 'result'     // 작업 결과 반환
  | 'broadcast'  // 전체 팀에 공지
  | 'send_to'    // 에이전트→Extension 라우팅 요청 (내부용)
  | 'set_role'   // 역할 선언
  | 'decline'    // 작업 거절
  | 'ack';       // 수신 확인
```

### `SharedTask`

```typescript
interface SharedTask {
  id: string;
  title: string;
  body: string;
  status: SharedTaskStatus;
  claimedBy: string | null;    // sessionId
  createdBy: string;           // sessionId
  dependsOn: string[];         // task IDs
  requiredRole?: string | null; // 특정 역할만 claim 가능. null이면 누구든
  priority: number;            // 1(높음) – 5(낮음)
  result?: string;
  assignedAt?: number;         // heartbeat timeout 기준
  createdAt: number;
  updatedAt: number;
}

type SharedTaskStatus =
  | 'pending'     // claim 가능
  | 'blocked'     // dependsOn 미충족
  | 'in_progress' // claim됨, 작업 중
  | 'completed'   // 완료
  | 'failed'      // 실패
  | 'declined'    // 거절됨
  | 'timed_out';  // 2분 이상 heartbeat 없음 → 자동 rollback
```

---

## 6. 메시지 프로토콜

### 메시지 흐름

```
에이전트 A (sender)
  │
  └─ $PIXEL_AGENTS_INBOX에 send_to 작성
          │
          ▼
  coordinationWatcher (inbox/ 디렉터리 감시)
          │
          ▼
  coordinationManager (라우팅 + 검증)
          │
  ┌───────┴────────┐
  │                │
  ▼                ▼
에이전트 B inbox  웹뷰 시각화
(실제 메시지)    (베지어 호 + 말풍선)
```

### send_to 메시지 형식 (에이전트가 작성)

```json
{
  "type": "send_to",
  "toSessionId": "<target-session-id>",
  "msgType": "delegate",
  "body": "Write integration tests for auth module",
  "taskId": "task-001",
  "sentAt": 1711234567000
}
```

`fromSessionId`, `fromProviderId`, `fromRole`은 Extension이 자동으로 채운다. 에이전트가 직접 쓸 필요 없다.

### 대용량 본문 처리

body가 4KB(4,096바이트)를 초과하면:

```json
{
  "body": "[PAYLOAD_REF:abc-123-def.txt]"
}
```

실제 내용은 `coordination/payloads/abc-123-def.txt`에 저장된다. 에이전트가 이 형식을 받으면:

```bash
cat $PIXEL_AGENTS_COORD_DIR/payloads/abc-123-def.txt
```

### 루프 방지

자동 위임이 순환하지 않도록 3중 방어:

1. `chainDepth` — 메시지가 전달될 때마다 +1, 최대 5
2. `rootMessageId` — 같은 루트 메시지가 자신에게 돌아오면 drop
3. Rate limit — 에이전트별 10초에 최대 20개 메시지

---

## 7. Task 시스템

Task는 디렉터리 구조로 상태를 관리한다. 파일 위치 자체가 상태다.

### Task 상태 전이

```
blocked/ ──(dependsOn 완료)──▶ pending/
                                   │
                          (rename, atomic)
                                   ▼
                              claimed/<id>.<session>
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
                  done/         failed/       pending/
               (completed)     (failed)    (timed_out rollback)
```

### Atomic Claim

`fs.renameSync`는 POSIX + NTFS 모두에서 원자적(atomic) syscall이다. 두 에이전트가 동시에 같은 태스크를 claim하려 하면, 먼저 성공한 쪽만 파일을 얻고 나머지는 `ENOENT`를 받는다.

```
pending/task-001.json  ──rename──▶  claimed/task-001.<session-id>
                                    (rename 실패 → ENOENT → claim 포기)
```

### Task Timeout

에이전트가 task를 claim한 후 `TASK_HEARTBEAT_MS`(30초)마다 `updatedAt`을 갱신해야 한다. Extension이 2초마다 claimed/ 디렉터리를 스캔해서 `TASK_TIMEOUT_MS`(2분) 초과 태스크를 `timed_out`으로 처리하고 `pending/`으로 rollback한다.

### Task Decline

에이전트가 task를 거절할 때:

```bash
echo "{
  \"type\": \"send_to\",
  \"toSessionId\": \"<task-creator-session>\",
  \"msgType\": \"decline\",
  \"taskId\": \"task-001\",
  \"body\": \"This task requires database access which I don't have.\",
  \"sentAt\": $(date +%s)000
}" >> $PIXEL_AGENTS_INBOX
```

Extension이 decline 메시지를 감지해서 동일 역할의 다른 에이전트에게 재할당한다.

### MCP Tool 사용 (Phase 3)

Phase 3 이후에는 파일 직접 조작 없이 MCP 툴로 Task를 관리할 수 있다:

```
pa_create_task("Write tests for auth.ts", body, priority=2, requiredRole="QA Engineer")
pa_claim_task("task-001")
pa_complete_task("task-001", success=true, result="Done. 23 tests added.")
```

---

## 8. 협업 패턴

### Orchestrator 패턴

한 에이전트(Architect)가 팀을 조율하고 다른 에이전트들이 실행한다.

```
Claude(Architect)
  │
  ├─ registry에서 QA Engineer(Gemini) 발견
  │   └─ delegate: "Write tests for auth.ts"
  │
  └─ registry에서 Tech Writer(GPT) 발견
      └─ delegate: "Write API docs for auth.ts"

Gemini(QA) ──── result ────▶ Claude(Architect)
GPT(Writer) ─── result ────▶ Claude(Architect)

Claude(Architect) ──── 결과 종합 ────▶ 사용자
```

### Shared Task List 패턴

Orchestrator 없이 에이전트들이 자율적으로 태스크를 가져간다.

```
Claude: create_task "리팩터링 auth.ts" [P1, requiredRole=Backend Dev]
Claude: create_task "테스트 작성"      [P2, requiredRole=QA Engineer]
Claude: create_task "문서 업데이트"    [P3, requiredRole=Tech Writer]

Gemini(Backend Dev) ──── claim "리팩터링 auth.ts" ────▶ 작업
GPT(QA) ──────────────── claim "테스트 작성" ─────────▶ 작업
                          (문서 업데이트는 Tech Writer가 없어서 pending 유지)
```

### Broadcast + 경쟁 가설 패턴

동일 문제를 여러 에이전트가 다른 관점으로 분석한다. Claude Agent Teams의 "Competing Hypotheses" 패턴.

```
Claude(Architect): broadcast "Bug: 로그인이 간헐적으로 실패. 원인 분석 해주세요."

Gemini ──▶ "DB 커넥션 풀 소진 가설로 분석 중..."
GPT ──────▶ "세션 토큰 race condition 가설로 분석 중..."
Claude2 ──▶ "캐시 무효화 타이밍 가설로 분석 중..."

각 에이전트 → result 전송 → Architect가 종합
```

### Decline + 재할당 패턴

```
Claude: delegate → Gemini "AWS 배포 스크립트 작성해줘"
Gemini: decline "AWS 권한이 없습니다"
Extension: 다른 DevOps 에이전트에게 재할당
GPT(DevOps): task claim → 작업 수행
```

---

## 9. 오피스 UI 시각화

### ToolOverlay 레이아웃

```
┌─────────────────────────────────┐
│  Claude Code · Architect        │  ← 프로바이더 + 역할
│  ● Writing auth.ts...           │  ← 현재 작업
│  [💬 Send] [📋 Tasks] [🏷 Role] │  ← 버튼 행 (선택된 에이전트만)
└─────────────────────────────────┘
```

역할이 없을 때:
```
│  Claude Code · + 역할 추가      │  ← 회색, 클릭하면 RoleSelector 열림
```

### 베지어 호 애니메이션

에이전트 간 메시지가 전달될 때 캐릭터 머리 위를 가로지르는 호(arc)가 그려진다.

**색상 코딩**:
| 메시지 타입 | 색상 |
|---|---|
| `message` | 파란색 `#a0c4ff` |
| `delegate` | amber `#ffd6a5` |
| `result` | 초록색 `#caffbf` |
| `broadcast` | 보라색 `#d0b3ff` |

**애니메이션 순서**:
1. 0.8초 — 이동 중인 점이 호를 따라 이동 (베지어 곡선)
2. 0.5초 — 목적지에서 정지 유지
3. 0.4초 — 페이드아웃

### TaskPanel

BottomToolbar의 "Tasks" 버튼으로 토글. 픽셀 아트 스타일:

```
┌──────────────────────────────────┐
│ Pending │ Active │ Done          │
├──────────────────────────────────┤
│ [P1][Architect] Refactor DB      │
│ ▶ Claim                          │
├──────────────────────────────────┤
│ [P3] Write integration tests     │
│ → Gemini · QA Engineer (active)  │
└──────────────────────────────────┘
```

### Coordination Log

SettingsModal의 "Coordination Log" 탭. 최근 50개 이벤트:

```
14:23:01  Claude → Gemini  [delegate] Write tests for auth.ts
14:23:45  Gemini → Claude  [result]   23 tests added
14:24:12  Claude           [broadcast] API contract updated: /v2/auth
```

---

## 10. 웹뷰 메시지 프로토콜 (개발자용)

coordination 관련 메시지를 `type: 'coordination'` 하나로 묶고 `subtype`으로 구분한다.

### Extension → Webview

```typescript
// 에이전트 간 연결호 추가
{ type: 'coordination'; subtype: 'arc'; fromId: number; toId: number; arcType: 'message'|'delegate'|'result'|'broadcast' }

// 연결호 제거
{ type: 'coordination'; subtype: 'arcClear'; fromId: number; toId: number }

// 메시지 수신 알림 (말풍선)
{ type: 'coordination'; subtype: 'message'; agentId: number; fromAgentId: number; fromRole: string|null; body: string; msgType: string }

// 전체 registry 갱신
{ type: 'coordination'; subtype: 'registry'; agents: AgentRegistryEntry[] }

// 역할 변경
{ type: 'coordination'; subtype: 'roleUpdated'; agentId: number; role: string|null; roleDescription?: string; capabilities?: string[] }

// 태스크 상태 변경
{ type: 'coordination'; subtype: 'taskUpdate'; task: SharedTask }

// Coordination Log 이벤트
{ type: 'coordination'; subtype: 'log'; events: CoordLogEntry[] }
```

### Webview → Extension

```typescript
// 역할 저장
{ type: 'coordination'; subtype: 'saveRole'; agentId: number; role: string|null; roleDescription?: string; capabilities?: string[] }

// UI에서 메시지 전송 (Phase 2)
{ type: 'coordination'; subtype: 'sendMessage'; fromId: number; toId: number; body: string }

// UI에서 태스크 claim
{ type: 'coordination'; subtype: 'claimTask'; taskId: string; agentId: number }
```

`useExtensionMessages.ts`에서 처리:
```typescript
case 'coordination':
  handleCoordinationMessage(message); // subtype별 dispatch
  break;
```

---

## 11. 구현 로드맵

### Phase 1: Registry + Role + 환경변수

**목표**: 에이전트가 팀 현황을 파악하고 역할을 지정할 수 있다.

신규 파일:
- `src/coordinationPersistence.ts` — registry/agents/ 파일 I/O
- `src/coordinationManager.ts` — registry 관리, `pruneStaleAgents`, `rollbackAgentTasks`
- `webview-ui/src/components/RoleSelector.tsx`

수정 파일:
- `src/constants.ts` — coordination 관련 상수 전체 추가
- `src/types.ts` — `AgentRegistryEntry`, `CoordinationMessage`, `SharedTask` 인터페이스 추가; `AgentState` + `PersistedAgent` 확장
- `src/agentManager.ts` — 터미널 생성 시 `env` + `sendText` 주입; register/deregister/restore 훅
- `src/PixelAgentsViewProvider.ts` — `saveRole` 핸들러, `sendRegistryToWebview`
- `webview-ui/src/office/components/ToolOverlay.tsx` — 역할 표시 + 버튼 행
- `webview-ui/src/office/types.ts` — `Character.role`
- `webview-ui/src/hooks/useExtensionMessages.ts` — `case 'coordination'` 핸들러

검증:
```bash
# 에이전트 실행 후
echo $PIXEL_AGENTS_SESSION_ID          # UUID 출력되어야 함
cat $PIXEL_AGENTS_REGISTRY             # 에이전트 항목 확인
# ToolOverlay에서 역할 설정 → 재시작 후 유지 확인
```

---

### Phase 2: Message Passing + Task List + 시각화

**목표**: 에이전트 간 메시지 라우팅 + Task 관리 + 오피스 시각화

신규 파일:
- `src/coordinationWatcher.ts` — `coordination/inbox/` 단일 directory 감시 (O(1), 에이전트 수와 무관)
- `webview-ui/src/office/engine/coordinationRenderer.ts` — 베지어 호 렌더링
- `webview-ui/src/components/TaskPanel.tsx`

수정 파일:
- `src/coordinationManager.ts` — `send_to` 라우팅, Broadcast, Decline 처리, Heartbeat, Timeout rollback
- `src/coordinationPersistence.ts` — `claimTask` (rename 기반), `rollbackAgentTasks`
- `webview-ui/src/office/engine/officeState.ts` — `coordinationLinks` Map, arc TTL 처리
- `webview-ui/src/office/engine/renderer.ts` — `renderCoordinationArcs` 호출
- `webview-ui/src/office/types.ts` — `bubbleType`에 `'message'` 추가
- `webview-ui/src/components/BottomToolbar.tsx` — "Tasks" 버튼
- SettingsModal — "Coordination Log" 탭

검증:
```bash
# 수동 send_to 테스트
TARGET="<target-session-id>"
echo "{\"type\":\"send_to\",\"toSessionId\":\"$TARGET\",\"msgType\":\"delegate\",\"body\":\"Hello\",\"sentAt\":$(date +%s)000}" >> $PIXEL_AGENTS_INBOX
# → 1초 내 오피스에 delegate 호(amber) 표시 확인
# → 10초 후 자동 소멸 확인
# → TaskPanel에서 task claim → in_progress 전환 확인
# → 에이전트 종료 시 claimed task → pending 롤백 확인
```

---

### Phase 3: MCP 서버

**목표**: 파일 직접 조작 없이 MCP 툴로 coordination 사용

방식: stdio (HTTP 아닌 이유 — 포트 관리 불필요, 방화벽 문제 없음, 에이전트별 세션 격리)

터미널 생성 시 per-session `mcp-configs/<session-id>.json` 자동 생성 → `buildCommand()`에 `--mcp-config` 플래그 추가.

신규 파일: `src/mcp-server.ts`

MCP Tools:

| Tool | 인자 | 설명 |
|---|---|---|
| `pa_set_role` | role, description?, capabilities? | 역할 선언 |
| `pa_list_agents` | status_filter?, role_filter? | registry 조회 |
| `pa_send_message` | toSessionId, body, type? | 메시지 전송 |
| `pa_send_to_role` | role, body | 역할 기반 전송 |
| `pa_broadcast` | body, onlineOnly? | 전체 팀 공지 |
| `pa_create_task` | title, body, priority?, requiredRole?, dependsOn? | 태스크 생성 |
| `pa_claim_task` | taskId | 원자적 claim |
| `pa_complete_task` | taskId, success, result? | 완료/실패 보고 |
| `pa_read_inbox` | since? | inbox 읽기 |

---

## 12. 설계 결정 및 트레이드오프

### 왜 파일 기반인가 (MCP 먼저가 아닌 이유)

기존 코드베이스가 이미 두 가지 파일 폴링 패턴을 검증했다:
- `layoutPersistence.ts` — 2초 폴링, mtime 기반
- `fileWatcher.ts` — 500ms 폴링, 바이트 오프셋

Phase 1-2는 이 패턴을 재사용해 추가 의존성 없이 구현한다. Phase 3 MCP는 Phase 1-2 인프라 위의 편의 레이어다.

### 왜 Extension이 단일 write 진입점인가

에이전트가 타 에이전트 inbox에 직접 쓰면 동시 write 경쟁 조건이 발생한다. Extension이 직렬화해서 write하면 이 문제가 해소된다. 에이전트는 자신의 inbox에만 `send_to` 타입을 쓰면 되며, Extension이 감지해서 라우팅한다.

### Registry 이중 구조 (per-agent 파일 + 집약 파일)

단일 `registry.json`은 여러 VS Code 창이 동시에 쓸 때 데이터 손실이 발생한다. per-agent 파일(`agents/<session-id>.json`)은 충돌이 없지만 에이전트가 N개 파일을 읽어야 하는 부담이 있다. 두 구조를 병행해서 각각의 장점만 취한다.

### rename-based Atomic Claim (파일 시스템 lock 불필요)

POSIX `rename(2)`와 NTFS rename은 모두 원자적(atomic)이다. `pending/<id>.json` → `claimed/<id>.<session>` rename이 성공한 쪽만 태스크를 소유한다. Node.js `flock` 등 별도 lock primitive가 불필요하다.

### 단일 directory watcher (O(1) — 에이전트 수와 무관)

기존 `fileWatcher.ts`는 에이전트별로 개별 폴링 타이머를 만든다. coordination inbox를 같은 방식으로 하면 에이전트 50개일 때 50개 타이머가 추가된다. `coordinationWatcher.ts`는 `coordination/inbox/` 디렉터리 하나를 감시하고 변경된 파일만 읽어서 O(1)을 유지한다.

### Gemini/OpenAI coordination context 자동 주입

**해결**: `env` 주입과 `sendText` 모두 프로바이더와 무관하게 동작한다.

`createTerminal({ env: {...} })`는 VS Code가 셸 프로세스에 환경변수를 설정하는 것이다. 셸(bash/zsh/PowerShell) 자체가 env를 상속하므로 `gemini`, `codex` 등 어느 CLI가 실행되든 `PIXEL_AGENTS_SESSION_ID` 등을 읽을 수 있다.

`terminal.sendText()`도 마찬가지다. VS Code 터미널 stdin에 텍스트를 보내는 것이므로 `claude`, `gemini`, `codex` 구분 없이 동일하게 동작한다. CLI가 준비되기 전에 텍스트가 도착하면 버퍼링되므로, 별도 대기 없이 바로 전송해도 된다.

따라서 `agentManager.ts`에서 프로바이더 구분 없이 동일하게 적용할 수 있다:

```typescript
// 모든 프로바이더에 동일하게 적용
const terminal = vscode.window.createTerminal({
  name: terminalName,
  cwd,
  env: {
    PIXEL_AGENTS_SESSION_ID: sessionId,
    PIXEL_AGENTS_REGISTRY: path.join(coordDir, 'registry.json'),
    PIXEL_AGENTS_INBOX: path.join(coordDir, 'inbox', `${sessionId}.jsonl`),
    PIXEL_AGENTS_COORD_DIR: coordDir,
  }
});
terminal.sendText(provider.buildCommand(sessionId, options));

// 모든 프로바이더에 동일한 coordination context 전송
const coordContext = [
  `Your session ID: ${sessionId}`,
  `Team registry: $PIXEL_AGENTS_REGISTRY`,
  `Your inbox: $PIXEL_AGENTS_INBOX`,
  `To message another agent, append to $PIXEL_AGENTS_INBOX:`,
  `  {"type":"send_to","toSessionId":"<id>","msgType":"delegate","body":"...","sentAt":<ms>}`,
  `Check $PIXEL_AGENTS_INBOX for incoming messages at the start of each response.`,
].join('\n');
terminal.sendText(coordContext);
```

---

### Capability 검증

**해결**: 자유 텍스트를 허용하되 표준 프리셋을 상수로 정의하고, 라우팅 시 정규화(normalize)해서 매칭한다.

`src/constants.ts`에 추가:

```typescript
export const CAPABILITY_PRESETS = {
  'code-review':    '코드 리뷰 및 품질 검증',
  'testing':        '테스트 작성 및 실행',
  'documentation':  '문서화 및 주석 작성',
  'architecture':   '시스템 설계 및 아키텍처',
  'frontend':       'UI/UX 구현',
  'backend':        'API 및 서버 구현',
  'database':       'DB 스키마 및 쿼리',
  'devops':         'CI/CD 및 인프라',
  'security':       '보안 취약점 분석',
  'performance':    '성능 최적화',
} as const;

export type KnownCapability = keyof typeof CAPABILITY_PRESETS;
```

라우팅 시 대소문자·공백 정규화 후 매칭:

```typescript
function normalizeCapability(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '-');
}

// 에이전트 capability 필터링
function hasCapability(entry: AgentRegistryEntry, required: string): boolean {
  const norm = normalizeCapability(required);
  return entry.capabilities.some(c => normalizeCapability(c) === norm);
}
```

UI(`RoleSelector`)에서는 `CAPABILITY_PRESETS` 키를 체크박스로 표시하되, 직접 입력한 커스텀 태그도 함께 보여준다. 알 수 없는 태그는 회색 처리(unknown), 표준 프리셋은 파란색 처리로 시각적으로 구분한다.

---

### Multi-window coordination log 동기화

**해결**: `history.jsonl`을 소스 오브 트루스로 삼고 `layoutPersistence.ts`의 파일 감시 패턴을 재사용한다.

`history.jsonl`은 append-only JSONL이므로 `fileWatcher.ts`의 바이트 오프셋 방식을 그대로 쓸 수 있다.

```
VS Code 창 A                     VS Code 창 B
  coordination 이벤트 발생            coordination 이벤트 발생
        ↓                                   ↓
  history.jsonl에 append             history.jsonl에 append
        ↓                                   ↓
  coordinationWatcher가 감지         coordinationWatcher가 감지
  (바이트 오프셋 전진)               (바이트 오프셋 전진)
        ↓                                   ↓
  웹뷰에 log 이벤트 전송             웹뷰에 log 이벤트 전송
```

각 창은 자신이 처리한 byte offset을 기억하므로 이미 읽은 항목을 중복으로 읽지 않는다. 여러 창이 동시에 append해도 OS 레벨 원자성(`O_APPEND`)으로 줄이 섞이지 않는다(쓰기 크기 < 4KB일 때).

`coordinationWatcher.ts`에서 `history.jsonl`도 함께 감시:

```typescript
// history.jsonl 읽기 (바이트 오프셋)
let historyOffset = 0;

function readNewHistoryLines(): CoordLogEntry[] {
  const stat = fs.statSync(historyFile);
  if (stat.size <= historyOffset) return [];
  const buf = Buffer.alloc(stat.size - historyOffset);
  const fd = fs.openSync(historyFile, 'r');
  fs.readSync(fd, buf, 0, buf.length, historyOffset);
  fs.closeSync(fd);
  historyOffset = stat.size;
  return buf.toString('utf-8').split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}
```

이 패턴은 이미 `fileWatcher.ts`의 `readNewLines()`로 검증되어 있다. 구현 시 `readNewLines()`를 직접 재사용해도 된다.
