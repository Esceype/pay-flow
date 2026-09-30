# PayFlow — Senior-Level Architecture Plan

> **Примітка (2026-09-30):** це початковий план. Нумерація фаз і деякі
> деталі з того часу змінились — актуальний порядок фаз див. у `CLAUDE.md`
> (Build Order), рішення — у `docs/adr/`. Зокрема, «платформний endpoint для
> `account.updated`» виявився хибним припущенням: див. поправку до ADR-003.
## Stripe Subscription & Invoicing SaaS (multi-tenant, Stripe Connect), спроєктований як data-intensive система

Ціль цього плану: не просто "інтегрував Stripe", а показати мислення інженера, який
проєктує систему з розрахунком на надійність, масштабованість і коректність при
конкурентному навантаженні — саме те, про що йдеться в *Designing Data-Intensive
Applications* (Kleppmann). Кожне рішення пояснене по ходу.

> **Оновлення від попередньої версії:** проєкт — це платформа, де кожен `User`
> (бізнес-власник) підключає **власний Stripe-акаунт через Stripe Connect**, а не
> єдиний Stripe-акаунт власника SaaS. Це змінює модель даних, webhook-routing,
> виклики Stripe API з боку worker'а й onboarding-флоу — деталі нижче в кожному
> розділі, де це релевантно.

---

## 1. Чому взагалі "high load" для платіжної системи — це особлива задача

У платіжній системі найбільша небезпека — не повільність, а **неконсистентність**:
подвійне списання, загублений платіж, розсинхронізація між Stripe і своєю БД. Тому вся
архітектура нижче будується навколо трьох принципів DDIA:

1. **Reliability** — система продовжує коректно працювати навіть при збої (мережа впала,
   воркер впав посеред обробки, дублікат webhook прийшов двічі).
2. **Scalability** — система витримує ріст навантаження (більше клієнтів, більше
   webhook-подій, більше connected-акаунтів) без переписування архітектури з нуля.
3. **Maintainability** — код структурований так, щоб інша людина (чи ти сам через рік)
   міг розібратись і безпечно вносити зміни.

---

## 2. Stripe Connect: чому multi-tenant і що це змінює

PayFlow — це не інструмент для одного бізнесу, а платформа: кожен зареєстрований
`User` проходить **Stripe Connect onboarding** і підключає власний Stripe-акаунт.
Платежі, інвойси й підписки належать конкретному connected-акаунту, а не платформі.

### Наслідки для архітектури (на відміну від single-account моделі)

- **Onboarding flow**: `User` проходить Stripe Connect OAuth (Standard connected
  accounts — обираємо цей тип, бо він дає найпростіший compliance-периметр для
  портфоліо-проєкту: Stripe сам відповідає за KYC/onboarding UI, нам не треба
  імплементувати Custom-акаунти з власним UI верифікації). Зберігаємо
  `stripeAccountId` і `onboardingComplete` на `User`.
- **Два webhook endpoint'и в Stripe Dashboard**: один слухає events платформи
  (`account.updated`, коли статус onboarding змінюється), інший — Connect webhook
  endpoint, який отримує events **від усіх connected-акаунтів** із додатковим полем
  `account` у payload.
- **Ідентифікація власника події ще до вставки в БД**: `WebhookEvent` unique
  constraint має бути на композитному ключі `(stripeEventId, stripeAccountId)`,
  а не просто на `eventId` — теоретично два різні connected-акаунти можуть мати
  різні events, але в Connect-моделі `event.id` вже унікальний глобально в Stripe,
  тож практично достатньо `stripeEventId` — **проте `stripeAccountId` все одно
  обов'язково зберігаємо як окрему колонку**, бо без неї neither webhook handler,
  ні worker не знають, до якого `User` застосовувати бізнес-логіку.
