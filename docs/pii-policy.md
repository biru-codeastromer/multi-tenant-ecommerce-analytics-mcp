# PII policy

## The problem

`events.properties` is an open JSONB bag filled by client SDKs we do not control. In
practice it accumulates contact details nobody intended to send: a checkout form serialises
its whole state, a debug field ships to production, a developer adds `contact_email`
"temporarily". The seed data reproduces this deliberately — ~18% of orders carry a
`contact_email` and ~10% a `contact_phone`.

For an analytics MCP the risk is specific and worse than ordinary data exposure: query
results flow into a model's context window, which may be logged, cached by the model
provider, or replayed in a later turn. **A customer email that reaches the context window
has left the database's control permanently.**

## Controls

### 1. Detection (discovery job)

Property keys are flagged `is_pii` when either the key name or its observed values match:

- **Key patterns** — `email`, `phone`, `mobile`, `msisdn`, `address`, `street`, `postcode`,
  `zip`, `pincode`, `ssn`, `aadhaar`, `pan`, `dob`, `birth`, `card`, `cvv`, `iban`,
  `account_no`, matched on word boundaries.
- **Value patterns** — anything shaped like an email address or an 8–15 digit phone number.

Value matching matters because the key is often uninformative (`p_src`, `field_7`).

### 2. Sample withholding (registry)

**Values of PII-flagged keys are never persisted into the registry.** `sample_values` is
stored empty and `enum_values` is left `NULL`.

This is the highest-leverage control here. The registry feeds the data dictionary shipped
to every model on every connection — a sample containing a real email would be transmitted
on *every session*, indefinitely, to *every* client. The key is still documented, so the
model knows it exists and what type it is; only the values are withheld.

Asserted by `tests/injection.test.ts` and `tests/discovery.test.ts`.

### 3. Masking at read time

`public.mask_pii(text)` is available for query paths that surface property values:

| Input | Output |
|---|---|
| `alice.smith@example.com` | `a***@example.com` |
| `+919812345678` | `***78` |
| `blue running shoes` | `blue running shoes` (untouched) |

Partial rather than total masking is intentional: the domain of an email and the last digits
of a phone are frequently the analytically useful part ("how many orders from corporate
domains?"), while the identifying part is removed.

### 4. Audit log redaction

Tool arguments are model-authored free text and can contain anything a user pasted into the
chat. Before persisting, keys matching `api_key`, `token`, `secret`, `password`,
`authorization`, `bearer` are replaced with `[redacted]`, and long strings are truncated.

## Limits — stated plainly

This policy is **pattern-based**, and pattern-based detection has a floor:

- **Names are not detected.** `properties->>'customer_name'` is caught by key pattern only
  if it matches the list; a value like "Priya Sharma" is indistinguishable from a product
  name or a search query by shape alone.
- **Free-text addresses are not reliably detected.** Street addresses have no consistent
  format across the markets in this dataset.
- **Unusual key names are missed.** An SDK writing `f_17` with an email inside is caught by
  the *value* pattern, but only if a matching value lands in the sample.
- **Masking is not applied to `run_sql` output by default.** A caller who explicitly selects
  `properties->>'contact_email'` gets it. This is a deliberate trade: the tenant already
  owns that data, and silently mutating raw SQL results would make the tool untrustworthy
  for legitimate use. The exposure boundary is the tenant's own model context, not another
  tenant.
- **Detection runs at discovery time**, so a PII key that starts appearing between runs is
  unflagged until the next cycle (hourly).

## What I'd do with more time

1. **Ingest-time rejection or hashing** — the real fix. Catching PII at write time means it
   never lands in the store, rather than being masked on the way out. Requires a schema
   contract per org, which is a client-onboarding problem as much as a technical one.
2. **An allowlist rather than a denylist** — orgs declare which property keys are
   analytically meaningful; everything else is stored but never returned. Denylists lose to
   novelty by construction; allowlists fail closed.
3. **A trained NER pass** over sampled values for names and addresses, which regexes cannot
   reach.
4. **Per-org policy configuration** — jurisdictions differ, and a GDPR-scope merchant needs
   stricter defaults than the platform's.
5. **A right-to-erasure path** — `events` is append-only by design, which is correct for an
   event store and awkward for GDPR Article 17. The usual answer is crypto-shredding:
   encrypt per-user PII fields with a per-user key and delete the key on request.
