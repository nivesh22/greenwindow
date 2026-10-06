# Decisions log

Deviations from `greenwindow-design-spec.md`, new dependencies, and resolved verification items (V1–V11). Newest first.

Format:

```
## YYYY-MM-DD — <short title>
- Context:
- Decision:
- Reason:
- Spec sections affected:
```

---

## 2026-10-05 — Project setup
- Context: Claude Code project initialized with `CLAUDE.md`, `AGENTS.md` (spec Section 12 verbatim), and MCP config.
- Decision: Configure GitHub and Vercel MCPs only. Supabase is not configured, per spec D6 and 15.1.
- Reason: The plan uses no database; connecting one adds risk and a pausing free tier.
- Spec sections affected: none.

## 2026-10-05 — GitHub access via gh CLI instead of GitHub MCP
- Context: Spec H6 suggests a fine-grained PAT scoped to one repo for the GitHub MCP.
- Decision: Use `git` + `gh` CLI with the owner's existing login. GitHub MCP removed from `.mcp.json`.
- Reason: Owner's choice; simpler. Risk: the login has `repo`/`workflow` scope on all the owner's repos, so the agent rule is to touch only `nivesh22/greenwindow`.
- Spec sections affected: 15.2 H6, 15.3.

## 2026-10-05 — T-1 feasibility script written in-repo; V1, V3, V4, V9 resolved
- Context: Spec 14 refers to `scripts/feasibility_check.py` "delivered alongside this spec", but it was not provided.
- Decision: Wrote it from spec 14.3. Weather points/weights in it are provisional (equal weights; London, Birmingham, Glasgow, Aberdeen); T1 sets the real ones. SARIMAX(2,0,1)+Fourier and UCM specs in the gate are placeholders until course specs are confirmed.
- Findings: V1 — Carbon API accepts up to 30 days per request (31 rejected), not ~14; chunk at 30 days. V3/V4 — host and variable names as spec assumed; request `wind_speed_unit=ms`. V9 — raw host sends `Access-Control-Allow-Origin: *`, `Cache-Control: max-age=300`.
- Spec sections affected: 2.2 (V1, V3, V4 annotated).