- **Виклики Stripe API з боку worker'а виконуються від імені connected-акаунта**:
  кожен запит (наприклад,worker сам create/update щось у Stripe) передає
  `{ stripeAccount: user.stripeAccountId }` в опціях Stripe SDK — інакше запит
  піде в платформенний акаунт, а не в акаунт клієнта.
- **Бізнес-логіка блокується, поки onboarding не завершено**: якщо
  `onboardingComplete = false`, UI не дозволяє створювати Invoice/Checkout Session
  для цього User — сам факт підключення Stripe-акаунта ще не означає, що на ньому
  можна приймати платежі (Stripe вимагає заповнення реквізитів).

---

## 3. Ключова архітектурна проблема: Stripe Webhooks під навантаженням

### Наївний підхід (те, що робить 90% стартапів)
```
Stripe → POST /api/webhook → синхронна обробка → запис в БД → 200 OK
```
**Проблема:** якщо обробка займає довго (наприклад, ще й email надсилається синхронно,
чи робиться кілька залежних DB-записів), Stripe може відпрацювати timeout і **повторно
надіслати ту саму подію** — а ти вже, наприклад, двічі нарахував доступ в аналітиці чи
двічі відправив email клієнту.

### Наше рішення: Transactional Outbox + Message Queue

Це прямо паттерн з DDIA (розділ про Derived Data та Stream Processing) і з практики
event-driven систем:

```
Stripe → POST /api/webhook  (Connect webhook endpoint, приймає events з усіх акаунтів)
           │
           ▼
   1. Verify signature (Connect webhook secret, окремий від platform secret)
   2. Визначити stripeAccountId з payload → знайти відповідний User
   3. Check idempotency (WebhookEvent table, unique constraint на stripeEventId)
   4. Insert raw event → відповідь 200 OK Stripe НЕГАЙНО (< 1 сек)
           │
           ▼
   5. Той самий INSERT в одній транзакції додає задачу в чергу
      (Outbox Pattern: подія і "намір обробити" записуються атомарно)
           │
           ▼
   ┌─────────────────────┐
   │  BullMQ Queue        │  ← Redis-backed, окремий процес
   │  (Redis)             │
   └───────────┬───────────┘
               ▼
   ┌─────────────────────┐
   │  Worker Process       │  ← окремий Node.js процес (не той самий, що API)
   │  (обробляє чергу)      │
   └───────────┬───────────┘
               ▼
   Бізнес-логіка: оновлення Invoice/Subscription (від імені stripeAccountId),
   надсилання email, оновлення аналітики
```

**Чому це "senior"-рішення, а не overengineering:**
- Webhook endpoint відповідає Stripe миттєво (Stripe вимагає відповіді до ~10-20 сек,
  інакше вважає доставку невдалою й ретраїть — саме по собі може створити дублікати).
- Важка бізнес-логіка (email, аналітика, побічні ефекти) винесена з critical path.
- Якщо worker впаде посеред обробки — задача залишається в черзі (BullMQ підтримує
  retry з exponential backoff з коробки) — це і є "reliability" з DDIA: **збій одного
  компонента не веде до втрати даних**.

### Ordering guarantee для lifecycle-подій підписки

BullMQ за замовчуванням **не гарантує порядок обробки** паралельних job'ів навіть з
однієї черги, якщо concurrency > 1. Для Connect-подій типу
`customer.subscription.updated` → `customer.subscription.deleted`, які можуть прийти
й обробитись майже одночасно, порядок критичний: якщо "updated" обробиться після
"deleted", підписка помилково "воскресне" як активна.

**Рішення:** job'и, що стосуються однієї підписки, обробляються послідовно —
використовуємо BullMQ `group` (через `bullmq-pro` groupId) або, без платних
розширень, простіший підхід: job id формується як
`subscription:${stripeSubscriptionId}` з опцією `jobId`, і перед записом статусу
worker звіряє `event.created` (Unix timestamp від Stripe) з timestamp останньої
застосованої події для цієї підписки, збереженим у `Subscription.lastEventAt`.
Якщо вхідна подія старіша — вона ігнорується (last-write-wins за event timestamp,
не за часом обробки). Це дешевший і надійніший механізм, ніж намагатись гарантувати
чергу FIFO на рівні інфраструктури.

