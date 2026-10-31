# Android capture pilot implementation plan

**Goal:** Build an installable private Android pilot to validate payment capture on OnePlus 13, with native bookkeeping flows and a first confirmed-transaction sync path.

**Architecture:** Native Kotlin/Compose UI, Room local persistence, explicit notification/accessibility services, existing HTTPS ledger API. Cloud remains optional; capture never requires a network connection. This milestone does not claim production-grade bidirectional editing, background instant sync, or verified device coverage.

**Scope:** Preserve production website and database. No secret/config/schema changes. No Root, SMS, screenshots, clicks or payment automation. User explicitly enables Android permissions. Only supported payment packages are inspected.

## Work and ownership

- [ ] Parent: isolated JDK/SDK/Gradle build setup under ignored `.local/`; source under `android/`.
- [ ] Capture worker: `capture/PaymentParser.kt`, notification listener, accessibility listener, JVM tests. Strict cents and ambiguous transactions remain pending.
- [ ] UI worker: `ui/MoneyApp.kt` using data-package `LedgerItem`/`UiState`; four real-data tabs, add/confirm/ignore and settings/login callbacks.
- [ ] Parent: Room database, local event dedup, confirmed entry workflow, HTTPS cookie login, idempotent expense/income upload and cloud refresh. No service credentials in APK.
- [ ] Parent: manifest least permissions, package-restricted accessibility config, exclude backup of local finance/session state, assemble APK and run JVM tests/lint.
- [ ] Parent: browser reference prototype for four flows if emulator unavailable, clearly identified as prototype; APK remains native source of truth.
- [ ] Device validation: user installs pilot and enables chosen permissions; verify actual app/version notifications, offline persistence, restart, duplicate events, foreground and locked-screen coverage. No false success without this test.

## Contracts

`CaptureStore(context).capture(source,eventKey,text,receivedAt)` persists candidates; `enabled(packageName)` gates each allowed package; `setServiceState(source,connected)` records service connectivity. `PaymentParser.parse(text)` returns a conservative `ParsedPayment` or null for unrelated content.

UI receives `UiState` and action callbacks, never directly reads notifications or credentials. Source event IDs and API client request IDs are stable across retry. Server-read rows carry remote IDs to avoid duplicating locally uploaded rows.

## Verification

Build: `android/gradlew -p android testDebugUnitTest assembleDebug lintDebug` with task-local JAVA_HOME/ANDROID_HOME. Existing site: `npm test` and `npm run build` if shared code changes. Inspect APK permissions and verify no secret/config file packaged. Actual device verification remains explicitly pending until phone is available.
