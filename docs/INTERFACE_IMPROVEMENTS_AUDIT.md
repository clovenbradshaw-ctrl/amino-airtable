# Interface Functionality Audit: 10 Improvement Opportunities

This revision turns the prior audit into an execution-oriented checklist with **priority, rationale, and acceptance criteria**.

## Suggested rollout order
1. **P0 (do first):** #1, #2, #3, #4, #10
2. **P1 (next):** #7, #8, #9
3. **P2 (planned refactor):** #5, #6

---

## 1) Replace blocking browser dialogs with first-class UI modals
**Priority:** P0  
**Problem:** Core workflows still use `prompt`, `confirm`, and `alert`, which creates inconsistent UX, weak validation, and poor accessibility.

**What to change**
- Create reusable modal components (confirm, input, destructive confirm).
- Migrate dialog-driven flows: folder creation/rename, workspace creation, role visibility picker, move-to-folder/workspace, destructive actions.
- Add keyboard trap + escape support + ARIA labels.

**Acceptance criteria**
- No production usage of `prompt/alert/confirm` for core app flows.
- All replacement modals support validation and non-destructive cancel.

## 2) Improve destructive-action safety with impact previews + undo
**Priority:** P0  
**Problem:** Destructive operations are often one-click/one-confirm without context.

**What to change**
- Add impact previews (what will be deleted/changed).
- Require typed confirmation for irreversible actions (e.g., local DB reset).
- Add undo for reversible deletes (soft-delete window where feasible).

**Acceptance criteria**
- High-risk operations require explicit secondary confirmation.
- Reversible operations expose an undo toast/action.

## 3) Restrict or remove the “Skip encryption” path
**Priority:** P0  
**Problem:** Users can store API keys/cached data unencrypted after one confirmation.

**What to change**
- Hide behind admin/feature flag.
- Add policy gate at org-level: `encryption_required=true` by default.
- If enabled, require explicit risk acknowledgement with stronger copy.

**Acceptance criteria**
- Default behavior forbids unencrypted mode.
- Security settings are enforced by policy, not just client preference.

## 4) Re-enable zoom and test accessibility at larger scale
**Priority:** P0  
**Problem:** Viewport settings block pinch-zoom (`user-scalable=no`), harming accessibility.

**What to change**
- Remove zoom lock from viewport meta.
- Validate at 200% zoom and large text settings.
- Fix overflow/cropping regressions in login, table, and settings screens.

**Acceptance criteria**
- Users can zoom on mobile.
- Primary workflows remain usable at 200% zoom.

## 5) Improve login naming and product orientation
**Priority:** P2  
**Problem:** “DB Viewer / Amino Viewer” naming feels internal and not role-oriented.

**What to change**
- Rename title/entry copy to user-facing product wording.
- Add role-aware welcome text and first-step guidance after login.

**Acceptance criteria**
- Login and first screen language is task-oriented and consistent with brand terminology.

## 6) Break up monolithic front-end implementation
**Priority:** P2  
**Problem:** `index.html` contains ~29k lines of mixed UI, logic, and state handling.

**What to change**
- Split into modules: auth, sync, interface builder, settings, views.
- Extract CSS and shared utilities.
- Add a build step and lint gates for maintainability.

**Acceptance criteria**
- No single file over agreed threshold (e.g., 2k lines, excluding generated assets).
- Module boundaries documented and testable.

## 7) Remove inline event handlers
**Priority:** P1  
**Problem:** Inline `onclick` handlers increase coupling and limit CSP/security posture.

**What to change**
- Replace inline handlers with delegated listeners or component wiring.
- Centralize event registration by feature module.

**Acceptance criteria**
- Zero inline JS event attributes in primary UI templates.
- CSP-compatible event wiring pattern established.

## 8) Introduce structured logging and log levels
**Priority:** P1  
**Problem:** High volume `console.log` usage creates noise and risks exposing sensitive context.

**What to change**
- Add logger utility with levels (`debug/info/warn/error`).
- Disable debug logs in production by default.
- Add redaction for tokens, IDs, and sensitive payload fields.

**Acceptance criteria**
- Production logs are actionable and low-noise.
- Sensitive values are never emitted in plaintext logs.

## 9) Remove direct webhook endpoint exposure in client code
**Priority:** P1  
**Problem:** Client-side hardcoded webhook URLs increase operational and security risk.

**What to change**
- Move write-trigger endpoints behind server-managed API routes.
- Fetch environment-specific config from trusted bootstrap endpoint.
- Add key rotation and endpoint revocation process.

**Acceptance criteria**
- Client bundle no longer contains privileged webhook endpoints.
- Endpoint management and rotation are operationally documented.

## 10) Replace `alert(...)` errors with contextual inline guidance
**Priority:** P0  
**Problem:** Blocking browser alerts interrupt flow and hide recovery options.

**What to change**
- Show errors inline near failing form/action.
- Provide concise recovery suggestions (“retry”, “fix input”, “contact admin”).
- Use toast notifications for transient/non-blocking status.

**Acceptance criteria**
- Validation and import errors render in-context.
- Users can recover without losing current workflow state.

---

## Quick metrics to track after implementation
- Task completion rate for: create view, move view, create workspace, reset password.
- Error recovery rate without hard page refresh.
- Drop in destructive-action support incidents.
- Accessibility checks passed at zoom/text scaling scenarios.