### Ідемпотентність на двох рівнях (важливо пояснити в коді й README)
1. **На рівні webhook**: `stripeEventId` з unique constraint в БД — Stripe генерує
   унікальний ID для кожної події, навіть при повторній доставці.
2. **На рівні бізнес-операції**: окремо від event.id, використовуй **idempotency
   key** при виклику Stripe API зі свого боку (наприклад, коли worker сам хоче
   create/update в Stripe) — це захищає від дублювання вже з ВАШОЇ сторони, якщо
   worker сам зробить retry.

Це саме той нюанс, який відрізняє "я перевіряю event.id" (базовий рівень) від "я
розумію, що ідемпотентність потрібна в обидва боки взаємодії" (senior рівень).

---

## 4. Consistency model: чому Eventual Consistency тут — свідомий вибір, а не баг

У DDIA є ключова ідея: не всі частини системи потребують strong consistency. Ми
свідомо поділяємо систему на:

- **Strongly consistent частина**: сам факт "платіж пройшов чи ні" — статус Invoice
  оновлюється синхронно в тій самій транзакції, що обробляє webhook у worker'і. Тут
  консистентність критична — не можна показати клієнту "paid", якщо насправді це
  pending.

- **Eventually consistent частина**: аналітичний дашборд (MRR, churn rate). Це
  **derived data** (термін прямо з DDIA) — обчислюється асинхронно з потоку подій і
  може відставати на секунди. Це прийнятний trade-off: власнику бізнесу не критично,
  чи дашборд оновиться за 200мс чи за 3 секунди, а от неможливість зробити
  live-агрегацію без гальмування запису транзакцій — критична для write-throughput.

**Як це показати в коді:** окрема `MaterializedRevenueStats` таблиця (read model),
яку оновлює worker асинхронно після кожної обробленої транзакції — це спрощена версія
CQRS (Command Query Responsibility Segregation): пишемо в одну модель (Transaction),
читаємо агреговані дані з іншої (MaterializedRevenueStats), оптимізованої під швидке
читання дашбордом, без важких `GROUP BY` запитів на льоту по мільйонах рядків.
Ключ агрегації — `(userId, ...)`, оскільки статистика завжди per-tenant (per
connected-акаунт), ніколи не крос-тенантна.

---

## 5. Кешування: де я навмисно (не "бо модно", а з конкретним обґрунтуванням)

Redis тут виконує дві ролі:

1. **Job queue backend** (BullMQ) — вже описано вище.
2. **Read-through cache для аналітичного дашборду** — `MaterializedRevenueStats`
   кешується в Redis з TTL (наприклад, 30 сек), щоб при 1000 одночасних власників
   бізнесу, які дивляться свій дашборд, ми не били по Postgres кожним запитом.

