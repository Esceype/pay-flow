# ADR-011: Refunds — mirrored from Stripe, recorded in an append-only ledger

## Context

A tenant needs to give money back: all of a payment or part of it, from
PayFlow. Tenants also refund from their own Stripe Dashboard, and PayFlow
can't stop them. Its figures must still match what happened.

A refund is not an instant fact. Stripe creates it as `pending`, usually
settles it as `succeeded`, and can still turn a succeeded refund into
`failed` days later when the customer's bank returns the money. A refund
can also be `canceled` before it settles. Stripe reports each change with
`refund.created`, `refund.updated` and `refund.failed`. As with every
other webhook (ADR-001), these arrive at least once and in no guaranteed
order.

Out of scope: disputes. They also take money back, but they have a
lifecycle of their own (evidence, won, lost). They would land in the same
ledger as negative entries.

## Decisions

### 1. A `Refund` row per refund, with Stripe as the source of its status

A payment can be refunded several times in part, and each refund has its
own lifecycle. So a refund is its own row, pointing at the payment (the
`Transaction`) it refunds, rather than a column on the payment.

Its status mirrors Stripe's. There is one writer: the worker, processing
refund events. This is the same rule as for subscriptions (ADR-007). The
request handler that asks Stripe for a refund does not store the status
from Stripe's response, even though the response carries one. If it did,
there would be two writers racing.

There is one exception. When Stripe **rejects** the request outright (a
4xx other than 409/429: the payment was disputed, or is already fully
refunded), no refund exists in Stripe and no event will ever arrive for
it. The request handler then marks the row `FAILED` itself, so the amount
it had set aside is free again.

### 2. Requesting a refund: intent-first, under a lock on the payment

This is the two-layer idempotency of invoices (ADR-006), plus a check that
needs a lock:

1. **Lock the payment row** (`SELECT … FOR UPDATE`), read its refunds, and
   check that the amount fits within what is still refundable. Then
   insert the `Refund` row (`PENDING`) and commit. The lock is what makes
   the check mean anything. Without it, two requests at the same moment
   both see the full amount available, and together refund more than was
   paid. A pending refund counts against the refundable amount: it may
   still succeed.
2. **Call Stripe** on the tenant's account. The idempotency key is
   `refund-<row id>`, and the row id goes in the refund's metadata
   (`payflowRefundId`).
3. **Store the Stripe refund id** on the row, if the worker hasn't
   already linked it from `refund.created`.

A `requestKey` rendered into the form (unique) turns a double submit into
the same row, as for invoices and subscriptions.

If Stripe never answers (a timeout, an outage), PayFlow can't know
whether the refund was made. The row stays `PENDING` and unlinked, and it
keeps the money set aside. If Stripe did make the refund, its
`refund.created` event links the row through the metadata. If it didn't,
the payments page offers **Retry**, which sends the same request under the
same idempotency key, so a refund Stripe already made is returned rather
than made twice.

### 3. Status changes: forward only, no timestamps

Unlike a subscription's, a refund's states form a graph with no cycles:

```
PENDING ──▶ SUCCEEDED ──▶ FAILED
   │                        ▲
   ├────────────────────────┘
   └──▶ CANCELED
```

Stripe never moves a refund backwards: a failed refund is not retried,
and a new refund is created instead. So applying an event means "move to
the event's status if that is a step forward from where the row is now;
otherwise ignore it". That converges on Stripe's final state whatever
order the events are processed in, and it needs no `event.created`
comparison. Subscriptions cycle (`active ↔ past_due`), so they need the
ordering guard of ADR-007; refunds don't.

The row is **locked before its status is read**. The transition being
taken decides the ledger entry (decision 4), so the read and the write
must see the same state. Two conditional UPDATEs tried one after the
other ("from SUCCEEDED", then "from PENDING") are not enough. A
`succeeded` committed between them would leave a `failed` matching
neither, and the refund would stay succeeded when it isn't. A test lines
the two events up behind a held row lock to reproduce exactly that.

### 4. The ledger is append-only and signed

Money movements are `Transaction` rows, as for payments, linked to the
refund (`refundId`) and to the payment's invoice or subscription:

| transition            | entry                                   |
| --------------------- | --------------------------------------- |
| `PENDING → SUCCEEDED` | `refund`, −amount                       |
| `SUCCEEDED → FAILED`  | `refund_reversal`, +amount              |
| anything else         | none (no money moved)                   |

