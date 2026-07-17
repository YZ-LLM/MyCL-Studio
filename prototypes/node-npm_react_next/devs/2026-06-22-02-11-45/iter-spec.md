# Auth, RBAC & Product Catalog Foundation Iteration

## Scope

This iteration builds the greenfield on-premise Arçelik back-office panel foundation (Next.js web UI in Turkish, Node.js backend, PostgreSQL) plus the product catalog module end-to-end. Included: local username/password authentication with hashed credentials and server-managed sessions; server-side role-based access control for three roles (Admin, Dealer, Service technician); a shared Turkish application layout with role-aware navigation; a reusable data-access layer that centralizes all PostgreSQL access via parameterized queries; and full product catalog CRUD (create, read/list, update, delete) persisted to PostgreSQL. Because this is the genuine first build (the working directory contains no package scripts, .gitignore, or error_folder), the iteration also delivers the mandatory first-build scaffolding: the MyCL error catalog (error_folder/mycl_errors.db + backend middleware + frontend error boundary + Hata Kodları page + gitignore) and the concurrent dev-workflow scripts. Explicitly excluded: dealer management, order tracking, and service/malfunction request modules (deferred to later iterations, not dropped), advanced authentication beyond local username/password, catalog features beyond basic CRUD, and any performance/load budget.

## Acceptance Criteria

- **AC1**: Valid credentials log the user in and establish an authenticated session.
  - _Given:_ A user account exists in PostgreSQL with a known username and a hashed password
  - _When:_ The user submits the correct username and password to the login flow
  - _Then:_ The server verifies the password against the stored hash, establishes an authenticated session, and the user reaches an authenticated area of the panel
- **AC2**: Invalid credentials are rejected with no session established.
  - _Given:_ A user account exists
  - _When:_ The user submits a wrong password or an unknown username
  - _Then:_ The server rejects the attempt, no authenticated session is created, and access to authenticated areas is denied
- **AC3**: Passwords are stored only as salted one-way hashes, never plaintext.
  - _Given:_ A user account is created or its password is set
  - _When:_ The stored credential row is inspected directly in PostgreSQL
  - _Then:_ The password is persisted only as a salted one-way hash and the plaintext password never appears in the database
- **AC4**: RBAC is enforced server-side for all three roles, including catalog writes.
  - _Given:_ An authenticated user holding one of the three roles (Admin, Dealer, Service technician)
  - _When:_ The user requests an action or route not permitted for their role — including calling the API directly to bypass the UI (e.g. a non-authorized role attempting a product create/update/delete)
  - _Then:_ The server denies the request with HTTP 403 Forbidden and performs no state change
- **AC5**: A shared Turkish layout with role-aware navigation renders on authenticated pages.
  - _Given:_ An authenticated user
  - _When:_ They navigate any authenticated page of the panel
  - _Then:_ A shared Turkish-language application layout (common header/navigation shell) renders, and the navigation shows only the items permitted for that user's role
- **AC6**: All database access goes through a reusable data-access layer using parameterized queries.
  - _Given:_ Any feature needs to read or write application data in PostgreSQL
  - _When:_ It performs the database access
  - _Then:_ The access is routed through the reusable data-access layer using parameterized queries, with no inline string-concatenated SQL
- **AC7**: Product catalog supports full CRUD persisted to PostgreSQL.
  - _Given:_ An authenticated user authorized to manage the catalog
  - _When:_ They create, list/read, update, and delete a product
  - _Then:_ Each operation persists to PostgreSQL and is reflected on subsequent reads — a created product appears in the list, an update shows the new values, and a deleted product no longer appears
- **AC8**: The MyCL error catalog SQLite database exists with the required schema and holds only errors.
  - _Given:_ The application starts for the first time
  - _When:_ Initialization runs
  - _Then:_ error_folder/mycl_errors.db is opened/created with an errors table (id, ts, error_code, location, description_tr, stack, resolved DEFAULT 0, solution_tr) and contains ONLY the error catalog — application data such as users and products lives in the app's own PostgreSQL, never in mycl_errors.db
