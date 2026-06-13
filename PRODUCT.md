# Product Baseline — Trade Compliance Classification Engine

## Product Promise
A dense internal workbench that turns importer product catalogs into evidence-led, repeatable customs classification recommendations. The product helps compliance teams see why a recommendation exists, what was rejected, and what still needs human review.

## Primary Users
- Admins who register tenants, manage users, upload rule packs, and configure optional integrations.
- Classifiers who import catalog rows, repair readiness errors, and start classification runs.
- Reviewers who inspect low-confidence or high-risk decisions and create structured overrides.
- Auditors who download immutable JSON/PDF/CSV evidence packs without changing decisions.

## Product Personality
Calm, precise, audit-friendly, and explicit about uncertainty. The interface should feel like a compliance control room: compact information density, clear hierarchy, low decoration, and confident warning states.

## Trust Boundaries
- Always show rule-pack version, matched facts, matched rules, rejected alternatives, confidence, risk band, and reviewer history when a classification is presented.
- Never imply legal advice or guaranteed customs correctness.
- Preserve original machine decisions after override; corrections are append-only evidence.
- Make optional RAG, Notification Hub, and Workflow integrations visibly non-blocking.
- UI controls may mirror policies, but server-side authorization remains the source of truth.

## Anti-References
No generic SaaS marketing gloss, no playful customs metaphors, no hidden security-by-UI controls, no RAG-first experience, no unexplained gradients, no decorative dashboards that obscure audit evidence.