**Cache invalidation стратегія** (DDIA явно попереджає — "cache invalidation — одна з
двох складних речей в CS"): при кожному новому обробленому Transaction, worker явно
інвалідовує (`DEL`) відповідний ключ кешу для цього User, а не покладається лише на
TTL. Це гібрид: TTL як safety net + explicit invalidation як primary механізм.

---

## 6. Database: partitioning та indexing з розрахунком на ріст

DDIA приділяє багато уваги партиціюванню як способу масштабування запису. У нашому
випадку:

- **Transaction table** — найбільша за обсягом (кожен платіж/подія, per connected
  account). Проєктуємо схему та індекси так, щоб у майбутньому її можна було
  **партиціонувати по даті** (Postgres native partitioning,
  `PARTITION BY RANGE (created_at)`) — не обов'язково реалізовувати партиції фізично
  одразу (для pet-проєкту це overkill без реальних даних), але:
  - Схема й індекси проєктуються так, щоб партиціювання додати без міграції даних.
  - У README/ADR явно розписати: "at what data volume would we introduce
    partitioning, and how".

- **Composite indexes** там, де реально будуть запити при рості: `(userId,
  createdAt)` на Transaction для швидкої пагінації історії конкретного бізнесу,
  `(customerId, status)` на Invoice, `(stripeAccountId)` на User (унікальний, для
  швидкого lookup при вхідному webhook).

- **Explain це рішення в коді коментарем** — рев'ювер побачить не просто індекс, а
  розуміння, ЧОМУ саме такий композитний ключ, а не окремі індекси на кожне поле.

---

## 7. Rate limiting та захист від сплеску навантаження (Backpressure)

DDIA описує backpressure як механізм, коли система свідомо сповільнює/відхиляє запити,
замість того щоб впасти під навантаженням.

- **API rate limiting**: на публічних API routes (не webhook — Stripe маємо завжди
  приймати) — token bucket через Redis (можна на базі `@upstash/ratelimit` або власна
  реалізація), обмеження на користувача.
- **Webhook endpoint НЕ rate-limited** з боку прийому (ми не можемо відмовити Stripe),
  але **обробка через чергу з concurrency limit** у worker (BullMQ дозволяє задати
  `concurrency`) — це і є backpressure: черга росте, якщо навантаження стрибнуло,
  замість того щоб покласти БД одночасними конкурентними запитами.

---

## 8. Оновлена архітектурна діаграма (повна картина)

```
                        ┌───────────────────────┐
                        │   Next.js Frontend     │
                        │   (App Router, RSC)     │
                        └───────────┬─────────────┘
                                    │
                        ┌───────────▼─────────────┐
                        │   Next.js API Routes     │
                        │  (thin controllers)      │
                        └───────────┬─────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                      ▼
     ┌───────────────┐      ┌────────────────┐      ┌─────────────────┐
     │  PostgreSQL    │      │    Redis        │      │  Stripe API       │
     │  (Prisma)      │      │ (cache+queue)   │      │  (Connect,        │
     │                │      │                 │      │  Checkout,        │
     │                │      │                 │      │  Billing)         │
     └───────┬─────────┘      └───────┬─────────┘      └────────┬─────────┘
             │                        │                          │
             │                ┌───────▼─────────┐                │
             │                │  BullMQ Queue    │◀───────────────┘
             │                └───────┬─────────┘   (webhook events,
             │                        │               з полем account)
             │                ┌───────▼─────────┐
             └───────────────▶│  Worker Process   │
                               │  (Node.js,        │
                               │  окремий процес)   │
                               │  Stripe-Account:   │
                               │  {user.acctId}     │
                               └───────────────────┘

Docker Compose піднімає: postgres, redis, nextjs-app, worker — 4 окремі сервіси,
кожен масштабується незалежно.
```

---

## 9. Оновлений стек

| Шар | Технологія | Нове порівняно з базовим планом |
|---|---|---|
| Frontend/API | Next.js 14, TypeScript | без змін |
| Платежі | **Stripe Connect (Standard accounts)** | нове — multi-tenant модель |
| БД | PostgreSQL + Prisma | + partition-ready schema, `stripeAccountId` скрізь де треба |
| Черга | BullMQ + Redis | event-driven обробка |
| Worker | Окремий Node.js процес | ізолює важку логіку |
| Кеш | Redis (той самий інстанс, окрема логічна БД) | — |
| Rate limiting | Upstash Ratelimit / власний token bucket | — |
| Інфраструктура | Docker Compose (postgres, redis, app, worker) | — |
| Моніторинг черги | **Bull Board (за auth middleware, не публічний)** | уточнено — обов'язковий захист доступу |
| Тести | **Vitest/Jest: unit на idempotency/ordering логіку worker'а + integration на webhook endpoint (дублікат event, конкурентні events)** | нове — мінімальний, але явний скоуп тестів |
| Деплой | Vercel (app) + Railway/Render (worker+redis) | без змін |

---

## 10. Фази реалізації (оновлені)

### Фаза 0 — Інфраструктура та фундамент
- [ ] Docker Compose: postgres, redis, app, worker
- [ ] Prisma schema з розрахунком на партиціонування (індекси, composite keys,
      `stripeAccountId` на User)
- [ ] Базовий BullMQ setup: queue + worker, health check
- [ ] Bull Board піднятий за auth middleware (навіть у dev — звичка на майбутнє)

### Фаза 1 — Stripe Connect onboarding
- [ ] Connect OAuth flow: User підключає Stripe-акаунт (Standard)
- [ ] `account.updated` webhook (platform endpoint) → оновлення `onboardingComplete`
- [ ] UI-гейт: блокування створення Invoice/Checkout, поки onboarding не завершено

### Фаза 2 — Core webhook pipeline (серце архітектури, робимо перший)
- [ ] Connect webhook endpoint: signature verification + визначення stripeAccountId
      + insert в WebhookEvent (idempotent insert)
- [ ] Outbox: та сама транзакція додає job в BullMQ
- [ ] Worker: обробка `checkout.session.completed`, оновлення Invoice (з урахуванням
      stripeAccountId при викликах Stripe API)
- [ ] Ordering guard для lifecycle-подій підписки (event.created timestamp check)
- [ ] Retry policy на воркері (exponential backoff, max attempts, dead-letter після
      вичерпання)

### Фаза 3 — Business logic поверх pipeline
- [ ] Customer CRUD, Invoice creation → Checkout Session (per connected account)
- [ ] Subscriptions + lifecycle webhooks через той самий queue pipeline
- [ ] Email notifications як окремий job в черзі (не блокує основний потік)

### Фаза 4 — Read model та кешування
- [ ] MaterializedRevenueStats — окрема read-модель, оновлюється воркером
- [ ] Redis caching дашборду з TTL + explicit invalidation
- [ ] Rate limiting на публічних API routes

### Фаза 5 — Надійність та тести
- [ ] Dead-letter queue handling + UI перегляду невдалих задач
- [ ] Graceful degradation: якщо Redis недоступний → webhook все одно приймається й
      пишеться в БД (fallback на синхронну обробку з чергою в самій БД як backup)
- [ ] Structured logging (кожен job логується з correlation ID + stripeAccountId)
- [ ] **Тести**: unit на ordering/idempotency логіку worker'а; integration тест на
      webhook endpoint, що симулює дублікат event і конкурентні updated/deleted події

### Фаза 6 — Документація для рев'ювера
- [ ] ADR (Architecture Decision Records): `docs/adr/001-outbox-pattern.md`,
      `002-eventual-consistency-analytics.md`, `003-stripe-connect-multitenancy.md` —
      кожен: контекст, розглянуті альтернативи, чому обрано саме це рішення
- [ ] README з діаграмою, поясненням trade-offs, і explicit секцією "How this would
      scale further" (partition Transaction table at N million rows, Kafka якщо
      з'явиться multi-service архітектура, read replicas для Postgres при рості
      читання дашбордів)

