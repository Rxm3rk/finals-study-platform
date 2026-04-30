# Remove Viewer Watermark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove only the `@RXM3RK` watermark overlay from the PDF viewer while keeping the approved-device security wall unchanged.

**Architecture:** Make a minimal frontend-only removal in `viewer.html` by deleting the watermark CSS and markup. Update the existing security-wall design/spec references so documentation no longer claims the viewer watermark is required.

**Tech Stack:** Static HTML/CSS/vanilla JavaScript; Node.js syntax checks for inline scripts.

---

## File Structure

- Modify `viewer.html`
  - Remove `.rxm-watermark` CSS and `.rxm-watermark::before` CSS.
  - Remove `<div class="rxm-watermark" aria-hidden="true"></div>`.
- Modify `docs/superpowers/specs/2026-04-30-security-wall-design.md`
  - Replace the viewer watermark section with a short note that no viewer watermark is shown.
  - Remove testing/data-flow claims that require watermark presence.
- Modify `docs/superpowers/plans/2026-04-30-security-wall.md`
  - Update the original security-wall plan so it no longer lists watermark implementation/verification as a requirement.
- No server changes.
- Do not remove the homepage author tag `Made by @rxm3rk`.
- Do not change admin password fallback text.

## Task 1: Remove Viewer Watermark UI

**Files:**
- Modify: `viewer.html:237-292`

- [ ] **Step 1: Remove watermark CSS**

Delete this exact CSS block from `viewer.html`:

```css
        .rxm-watermark {
            position: fixed;
            inset: 60px 0 0;
            z-index: 6;
            pointer-events: none;
            overflow: hidden;
            opacity: 0.12;
        }

        .rxm-watermark::before {
            content: "@RXM3RK  @RXM3RK  @RXM3RK  @RXM3RK";
            position: absolute;
            top: -10%;
            left: -25%;
            width: 150%;
            height: 150%;
            color: #111827;
            font-size: clamp(2rem, 8vw, 5rem);
            font-weight: 800;
            letter-spacing: 0.4rem;
            line-height: 2.8;
            white-space: pre-wrap;
            transform: rotate(-24deg);
            text-align: center;
        }
```

- [ ] **Step 2: Remove watermark markup**

Delete this exact line from `viewer.html`:

```html
    <div class="rxm-watermark" aria-hidden="true"></div>
```

- [ ] **Step 3: Verify viewer no longer contains watermark markers**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const viewer = fs.readFileSync('viewer.html', 'utf8');
for (const term of ['rxm-watermark', '@RXM3RK']) {
  if (viewer.includes(term)) throw new Error(`viewer.html still contains ${term}`);
}
console.log('viewer watermark removed');
NODE
```

Expected:

```text
viewer watermark removed
```

- [ ] **Step 4: Verify viewer inline script syntax still passes**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const html = fs.readFileSync('viewer.html', 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
for (const script of scripts) new Function(script);
console.log('viewer.html: inline scripts ok');
NODE
```

Expected:

```text
viewer.html: inline scripts ok
```

## Task 2: Update Security-Wall Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-04-30-security-wall-design.md:87-144`
- Modify: `docs/superpowers/plans/2026-04-30-security-wall.md`

- [ ] **Step 1: Update design spec watermark section**

In `docs/superpowers/specs/2026-04-30-security-wall-design.md`, replace this section:

```markdown
## Viewer watermark

The viewer should render a subtle watermark overlay behind/over the PDF view without becoming annoying. The watermark should use only the owner's mark:

```text
@RXM3RK
```

The watermark should repeat lightly across the visible viewer area, using low opacity and rotation. It should not include user details, timestamps, device IDs, or other distracting identifiers.
```

with:

```markdown
## Viewer watermark

No viewer watermark should be shown. Account-sharing protection should rely on admin approval, the two-device limit, session rotation, protected PDF routes, and admin reset controls.
```

- [ ] **Step 2: Update design spec copy/screenshot note**

In the same spec, replace:

```markdown
- Do not claim screenshots are impossible. The watermark is the core leakage deterrent.
```

with:

```markdown
- Do not claim screenshots are impossible. The security wall is focused on access control, not screenshot prevention.
```

- [ ] **Step 3: Update design spec data flow**

Replace:

```markdown
12. Viewer shows the subtle `@RXM3RK` watermark.
```

with:

```markdown
12. Viewer opens without a watermark overlay.
```

- [ ] **Step 4: Update design spec testing plan**

Delete this testing bullet:

```markdown
- Verify the subtle `@RXM3RK` watermark appears in the viewer and does not block PDF interaction.
```

- [ ] **Step 5: Update implementation plan summary**

In `docs/superpowers/plans/2026-04-30-security-wall.md`, replace:

```markdown
**Goal:** Add a server-side security wall that limits access to admin-approved group members, caps approved users at 19, allows two trusted devices per user, blocks third devices, and adds a subtle `@RXM3RK` viewer watermark.
```

with:

```markdown
**Goal:** Add a server-side security wall that limits access to admin-approved group members, caps approved users at 19, allows two trusted devices per user, and blocks third devices.
```

- [ ] **Step 6: Update implementation plan architecture**

In the same plan, replace:

```markdown
Add subtle repeated `@RXM3RK` watermark overlay.
```

with:

```markdown
Do not render a viewer watermark overlay.
```

- [ ] **Step 7: Verify docs no longer require watermark**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
for (const file of ['docs/superpowers/specs/2026-04-30-security-wall-design.md', 'docs/superpowers/plans/2026-04-30-security-wall.md']) {
  const text = fs.readFileSync(file, 'utf8');
  if (/watermark appears|subtle `@RXM3RK` watermark|adds a subtle `@RXM3RK`/.test(text)) {
    throw new Error(`${file} still requires the watermark`);
  }
  console.log(`${file}: watermark requirement removed`);
}
NODE
```

Expected:

```text
docs/superpowers/specs/2026-04-30-security-wall-design.md: watermark requirement removed
docs/superpowers/plans/2026-04-30-security-wall.md: watermark requirement removed
```

## Task 3: Final Verification and Commit

**Files:**
- Verify: `viewer.html`, `docs/superpowers/specs/2026-04-30-security-wall-design.md`, `docs/superpowers/plans/2026-04-30-security-wall.md`

- [ ] **Step 1: Run final syntax and marker checks**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const viewer = fs.readFileSync('viewer.html', 'utf8');
for (const term of ['rxm-watermark', '@RXM3RK']) {
  if (viewer.includes(term)) throw new Error(`viewer.html still contains ${term}`);
}
const scripts = [...viewer.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
for (const script of scripts) new Function(script);
console.log('viewer watermark removed and inline scripts ok');
NODE
```

Expected:

```text
viewer watermark removed and inline scripts ok
```

- [ ] **Step 2: Run whitespace check**

Run:

```bash
git diff --check -- viewer.html docs/superpowers/specs/2026-04-30-security-wall-design.md docs/superpowers/plans/2026-04-30-security-wall.md
```

Expected: no whitespace errors.

- [ ] **Step 3: Commit and push only watermark removal files**

Run:

```bash
git status --short
git add -- viewer.html docs/superpowers/specs/2026-04-30-security-wall-design.md docs/superpowers/plans/2026-04-30-security-wall.md
git commit -m "$(cat <<'EOF'
fix: remove viewer watermark

Remove the viewer watermark overlay while keeping the approved-device security wall unchanged.

Co-Authored-By: Claude GPT-5.5 <noreply@openclaude.dev>
EOF
)"
git push origin master
```

Expected: commit succeeds and push updates `origin/master`.

## Self-Review

- Spec coverage: removes only the viewer watermark CSS/markup, updates docs that required the watermark, leaves security wall and unrelated `@rxm3rk` text untouched.
- Placeholder scan: no TBD/TODO/later placeholders are present.
- Type consistency: target marker names are consistently `rxm-watermark` and `@RXM3RK`.
