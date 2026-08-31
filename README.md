# OmniChat AI

AI-powered omnichannel customer support and sales, in one Next.js app.
WhatsApp · Instagram · Messenger · Stripe payments · Google Gemini.

A customer messages your business. The AI answers using your real catalog,
places orders, and returns a payment link. When it can't help, a human takes
over from the Inbox.

---

## Contents

1. [What you need](#what-you-need)
2. [Setup](#setup)
3. [How it fits together](#how-it-fits-together)
4. [Project layout](#project-layout)
5. [Commands](#commands)
6. [Connecting a channel](#connecting-a-channel)
7. [Payments](#payments)
8. [Deploying](#deploying)
9. [Troubleshooting](#troubleshooting)
10. [Known gaps](#known-gaps)

---

## What you need

| | Why | Cost |
|---|---|---|
| **Node.js 18.17+** | Runs the app | free |
| **A Supabase project** | Database and sign-in | free tier |
| **A Gemini API key** | The AI replies | free tier |
| A Meta Business account | Only for live WhatsApp/Instagram/Messenger | free, needs verification |
| A Stripe account | Only for taking payments | free to test |

The first three are enough to run everything except live channels and real
payments.

---

## Setup

**1. Install**

```bash
npm install
```

**2. Create the database**

In your Supabase project, open the **SQL Editor**, paste all of
[`supabase/schema.sql`](supabase/schema.sql), and Run. It is idempotent — safe
to re-run whenever the schema changes.

This creates all 16 tables, row-level security on every one of them, and the
realtime publication the live Inbox depends on.

**3. Configure**

```bash
cp .env.example .env.local
```

Fill in the four required values. From Supabase → Project Settings → API:

| Variable | Where |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | "Project URL" |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the `publishable` key (safe in a browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | the `secret` key — **server only, never expose** |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey |

**4. Turn off email confirmation** (development only)

Supabase → Authentication → Sign In / Providers → Email → uncheck
**Confirm email**. Otherwise your first sign-up waits on a confirmation mail.

**5. Run**

```bash
npm run dev     # http://localhost:3000
```

Sign up, enter your name and business name, and you're in.

---

## How it fits together

```
Customer on WhatsApp / Instagram / Messenger
                │
                ▼
   /api/webhooks/whatsapp   (signature verified, fails closed)
   /api/channels/instagram
   /api/channels/messenger
                │
                ▼
        lib/channels/pipeline.ts
        dedupe → store → ask the AI → send the answer
                │
                ▼
          lib/ai/gemini.ts
   Gemini + tools: search_products, create_order
   Falls back model → model → catalog → plain apology.
   Never throws: a 500 makes Meta retry and double-send.
                │
                ▼
             Supabase
                │
                ▼
   Dashboard  ── live via Supabase realtime
```

**One AI brain, one order path.** The chat agent and
`POST /api/orders/create` both go through `lib/orders/create.ts`, so a price
quoted in chat and a price charged at checkout cannot drift apart. Prices are
always read from the database — never taken from the caller, and never
invented by the model.

**Every dashboard endpoint is authenticated.** The business is resolved from
the caller's session token; the browser never names which business it wants.

---

## Project layout

```
app/
  api/
    ai/chat            widget/chat endpoint
    campaigns/         scheduler (cron-protected)
    carts/[id]/remind  abandoned-cart reminder
    channels/          Instagram + Messenger webhooks
    dashboard/         stats, conversations, reply, status
    orders/create      create an order, optional Stripe link
    products/upload    CSV catalog import
    webhooks/          WhatsApp + Stripe
components/            dashboard UI
hooks/                 data hooks + realtime subscription
lib/
  ai/gemini.ts         the AI brain and its tools
  channels/            adapters, pipeline, signature verification
  orders/create.ts     the one order path
  supabase/            clients, types, auth helper
store/                 Zustand UI + inbox state
supabase/schema.sql    the whole database
tests/                 npm test
```

---

## Commands

```bash
npm run dev        # development server
npm run build      # production build
npm start          # serve the production build
npm test           # 18 tests (node:test + tsx)
npm run typecheck  # tsc --noEmit
npm run lint       # next lint
```

---

## Connecting a channel

Live channels need a Meta Business account with a verified business — that
part takes days and is outside this repo.

Once you have one, add these to `.env.local` (see `.env.example`), then in the
dashboard go to **Channels → Connect WhatsApp** and paste your Phone Number ID
and access token:

```
WHATSAPP_VERIFY_TOKEN=any-long-random-string-you-invent
WHATSAPP_APP_SECRET=from Meta → App Settings → Basic
WHATSAPP_DEFAULT_BUSINESS_ID=your business row id
```

In Meta's webhook settings, point the callback at
`https://your-domain/api/webhooks/whatsapp` and use the same verify token.

**`WHATSAPP_APP_SECRET` is not optional.** Signature verification fails closed:
with no secret configured, every webhook is rejected. That is deliberate — the
alternative is a typo silently disabling authentication.

---

## Payments

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Point a Stripe webhook at `https://your-domain/api/webhooks/stripe` for the
`checkout.session.completed` event. Orders move to `paid` and the customer
gets a confirmation in the same chat thread.

Without these, orders are still created — just without a payment link, and the
API says so rather than failing silently.

---

## Deploying

The app is a single Next.js deployment; Vercel's free tier is enough.

1. Push to GitHub
2. Import the repo at vercel.com
3. Add the same environment variables from `.env.local`
4. Deploy, then set `NEXT_PUBLIC_APP_URL` to the URL you get back

---

## Troubleshooting

**Pages are empty and never load data.** The schema hasn't been run, or
`SUPABASE_SERVICE_ROLE_KEY` is missing. Check the browser console.

**Sign-up appears to do nothing.** Email confirmation is on — check your
inbox, or turn it off (step 4 above).

**The Inbox doesn't update live.** Re-run `supabase/schema.sql`; the realtime
publication is section 11 and was added later than the tables.

**The AI answers but ignores your catalog.** Products must have
`is_active = true` and belong to your business. Try the Catalog page.

**Meta webhooks return 403.** The verify token or app secret doesn't match.
Both must be identical in `.env.local` and in Meta's settings.

---

## Known gaps

Honest list of what is not finished:

- **Campaign delivery.** Recipients are queued and the campaign stays
  `scheduled`. No messages are sent, and nothing claims otherwise.
- **Template messages.** Outside WhatsApp's 24-hour window, replies and cart
  reminders are refused with an explanation rather than sent as templates.
- **The web widget.** `widget.js` posts to an endpoint that doesn't exist.
- **Team management.** The Settings tab lists agents but can't invite them.
- **Billing.** Plan tiers are static copy; no Stripe subscription is wired up.
