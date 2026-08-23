# Design QA: Tutti-style WinAgent Frontend Redesign

- Source visual truth paths:
  - `E:\tutti\tutti\tutti\docs\assets\zh\workspace-hero.jpg`
  - `E:\tutti\tutti\tutti\docs\assets\zh\at-command.jpg`
  - `E:\tutti\tutti\tutti\docs\assets\zh\plus-reference.jpg`
  - `E:\tutti\tutti\tutti\docs\assets\zh\control-center.jpg`
- Implementation screenshot path: `E:\WinAgent-Workbench\.tmp\winagent-tutti-redesign-clean.png`
- Windows-style follow-up screenshot path: `E:\WinAgent-Workbench\.tmp\winagent-windows-workbench.png`
- Viewport: Codex in-app browser desktop viewport, captured full page.
- Source pixel dimensions: README screenshots are 1600 x 1000.
- Implementation pixel dimensions: browser-rendered screenshot captured from local Vite app.
- CSS size and density normalization: compared desktop layout proportions and visible states rather than pixel-perfect asset reproduction because the implementation preserves WinAgent product content and does not copy Tutti raster assets.
- State: default workspace open, Applications window active, Agent composer visible, Control Center visible.
- Primary interactions tested: local page load, dock active window rendering, no current browser console errors after reload.

## Full-view comparison evidence

The implementation adopts the core Tutti front-end pattern:

- Windows 11-like desktop background with blue/purple Mica depth and grid overlay;
- floating application windows with Windows-style title bars and right-side window controls;
- left session/project rail inside the main Agent window;
- central Agent composer with `+` reference entry and `@ Apps / Agents` entry;
- right-side Agent messages control center;
- bottom workspace dock;
- bottom Windows-style taskbar with Start entry and active app indicator;
- application marketplace-style cards;
- reference picker modal implemented as a first-class workflow surface.

## Focused region comparison evidence

Focused visual regions were checked against the source screenshots:

- `at-command.jpg`: mapped to the composer command-palette entry and `@ Apps / Agents` trigger.
- `plus-reference.jpg`: mapped to the `Pick workspace references` modal with category rail, results list, preview, and selected reference chips.
- `control-center.jpg`: mapped to the persistent Agent messages side panel with `Needs attention`, `Running`, and `Completed` sections.
- `apps-1.jpg`: mapped to the Applications floating window with categorized app cards.
- User follow-up screenshot: removed macOS red/yellow/green traffic-light controls and replaced the overall shell with a Windows taskbar/titlebar visual language.

## Findings

- No P0/P1/P2 blockers remain.

## Comparison history

1. Initial implementation showed the right-side control center below the main window at medium width.
   - Severity: P2.
   - Fix: lowered the responsive breakpoint and changed the desktop grid to keep the control center visible at the captured width.
   - Post-fix evidence: `E:\WinAgent-Workbench\.tmp\winagent-tutti-redesign-v2.png`.

2. Initial implementation used a dynamic long Agent name in the hero title, causing visible clipping.
   - Severity: P2.
   - Fix: replaced the dynamic hero title with stable product copy, keeping the selected Agent name in the left selector.
   - Post-fix evidence: `E:\WinAgent-Workbench\.tmp\winagent-tutti-redesign-clean.png`.

3. Dev-mode HMR logged duplicate React root creation.
   - Severity: P2 for QA cleanliness.
   - Fix: reused a cached React root on `globalThis`.
   - Post-fix evidence: browser console error check returned no current errors.

4. User identified the workbench as too macOS-like because of the traffic-light controls and dock.
   - Severity: P2 for platform fit.
   - Fix: replaced macOS traffic lights with Windows minimize/maximize/close controls, changed the dock into a Windows taskbar, moved the background from pastoral desktop art toward Windows 11 Mica/Acrylic blue gradients, and reduced window radii.
   - Post-fix evidence: `E:\WinAgent-Workbench\.tmp\winagent-windows-workbench.png`.

## Required fidelity surfaces

- Fonts and typography: uses a Lexend/Inter/system stack similar to Tutti's rounded product typography, with reduced hero sizing to prevent overflow in WinAgent's narrower working area.
- Spacing and layout rhythm: adopts Tutti's windowed desktop layout while using Windows-style title bars, taskbar alignment, smaller radii, and right-side control panel rhythm.
- Colors and visual tokens: maps to Windows 11 Mica/Acrylic-like light surfaces, blue Agent accent, purple tool/reference accent, subtle grid background, and soft shadow elevation.
- Image quality and asset fidelity: no Tutti raster assets were copied into the app. The implementation recreates the layout language with CSS backgrounds and native UI surfaces to avoid shipping borrowed image assets.
- Copy and content: keeps WinAgent-specific wording and function labels while matching Tutti's composer/control-center/app-workspace information architecture.

## Follow-up polish

- P3: replace text-based dock labels with a proper icon set.
- P3: add draggable/resizable floating windows.
- P3: persist active desktop window layout per workspace.
- P3: add a task center surface behind the Task Center app card.
- P3: replace the text Start glyph with an actual Windows-compatible icon asset.

## Final result

final result: passed
