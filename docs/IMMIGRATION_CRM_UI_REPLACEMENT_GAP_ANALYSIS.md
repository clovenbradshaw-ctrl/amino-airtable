# Immigration CRM Interface: Current-State Audit and Replacement Blueprint

## Goal

This document evaluates the current interface direction against the legacy system shown in reference screenshots and outlines how to make the replacement app materially better for immigration-law casework.

---

## 1) What the legacy app gets right (and must be preserved)

The legacy UI (Softr-based screenshots) has several patterns worth preserving:

1. **Single client workspace**
   - Caseworkers stay in one client context and move laterally across tabs.
   - Key legal modules are present in one place: Client Info, Matters, Case Notes, EAD, Activities, Deadlines, Record Requests, Related Individuals, Applications.

2. **Action-first top lane**
   - Frequent tasks are one click away: New Client Event, New Case Note, Quick Search, calendar and communications.

3. **Operational breadth**
   - It supports both legal progression (matters, applications, hearings, deadlines) and operational execution (comms, notes, requests, linked individuals).

4. **Dense information scanning**
   - Users can rapidly skim many records in list/table layouts.

These are the right foundations for immigration CRM work and should be retained in the new product.

---

## 2) Current-state issues to fix (from the replacement direction + legacy pain points)

### A. Information architecture is broad but not casework-centric

The current shape is tab-heavy and object-centric, but legal teams think in:
- **matter lifecycle** (intake → filing → biometrics/interview/hearing → decision → post-decision),
- **critical dates**,
- **missing documents**,
- **next best action**.

Today, those are scattered across tabs instead of being orchestrated in one case control center.

### B. Weak “at-a-glance” legal triage

Caseworkers need immediate visibility into:
- next hearing/interview,
- SLA-risk deadlines (7/14/30 day buckets),
- case stage and blockers,
- document completeness,
- last client contact.

The current experiences over-emphasize neutral lists while under-emphasizing legal risk indicators.

### C. Error and empty states are non-actionable

Observed states like “Something went wrong. Please refresh” and “No results found” give no operational recovery path.

For legal operations, empty/error states should suggest safe next actions:
- reconnect source,
- create first matter,
- link existing client,
- open escalation ticket,
- retry specific data source only.

### D. Navigation overload and visual competition

The interface places many primary actions and tabs at equal visual weight. This creates decision friction and increases miss-click risk for high-frequency staff workflows.

### E. Fragmented timeline of truth

Activities, hearings, case notes, and communications are split into separate panels/tabs. Users must mentally reconstruct chronology—high cognitive load for litigation/immigration preparation.

### F. Data model visibility for legal outcomes is low

The UI currently under-surfaces immigration-specific objects that matter most in execution:
- dependents/family graph,
- filing package checklist,
- notices and response deadlines,
- court/USCIS/EOIR milestones,
- representation and venue transitions.

---

## 3) Target UX principles for an immigration-firm CRM

1. **Matter-first, not table-first**
   - Organize screens around legal matters and stages.
2. **Risk-first visual hierarchy**
   - Deadlines, hearings, and blockers should visually outrank passive metadata.
3. **One timeline, many filters**
   - Unified activity timeline with note/event/comms/doc filters.
4. **Actionable empty/error states**
   - Every “no data” or error message must include guided next actions.
5. **Progressive disclosure**
   - Summary first, detail on demand; preserve density without chaos.
6. **Role-aware defaults**
   - Attorney, paralegal, intake, and admin each get tailored default views.

---

## 4) Proposed replacement IA (vastly improved)

## A. Global structure

- **Global Nav (left rail or slim top):** Home, Clients, Matters, Calendar, Communications, Tasks.
- **Client Workspace (within client):**
  1. Overview
  2. Matters
  3. Timeline
  4. Documents
  5. Deadlines
  6. Contacts/Family
  7. Applications & Filings
  8. Billing/Admin (if needed)

## B. New “Client Overview” layout (default tab)

### Top strip (sticky)
- Client identity + aliases + language + vulnerability flags.
- Matter stage chip (e.g., “SIJ – Evidence Collection”).
- Next critical date card (hearing/interview/RFE due).
- Quick actions: Add note, Log comms, Add deadline, Create filing task.

### Body (3-column desktop)
1. **Legal Risk Panel (left):** overdue items, upcoming deadlines, missing docs.
2. **Unified Timeline (center):** notes/events/comms with smart filters.
3. **Hearings/Interviews + Family graph (right):** immediate legal context.

This preserves legacy breadth but prioritizes legal execution.

## C. Matter workspace redesign

Each matter gets its own view with:
- stage tracker,
- checklist completion,
- upcoming court/agency events,
- required evidence list,
- filings history,
- decision outcomes.

This makes “Matters” operational instead of a passive record list.

---

## 5) Component-level upgrades

1. **Critical Date Stack**
   - “Today / 7 days / 30 days” grouped cards with severity colors and owner avatars.
2. **Case Health Score (explainable)**
   - Derived from deadline proximity, stale communications, missing required docs.
3. **Guided Next Actions widget**
   - System-suggested actions based on stage and missing prerequisites.
4. **Cross-module quick create**
   - One command palette: note, event, request, filing, task.
5. **Legal-status chips**
   - Standardized chip taxonomy for stage, urgency, agency, and outcome.
6. **Dependents/Related Individuals graph**
   - Family relationships visualized and linked to shared deadlines/documents.
7. **Evidence pack checklist**
   - Reusable checklist templates by matter type (SIJ, asylum, removal defense, etc.).

---

## 6) Data and workflow alignment requirements

To align with the app being replaced, the replacement should formalize these objects:

- **Client** (core profile, multilingual preferences, contact protocols)
- **Matter** (type, venue/agency, stage, attorney owner)
- **Deadline** (source, statutory/court/operational, hard/soft)
- **Event** (hearing/interview/biometrics/appointment)
- **Communication** (channel, direction, disposition)
- **Document/Evidence** (required/received/validated/submitted)
- **Related Individual** (relationship + shared matter references)
- **Application/Filing** (form/package lifecycle)
- **Tasks** (owner, SLA, escalation)

Without this model discipline, UX improvements will not sustain operational gains.

---

## 7) Prioritized roadmap (90-day UI/UX plan)

### Phase 1 (Weeks 1–4): Stabilize and clarify
- Implement actionable error/empty states.
- Reduce top-level nav clutter and define primary vs secondary actions.
- Ship Client Overview with critical date card + quick actions.

### Phase 2 (Weeks 5–8): Operational control center
- Launch unified timeline with filters.
- Add deadline risk grouping and owner assignment workflows.
- Introduce standardized status chips and stage tracker.

### Phase 3 (Weeks 9–12): Matter intelligence
- Matter workspace with checklist templates by immigration case type.
- Case health scoring + next-best-action panel.
- Related individuals graph + shared dependency alerts.

---

## 8) Suggested success metrics

1. Time to find next required action (target: -40%).
2. Overdue deadline rate (target: -50%).
3. Matter update completion within SLA (target: +35%).
4. Weekly active usage by role (paralegal/attorney/admin).
5. Error-state abandonment rate (target: -60%).

---

## 9) Immediate UI changes to implement first

1. Make **Overview** the default client tab with risk-focused cards.
2. Replace generic errors with **recovery actions**.
3. Merge Notes + Events + Comms into **one timeline** component.
4. Move lower-frequency tabs behind “More” to reduce cognitive load.
5. Add stage, urgency, and due-date chips in every list row.

These five changes alone will make the replacement feel materially better than the current system while staying aligned with what users already recognize.
