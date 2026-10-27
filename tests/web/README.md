# Web renderer QA

Run `npm run test:web` after `npm install` and `npx playwright install chromium`.
The Playwright config starts Vite on `127.0.0.1:4173` and uses the same React
renderer as Electron. Browser workers are limited to two so native and Electron
QA can run on the same workstation.

`workspace.spec.ts` opens `?demo=1`, which explicitly selects synthetic assets,
documents and Photos operations. Move/copy/recovery tests never touch the actual
Photos library. They verify UI behavior and the shared adapter contract, not
PhotoKit authorization, iCloud upload verification or real source deletion.

`shared-web.spec.ts` opens the normal web renderer and serves versioned synthetic
`snapshot.json` responses. It checks the read-only surface, malformed snapshots,
network errors, unsafe links, empty results and mobile layout. This verifies the
hosted renderer contract; it does not claim a Site was deployed or a production
endpoint received a desktop update.

Screenshots and failure traces go to ignored `test-results/web/`; the HTML report
goes to ignored `playwright-report/web/`. Both desktop and mobile screenshots
contain only synthetic data. Execution results belong in the integration QA
report, separate from the original Swift baseline.