A refund that fails after succeeding is not "un-recorded". The debit
stays, and a credit cancels it. Each entry is written in the same
transaction as the status change that causes it, and that change can
happen only once. So a duplicate or concurrent event writes nothing. This
is the "conditional transition guards the insert" pattern of invoice
payments.

Lifetime revenue in the read model (ADR-002) is the sum of the ledger, so
it is **net of refunds** with no special case. The refunded total is shown
next to it. A pending refund doesn't count until it succeeds. MRR is
unaffected: a refund gives back money already paid, and does not change
what a subscription will charge next.

### 5. Payment intents are looked up when first needed

A refund is made against a payment intent, and a refund names only its
payment intent. Neither payment webhook carries one in this API version
(`2026-07-29.dahlia`): `checkout.session.completed` has
`payment_intent: null`, and `invoice.paid` has no `payments`. So the link
is looked up from Stripe the first time a refund needs it, and kept on the
`Transaction`:

- **Our payment → its payment intent** (a refund requested in PayFlow):
  for a one-time invoice, from its Checkout Session; for a subscription
  payment, from the Stripe invoice's payments (`invoicePayments.list`).
- **A payment intent → our payment** (a refund made in the Stripe
  Dashboard): first our stored column, then Stripe's invoice payments for
  that intent, then Checkout Sessions for it.

The alternative was to fetch the intent while recording each payment.
That would put a Stripe API call into every payment's processing for the
benefit of the few that get refunded, and it would make recording a
payment depend on Stripe's API being up. Recording a payment stays a
webhook-only path. Subscription payments now also store their Stripe
invoice id; the migration backfills it from the stored `invoice.paid`
events.

### 6. Refunds made in the Stripe Dashboard are mirrored

A `refund.*` event that carries no `payflowRefundId` is matched to one of
the tenant's payments by payment intent (decision 5), and recorded as a
new `Refund` row with no `requestKey`. The payments page marks it "made in
Stripe". Insertion is insert-first on the unique Stripe refund id, so two
events for the same refund processed at once create one row. A refund of
a payment PayFlow didn't record (a sale made outside it) is acknowledged
and ignored, like every other event about an object PayFlow didn't create.

### 7. Tenant isolation

Metadata is editable by the tenant, so `payflowRefundId` is not trusted on
its own. It links only to a row of the event's tenant that isn't linked
yet. A Stripe refund id that is already linked to another tenant's row is
treated as corruption: `UnrecoverableError`, a dead letter. All
payment-intent lookups run on the event's connected account and are scoped
to the event's tenant.

### 8. The platform fee is given back in proportion

Refunds are requested with `refund_application_fee: true`. Refunding half
a payment returns half of PayFlow's application fee to the tenant. The
platform gives up its fee on money that didn't stay with the tenant,
which is the fairer default for a billing tool. Stripe's own processing
fee is not returned by Stripe in either case.

### 9. A refund doesn't change the invoice or the subscription

A refunded invoice stays `PAID`: it was paid, and the refund is a later,
separate movement of money, visible on the payments page. A refund
doesn't cancel a subscription; that is a separate decision with its own
button. This keeps every status owned by exactly one kind of event.

### 10. One email when a refund fails

Success is what the tenant expects; a failure means the customer didn't
get their money back and someone has to act. So only a refund that ends
`FAILED` emails the tenant (ADR-010). Stripe reports one failure with two
events (`refund.updated` and `refund.failed`), so this notification is
de-duplicated per **Stripe refund**, not per event:
`refund_failed:<stripe refund id>`.

## Consequences

- The first refund of a payment costs one or two extra Stripe API calls to
  find its payment intent; later ones cost none.
- A refund whose request got no answer stays "awaiting Stripe" until its
  `refund.created` arrives or the tenant presses Retry. Nothing retries it
  in the background. A refund is a decision about money, and resending one
  without the tenant is not PayFlow's call.
- Refunds of payments made outside PayFlow are not shown, just as those
  payments aren't.
- The webhook endpoint must have `refund.created`, `refund.updated` and
  `refund.failed` enabled.
- Disputes are not handled. Adding them means new negative ledger entries
  and their own lifecycle; the read model would need no change.