---

## 11. Що саме побачить технічний рев'ювер

Досвідчений технічний інтерв'юер/клієнт на Upwork, гортаючи код, дивиться не на
кількість фіч, а на:
- Чи є ізоляція concerns (worker окремо від API)
- Чи коректно змодельована multi-tenancy (Connect, а не одна велика спільна таблиця
  без розмежування власника)
- Чи є явна обробка edge cases (дублікати, збій мережі, конкурентний доступ, порядок
  подій підписки)
- Чи документовані trade-offs (ADR) — це показує, що рішення свідомі, а не випадкові
- Чи є хоч якась форма observability (Bull Board за auth, structured logs)
- Чи є тести на найризикованіші місця (idempotency, ordering), а не 100% coverage
  заради цифри

---

## 12. Оновлений бриф для Claude Code

```markdown
# Project: PayFlow — Senior-Level Stripe Billing SaaS (multi-tenant, Stripe Connect)

## Context
Portfolio project demonstrating senior-level backend architecture for a
full-stack developer. This is a multi-tenant platform: each User connects
their own Stripe account via Stripe Connect (Standard accounts) — this is NOT
a single-Stripe-account CRUD wrapper. It should demonstrate data-intensive
systems thinking inspired by "Designing Data-Intensive Applications"
(Kleppmann): reliability under failure, eventual consistency where
appropriate, event-driven processing, correct multi-tenant data isolation,
and documented architectural trade-offs.

## Tech Stack
- Next.js 14+ (App Router), TypeScript, TailwindCSS
- PostgreSQL + Prisma ORM (schema designed to be partition-ready)
- Redis (BullMQ job queue + caching layer, same instance, separate logical DBs)
- BullMQ for event-driven webhook processing (separate worker process)
- Bull Board for queue observability, protected by auth middleware
- Stripe Connect (Standard accounts) + Checkout + Billing/Subscriptions + Webhooks
- NextAuth.js for platform authentication (User login, separate from Stripe Connect OAuth)
- Resend for transactional emails (sent via queue, not synchronously)
- Vitest for unit tests (idempotency/ordering logic) + integration tests on
  the webhook endpoint (duplicate event delivery, concurrent lifecycle events)
- Docker Compose: postgres, redis, nextjs app, worker — 4 independent services
- Deploy: Vercel (app) + Railway or Render (worker + redis)

## Multi-Tenancy Model (Stripe Connect — read this before touching the schema)
- Each `User` connects their own Stripe account via Connect OAuth (Standard
  accounts). Store `stripeAccountId` and `onboardingComplete` on User.
- Two webhook endpoints in Stripe Dashboard: platform endpoint (`account.updated`)
  and Connect endpoint (receives events from all connected accounts, payload
  includes `account` field).
- WebhookEvent stores `stripeAccountId` explicitly, resolved BEFORE insert, so
  every downstream job knows which User/tenant it belongs to.
- Any Stripe API call the worker makes on behalf of a user MUST pass
  `{ stripeAccount: user.stripeAccountId }` — omitting this sends the request
  to the platform account instead of the tenant's account.
- Business actions (create Invoice, Checkout Session) are gated on
  `onboardingComplete = true`.

## Core Architectural Pattern: Transactional Outbox + Queue
Webhook endpoint must:
1. Verify Stripe Connect webhook signature
2. Resolve stripeAccountId from payload → resolve owning User
3. Insert into WebhookEvent table with unique constraint on stripeEventId
   (idempotency check — reject/ignore duplicates)
4. In the SAME transaction, enqueue a BullMQ job (outbox pattern)
5. Return 200 OK to Stripe immediately (before any business logic runs)
6. Worker process picks up job, does the actual business logic, scoped to
   the resolved stripeAccountId

## Ordering Guarantee (subscription lifecycle events)
BullMQ does not guarantee processing order across concurrent jobs. For a
given stripeSubscriptionId, use a stable jobId (e.g.
`subscription:${stripeSubscriptionId}`) and compare incoming Stripe
`event.created` against `Subscription.lastEventAt` before applying — discard
stale events (last-write-wins by event timestamp, not by processing time).

## Consistency Model
- STRONG consistency: Invoice/Subscription status updates — synchronous
  within the worker's transaction before marking job complete.
- EVENTUAL consistency: analytics (MRR, churn) — separate read model
  (MaterializedRevenueStats table, keyed per User/tenant), updated
  asynchronously after each processed transaction.

## Idempotency (two layers — implement both)
1. Inbound: WebhookEvent.stripeEventId unique constraint.
2. Outbound: worker's own Stripe API calls use Stripe's idempotency-key
   parameter to protect against duplicate calls on worker retry.

## Caching Strategy
- Redis caches MaterializedRevenueStats per user with TTL (~30s) as a safety
  net, AND explicit cache invalidation (DEL) triggered by the worker on every
  new transaction affecting that user. Do not rely on TTL alone.

## Database Design Notes
- Transaction table: design schema/indexes anticipating future
  PARTITION BY RANGE (createdAt) without implementing it physically yet —
  document the reasoning and threshold in an ADR.
- Composite indexes: (userId, createdAt) on Transaction, (customerId, status)
  on Invoice, unique index on User.stripeAccountId — comment explaining why
  composite over separate single-column indexes.

## Rate Limiting / Backpressure
- Public API routes: token bucket rate limiting per user.
- Webhook endpoint is never rate-limited on receipt; worker concurrency is
  capped via BullMQ's concurrency option to create backpressure instead of
  overwhelming the database.

## Testing Scope (minimal but explicit — do not skip)
- Unit tests: idempotency check logic, ordering/staleness check logic.
- Integration tests: webhook endpoint receiving a duplicate event (must not
  double-process), and two out-of-order subscription lifecycle events
  (must apply only the newer one).

## Build Order (confirm with me after each phase before proceeding)
0. Docker Compose infra + Prisma schema
1. Stripe Connect onboarding flow (OAuth, account.updated handling, UI gate)
2. Webhook pipeline: signature verification → resolve tenant → idempotent
   insert → outbox enqueue → worker processes checkout.session.completed →
   ordering guard → retry/backoff/dead-letter → Bull Board (auth-protected)
3. Customer CRUD, invoice creation, Checkout integration (per connected account)
4. Subscriptions + lifecycle webhooks through the same pipeline
5. MaterializedRevenueStats read model + Redis caching + rate limiting
6. Dead-letter queue UI, graceful degradation if Redis is unavailable,
   structured logging with correlation IDs + stripeAccountId, test suite

## Documentation Deliverables
- docs/adr/ folder: ADRs for outbox pattern, eventual consistency for
  analytics, partition-ready schema, caching strategy, Stripe Connect
  multi-tenancy — format: Context / Options Considered / Decision / Consequences
- README.md: architecture diagram, setup instructions, explicit
  "How this would scale further" section

## Working style
I have 4 years of full-stack experience and am comfortable reviewing code,
but I'm using you to move faster and to correctly implement patterns I
understand conceptually but haven't fully implemented myself before. After
each phase, pause, summarize what was built, and explain any non-obvious
implementation decisions before I review and we proceed.
```

---

## 13. Реалістичний таймлайн

| Тиждень | Фокус |
|---|---|
| 1 | Docker Compose, Prisma schema, Stripe Connect onboarding, базовий webhook pipeline (outbox + queue), worker skeleton |
| 2 | Повний webhook lifecycle (checkout, subscriptions), ordering guard, retry/dead-letter, Bull Board |
| 3 | Business logic (Customer/Invoice/Subscription CRUD та UI) поверх готового pipeline |
| 4 | Read model, кешування, rate limiting, graceful degradation, тести |
| 5 | ADR-документація, README, деплой (Vercel + Railway), демо-відео |

~5 тижнів при частковій зайнятості — реалістично, з огляду на те, що це вже не
"вихідний проєкт", а серйозний портфоліо-кейс.

---

## 14. Наступний крок

1. Створити репозиторій, одразу з `docker-compose.yml` як перший файл.
2. Вставити бриф з розділу 12 в Claude Code як перше повідомлення або зберегти як
   `CLAUDE.md`.
3. Почати з Фази 0 → Фази 1 (Connect onboarding) — зупинитись саме на межі Фази 1/2
   для рев'ю, перш ніж торкатись webhook pipeline, бо саме на цьому фундаменті
   будується все інше.
