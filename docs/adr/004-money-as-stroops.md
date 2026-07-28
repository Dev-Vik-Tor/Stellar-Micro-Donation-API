# ADR-004: Represent Monetary Amounts as Stroops Internally

**Status:** Accepted  
**Date:** 2024-04-05  
**Deciders:** Core team

---

## Context

Stellar amounts are natively expressed in **stroops** — the smallest indivisible unit of
XLM, where 1 XLM = 10,000,000 stroops. The Stellar SDK and Horizon API both use stroops
for all amount fields to avoid floating-point representation issues.

The application needs to store, compute, and compare donation amounts. Using
floating-point XLM values for these operations risks:

- Rounding errors accumulating across many small donations
- Incorrect comparisons (e.g. `0.1 + 0.2 !== 0.3` in IEEE 754)
- Mismatch with Horizon responses that already use stroop integers

The user-facing API, however, should accept and display amounts in XLM for readability.

## Decision

All **internal representations, database columns, and Stellar SDK calls** use
**integer stroops**. The API layer converts between XLM (user-facing) and stroops
(internal) at the request/response boundary using the helpers in
`src/utils/stellarUtils.js` (`xlmToStroops`, `stroopsToXlm`).

Donation validation limits (`MIN_DONATION_AMOUNT`, `MAX_DONATION_AMOUNT`) are defined
in XLM in environment variables and converted to stroops at startup.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Store amounts as floating-point XLM | Floating-point arithmetic is unsuitable for money; rounding errors compound |
| Store amounts as `DECIMAL(19,7)` strings | SQLite has no native decimal type; string comparisons don't sort numerically |
| Use a big-integer library for XLM | Unnecessary indirection when the Stellar protocol already defines stroops as the canonical unit |

## Consequences

**Positive:**
- Integer arithmetic is exact — no rounding errors.
- Direct compatibility with Stellar SDK and Horizon API amounts.
- Database `INTEGER` columns sort and compare correctly.
- Overflow risk is negligible: the maximum XLM supply in stroops fits in a 64-bit
  integer (JavaScript's `Number.MAX_SAFE_INTEGER` covers ~900 billion XLM).

**Negative / trade-offs:**
- Developers must remember the XLM↔stroop boundary and use the conversion helpers.
  Mixing units is a latent bug risk; code review should check all amount handling.
- Logging and debugging show large integers instead of human-readable XLM decimals.
  The helpers include a `formatXlm` utility for display contexts.

**Follow-on tasks:**
- [x] Add `xlmToStroops` / `stroopsToXlm` helpers to `src/utils/stellarUtils.js`
- [ ] Database migration to ensure all `amount` columns are `INTEGER`
- [ ] Linting rule or code-review checklist entry to catch direct floating-point
  amount comparisons

---

*See also: `src/utils/stellarUtils.js`, Stellar documentation on
[lumens and stroops](https://developers.stellar.org/docs/learn/fundamentals/lumens)*