- **AC9**: Backend error middleware logs every uncaught exception and 4xx/5xx response to the error catalog.
  - _Given:_ The Node.js backend is running
  - _When:_ An uncaught exception is thrown or a 4xx/5xx response is returned while handling a request
  - _Then:_ A row is written to mycl_errors.db with location set to the endpoint path, an error_code, a Turkish description, and the stack trace where available
- **AC10**: Frontend error boundary logs caught React errors and failed fetches to the error catalog.
  - _Given:_ The Next.js web UI is running
  - _When:_ A React render error is caught by the error boundary or a fetch returns a failed response
  - _Then:_ The error is logged to mycl_errors.db via a /api/log-error endpoint
- **AC11**: A Hata Kodları page displays all error catalog rows in a readable Turkish table.
  - _Given:_ An operator is using the panel
  - _When:_ They navigate to /hata-kodlari
  - _Then:_ A readable Turkish table lists all rows from mycl_errors.db showing timestamp, error code, location, description, and resolved status
- **AC12**: The error_folder directory is gitignored.
  - _Given:_ The project repository
  - _When:_ .gitignore is inspected or a commit is attempted
  - _Then:_ error_folder/ is ignored and is never committed (error logs are per-instance)
- **AC13**: Concurrent dev scripts start both tiers and the web dev server is reachable.
  - _Given:_ A developer has installed the project
  - _When:_ They run npm run dev
  - _Then:_ Both the Next.js frontend and the Node.js backend start concurrently via a concurrently devDependency running npm:dev:backend and npm:dev:frontend; dev:backend and dev:frontend each start one tier alone; and the web UI dev server is reachable on its configured dev port

## Out of Scope

- Dealer management, order tracking, and service/malfunction request modules — deferred to later iterations (not dropped)
- Advanced authentication: SSO, MFA, password reset/recovery, email verification, account lockout/rate-limiting — only local username/password this iteration
- Catalog enhancements beyond basic CRUD: media/image upload, bulk import/export, and advanced search/filter/pagination
- Self-service user & role administration UI beyond the minimum needed to seed accounts and enforce RBAC
- No performance/load budget — perf and scale targets are out of scope this iteration (no stated perf need)

## Risks

### RBAC server enforcement coverage
Every mutating endpoint, including catalog writes, must check role server-side. A single unguarded endpoint defeats RBAC even when the UI hides the control.

### Undefined product catalog schema
The intent does not specify the product fields. The chosen catalog shape may not match Arçelik's real product attributes and could require rework once confirmed.

### On-prem PostgreSQL provisioning
Connection, migration, and seeding on an on-premise PostgreSQL instance (no managed DB) may introduce environment-specific setup friction.

### Dual-store separation
Application data must stay in PostgreSQL while the error catalog stays in the separate mycl_errors.db SQLite file. Accidentally mixing the two would pollute the error catalog with app data.

## Assumptions (kullanıcı açıkça belirtmedi — yanlışsa itiraz et)

- **Admin has full product CRUD while Dealer and Service technician have read-only catalog access.** — The intent named the three roles but did not specify per-role catalog permissions; a concrete default is needed to make RBAC testable.
- **The product entity has a minimal shape (e.g. name, code/SKU, category, price, stock/description).** — The intent did not define the catalog schema, so a minimal field set is assumed to enable CRUD and persistence tests.
- **First-build scaffolding (error catalog + concurrent dev scripts + gitignore) is in-scope.** — The working directory has no existing error_folder, package scripts, or .gitignore, so these mandatory items are genuine first-build deliverables rather than already-done work.
- **Login state is held in a server-managed authenticated session.** — The intent said 'local username/password' without specifying the session mechanism; a server-side session is assumed to express the auth acceptance criteria.
