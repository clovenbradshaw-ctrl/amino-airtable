# Interface Functionality Audit: Execution Plan for Immigration CRM

## Purpose

This plan operationalizes two inputs into a delivery sequence:
1. **Interface Functionality Audit: 10 Improvement Opportunities** (priority-driven UX/platform fixes).
2. **Immigration CRM Interface: Current-State Audit and Replacement Blueprint** (domain-specific IA and casework priorities).

The objective is to deliver a safer, more accessible, and more casework-effective interface in phased increments with clear acceptance criteria.

---

## Delivery sequencing

- **P0 (stabilize + de-risk now):** #1, #2, #3, #4, #10
- **P1 (hardening + operational quality):** #7, #8, #9
- **P2 (structural refactor + product orientation):** #5, #6

### 90-day alignment
- **Weeks 1–4 (Phase 1):** P0 focus + Client Overview shell + actionable empty/error states.
- **Weeks 5–8 (Phase 2):** timeline unification, risk grouping, status chips, logging + endpoint hardening.
- **Weeks 9–12 (Phase 3):** matter workspace intelligence, modularization milestones, role-aware defaults.

---

## Workstream A — UX safety/accessibility foundation (P0)

### 1) Replace browser dialogs with first-class modals
**Why:** Blocking browser dialogs break UX consistency and limit validation/accessibility.

**Execution**
- Build reusable modal primitives:
  - `ConfirmModal`
  - `InputModal`
  - `DestructiveConfirmModal`
- Migrate high-traffic flows first:
  - folder/workspace create-rename-delete
  - move-to-folder/workspace
  - role visibility picker
  - destructive local reset and sign-out confirmation
- Accessibility baseline:
  - focus trap
  - keyboard escape
  - labelled title + description (`aria-labelledby`, `aria-describedby`)
  - return focus to invoking trigger on close

**Acceptance criteria**
- No core app usage of `prompt`, `alert`, `confirm`.
- All migrated actions support non-destructive cancel and inline validation.

### 2) Destructive-action safety with impact preview + undo
**Why:** Legal operations cannot tolerate accidental destructive edits.

**Execution**
- Add impact previews in destructive modals (affected records, scope, reversibility).
- Introduce typed confirmation for irreversible actions (e.g., local DB reset).
- Add undo to reversible operations (soft-delete with toast action and timeout).

**Acceptance criteria**
- High-risk operations require explicit secondary confirmation.
- Reversible operations provide undo.

### 3) Restrict “Skip encryption” path
**Why:** Unencrypted storage should be policy-controlled, not convenience-enabled.

**Execution**
- Gate unencrypted mode behind org policy (`encryption_required=true` default).
- Hide bypass path behind admin-only flag when policy allows.
- Strengthen copy with explicit risk acknowledgement when bypass is enabled.

**Acceptance criteria**
- Default behavior blocks unencrypted mode.
- Enforcement is policy-driven, not only client preference.

### 4) Re-enable zoom and validate large-scale usability
**Why:** Zoom lock is an accessibility blocker.

**Execution**
- Remove viewport zoom lock.
- Run usability checks at 200% zoom and large text.
- Fix overflow/cropping on login/table/settings screens.

**Acceptance criteria**
- Mobile zoom available.
- Primary workflows are usable at 200% zoom.

### 10) Replace blocking alerts with contextual guidance
**Why:** Generic alerts interrupt flow and hide recovery options.

**Execution**
- Inline errors near failing field/action.
- Recovery-oriented messaging (`Retry`, `Fix input`, `Contact admin`).
- Toasts for transient non-blocking status.

**Acceptance criteria**
- Validation/import errors render in context.
- Users recover without hard refresh.

---

## Workstream B — immigration casework UX (P0→P1)

### IA target
- Global nav: Home, Clients, Matters, Calendar, Communications, Tasks.
- Client workspace tabs: Overview, Matters, Timeline, Documents, Deadlines, Contacts/Family, Applications & Filings.

### P0 immediate UI moves
1. Make **Overview** the default client tab.
2. Add **risk-first top strip** (next critical date, matter stage chip, quick actions).
3. Replace generic error/empty states with guided next steps.

### P1 operating model upgrades
1. Launch **unified timeline** with note/event/comms/doc filters.
2. Add **critical date stack** (today/7/30-day buckets with severity + owner).
3. Add **status chips** for stage, urgency, agency, outcome in list rows.

### P2 intelligence layer
1. Matter workspace stage tracker + checklist templates.
2. Case health score (deadline risk, stale comms, missing docs).
3. Related individuals graph + shared dependency alerts.

---

## Workstream C — engineering hardening (P1/P2)

### 7) Remove inline event handlers (P1)
- Replace inline `onclick`/attribute handlers with delegated listeners.
- Centralize event wiring by feature module.
- Enforce CSP-compatible pattern for new templates.

### 8) Structured logging and redaction (P1)
- Introduce logger levels: `debug/info/warn/error`.
- Disable debug in production by default.
- Redact tokens, IDs, and sensitive payload fields.

### 9) Remove direct webhook exposure (P1)
- Move privileged triggers behind server-managed API routes.
- Load environment config from trusted bootstrap endpoint.
- Document endpoint rotation and revocation operations.

### 5) Product naming/orientation (P2)
- Replace internal-facing labels with role-and-task-oriented language.
- Add role-aware welcome and first-step guidance.

### 6) Break up monolithic front-end (P2)
- Split monolithic implementation into modules (auth, sync, builder, settings, views).
- Extract shared CSS/utilities.
- Add build/lint gates and module-boundary documentation.

---

## Definition of Done (cross-cutting)

- Accessibility checks pass for keyboard navigation and zoom/text scaling scenarios.
- No blocking browser dialogs in core workflows.
- Error/empty states provide concrete recovery actions.
- Security-sensitive paths are policy-enforced and auditable.
- Metrics instrumentation shipped for adoption and error recovery.

## Success metrics

1. Time to find next required action: **target -40%**.
2. Overdue deadline rate: **target -50%**.
3. Matter updates completed within SLA: **target +35%**.
4. Weekly active usage by role: **upward trend**.
5. Error-state abandonment rate: **target -60%**.
6. Task completion for create/move view + workspace and password reset: **upward trend**.
