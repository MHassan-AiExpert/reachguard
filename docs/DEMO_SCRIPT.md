# Demo script (about 10 minutes)

Prerequisites: stack running, workflows imported and active, credentials created (see README), `GEMINI_API_KEY` set so the agents can answer. Telegram is optional.

1. **Show the pipeline.** Open n8n and the workflow list: 14 workflows tagged `reachguard`. Open `WF-02 Hygiene Agent` to show the claim, call, transition shape shared by every stage.
2. **Run the demo.** Open `WF-14 Sandbox Demo Runner` and run it. It checks the mode, refuses to continue if `MODE=live`, resets sandbox data, seeds 60 synthetic leads through the signed intake webhook, loops the stage workflows with a 20-minute cap, auto-approves in sandbox (recorded as `demo-runner`), sends, then injects 40 labeled replies.
3. **Watch the funnel.** In Metabase (http://localhost:3000) or with `SELECT * FROM v_funnel;` show leads leaving at hygiene (role accounts, disposable domains, no MX, suppressed, blocked regions), at scoring, and at QA.
4. **Open the inbox.** Mailpit (http://localhost:8025): each email has the unsubscribe link and the physical address.
5. **Show a guard working.** Pick a rejected lead in `lead_transitions` and read its reason. Show a draft whose claim cites an evidence id from another lead being failed by the precheck.
6. **Show unsubscribe wins.** Find the reply that says "stop" and its suppression row.
7. **Show the evaluation.** Open `docs/EVAL_REPORT.md`. Point out the "not run" parts and why: the report does not print numbers for anything that did not run.

Reset between runs by running WF-14 again; it clears the sandbox first.
